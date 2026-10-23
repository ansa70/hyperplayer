//! Per-device client settings, stored in `$XDG_CONFIG_HOME/hyperplayer/settings.json`.
//!
//! Library state (queue, playlists) lives on the server; only what belongs to
//! this machine is kept here, including the id the server knows the device by.

use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Identifies this device's play queue on the server.
    pub device_id: String,
    /// Server URL and account last signed in to (the token itself is in the keyring).
    pub server: String,
    pub username: String,
    /// The admin chose not to register an everyday user from this device.
    pub onboarding_skipped: bool,
    pub volume: f32,
    /// `auto`, `original` or `data-saver`.
    pub quality: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            device_id: new_device_id(),
            server: String::new(),
            username: String::new(),
            onboarding_skipped: false,
            volume: 0.8,
            quality: "auto".into(),
        }
    }
}

fn new_device_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let mixed = nanos ^ ((std::process::id() as u128) << 64);
    format!("dev-{:024x}", mixed & ((1u128 << 96) - 1))
}

fn path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("hyperplayer").join("settings.json"))
}

impl Settings {
    /// Loads settings, creating (and saving) a device id on first run.
    pub fn load() -> Self {
        let loaded = path()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok());
        match loaded {
            Some(s) if !s.device_id.is_empty() => s,
            _ => {
                let s = Settings::default();
                s.save();
                s
            }
        }
    }

    pub fn save(&self) {
        let Some(p) = path() else { return };
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(self)
            && let Err(e) = fs::write(&p, json)
        {
            eprintln!("saving {}: {e}", p.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_ids_match_the_server_pattern() {
        let id = new_device_id();
        assert!(id.len() >= 8 && id.len() <= 64);
        assert!(
            id.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "{id}"
        );
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let s: Settings = serde_json::from_str(r#"{"deviceId":"dev-1234abcd"}"#).unwrap();
        assert_eq!(s.device_id, "dev-1234abcd");
        assert_eq!(s.quality, "auto");
    }
}
