//! Listening history: counts how much of each track is really played, reports
//! listens to the server, and shows the History page.

use std::{
    thread,
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use hyperplayer::api::types;
use slint::{Model, ModelRc, VecModel};

use super::{
    App, AppWindow, Page, TrackItem, background, current_track,
    models::{artist_model, fmt_duration, plural},
    with_app,
};

/// Tracks shorter than this never count; playing `ENOUGH` always does (the server checks too).
const MIN_TRACK: Duration = Duration::from_secs(30);
const ENOUGH: Duration = Duration::from_secs(4 * 60);
/// Position jumps bigger than this between ticks are seeks, not playing.
const MAX_STEP: Duration = Duration::from_secs(2);
const RETRY_AFTER: Duration = Duration::from_secs(30);
/// Resuming within this long of the last "now playing" doesn't announce it again.
const ANNOUNCE_GAP: Duration = Duration::from_secs(30);
/// The History page's window for "most played".
const STATS_DAYS: i64 = 30;

/// One play of a track, from its start until the next track.
pub struct Listening {
    track_id: String,
    length: Duration,
    started_at: DateTime<Utc>,
    played: Duration,
    last_position: Option<Duration>,
    reported: bool,
    /// "Now playing" was sent since the track started or last resumed.
    announced: bool,
    last_announced: Option<Instant>,
    /// While a report is in flight or after one failed, don't send another before this.
    next_attempt: Option<Instant>,
}

/// A new play of `track` begins (a track change, not a seek or quality switch).
pub fn begin(app: &mut App, track: &types::Track) {
    app.listening = Some(Listening {
        track_id: track.id.to_string(),
        length: Duration::from_millis(track.duration_ms.max(0) as u64),
        started_at: Utc::now(),
        played: Duration::ZERO,
        last_position: None,
        reported: false,
        announced: false,
        last_announced: None,
        next_attempt: None,
    });
}

/// Called from the playback tick with the current position.
pub fn follow(app: &mut App, position: Duration, playing: bool) {
    let session_track = app.session.as_ref().map(|s| s.track.id.to_string());
    let Some(l) = app.listening.as_mut() else {
        return;
    };
    // The previous track can still be playing while the next one opens.
    if session_track.as_deref() != Some(l.track_id.as_str()) {
        return;
    }
    let mut advanced = false;
    if playing
        && let Some(last) = l.last_position
        && position > last
        && position - last < MAX_STEP
    {
        l.played += position - last;
        advanced = true;
    }
    l.last_position = Some(position);

    // Announced once audio really plays (not while it loads), and again after a pause.
    if !playing {
        l.announced = false;
    } else if advanced
        && !l.announced
        && l.last_announced.is_none_or(|t| t.elapsed() >= ANNOUNCE_GAP)
    {
        l.announced = true;
        l.last_announced = Some(Instant::now());
        let (api, id) = (app.api.clone(), l.track_id.clone());
        thread::spawn(move || {
            if let Err(e) = api.playing_now(&id) {
                eprintln!("reporting now playing: {e:#}");
            }
        });
    }

    let counts = l.length >= MIN_TRACK && l.played >= (l.length / 2).min(ENOUGH);
    if !counts || l.reported || l.next_attempt.is_some_and(|t| Instant::now() < t) {
        return;
    }
    l.next_attempt = Some(Instant::now() + RETRY_AFTER);
    let (api, id, started, played) = (app.api.clone(), l.track_id.clone(), l.started_at, l.played);
    thread::spawn(move || {
        let result = api.record_listen(&id, started, played);
        let _ = slint::invoke_from_event_loop(move || {
            with_app(|app| {
                if let Err(e) = &result {
                    eprintln!("recording listen: {e:#}");
                    return;
                }
                if let Some(l) = app
                    .listening
                    .as_mut()
                    .filter(|l| l.track_id == id && l.started_at == started)
                {
                    l.reported = true;
                }
                // Keep an open History page current.
                if app
                    .ui
                    .upgrade()
                    .is_some_and(|ui| ui.get_page() == Page::History)
                {
                    load();
                }
            })
        });
    });
}

pub fn toggle_page() {
    let open = with_app(|app| {
        let ui = app.ui.upgrade()?;
        if ui.get_page() == Page::History {
            ui.set_page(app.page_before_history);
            None
        } else {
            app.page_before_history = ui.get_page();
            ui.set_page(Page::History);
            Some(())
        }
    });
    if open.is_some() {
        load();
    }
}

/// Fetches recent listens and statistics for the History page.
pub fn load() {
    let api = with_app(|app| app.api.clone());
    background(
        move || Ok((api.history_stats(STATS_DAYS, 10)?, api.history(0, 50)?)),
        |(stats, recent)| with_app(|app| show(app, stats, recent)),
    );
}

fn show(app: &mut App, stats: types::HistoryStats, recent: types::ListenPage) {
    let Some(ui) = app.ui.upgrade() else { return };
    let listened = Duration::from_millis(stats.listened_ms.max(0) as u64);
    ui.set_history_summary(
        if stats.listens == 0 {
            String::new()
        } else {
            format!(
                "{} · {} in the last {} days",
                plural(stats.listens, "listen"),
                fmt_listened(listened),
                stats.days
            )
        }
        .into(),
    );

    let artists: Vec<types::ArtistSummary> =
        stats.top_artists.iter().map(|a| a.artist.clone()).collect();
    let model = artist_model(app, &artists, |ui| ui.get_history_artists());
    for (i, a) in stats.top_artists.iter().enumerate() {
        if let Some(mut row) = model.row_data(i) {
            row.subtitle = plural(a.plays, "play").into();
            model.set_row_data(i, row);
        }
    }
    ui.set_history_artists(model);

    let playing = current_track(app).map(|t| t.id.to_string());
    let row = |i: usize, t: &types::Track, detail: String| TrackItem {
        number: (i + 1).to_string().into(),
        title: t.title.clone().into(),
        artist: format!("{} · {detail}", t.artist_name).into(),
        duration: fmt_duration(t.duration_ms).into(),
        playing: playing.as_deref() == Some(t.id.as_str()),
        available: true,
    };
    let top: Vec<TrackItem> = stats
        .top_tracks
        .iter()
        .enumerate()
        .map(|(i, t)| row(i, &t.track, plural(t.plays, "play")))
        .collect();
    let now = Utc::now();
    let recent_rows: Vec<TrackItem> = recent
        .items
        .iter()
        .enumerate()
        .map(|(i, l)| row(i, &l.track, ago(now, l.started_at)))
        .collect();
    ui.set_history_top(ModelRc::new(VecModel::from(top)));
    ui.set_history_recent(ModelRc::new(VecModel::from(recent_rows)));
    ui.set_history_loaded(true);
    app.history_top = stats.top_tracks.into_iter().map(|t| t.track).collect();
    app.history_recent = recent.items.into_iter().map(|l| l.track).collect();
}

/// Marks the playing track in the History page's lists.
pub fn refresh_playing(app: &App, ui: &AppWindow) {
    let playing = current_track(app).map(|t| t.id.as_str());
    for (model, tracks) in [
        (ui.get_history_top(), &app.history_top),
        (ui.get_history_recent(), &app.history_recent),
    ] {
        for (i, t) in tracks.iter().enumerate() {
            if let Some(mut row) = model.row_data(i)
                && row.playing != (playing == Some(t.id.as_str()))
            {
                row.playing = !row.playing;
                model.set_row_data(i, row);
            }
        }
    }
}

fn fmt_listened(d: Duration) -> String {
    let minutes = d.as_secs() / 60;
    match minutes {
        0..60 => plural(minutes as i64, "minute"),
        _ => format!("{} h {} min", minutes / 60, minutes % 60),
    }
}

/// "just now", "12 min ago", "3 h ago", "yesterday", "5 days ago", then the date.
fn ago(now: DateTime<Utc>, then: DateTime<Utc>) -> String {
    let secs = (now - then).num_seconds().max(0);
    match secs {
        0..60 => "just now".into(),
        60..3600 => format!("{} min ago", secs / 60),
        3600..86_400 => format!("{} h ago", secs / 3600),
        86_400..172_800 => "yesterday".into(),
        172_800..604_800 => format!("{} days ago", secs / 86_400),
        _ => then
            .with_timezone(&chrono::Local)
            .format("%-d %b %Y")
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_times() {
        let now = Utc::now();
        let before = |s: i64| ago(now, now - chrono::Duration::seconds(s));
        assert_eq!(before(5), "just now");
        assert_eq!(before(12 * 60), "12 min ago");
        assert_eq!(before(3 * 3600 + 100), "3 h ago");
        assert_eq!(before(30 * 3600), "yesterday");
        assert_eq!(before(5 * 86_400), "5 days ago");
    }
}
