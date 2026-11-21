//! Playback: streams for the current track, and the server-side queue that decides what's current.

use std::{
    thread,
    time::{Duration, Instant},
};

use hyperplayer::{
    adaptive::{self, Mode, Quality},
    api::{Api, types},
    pipeline::{BufferedSource, PipelineHandle},
    playback, replaygain,
    stream::StreamHandle,
    tr,
};
use slint::SharedString;

use super::{
    App, Page, RepeatMode, background,
    browse::fetch_now_playing,
    current_entry_id, current_track,
    library::sync_queue_ui,
    models::{fmt_duration, search_track_model, track_model},
    set_status, with_app,
};

/// The stream currently feeding the audio device.
pub struct Session {
    pub track: types::Track,
    pub quality: Quality,
    pub pipeline: PipelineHandle,
    pub stream: StreamHandle,
    /// Position of the pipeline's zero point within the track.
    pub offset: Duration,
    /// The ReplayGain currently applied.
    pub gain: replaygain::Applied,
    /// Where playback stops: the trimmed end, or the track's length.
    pub end: Duration,
}

impl Session {
    fn new(
        track: types::Track,
        opened: playback::Opened,
        from: Duration,
    ) -> (Self, BufferedSource) {
        let mut s = Session {
            end: Duration::ZERO,
            track,
            quality: opened.quality,
            pipeline: opened.pipeline,
            stream: opened.stream,
            offset: opened.offset,
            gain: replaygain::Applied::UNITY,
        };
        s.bound(from);
        (s, opened.source)
    }

    pub fn position(&self) -> Duration {
        self.offset + self.pipeline.position()
    }

    fn length(&self) -> Duration {
        Duration::from_millis(self.track.duration_ms.max(0) as u64)
    }

    /// Ends playback at the track's trimmed end, unless playing from beyond it (`from`:
    /// someone sought there, so they want to hear it).
    pub fn bound(&mut self, from: Duration) {
        let length = self.length();
        self.pipeline
            .set_expected_end(length.saturating_sub(self.offset));
        let end = trim_end(&self.track).filter(|&e| e > from);
        self.pipeline
            .set_end(end.map(|e| e.saturating_sub(self.offset)));
        self.end = end.unwrap_or(length);
    }
}

/// Where `track` starts playing: after any silence trimmed off its start.
pub fn trim_start(track: &types::Track) -> Duration {
    let ms = track.trim.as_ref().and_then(|t| t.start_ms).unwrap_or(0);
    Duration::from_millis(ms.max(0) as u64)
}

/// Where `track` stops playing, if its end is trimmed.
pub fn trim_end(track: &types::Track) -> Option<Duration> {
    let ms = track.trim.as_ref()?.end_ms?;
    Some(Duration::from_millis(ms.get()))
}

/// Crossfade settings, from the user's preferences.
#[derive(Clone, Copy, Default)]
pub struct Crossfade {
    pub seconds: u32,
    /// Also when skipping, not only when a track ends.
    pub on_skip: bool,
    /// Also between tracks of an album playing in order.
    pub albums: bool,
}

impl Crossfade {
    fn length(&self) -> Duration {
        Duration::from_secs(self.seconds.into())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.pipeline.stop();
        self.stream.cancel();
    }
}

/// The queue's next track, already in the mixer and gated to start on the sample
/// the current one ends (gapless playback).
pub struct Preload {
    entry_id: String,
    pub(super) session: Session,
}

/// How long before the current track's end the next one starts opening.
const PRELOAD_BEFORE: Duration = Duration::from_secs(20);

/// What to do once a queue operation's new state has arrived.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Then {
    /// Start the (new) current track from the beginning.
    Play,
    /// Start it only if the current entry changed (e.g. the playing entry was removed).
    PlayIfChanged,
    /// Just update the display.
    Show,
    /// Playback already moved on to the preloaded track: start the current one only
    /// if the server disagrees about what that is.
    Continue,
}

