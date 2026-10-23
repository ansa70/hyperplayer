//! Blocking HTTP client for the HyperPlayer server. All request/response
//! types are generated from the shared Zod schemas (see `build.rs`).

use anyhow::{Context, Result, bail};
use serde::de::DeserializeOwned;

#[allow(dead_code, clippy::all)]
pub mod types {
    include!(concat!(env!("OUT_DIR"), "/api_types.rs"));
}

use types::{Album, AlbumList, ApiError, Artist, ArtistPage, NowPlaying, StreamFormat};

/// Codecs the client can decode natively; everything else is transcoded to FLAC.
const NATIVE_CODECS: &[&str] = &[
    "mpeg 1 layer 3",
    "mp3",
    "flac",
    "vorbis",
    "aac",
    "mpeg-4/aac",
    "pcm",
];

#[derive(Clone)]
pub struct Api {
    base: String,
    http: reqwest::blocking::Client,
}

impl Api {
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_owned(),
            http: reqwest::blocking::Client::new(),
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

    pub fn artwork(&self, id: &str, size: u32) -> Result<Vec<u8>> {
        self.bytes(&format!("/api/artwork/{id}?size={size}"))
    }

    /// Downloads a track in a format the local decoder understands.
    pub fn audio(&self, track: &types::Track) -> Result<Vec<u8>> {
        let codec = track.format.codec.to_lowercase();
        let format = if NATIVE_CODECS.iter().any(|c| codec.contains(c)) {
            StreamFormat::Original
        } else {
            StreamFormat::Flac
        };
        self.bytes(&format!("/api/stream/{}?format={format}", *track.id))
    }
}
