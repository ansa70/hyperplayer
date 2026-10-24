//! Which servers' certificates to trust. Certificates from a public authority are
//! checked as usual (by the OS); a self-signed one, as a home server makes, is
//! trusted once the user has accepted its fingerprint ("trust on first use"). From
//! then on only that exact certificate is accepted for the server.

use std::{
    collections::BTreeMap,
    fmt, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use rustls::{
    DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::CryptoProvider,
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use sha2::{Digest, Sha256};

/// A server whose certificate this computer doesn't trust (yet).
#[derive(Debug)]
pub struct UntrustedCertificate {
    pub server: String,
    /// SHA-256 of the certificate, as `AB:CD:...` (the server logs the same).
    pub fingerprint: String,
}

impl fmt::Display for UntrustedCertificate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} uses a certificate this computer doesn't trust (SHA-256 {})",
            self.server, self.fingerprint
        )
    }
}

impl std::error::Error for UntrustedCertificate {}

/// The certificate the last failed connection was offered, for `UntrustedCertificate`.
pub type Seen = Arc<Mutex<Option<String>>>;

pub fn fingerprint(cert: &[u8]) -> String {
    Sha256::digest(cert)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// `host:port` of a server URL: pins are per server, whatever the path.
fn origin(server: &str) -> String {
    let rest = server.split_once("://").map_or(server, |(_, r)| r);
    let host = rest.split('/').next().unwrap_or(rest);
    if host
        .rsplit_once(':')
        .is_some_and(|(_, p)| p.chars().all(|c| c.is_ascii_digit()))
        && !host.ends_with(']')
    {
        host.to_lowercase()
    } else {
        format!("{}:443", host.to_lowercase())
    }
}

fn path() -> Option<PathBuf> {
    Some(crate::dirs::config_dir()?.join("trusted-servers.json"))
}

fn load() -> BTreeMap<String, String> {
    path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The fingerprint trusted for `server`, if any.
pub fn pinned(server: &str) -> Option<String> {
    load().remove(&origin(server))
}

/// Trusts the certificate with `fingerprint` for `server` from now on (replacing any other).
pub fn trust(server: &str, fingerprint: &str) {
    let mut pins = load();
    pins.insert(origin(server), fingerprint.to_string());
    let Some(p) = path() else { return };
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(&pins)
        && let Err(e) = fs::write(&p, json)
    {
        eprintln!("saving {}: {e}", p.display());
    }
}

/// TLS settings for connections to `server`, and where a refused certificate is reported.
pub fn tls_config(server: &str) -> (rustls::ClientConfig, Seen) {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let seen = Seen::default();
    let verifier = Pinning {
        system: Arc::new(
            rustls_platform_verifier::Verifier::new(provider.clone())
                .expect("the system's certificate verifier"),
        ),
        provider: provider.clone(),
        pinned: pinned(server),
        seen: seen.clone(),
    };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("TLS protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    (config, seen)
}

#[derive(Debug)]
struct Pinning {
    system: Arc<rustls_platform_verifier::Verifier>,
    provider: Arc<CryptoProvider>,
    pinned: Option<String>,
    seen: Seen,
}

impl ServerCertVerifier for Pinning {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = fingerprint(end_entity);
        if self.pinned.as_deref() == Some(fingerprint.as_str()) {
            return Ok(ServerCertVerified::assertion());
        }
        self.system
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
            .inspect_err(|_| *self.seen.lock().unwrap() = Some(fingerprint))
    }

    // The handshake's signatures prove the server holds the certificate's key, pinned or not.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_are_per_host_and_port() {
        assert_eq!(origin("https://Music.Home:4533/"), "music.home:4533");
        assert_eq!(origin("https://music.home"), "music.home:443");
        assert_eq!(origin("https://[fd00::1]:4533"), "[fd00::1]:4533");
        assert_eq!(origin("https://[fd00::1]"), "[fd00::1]:443");
    }

    #[test]
    fn fingerprints_look_like_the_servers() {
        assert_eq!(&fingerprint(b"abc")[..8], "BA:78:16");
    }
}