/// Runs a queue operation on the server and applies the returned state.
/// Responses are applied in request order; a late reply to an older request is dropped.
pub fn queue_op(
    then: Then,
    op: impl FnOnce(&Api) -> anyhow::Result<types::QueueState> + Send + 'static,
) {
    let (api, seq) = with_app(|app| {
        app.queue_seq += 1;
        (app.api.clone(), app.queue_seq)
    });
    background(
        move || op(&api),
        move |state| {
            let play = with_app(|app| {
                if seq < app.queue_applied {
                    return false;
                }
                app.queue_applied = seq;
                let before = current_entry_id(app);
                app.resume_at = Duration::from_millis(state.position_ms.max(0) as u64);
                app.queue = Some(state);
                sync_queue_ui(app);
                match then {
                    Then::Play => true,
                    Then::PlayIfChanged => before != current_entry_id(app),
                    Then::Show => false,
                    Then::Continue => {
                        current_track(app).map(|t| &t.id)
                            != app.session.as_ref().map(|s| &s.track.id)
                    }
                }
            });
            if play {
                play_current(Duration::ZERO);
            }
        },
    );
}

/// Starts the queue's current track at `start`, or stops when nothing is current.
pub fn play_current(start: Duration) {
    // A track from the queue takes over from a station.
    super::radio::leave();
    let Some(track) = with_app(|app| current_track(app).cloned()) else {
        stop();
        return;
    };
    // From the top: after any silence trimmed off.
    let start = if start.is_zero() {
        trim_start(&track)
    } else {
        start
    };
    refresh_playing_marks();
    let quality = with_app(|app| {
        app.resume_at = Duration::ZERO;
        super::history::begin(app, &track);
        adaptive::choose(&track, app.mode, app.bandwidth.get())
    });
    start_stream(track.clone(), quality, start, false);
    let source = with_app(|app| {
        app.np_polls = 0;
        playing_source(app)
    });
    show(source);
    fetch_now_playing(track.id.to_string());
}

pub fn stop() {
    // Signing out or switching library stops a station too.
    super::radio::leave();
    with_app(|app| {
        cancel_preload(app);
        app.session = None;
        app.fading = None;
        if let Some(a) = &app.audio {
            a.stop();
        }
        app.generation += 1; // drop any stream still opening
        app.loading = false;
        if let Some(ui) = app.ui.upgrade() {
            ui.set_playing(false);
        }
    });
    refresh_playing_marks();
}

pub fn play_from(source: types::TrackSource, start: usize, shuffle: Option<bool>) {
    queue_op(Then::Play, move |api| api.set_queue(source, start, shuffle));
}

pub fn next(auto: bool) {
    // A station has no next: "back to the queue" leads there.
    if with_app(|app| super::radio::is_live(app)) {
        return;
    }
    queue_op(Then::Play, move |api| api.advance_queue(auto));
}

pub fn previous() {
    if with_app(|app| super::radio::is_live(app)) {
        return;
    }
    // Like most players: restart the track unless we're at its very beginning.
    let restart = with_app(|app| {
        app.session
            .as_ref()
            .is_some_and(|s| s.position() > Duration::from_secs(3))
    });
    if restart {
        seek_to(Duration::ZERO);
    } else {
        queue_op(Then::Play, |api| api.rewind_queue());
    }
}

/// The shuffle button. On draws from the user's scope around the playing track; with
/// nothing playing, the server picks one to start, so play it if the current entry changed.
pub fn toggle_shuffle() {
    let on = with_app(|app| !app.queue.as_ref().is_some_and(|q| q.shuffle));
    queue_op(Then::PlayIfChanged, move |api| api.set_shuffle(on));
}

/// A choice in the shuffle button's menu: saved to the account, then shuffle (re)draws from it.
pub fn set_shuffle_scope(scope: SharedString) {
    with_app(|app| {
        if let Some(ui) = app.ui.upgrade() {
            ui.set_shuffle_scope(scope.clone());
        }
    });
    queue_op(Then::PlayIfChanged, move |api| {
        api.update_preferences(serde_json::json!({ "shuffleScope": scope.as_str() }))?;
        api.set_shuffle(true)
    });
}

