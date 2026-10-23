//! The Slint UI and its state. Background work (network, decoding) runs on
//! other threads and hands results back via `slint::invoke_from_event_loop`.

mod account;
mod browse;
mod desktop;
mod library;
mod lyrics;
mod models;
mod playback;

use std::{
    cell::RefCell,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use hyperplayer::{
    adaptive::{self, Bandwidth, Mode, Monitor},
    api::{Api, types},
    player::Audio,
    settings::Settings,
};
use slint::{Timer, TimerMode};

slint::include_modules!();

/// UI-thread state.
pub struct App {
    ui: slint::Weak<AppWindow>,
    api: Api,
    settings: Settings,
    audio: Option<Audio>,
    images: mpsc::Sender<models::ImageJob>,

    album_id: Option<String>,
    album_tracks: Vec<types::Track>,
    /// Bumped per keystroke; only the latest search's results are shown.
    search_seq: u64,
    search_tracks: Vec<types::Track>,
    /// Where clearing the search box / closing the queue returns to.
    page_before_search: Page,
    page_before_queue: Page,
    page_before_lyrics: Page,
    playlists: Vec<types::PlaylistSummary>,
    playlist: Option<types::Playlist>,

    /// The server's queue for this device, as last returned.
    queue: Option<types::QueueState>,
    /// Queue requests sent / applied, so a late reply can't overwrite a newer state.
    queue_seq: u64,
    queue_applied: u64,
    /// Where to resume the current track (from the server's saved position).
    resume_at: Duration,
    last_saved: Instant,

    /// True while a stream is being opened (prebuffering).
    loading: bool,
    /// Bumped whenever a new stream is requested; results for older ones are discarded.
    generation: u64,
    session: Option<playback::Session>,
    /// The queue's next track, opened and waiting behind the current one (gapless).
    preload: Option<playback::Preload>,
    /// Which (generation, entry) a preload was started for, so it's attempted once.
    preload_tried: Option<(u64, String)>,
    mode: Mode,
    bandwidth: Bandwidth,
    monitor: Monitor,
    /// Now-playing refreshes done for the current track while enrichment is pending.
    np_polls: u32,
    np_had_banner: bool,
    /// Volume to restore when unmuting.
    unmuted_volume: Option<f32>,
    /// Signed in with a default password: held here until a new one is saved.
    pending: Option<account::Pending>,
    /// Media keys and the desktop's media widget (MPRIS on Linux).
    desktop: Option<desktop::Desktop>,
    /// The playing track's lyrics once fetched, and the synced line being sung.
    lyrics: Option<types::Lyrics>,
    lyric_line: Option<usize>,
    /// ReplayGain mode and pre-amplification (dB), from the user's preferences.
    rg_mode: hyperplayer::replaygain::Mode,
    rg_preamp: f32,
}

thread_local! {
    static APP: RefCell<Option<App>> = const { RefCell::new(None) };
}

fn with_app<R>(f: impl FnOnce(&mut App) -> R) -> R {
    APP.with(|a| f(a.borrow_mut().as_mut().expect("app initialised")))
}

/// Runs `work` on a background thread and `done` with its result on the UI thread.
fn background<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
    done: impl FnOnce(T) + Send + 'static,
) {
    thread::spawn(move || match work() {
        Ok(value) => {
            let _ = slint::invoke_from_event_loop(move || done(value));
        }
        Err(err) => {
            let msg = format!("{err:#}");
            eprintln!("{msg}");
            let _ = slint::invoke_from_event_loop(move || {
                if !account::handle_error(&err) {
                    with_app(|app| set_status(app, &msg));
                }
            });
        }
    });
}

fn set_status(app: &App, msg: &str) {
    if let Some(ui) = app.ui.upgrade() {
        ui.set_status(msg.into());
    }
}

fn current_entry(app: &App) -> Option<&types::QueueEntry> {
    let q = app.queue.as_ref()?;
    q.entries.get(q.index? as usize)
}

fn current_track(app: &App) -> Option<&types::Track> {
    current_entry(app).map(|e| &e.track)
}

fn current_entry_id(app: &App) -> Option<String> {
    current_entry(app).map(|e| e.entry_id.to_string())
}

fn mode_from(name: &str) -> Mode {
    match name {
        "original" => Mode::Original,
        "data-saver" => Mode::DataSaver,
        _ => Mode::Auto,
    }
}

fn mode_name(mode: Mode) -> &'static str {
    match mode {
        Mode::Auto => "auto",
        Mode::Original => "original",
        Mode::DataSaver => "data-saver",
    }
}

