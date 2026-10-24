//! Desktop media integration: MPRIS on Linux (media keys, headset buttons, the
//! GNOME/KDE media widgets), and the equivalent system controls elsewhere.

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};

use slint::ComponentHandle;

use super::{App, current_track, playback, with_app};

/// Arrow-key-sized step for "seek" requests that don't say how far.
const SEEK_STEP: Duration = Duration::from_secs(10);
/// Position drift (e.g. after a seek) beyond which the desktop is told the new position.
const DRIFT: Duration = Duration::from_millis(1500);

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Stopped,
    Paused,
    Playing,
}

pub struct Desktop {
    controls: MediaControls,
    /// Track id whose metadata was last published (with or without its cover yet).
    track: Option<String>,
    state: State,
    /// Position last published and when, to detect seeks by drift.
    published: (Duration, Instant),
}

/// Windows: registers once our window exists (asking again every 250 ms, for up to 10 s).
#[cfg(windows)]
pub fn start_when_window_exists(attempt: u32) {
    match super::window::native_handle() {
        Some(hwnd) => {
            let media = start(Some(hwnd));
            with_app(|app| app.desktop = media);
        }
        None if attempt < 40 => slint::Timer::single_shot(Duration::from_millis(250), move || {
            start_when_window_exists(attempt + 1)
        }),
        None => eprintln!("media controls unavailable: the window has no handle"),
    }
}

/// Registers with the desktop; returns None where no media service is available.
/// Windows ties the controls to our window (`hwnd`); elsewhere it's None.
pub fn start(hwnd: Option<*mut std::ffi::c_void>) -> Option<Desktop> {
    // Windows' controls can't exist without the window (souvlaki panics).
    if cfg!(windows) && hwnd.is_none() {
        return None;
    }
    let config = PlatformConfig {
        display_name: "HyperPlayer",
        dbus_name: "hyperplayer",
        hwnd,
    };
    let mut controls = match MediaControls::new(config) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("media controls unavailable: {e:?}");
            return None;
        }
    };
    // Events arrive on a D-Bus thread; handle them on the UI thread.
    let attached = controls.attach(|event| {
        let _ = slint::invoke_from_event_loop(move || handle(event));
    });
    if let Err(e) = attached {
        eprintln!("media controls unavailable: {e:?}");
        return None;
    }
    Some(Desktop {
        controls,
        track: None,
        state: State::Stopped,
        published: (Duration::ZERO, Instant::now()),
    })
}

fn is_playing() -> bool {
    with_app(|app| app.session.is_some() && app.audio.as_ref().is_some_and(|a| !a.is_paused()))
}

fn handle(event: MediaControlEvent) {
    match event {
        MediaControlEvent::Toggle => playback::toggle_play(),
        MediaControlEvent::Play if !is_playing() => playback::toggle_play(),
        MediaControlEvent::Pause | MediaControlEvent::Stop if is_playing() => {
            playback::toggle_play()
        }
        MediaControlEvent::Next => playback::next(false),
        MediaControlEvent::Previous => playback::previous(),
        MediaControlEvent::Seek(dir) => super::seek_by(signed(dir, SEEK_STEP)),
        MediaControlEvent::SeekBy(dir, by) => super::seek_by(signed(dir, by)),
        MediaControlEvent::SetPosition(MediaPosition(to)) => playback::seek_to(to),
        MediaControlEvent::SetVolume(v) => super::set_volume(v.clamp(0.0, 1.0) as f32),
        MediaControlEvent::Raise => with_app(|app| {
            if let Some(ui) = app.ui.upgrade() {
                let _ = ui.show();
            }
        }),
        MediaControlEvent::Quit => {
            let _ = slint::quit_event_loop();
        }
        _ => {}
    }
}

fn signed(dir: SeekDirection, by: Duration) -> f64 {
    match dir {
        SeekDirection::Forward => by.as_secs_f64(),
        SeekDirection::Backward => -by.as_secs_f64(),
    }
}