pub fn cycle_repeat() {
    let next = with_app(|app| match app.queue.as_ref().map(|q| q.repeat) {
        Some(types::RepeatMode::All) => types::RepeatMode::One,
        Some(types::RepeatMode::One) => types::RepeatMode::Off,
        _ => types::RepeatMode::All,
    });
    queue_op(Then::Show, move |api| api.set_repeat(next));
}

/// Play/pause; with nothing loaded, resumes the saved queue or plays the album on screen.
pub fn toggle_play() {
    if super::radio::toggle() {
        return;
    }
    enum Do {
        Toggled,
        /// From the saved position.
        Resume(Duration),
        PlayAlbum(String),
        Nothing,
    }
    let what = with_app(|app| match &app.audio {
        Some(a) if app.session.is_some() => {
            if let Err(e) = a.toggle() {
                set_status(app, &format!("{e:#}"));
            }
            if a.is_paused() {
                save_position(app);
            }
            Do::Toggled
        }
        _ if current_track(app).is_some() => Do::Resume(app.resume_at),
        _ => app.album_id.clone().map_or(Do::Nothing, Do::PlayAlbum),
    });
    match what {
        Do::Resume(at) => play_current(at),
        Do::PlayAlbum(id) => play_from(
            types::TrackSource::Album {
                id: id.as_str().try_into().expect("album id"),
            },
            0,
            None,
        ),
        Do::Toggled | Do::Nothing => {}
    }
}

/// Saves the playback position on the server (fire and forget), for resuming later.
pub fn save_position(app: &mut App) {
    let Some(pos) = app.session.as_ref().map(|s| s.position()) else {
        return;
    };
    app.last_saved = Instant::now();
    let api = app.api.clone();
    thread::spawn(move || {
        if let Err(e) = api.save_position(pos) {
            eprintln!("saving position: {e:#}");
        }
    });
}

/// Opens `track` at `quality` from `start` and swaps it in when ready. With
/// `follow`, the stream replaces one of the same track that kept playing while it
/// opened, and resumes from wherever that one got to rather than jumping back.
pub fn start_stream(track: types::Track, quality: Quality, start: Duration, follow: bool) {
    let (api, mode, generation) = with_app(|app| {
        app.generation += 1;
        app.loading = true;
        (app.api.clone(), app.mode, app.generation)
    });
    let title = track.title.clone();
    thread::spawn(move || {
        let opened = playback::open(&api, &track, mode, quality, start);
        let _ = slint::invoke_from_event_loop(move || {
            with_app(|app| {
                if app.generation != generation {
                    // Superseded by a newer request; dropping `opened` stops its threads.
                    return;
                }
                app.loading = false;
                let opened = match opened {
                    Ok(o) => o,
                    Err(err) => {
                        return set_status(
                            app,
                            &tr!("Cannot play {}: {}", title, format!("{err:#}")),
                        );
                    }
                };
                let Some(audio) = &app.audio else {
                    return set_status(app, tr!("No audio output device"));
                };
                if let Some(kbps) = opened.measured_kbps {
                    app.bandwidth.update(kbps);
                }
                if follow && let Some(old) = app.session.as_ref().filter(|s| s.track.id == track.id)
                {
                    let new = opened.offset + opened.pipeline.position();
                    opened.pipeline.skip(old.position().saturating_sub(new));
                }
                // The output's queued track was gated on the stream being replaced.
                app.preload = None;
                app.preload_tried = None;
                let fade = skip_crossfade(app, &track, opened.pipeline.sample_rate(), follow);
                let (session, source) = Session::new(track, opened, start);
                let played = match fade {
                    Some(fade) => {
                        if let Some(old) = &app.session {
                            old.pipeline.fade_out_now(fade);
                        }
                        session.pipeline.set_fade_in(fade);
                        audio.crossfade_to(source)
                    }
                    None => audio.play(source),
                };
                // With a crossfade the old stream plays on while it fades out, then it's
                // dropped; without, it's dropped now (and any older one fading with it).
                let old = app.session.take();
                app.fading = if fade.is_some() { old } else { None };
                if let Err(e) = played {
                    app.session = None;
                    return set_status(app, &tr!("Cannot play {}: {}", title, format!("{e:#}")));
                }
                app.monitor.reset();
                app.session = Some(session);
                apply_replaygain(app);
            })
        });
    });
}

