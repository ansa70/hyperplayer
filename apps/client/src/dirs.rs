//! Where the client keeps its files: the platform's usual places (on Linux the
//! XDG directories, `~/.config/hyperplayer` and `~/.cache/hyperplayer`).

use std::{env, path::PathBuf};

/// Settings, trusted certificates and (without a keyring) the sign-in token.
pub fn config_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        return env::var_os("APPDATA").map(|d| PathBuf::from(d).join("HyperPlayer"));
    }
    if cfg!(target_os = "macos") {
        return env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support/HyperPlayer"));
    }
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("hyperplayer"))
}

/// Files that can be made again (e.g. covers for the desktop's media controls).
pub fn cache_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        return env::var_os("LOCALAPPDATA")
            .map(|d| PathBuf::from(d).join("HyperPlayer").join("cache"));
    }
    if cfg!(target_os = "macos") {
        return env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches/HyperPlayer"));
    }
    let base = env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))?;
    Some(base.join("hyperplayer"))
}
