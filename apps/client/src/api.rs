//! Blocking HTTP client for the HyperPlayer server. All request/response
//! types are generated from the shared Zod schemas (see `build.rs`).

use anyhow::{Context, Result, bail};
use serde::de::DeserializeOwned;

#[allow(dead_code, clippy::all)]
pub mod types {
    include!(concat!(env!("OUT_DIR"), "/api_types.rs"));
}

use std::time::Duration;

use types::{Album, AlbumList, ApiError, Artist, ArtistPage, NowPlaying, SearchResults};

use crate::adaptive::Quality;

#[derive(Clone)]
pub struct Api {
    base: String,
    http: reqwest::blocking::Client,
    /// No overall timeout: an audio stream legitimately stays open for the whole track.
    stream_http: reqwest::blocking::Client,
}

impl Api {
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_owned(),
            http: reqwest::blocking::Client::new(),
            stream_http: reqwest::blocking::Client::builder()
                .timeout(None)
                .connect_timeout(Duration::from_secs(10))
                .build()
                .expect("building HTTP client"),
        }
    }

    fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = format!("{}{path}", self.base);
        let res = self
            .http
            .get(&url)
            .send()
            .with_context(|| format!("GET {url}"))?;
        if !res.status().is_success() {
            let status = res.status();
            match res.json::<ApiError>() {
                Ok(e) => bail!("GET {url}: {status} {}: {}", e.error, e.message),
                Err(_) => bail!("GET {url}: {status}"),
            }
        }
        res.json()
            .with_context(|| format!("decoding response of GET {url}"))
    }

    fn bytes(&self, path: &str) -> Result<Vec<u8>> {
        let url = format!("{}{path}", self.base);
        let res = self
            .http
            .get(&url)
            .send()
            .with_context(|| format!("GET {url}"))?
            .error_for_status()?;
        Ok(res.bytes()?.to_vec())
    }

    pub fn artists(&self, offset: i64, limit: i64) -> Result<ArtistPage> {
        self.get(&format!("/api/artists?offset={offset}&limit={limit}"))
    }

    pub fn artist(&self, id: &str) -> Result<Artist> {
        self.get(&format!("/api/artists/{id}"))
    }

    pub fn artist_albums(&self, id: &str) -> Result<AlbumList> {
        self.get(&format!("/api/artists/{id}/albums"))
    }

    pub fn album(&self, id: &str) -> Result<Album> {
        self.get(&format!("/api/albums/{id}"))
    }

    pub fn now_playing(&self, track_id: &str) -> Result<NowPlaying> {
        self.get(&format!("/api/tracks/{track_id}/now-playing"))
    }

    pub fn search(&self, query: &str, limit: u32) -> Result<SearchResults> {
        let q: String = url_encode(query);
        self.get(&format!("/api/search?q={q}&limit={limit}"))
    }

    pub fn artwork(&self, id: &str, size: u32) -> Result<Vec<u8>> {
        self.bytes(&format!("/api/artwork/{id}?size={size}"))
    }

    pub fn stream_client(&self) -> reqwest::blocking::Client {
        self.stream_http.clone()
    }

    /// Stream endpoint URL for a track at a quality, optionally resuming a transcode at `start`.
    pub fn stream_url(&self, track_id: &str, quality: Quality, start: Option<Duration>) -> String {
        let mut url = format!("{}/api/stream/{track_id}?{}", self.base, quality.query());
        if let Some(start) = start {
            url.push_str(&format!("&start={:.3}", start.as_secs_f64()));
        }
        url
    }
}

/// Percent-encodes a query-string value.
fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