/// How long to crossfade from the playing track into `track` (a skip, not a track
/// ending), if at all: only when that's wanted, it's another track at the same sample
/// rate, and the playing one is audible.
fn skip_crossfade(app: &App, track: &types::Track, rate: u32, follow: bool) -> Option<Duration> {
    let c = app.crossfade;
    let old = app.session.as_ref()?;
    let playing = app.audio.as_ref().is_some_and(|a| !a.is_paused());
    (c.on_skip
        && c.seconds > 0
        && !follow
        && playing
        && old.track.id != track.id
        && old.pipeline.sample_rate() == rate
        && !old.pipeline.finished())
    .then(|| c.length())
}

/// How long the playing track (`current`) and the next one (`next`, at `rate`)
/// overlap when one follows the other: no longer than half of either, and not at
/// all at different sample rates or, unless wanted, within an album playing in order.
fn auto_crossfade(app: &App, current: &Session, next: &types::Track, rate: u32) -> Duration {
    let c = app.crossfade;
    let shuffled = app.queue.as_ref().is_some_and(|q| q.shuffle);
    let album_in_order = !shuffled && current.track.album_id == next.album_id;
    if c.seconds == 0 || current.pipeline.sample_rate() != rate || (album_in_order && !c.albums) {
        return Duration::ZERO;
    }
    let next_length = trim_end(next)
        .unwrap_or(Duration::from_millis(next.duration_ms.max(0) as u64))
        .saturating_sub(trim_start(next));
    let current_length = current.end.saturating_sub(trim_start(&current.track));
    c.length().min(next_length / 2).min(current_length / 2)
}

pub fn fmt_kbps(kbps: f64) -> String {
    if kbps >= 1000.0 {
        format!("{:.1} Mbit/s", kbps / 1000.0)
    } else {
        format!("{kbps:.0} kbit/s")
    }
}

/// The ReplayGain to play `track` with, given the mode and queue context.
fn gain_for(app: &App, track: &types::Track) -> replaygain::Applied {
    // "Album in order": the queue was started from an album and isn't shuffled.
    let in_album_order = app.queue.as_ref().is_some_and(|q| {
        !q.shuffle
            && q.origin
                .as_ref()
                .is_some_and(|o| o.kind == types::QueueOriginKind::Album)
    });
    // The track's own volume adjustment goes on top, by itself when ReplayGain applies nothing.
    let volume = track.volume_db as f32;
    let applied = replaygain::compute(
        &track.replay_gain,
        app.rg_mode,
        in_album_order,
        app.rg_preamp + volume,
    );
    if matches!(applied.basis, replaygain::Basis::None) && volume != 0.0 {
        return replaygain::Applied {
            db: volume,
            linear: 10f32.powf(volume / 20.0),
            ..applied
        };
    }
    applied
}

/// (Re)computes the current (and preloaded) track's ReplayGain, and applies it.
pub fn apply_replaygain(app: &mut App) {
    if let Some(p) = &app.preload {
        p.session
            .pipeline
            .set_gain(gain_for(app, &p.session.track).linear);
    }
    if let Some(gain) = app.session.as_ref().map(|s| gain_for(app, &s.track))
        && let Some(s) = app.session.as_mut()
    {
        s.gain = gain;
        s.pipeline.set_gain(gain.linear);
    }
    update_stream_info(app);
}

fn up_next(app: &App) -> Option<&types::QueueEntry> {
    let q = app.queue.as_ref()?;
    q.entries.get(usize::try_from(q.up_next?).ok()?)
}

