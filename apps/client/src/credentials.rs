//! Where the device token is kept: the OS keyring (GNOME Keyring / KWallet via the
//! Secret Service API, macOS Keychain, Windows Credential Manager), or, when no
//! keyring is available, a file only the current user can read.

use std::{fs, path::PathBuf};

const SERVICE: &str = "hyperplayer";

/// Keyring entries are per server and user, so several accounts/servers can coexist.
fn account(server: &str, username: &str) -> String {
    format!("{username}@{server}")
}

fn fallback_path(server: &str, username: &str) -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    let safe: String = account(server, username)
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '@' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Some(base.join("hyperplayer").join("tokens").join(safe))
}

pub fn load(server: &str, username: &str) -> Option<String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, &account(server, username))
        && let Ok(token) = entry.get_password()
    {
        return Some(token);
    }
    fs::read_to_string(fallback_path(server, username)?)
        .ok()
        .map(|t| t.trim().to_string())
}

/// Stores the token; returns where it went, for the log.
pub fn save(server: &str, username: &str, token: &str) -> &'static str {
    if let Ok(entry) = keyring::Entry::new(SERVICE, &account(server, username))
        && entry.set_password(token).is_ok()
    {
        // A stale fallback file would otherwise shadow nothing but still sit on disk.
        if let Some(p) = fallback_path(server, username) {
            let _ = fs::remove_file(p);
        }
        return "system keyring";
    }
    if let Some(p) = fallback_path(server, username)
        && write_private(&p, token).is_ok()
    {
        return "private file";
    }
    "nowhere (sign-in will not be remembered)"
}

pub fn delete(server: &str, username: &str) {
    if let Ok(entry) = keyring::Entry::new(SERVICE, &account(server, username)) {
        let _ = entry.delete_credential();
    }
    if let Some(p) = fallback_path(server, username) {
        let _ = fs::remove_file(p);
    }
}

/// Writes a file readable only by its owner (0600 on Unix).
fn write_private(path: &PathBuf, contents: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    #[cfg(unix)]
    {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(contents.as_bytes())
    }
    #[cfg(not(unix))]
    fs::write(path, contents)
}