pub fn run() -> anyhow::Result<()> {
    let settings = Settings::load();
    let server = account::initial_server(&settings.server);
    let token = (!settings.username.is_empty())
        .then(|| hyperplayer::credentials::load(&server, &settings.username))
        .flatten();
    let api = Api::with_token(server.clone(), token.as_deref());
    let ui = AppWindow::new()?;

    let audio = match Audio::open() {
        Ok(a) => Some(a),
        Err(err) => {
            eprintln!("audio output unavailable: {err:#}");
            None
        }
    };
    ui.set_volume(settings.volume);
    if let Some(a) = &audio {
        a.set_volume(settings.volume);
    }
    let mode = mode_from(&std::env::var("HP_QUALITY").unwrap_or_else(|_| settings.quality.clone()));

    APP.with(|cell| {
        *cell.borrow_mut() = Some(App {
            ui: ui.as_weak(),
            images: models::spawn_image_worker(),
            api,
            settings,
            audio,
            album_id: None,
            album_tracks: Vec::new(),
            search_seq: 0,
            search_tracks: Vec::new(),
            page_before_search: Page::Welcome,
            page_before_queue: Page::Welcome,
            page_before_lyrics: Page::Welcome,
            lyrics: None,
            lyric_line: None,
            playlists: Vec::new(),
            playlist: None,
            queue: None,
            queue_seq: 0,
            queue_applied: 0,
            resume_at: Duration::ZERO,
            last_saved: Instant::now(),
            loading: false,
            generation: 0,
            session: None,
            preload: None,
            preload_tried: None,
            mode,
            bandwidth: Bandwidth::default(),
            monitor: Monitor::default(),
            np_polls: 0,
            np_had_banner: false,
            unmuted_volume: None,
            pending: None,
            desktop: None,
            rg_mode: hyperplayer::replaygain::Mode::Auto,
            rg_preamp: 0.0,
        })
    });
    ui.set_status(format!("Connecting to {server}…").into());
    with_app(|app| playback::update_stream_info(app));

    // Browsing
    ui.on_select_artist(browse::select_artist);
    ui.on_select_album(browse::select_album);
    ui.on_back_to_artist(|| {
        with_app(|app| {
            if let Some(ui) = app.ui.upgrade() {
                ui.set_page(Page::Artist)
            }
        })
    });
    ui.on_search_changed(browse::search_changed);
    ui.on_search_accepted(browse::search_accepted);

    // Starting playback from a list: the server builds the queue.
    ui.on_play_track(|i| {
        if let Some(id) = with_app(|app| app.album_id.clone()) {
            playback::play_from(
                types::TrackSource::Album {
                    id: id.as_str().try_into().expect("album id"),
                },
                i as usize,
                None,
            );
        }
    });
    ui.on_play_search_track(|i| {
        let ids = with_app(|app| {
            app.search_tracks
                .iter()
                .map(|t| t.id.clone())
                .collect::<Vec<_>>()
        });
        if !ids.is_empty() {
            playback::play_from(
                types::TrackSource::Tracks { track_ids: ids },
                i as usize,
                None,
            );
        }
    });

    // Transport
    ui.on_toggle(playback::toggle_play);
    ui.on_next(|| playback::next(false));
    ui.on_prev(playback::previous);
    ui.on_toggle_shuffle(playback::toggle_shuffle);
    ui.on_cycle_repeat(playback::cycle_repeat);
    ui.on_seek(|secs| playback::seek_to(Duration::from_secs_f32(secs.max(0.0))));
    ui.on_cycle_quality_mode(|| {
        // Apply the new mode right away if it changes what should be streaming.
        let switch = with_app(|app| {
            app.mode = app.mode.next();
            app.settings.quality = mode_name(app.mode).into();
            app.settings.save();
            // The mode is a per-user preference: remember it on the server too.
            let (api, quality) = (app.api.clone(), mode_name(app.mode));
            thread::spawn(move || {
                if let Err(e) = api.set_quality_preference(quality) {
                    eprintln!("saving preference: {e:#}");
                }
            });
            playback::update_stream_info(app);
            let s = app.session.as_ref()?;
            let q = adaptive::choose(&s.track, app.mode, app.bandwidth.get());
            (q != s.quality).then(|| (s.track.clone(), q, s.position()))
        });
        if let Some((track, quality, at)) = switch {
            playback::start_stream(track, quality, at, true);
        }
    });
    ui.on_cycle_replaygain(|| {
        with_app(|app| {
            app.rg_mode = app.rg_mode.next();
            playback::apply_replaygain(app);
            let (api, mode) = (app.api.clone(), app.rg_mode.name());
            thread::spawn(move || {
                if let Err(e) = api.set_replaygain_preference(mode) {
                    eprintln!("saving preference: {e:#}");
                }
            });
        })
    });
    ui.on_volume_changed(|v| {
        with_app(|app| {
            if let Some(a) = &app.audio {
                a.set_volume(v)
            }
            app.unmuted_volume = None;
            app.settings.volume = v;
            desktop::publish_volume(app, v);
        })
    });

    ui.on_shortcut(|name| match name.as_str() {
        "seek-back" => seek_by(-SEEK_STEP),
        "seek-forward" => seek_by(SEEK_STEP),
        "toggle-mute" => toggle_mute(),
        _ => {}
    });

    // Playlists, queue, menus
    ui.on_select_playlist(library::select_playlist);
    ui.on_new_playlist(library::new_playlist);
    ui.on_play_playlist(library::play_playlist);
    ui.on_shuffle_playlist(library::shuffle_playlist);
    ui.on_rename_playlist(library::rename_playlist);
    ui.on_delete_playlist(library::delete_playlist);
    ui.on_track_action(library::track_action);
    ui.on_album_action(library::album_action);
    ui.on_show_queue(library::show_queue);
    ui.on_show_lyrics(lyrics::toggle_page);
    ui.on_seek_lyric_line(lyrics::seek_to_line);
    ui.on_jump_in_queue(library::jump_in_queue);
    ui.on_clear_queue(library::clear_queue);

    let media = desktop::start();
    with_app(|app| app.desktop = media);

    let timer = Timer::default();
    timer.start(
        TimerMode::Repeated,
        Duration::from_millis(250),
        playback::tick,
    );

    ui.on_login_submit(account::submit);
    ui.on_login_check_server(account::check_server);
    ui.on_login_change_password(account::change_password);
    ui.on_login_onboard(account::onboard);
    ui.on_login_skip_onboarding(account::skip_onboarding);
    ui.on_sign_out(account::sign_out);
    account::begin(token.is_some());

    ui.run()?;

    // Quitting: remember where we were (blocking, the event loop is gone).
    let (api, position, settings) = with_app(|app| {
        (
            app.api.clone(),
            app.session.as_ref().map(|s| s.position()),
            app.settings.clone(),
        )
    });
    settings.save();
    if let Some(pos) = position
        && let Err(e) = api.save_position(pos)
    {
        eprintln!("saving position: {e:#}");
    }
    Ok(())
}