fn cancel_preload(app: &mut App) {
    app.preload = None;
    app.preload_tried = None;
    // Nothing to crossfade into any more.
    if let Some(s) = &app.session {
        s.pipeline.set_fade_out(Duration::ZERO);
    }
    if let Some(a) = &app.audio {
        a.cancel_next();
    }
}

/// Drops a preload the queue no longer leads to (e.g. tracks were added or shuffle changed).
pub fn revalidate_preload(app: &mut App) {
    let next = up_next(app).map(|e| e.entry_id.to_string());
    let wanted = |id: &String| next.as_ref() == Some(id);
    if app.preload.as_ref().is_some_and(|p| !wanted(&p.entry_id)) {
        cancel_preload(app);
    }
    if app
        .preload_tried
        .as_ref()
        .is_some_and(|(_, id)| !wanted(id))
    {
        app.preload_tried = None;
    }
}

/// Once the current track nears its end, opens the next one and queues it on the
/// output behind the current stream, so it starts on the very sample this one ends.
fn maybe_preload(app: &mut App) {
    let Some(s) = &app.session else { return };
    let before = PRELOAD_BEFORE + app.crossfade.length();
    if app.loading || s.end.saturating_sub(s.position()) > before {
        return;
    }
    let Some(entry) = up_next(app) else { return };
    let key = (app.generation, entry.entry_id.to_string());
    if app.preload_tried.as_ref() == Some(&key) {
        return; // done, in progress, or failed (then the track starts normally at the end)
    }
    let track = entry.track.clone();
    super::visuals::prefetch(app, track.id.to_string());
    let quality = adaptive::choose(&track, app.mode, app.bandwidth.get());
    let (api, mode) = (app.api.clone(), app.mode);
    app.preload_tried = Some(key.clone());
    let start = trim_start(&track);
    thread::spawn(move || {
        let opened = playback::open(&api, &track, mode, quality, start);
        let _ = slint::invoke_from_event_loop(move || {
            with_app(|app| {
                // Superseded: another stream started, or the queue changed meanwhile.
                if app.preload_tried.as_ref() != Some(&key) {
                    return;
                }
                let opened = match opened {
                    Ok(o) => o,
                    Err(e) => return eprintln!("preloading {}: {e:#}", track.title),
                };
                let (Some(audio), Some(current)) = (&app.audio, &app.session) else {
                    return;
                };
                let overlap = auto_crossfade(app, current, &track, opened.pipeline.sample_rate());
                let gain = gain_for(app, &track);
                let (mut session, mut source) = Session::new(track, opened, start);
                source.play_after(&current.pipeline, overlap);
                if !overlap.is_zero() {
                    current.pipeline.set_fade_out(overlap);
                    session.pipeline.set_fade_in(overlap);
                }
                session.gain = gain;
                session.pipeline.set_gain(gain.linear);
                audio.queue_next(source);
                app.preload = Some(Preload {
                    entry_id: key.1,
                    session,
                });
            })
        });
    });
}

/// The current track ended and the preloaded one has already taken over in the
/// output: make it current here, then tell the server. Returns false without a preload.
fn promote_preload() -> bool {
    let promoted = with_app(|app| {
        let p = app.preload.take()?;
        if let Some(a) = &app.audio
            && let Err(e) = a.promote_next()
        {
            set_status(app, &format!("{e:#}"));
        }
        let id = p.session.track.id.to_string();
        super::history::begin(app, &p.session.track);
        // Plays on while it fades out (a crossfade), then it's dropped.
        app.fading = app.session.replace(p.session);
        app.generation += 1;
        app.preload_tried = None;
        app.monitor.reset();
        app.np_polls = 0;
        // Optimistically, so the display follows at once; the server's reply confirms it.
        if let Some(q) = app.queue.as_mut()
            && let Some(i) = q.entries.iter().position(|e| *e.entry_id == p.entry_id)
        {
            q.index = Some(i as i64);
            q.up_next = None;
            q.position_ms = 0;
        }
        sync_queue_ui(app);
        Some((id, playing_source(app)))
    });
    let Some((id, source)) = promoted else {
        return false;
    };
    show(source);
    refresh_playing_marks();
    fetch_now_playing(id);
    queue_op(Then::Continue, |api| api.advance_queue(true));
    true
}

