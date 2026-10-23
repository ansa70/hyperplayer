//! Blocking HTTP client for the HyperPlayer server. All request/response
//! types are generated from the shared Zod schemas (see `build.rs`).

use anyhow::{Context, Result, bail};
use serde::de::DeserializeOwned;

#[allow(dead_code, clippy::all)]
pub mod types {
    include!(concat!(env!("OUT_DIR"), "/api_types.rs"));
}

use std::time::Duration;

use reqwest::Method;
use serde::Serialize;
use types::{
    AddToPlaylist, AddToQueue, AddToQueuePlacement, Advance, Album, AlbumList, ApiError, Artist,
    ArtistPage, AuthStatus, CreatePlaylist, Jump, Me, MoveEntry, NowPlaying, Ok as OkResponse,
    Playlist, PlaylistList, Preferences, QueueState, RepeatMode, SearchResults, Session, SetQueue,
    TrackSource, UpdatePlaylist, UpdateQueue, UserList,
};

use crate::adaptive::Quality;

/// The server rejected our credentials (missing, expired or revoked token).
#[derive(Debug)]
pub struct Unauthorized(pub String);

impl std::fmt::Display for Unauthorized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "not signed in: {}", self.0)
    }
}

impl std::error::Error for Unauthorized {}

#[derive(Clone)]
pub struct Api {
    base: String,
    http: reqwest::blocking::Client,
    /// No overall timeout: an audio stream legitimately stays open for the whole track.
    stream_http: reqwest::blocking::Client,
}

impl Api {
    pub fn new(base: impl Into<String>) -> Self {
        Self::with_token(base, None)
    }

    /// A client that authenticates every request (JSON, audio and artwork) with `token`.
    pub fn with_token(base: impl Into<String>, token: Option<&str>) -> Self {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(token) = token
            && let Ok(mut value) =
                reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        {
            // Keeps the token out of debug output.
            value.set_sensitive(true);
            headers.insert(reqwest::header::AUTHORIZATION, value);
        }
        Self {
            base: base.into().trim_end_matches('/').to_owned(),
            http: reqwest::blocking::Client::builder()
                .default_headers(headers.clone())
                .build()
                .expect("building HTTP client"),
            stream_http: reqwest::blocking::Client::builder()
                .default_headers(headers)
                .timeout(None)
                .connect_timeout(Duration::from_secs(10))
                .build()
                .expect("building HTTP client"),
        }
    }

    fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.send::<T, ()>(Method::GET, path, None)
    }

    /// JSON request with an optional JSON body; API errors become `Err` with the server's message.
    fn send<T: DeserializeOwned, B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<T> {
        let url = format!("{}{path}", self.base);
        let mut req = self.http.request(method.clone(), &url);
        if let Some(body) = body {
            req = req.json(body);
        }
        let res = req.send().with_context(|| format!("{method} {url}"))?;
        if !res.status().is_success() {
            let status = res.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                let message = res
                    .json::<ApiError>()
                    .map(|e| e.message)
                    .unwrap_or_default();
                return Err(Unauthorized(message).into());
            }
            match res.json::<ApiError>() {
                Ok(e) => bail!("{method} {url}: {status} {}: {}", e.error, e.message),
                Err(_) => bail!("{method} {url}: {status}"),
            }
        }
        res.json()
            .with_context(|| format!("decoding response of {method} {url}"))
    }

    fn bytes(&self, path: &str) -> Result<Vec<u8>> {
        let url = format!("{}{path}", self.base);
        let res = self
            .http
            .get(&url)
            .send()
            .with_context(|| format!("GET {url}"))?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(Unauthorized(String::new()).into());
        }
        let res = res.error_for_status()?;
        Ok(res.bytes()?.to_vec())
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    // ------------------------------------------------------------------ auth

    pub fn auth_status(&self) -> Result<AuthStatus> {
        self.get("/api/auth/status")
    }

    pub fn login(
        &self,
        username: &str,
        password: &str,
        device_name: &str,
        device_id: &str,
    ) -> Result<Session> {
        let body = serde_json::json!({
            "username": username, "password": password, "deviceName": device_name, "deviceId": device_id,
        });
        self.send(Method::POST, "/api/auth/login", Some(&body))
    }

    pub fn change_password(&self, current: &str, new: &str) -> Result<()> {
        let body = serde_json::json!({ "currentPassword": current, "newPassword": new });
        self.send::<OkResponse, _>(Method::POST, "/api/me/password", Some(&body))
            .map(|_| ())
    }

    /// First run (as the admin): creates the everyday user and moves this device to it.
    pub fn onboard(&self, full_name: &str, username: &str, password: &str) -> Result<Session> {
        let mut body = serde_json::json!({ "username": username, "password": password });
        if !full_name.trim().is_empty() {
            body["fullName"] = full_name.trim().into();
        }
        self.send(Method::POST, "/api/auth/onboard", Some(&body))
    }

    /// All accounts (admins only).
    pub fn users(&self) -> Result<UserList> {
        self.get("/api/users")
    }

    pub fn preferences(&self) -> Result<Preferences> {
        self.get("/api/me/preferences")
    }

    pub fn set_replaygain_preference(&self, mode: &str) -> Result<Preferences> {
        let body = serde_json::json!({ "replayGain": mode });
        self.send(Method::PATCH, "/api/me/preferences", Some(&body))
    }

    pub fn set_quality_preference(&self, quality: &str) -> Result<Preferences> {
        let body = serde_json::json!({ "quality": quality });
        self.send(Method::PATCH, "/api/me/preferences", Some(&body))
    }

    pub fn me(&self) -> Result<Me> {
        self.get("/api/me")
    }

    pub fn logout(&self) -> Result<()> {
        self.send::<OkResponse, ()>(Method::POST, "/api/auth/logout", None)
            .map(|_| ())
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

    // ------------------------------------------------------------- playlists

    pub fn playlists(&self) -> Result<PlaylistList> {
        self.get("/api/playlists")
    }

    pub fn playlist(&self, id: &str) -> Result<Playlist> {
        self.get(&format!("/api/playlists/{id}"))
    }

    pub fn create_playlist(&self, name: &str, tracks: Vec<types::Id>) -> Result<Playlist> {
        let body = CreatePlaylist {
            name: name
                .try_into()
                .map_err(|e| anyhow::anyhow!("invalid playlist name: {e}"))?,
            description: None,
            track_ids: tracks,
        };
        self.send(Method::POST, "/api/playlists", Some(&body))
    }

    pub fn rename_playlist(&self, id: &str, name: &str) -> Result<Playlist> {
        let body = UpdatePlaylist {
            name: Some(
                name.try_into()
                    .map_err(|e| anyhow::anyhow!("invalid playlist name: {e}"))?,
            ),
            description: None,
        };
        self.send(Method::PATCH, &format!("/api/playlists/{id}"), Some(&body))
    }

    pub fn delete_playlist(&self, id: &str) -> Result<()> {
        self.send::<OkResponse, ()>(Method::DELETE, &format!("/api/playlists/{id}"), None)
            .map(|_| ())
    }

    pub fn add_to_playlist(&self, id: &str, source: TrackSource) -> Result<Playlist> {
        let body = AddToPlaylist {
            source,
            position: None,
        };
        self.send(
            Method::POST,
            &format!("/api/playlists/{id}/entries"),
            Some(&body),
        )
    }

    pub fn remove_from_playlist(&self, id: &str, entry: &str) -> Result<Playlist> {
        self.send::<_, ()>(
            Method::DELETE,
            &format!("/api/playlists/{id}/entries/{entry}"),
            None,
        )
    }

    pub fn move_playlist_entry(&self, id: &str, entry: &str, to_index: usize) -> Result<Playlist> {
        let body = MoveEntry {
            to_index: to_index as i64,
        };
        self.send(
            Method::POST,
            &format!("/api/playlists/{id}/entries/{entry}/move"),
            Some(&body),
        )
    }

    // ----------------------------------------------------------------- queue

    pub fn queue(&self) -> Result<QueueState> {
        self.get("/api/queue")
    }

    pub fn set_queue(
        &self,
        source: TrackSource,
        start: usize,
        shuffle: Option<bool>,
    ) -> Result<QueueState> {
        let body = SetQueue {
            source,
            start: start as i64,
            shuffle,
        };
        self.send(Method::PUT, "/api/queue", Some(&body))
    }

    pub fn update_queue(&self, changes: UpdateQueue) -> Result<QueueState> {
        self.send(Method::PATCH, "/api/queue", Some(&changes))
    }

    pub fn set_shuffle(&self, on: bool) -> Result<QueueState> {
        self.update_queue(UpdateQueue {
            shuffle: Some(on),
            ..Default::default()
        })
    }

    pub fn set_repeat(&self, repeat: RepeatMode) -> Result<QueueState> {
        self.update_queue(UpdateQueue {
            repeat: Some(repeat),
            ..Default::default()
        })
    }

    pub fn save_position(&self, position: Duration) -> Result<QueueState> {
        let changes = UpdateQueue {
            position_ms: Some(position.as_millis() as i64),
            ..Default::default()
        };
        self.update_queue(changes)
    }

    pub fn clear_queue(&self) -> Result<QueueState> {
        self.send::<_, ()>(Method::DELETE, "/api/queue", None)
    }

    pub fn add_to_queue(&self, source: TrackSource, next: bool) -> Result<QueueState> {
        let placement = if next {
            AddToQueuePlacement::Next
        } else {
            AddToQueuePlacement::End
        };
        let body = AddToQueue { source, placement };
        self.send(Method::POST, "/api/queue/entries", Some(&body))
    }

    pub fn remove_from_queue(&self, entry: &str) -> Result<QueueState> {
        self.send::<_, ()>(Method::DELETE, &format!("/api/queue/entries/{entry}"), None)
    }

    pub fn advance_queue(&self, auto: bool) -> Result<QueueState> {
        self.send(Method::POST, "/api/queue/next", Some(&Advance { auto }))
    }

    pub fn rewind_queue(&self) -> Result<QueueState> {
        self.send::<_, ()>(Method::POST, "/api/queue/previous", None)
    }

    pub fn jump_in_queue(&self, entry: &str) -> Result<QueueState> {
        let body = Jump {
            entry_id: entry
                .try_into()
                .map_err(|e| anyhow::anyhow!("invalid entry id: {e}"))?,
        };
        self.send(Method::POST, "/api/queue/jump", Some(&body))
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