/// Called from the playback tick: publishes what changed since last time.
pub fn sync(app: &mut App) {
    let track = current_track(app).cloned();
    let playing = app.session.is_some() && app.audio.as_ref().is_some_and(|a| !a.is_paused());
    let position = app
        .session
        .as_ref()
        .map(|s| s.position())
        .unwrap_or(app.resume_at);
    let state = match (&track, app.session.is_some(), playing) {
        (None, _, _) => State::Stopped,
        (Some(_), _, true) => State::Playing,
        (Some(_), _, false) => State::Paused,
    };
    let api = app.api.clone();
    let Some(desktop) = app.desktop.as_mut() else {
        return;
    };

    let track_id = track.as_ref().map(|t| t.id.to_string());
    let new_track = track_id != desktop.track;
    if new_track {
        desktop.track = track_id;
        match &track {
            Some(t) => {
                publish_metadata(desktop, t, None);
                // The desktop can't fetch our authenticated artwork URLs: hand it a local file.
                if let Some(cover) = t.cover.as_ref() {
                    let (artwork, id) = (cover.id.to_string(), t.id.to_string());
                    std::thread::spawn(move || {
                        let file = cached_cover(&api, &artwork);
                        let _ = slint::invoke_from_event_loop(move || {
                            let (Some(file), Some(t)) =
                                (file, with_app(|app| current_track(app).cloned()))
                            else {
                                return;
                            };
                            if t.id.as_str() != id {
                                return;
                            }
                            with_app(|app| {
                                if let Some(d) = app.desktop.as_mut() {
                                    publish_metadata(d, &t, Some(&file));
                                }
                            });
                        });
                    });
                }
            }
            None => {
                let _ = desktop.controls.set_metadata(MediaMetadata::default());
            }
        }
    }

    let (last_pos, at) = desktop.published;
    let expected = if desktop.state == State::Playing {
        last_pos + at.elapsed()
    } else {
        last_pos
    };
    let drifted = position.abs_diff(expected) > DRIFT;
    if new_track || state != desktop.state || drifted {
        let progress = Some(MediaPosition(position));
        let playback = match state {
            State::Stopped => MediaPlayback::Stopped,
            State::Paused => MediaPlayback::Paused { progress },
            State::Playing => MediaPlayback::Playing { progress },
        };
        let _ = desktop.controls.set_playback(playback);
        desktop.state = state;
        desktop.published = (position, Instant::now());
    }
}

/// The volume, for desktops that show it (MPRIS; Windows' media controls have none).
pub fn publish_volume(app: &mut App, volume: f32) {
    #[cfg(target_os = "linux")]
    if let Some(d) = app.desktop.as_mut() {
        let _ = d.controls.set_volume(volume as f64);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, volume);
}

fn publish_metadata(
    desktop: &mut Desktop,
    t: &hyperplayer::api::types::Track,
    cover: Option<&PathBuf>,
) {
    let url = cover.map(|p| format!("file://{}", p.display()));
    let _ = desktop.controls.set_metadata(MediaMetadata {
        title: Some(&t.title),
        album: Some(&t.album_title),
        artist: Some(&t.artist_name),
        cover_url: url.as_deref(),
        duration: Some(Duration::from_millis(t.duration_ms.max(0) as u64)),
    });
}

fn cache_dir() -> Option<PathBuf> {
    Some(hyperplayer::dirs::cache_dir()?.join("covers"))
}

/// The cover as a JPEG in the cache (fetched and converted once): desktop shells
/// reliably read JPEG, not necessarily the WebP the server resizes to.
fn cached_cover(api: &hyperplayer::api::Api, artwork_id: &str) -> Option<PathBuf> {
    let dir = cache_dir()?;
    let path = dir.join(format!("{artwork_id}.jpg"));
    if path.exists() {
        return Some(path);
    }
    let bytes = api.artwork(artwork_id, 512).ok()?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgb8();
    std::fs::create_dir_all(&dir).ok()?;
    // Write then rename, so a shell never reads a half-written file.
    let tmp = dir.join(format!(".{artwork_id}.jpg.tmp"));
    img.save_with_format(&tmp, image::ImageFormat::Jpeg).ok()?;
    std::fs::rename(&tmp, &path).ok()?;
    Some(path)
}
