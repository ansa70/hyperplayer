//! Playback: streams for the current track, and the server-side queue that decides what's current.

use std::{
    thread,
    time::{Duration, Instant},
};

use hyperplayer::{
    adaptive::{self, Mode, Quality},
    api::{Api, types},
    pipeline::PipelineHandle,
    playback, replaygain,
    stream::StreamHandle,
};

use super::{
    App, RepeatMode, background,
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
}

impl Session {
    pub fn position(&self) -> Duration {
        self.offset + self.pipeline.position()
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
    session: Session,
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
                        current_track(app).map(|t| &t.id) != app.session.as_ref().map(|s| &s.track.id)
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
    let Some(track) = with_app(|app| current_track(app).cloned()) else {
        stop();
        return;
    };
    refresh_playing_marks();
    let quality = with_app(|app| {
        app.resume_at = Duration::ZERO;
        adaptive::choose(&track, app.mode, app.bandwidth.get())
    });
    start_stream(track.clone(), quality, start, false);
    with_app(|app| app.np_polls = 0);
    fetch_now_playing(track.id.to_string());
}

pub fn stop() {
    with_app(|app| {
        cancel_preload(app);
        app.session = None;
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
    queue_op(Then::Play, move |api| api.advance_queue(auto));
}

pub fn previous() {
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

pub fn toggle_shuffle() {
    let on = with_app(|app| !app.queue.as_ref().is_some_and(|q| q.shuffle));
    queue_op(Then::Show, move |api| api.set_shuffle(on));
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
    enum Do {
        Toggled,
        Resume(Duration),
        PlayAlbum(String),
        Nothing,
    }
    let what = with_app(|app| match &app.audio {
        Some(a) if app.session.is_some() => {
            a.toggle();
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
                    Err(err) => return set_status(app, &format!("Cannot play {title}: {err:#}")),
                };
                let Some(audio) = &app.audio else {
                    return set_status(app, "No audio output device");
                };
                if let Some(kbps) = opened.measured_kbps {
                    app.bandwidth.update(kbps);
                }
                if follow
                    && let Some(old) = app.session.as_ref().filter(|s| s.track.id == track.id)
                {
                    let new = opened.offset + opened.pipeline.position();
                    opened.pipeline.skip(old.position().saturating_sub(new));
                }
                // The output's queued track was gated on the stream being replaced.
                app.preload = None;
                app.preload_tried = None;
                audio.play(opened.source);
                app.monitor.reset();
                app.session = Some(Session {
                    track,
                    quality: opened.quality,
                    pipeline: opened.pipeline,
                    stream: opened.stream,
                    offset: opened.offset,
                    gain: replaygain::Applied::UNITY,
                });
                apply_replaygain(app);
            })
        });
    });
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
    replaygain::compute(&track.replay_gain, app.rg_mode, in_album_order, app.rg_preamp)
}

/// (Re)computes the current (and preloaded) track's ReplayGain, and applies it.
pub fn apply_replaygain(app: &mut App) {
    if let Some(p) = &app.preload {
        p.session.pipeline.set_gain(gain_for(app, &p.session.track).linear);
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
    if app.preload_tried.as_ref().is_some_and(|(_, id)| !wanted(id)) {
        app.preload_tried = None;
    }
}

/// Once the current track nears its end, opens the next one and queues it on the
/// output behind the current stream, so it starts on the very sample this one ends.
fn maybe_preload(app: &mut App) {
    let Some(s) = &app.session else { return };
    let length = Duration::from_millis(s.track.duration_ms.max(0) as u64);
    if app.loading || length.saturating_sub(s.position()) > PRELOAD_BEFORE {
        return;
    }
    let Some(entry) = up_next(app) else { return };
    let key = (app.generation, entry.entry_id.to_string());
    if app.preload_tried.as_ref() == Some(&key) {
        return; // done, in progress, or failed (then the track starts normally at the end)
    }
    let track = entry.track.clone();
    let quality = adaptive::choose(&track, app.mode, app.bandwidth.get());
    let (api, mode) = (app.api.clone(), app.mode);
    app.preload_tried = Some(key.clone());
    thread::spawn(move || {
        let opened = playback::open(&api, &track, mode, quality, Duration::ZERO);
        let _ = slint::invoke_from_event_loop(move || {
            with_app(|app| {
                // Superseded: another stream started, or the queue changed meanwhile.
                if app.preload_tried.as_ref() != Some(&key) {
                    return;
                }
                let mut opened = match opened {
                    Ok(o) => o,
                    Err(e) => return eprintln!("preloading {}: {e:#}", track.title),
                };
                let (Some(audio), Some(current)) = (&app.audio, &app.session) else {
                    return;
                };
                opened.source.play_after(&current.pipeline);
                let session = Session {
                    gain: gain_for(app, &track),
                    track,
                    quality: opened.quality,
                    pipeline: opened.pipeline,
                    stream: opened.stream,
                    offset: opened.offset,
                };
                session.pipeline.set_gain(session.gain.linear);
                audio.queue_next(opened.source);
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
        if let Some(a) = &app.audio {
            a.promote_next();
        }
        let id = p.session.track.id.to_string();
        app.session = Some(p.session);
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
        Some(id)
    });
    let Some(id) = promoted else { return false };
    refresh_playing_marks();
    fetch_now_playing(id);
    queue_op(Then::Continue, |api| api.advance_queue(true));
    true
}

pub fn update_stream_info(app: &App) {
    let Some(ui) = app.ui.upgrade() else { return };
    ui.set_quality_mode(app.mode.label().into());
    ui.set_replaygain_mode(format!("RG {}", app.rg_mode.name().to_uppercase()).into());
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
            Err(s.pipeline.clone())
        } else {
            Ok((s.track.clone(), s.quality))
        })
    });
    match action {
        Some(Err(pipeline)) => {
            // May wait for the network: never on the UI thread.
            thread::spawn(move || pipeline.seek(target, Duration::from_secs(15)));
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

pub fn refresh_playing_marks() {
    with_app(|app| {
        let Some(ui) = app.ui.upgrade() else { return };
        let playing = current_track(app).map(|t| t.id.to_string());
        ui.set_album_tracks(track_model(&app.album_tracks, playing.as_deref()));
        ui.set_search_tracks(search_track_model(&app.search_tracks, playing.as_deref()));
    });
}

/// Saving more often than this while playing would only add load; pausing and quitting save immediately.
const SAVE_EVERY: Duration = Duration::from_secs(10);

pub fn tick() {
    let (finished, switch) = with_app(|app| {
        let Some(ui) = app.ui.upgrade() else {
            return (false, None);
        };
        let paused = app.audio.as_ref().is_none_or(|a| a.is_paused());
        ui.set_playing((app.session.is_some() && !paused) || app.loading);
        super::desktop::sync(app);
        let Some(s) = &app.session else {
            return (false, None);
        };
        let pos = s.position();
        ui.set_position(pos.as_secs_f32());
        ui.set_position_text(fmt_duration(pos.as_millis() as i64).into());
        let finished = !app.loading && s.pipeline.finished();
        update_stream_info(app);
        if !paused && app.last_saved.elapsed() > SAVE_EVERY {
            save_position(app);
        }
        let switch = adapt(app);
        if switch.is_none() {
            maybe_preload(app);
        }
        (finished, switch)
    });
    if let Some((track, quality, at)) = switch {
        start_stream(track, quality, at, true);
    } else if finished && !promote_preload() {
        with_app(|app| app.session = None);
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