pub fn update_stream_info(app: &App) {
    let Some(ui) = app.ui.upgrade() else { return };
    super::settings::show_preferences(app, &ui);
    ui.set_quality_mode(app.mode.label().into());
    ui.set_replaygain_mode(format!("RG {}", app.rg_mode.name().to_uppercase()).into());
    // A station shows its own (see radio.rs).
    if super::radio::is_live(app) {
        return;
    }
    let info = match &app.session {
        Some(s) => {
            let mut parts = vec![s.quality.label(&s.track)];
            if let Some(kbps) = s.stream.stats().throughput_kbps.or(app.bandwidth.get()) {
                parts.push(fmt_kbps(kbps));
            }
            let rg = s.gain.label();
            if !rg.is_empty() {
                parts.push(rg);
            }
            parts.join(" · ")
        }
        None => String::new(),
    };
    ui.set_stream_info(info.into());
}

/// Seeks within the current track: a byte-range seek for originals, a restarted
/// transcode for everything else.
pub fn seek_to(target: Duration) {
    let action = with_app(|app| {
        let s = app.session.as_ref()?;
        Some(if s.quality.seekable() {
            Err((s.pipeline.clone(), app.generation))
        } else {
            Ok((s.track.clone(), s.quality))
        })
    });
    match action {
        Some(Err((pipeline, generation))) => {
            // Past the trimmed end: play on to the file's end.
            with_app(|app| {
                super::trim::note_seek(app, target);
                if let Some(s) = app.session.as_mut() {
                    s.bound(target);
                }
            });
            // May wait for the network: never on the UI thread.
            thread::spawn(move || {
                if pipeline.seek(target, Duration::from_secs(15)) {
                    return;
                }
                // The stream can't get there (its download failed): open a fresh one there.
                let _ = slint::invoke_from_event_loop(move || {
                    let reopen = with_app(|app| {
                        let s = app
                            .session
                            .as_ref()
                            .filter(|_| app.generation == generation)?;
                        eprintln!("seek: failed in the stream; reopening {}", s.track.title);
                        Some((s.track.clone(), s.quality))
                    });
                    if let Some((track, quality)) = reopen {
                        start_stream(track, quality, target, false);
                    }
                });
            });
        }
        Some(Ok((track, quality))) => start_stream(track, quality, target, false),
        None => {}
    }
}

/// Feeds the adaptive monitor and returns a switch to perform, if any.
pub fn adapt(app: &mut App) -> Option<(types::Track, Quality, Duration)> {
    let s = app.session.as_ref()?;
    let stats = s.stream.stats();
    let underrun = s.pipeline.take_underrun();
    let auto = app.mode == Mode::Auto && !app.loading;
    let target = app
        .monitor
        .check(&s.track, s.quality, auto, &stats, underrun)?;
    if let Some(k) = stats.throughput_kbps {
        app.bandwidth.update(k);
    }
    Some((s.track.clone(), target, s.position()))
}

/// Where the current track plays from, to show in the panel.
enum Source {
    Playlist(String),
    Album(String),
}

/// The playlist the queue was started from, otherwise the current track's album;
/// `None` when it's on screen already, or the lyrics or the queue are (they follow
/// the playing track themselves).
fn playing_source(app: &App) -> Option<Source> {
    let ui = app.ui.upgrade()?;
    if matches!(ui.get_page(), Page::Lyrics | Page::Queue) {
        return None;
    }
    let playlist = app
        .queue
        .as_ref()
        .and_then(|q| q.origin.as_ref())
        .filter(|o| o.kind == types::QueueOriginKind::Playlist)
        .and_then(|o| o.id.as_ref())
        .map(|id| id.to_string());
    if let Some(id) = playlist {
        let shown = ui.get_page() == Page::Playlist && ui.get_selected_playlist_id() == id.as_str();
        return (!shown).then_some(Source::Playlist(id));
    }
    let album = current_track(app)?.album_id.to_string();
    let shown = ui.get_page() == Page::Album && app.album_id.as_deref() == Some(album.as_str());
    (!shown).then_some(Source::Album(album))
}