/// Arrow-key seek distance, in seconds.
const SEEK_STEP: f64 = 10.0;

pub(super) fn seek_by(delta: f64) {
    let target = with_app(|app| {
        let s = app.session.as_ref()?;
        let end = s.track.duration_ms as f64 / 1000.0;
        // Stop just short of the end, so seeking forward never skips the track outright.
        Some((s.position().as_secs_f64() + delta).clamp(0.0, (end - 1.0).max(0.0)))
    });
    if let Some(t) = target {
        playback::seek_to(Duration::from_secs_f64(t));
    }
}

/// Sets the volume from outside the slider (desktop media controls).
pub(super) fn set_volume(volume: f32) {
    with_app(|app| {
        if let Some(ui) = app.ui.upgrade() {
            ui.set_volume(volume);
        }
        if let Some(a) = &app.audio {
            a.set_volume(volume);
        }
        app.unmuted_volume = None;
        app.settings.volume = volume;
    });
}

fn toggle_mute() {
    with_app(|app| {
        let Some(ui) = app.ui.upgrade() else { return };
        let volume = match app.unmuted_volume.take() {
            Some(previous) => previous,
            None => {
                app.unmuted_volume = Some(ui.get_volume());
                0.0
            }
        };
        ui.set_volume(volume);
        if let Some(a) = &app.audio {
            a.set_volume(volume);
        }
    });
}

/// Once the saved queue has loaded, show its current track in the player (paused).
pub(super) fn restore_now_playing_when_ready() {
    Timer::single_shot(Duration::from_millis(200), || {
        let state = with_app(|app| {
            app.queue.as_ref()?;
            Some(current_track(app).map(|t| (t.id.to_string(), t.duration_ms, app.resume_at)))
        });
        match state {
            None => restore_now_playing_when_ready(), // not loaded yet
            Some(None) => {}
            Some(Some((id, duration_ms, at))) => {
                with_app(|app| {
                    if let Some(ui) = app.ui.upgrade() {
                        ui.set_duration(duration_ms as f32 / 1000.0);
                        ui.set_position(at.as_secs_f32());
                        ui.set_position_text(models::fmt_duration(at.as_millis() as i64).into());
                    }
                });
                browse::fetch_now_playing(id);
            }
        }
    });
}