/// Switches the panel to `source` (outside `with_app`: loading it borrows the app).
fn show(source: Option<Source>) {
    match source {
        Some(Source::Playlist(id)) => super::library::select_playlist(id.into()),
        Some(Source::Album(id)) => super::browse::select_album(id.into()),
        None => {}
    }
}

pub fn refresh_playing_marks() {
    with_app(|app| {
        let Some(ui) = app.ui.upgrade() else { return };
        // While a station plays, no track is.
        let playing = super::playing_track(app).map(|t| t.id.to_string());
        ui.set_album_tracks(track_model(&app.album_tracks, playing.as_deref()));
        ui.set_search_tracks(search_track_model(&app.search_tracks, playing.as_deref()));
        super::library::refresh_playlist_playing(app, &ui, playing.as_deref());
        super::history::refresh_playing(app, &ui);
        super::marks::refresh_playing(app, &ui);
    });
}

/// What the tick found to do after it returns the app.
enum Switch {
    /// The track's stream changes quality.
    Quality(Box<(types::Track, Quality, Duration)>),
    /// The station's stream stopped: connect again.
    Reconnect,
}

/// Saving more often than this while playing would only add load; pausing and quitting save immediately.
const SAVE_EVERY: Duration = Duration::from_secs(10);

pub fn tick() {
    let (finished, switch) = with_app(|app| {
        let Some(ui) = app.ui.upgrade() else {
            return (false, None);
        };
        if app.fading.as_ref().is_some_and(|f| f.pipeline.finished()) {
            app.fading = None;
        }
        let paused = app.audio.as_ref().is_none_or(|a| a.is_paused());
        super::window::sync(&ui);
        if super::radio::is_live(app) {
            ui.set_playing(super::radio::is_playing(app));
            super::desktop::sync(app);
            return (
                false,
                super::radio::tick(app, &ui).then_some(Switch::Reconnect),
            );
        }
        super::trim::show(app);
        ui.set_playing((app.session.is_some() && !paused) || app.loading);
        super::desktop::sync(app);
        let Some(s) = &app.session else {
            return (false, None);
        };
        let pos = s.position();
        ui.set_position(pos.as_secs_f32());
        ui.set_position_text(fmt_duration(pos.as_millis() as i64).into());
        // The next track has started (crossfading in, or on the sample this one ended).
        let next_started = app
            .preload
            .as_ref()
            .is_some_and(|p| p.session.pipeline.started());
        let finished = !app.loading && (s.pipeline.finished() || next_started);
        super::lyrics::follow(app, pos);
        super::history::follow(app, pos, !paused);
        update_stream_info(app);
        if !paused && app.last_saved.elapsed() > SAVE_EVERY {
            save_position(app);
        }
        let switch = adapt(app);
        if switch.is_none() {
            maybe_preload(app);
        }
        (finished, switch.map(|s| Switch::Quality(Box::new(s))))
    });
    if let Some(Switch::Reconnect) = switch {
        super::radio::reconnect();
    } else if let Some(Switch::Quality(change)) = switch {
        let (track, quality, at) = *change;
        start_stream(track, quality, at, true);
    } else if finished && !promote_preload() {
        // Close the output until the next track (if any) starts.
        with_app(|app| {
            app.session = None;
            if let Some(a) = &app.audio {
                a.stop();
            }
        });
        next(true);
    }
}

pub fn repeat_mode(r: types::RepeatMode) -> RepeatMode {
    match r {
        types::RepeatMode::Off => RepeatMode::Off,
        types::RepeatMode::All => RepeatMode::All,
        types::RepeatMode::One => RepeatMode::One,
    }
}
