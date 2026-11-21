//! Trimming tracks: the part of a track to play (set with a right-click on the
//! waveform, for everyone), and offers to skip long silences found at either end.

use std::{
    collections::{HashMap, HashSet},
    num::NonZeroU64,
    time::Duration,
};

use hyperplayer::{
    api::types::{self, Silence, TrackTrim},
    tr,
};

use super::{App, background, current_track, models::fmt_duration, set_status, with_app};

/// Silence this long (or longer) at either end is offered for trimming: a hidden
/// track's wait, not the quiet tail of a fade-out.
const LONG_GAP_MS: i64 = 10_000;
/// Left before the music starts, and after it ends, when trimming a silence.
const LEAD_IN_MS: i64 = 500;
const TAIL_MS: i64 = 1_000;

#[derive(Default)]
pub struct Trimming {
    /// Silence found per track, as the waveforms arrive.
    silences: HashMap<String, Silence>,
    /// Tracks whose offer was put off ("Not now") while the player is open.
    put_off: HashSet<String>,
    /// The offer on screen: for which track, and the trim it would set.
    offer: Option<(String, TrackTrim)>,
}

/// Shows the playing track's trim on the seek bar.
pub fn show(app: &App) {
    let Some(ui) = app.ui.upgrade() else { return };
    let track = app
        .session
        .as_ref()
        .map(|s| &s.track)
        .or(current_track(app));
    let trim = track.and_then(|t| t.trim.as_ref());
    let secs = |ms: Option<u64>| ms.map_or(-1.0, |ms| ms as f32 / 1000.0);
    ui.set_trim_start(secs(
        trim.and_then(|t| t.start_ms).map(|ms| ms.max(0) as u64),
    ));
    ui.set_trim_end(secs(trim.and_then(|t| t.end_ms).map(NonZeroU64::get)));
    ui.set_can_trim(app.admin && track.is_some());
}

/// The seek bar's menu: `kind` is "start" or "end" (at `at` seconds), or "clear".
pub fn pick(kind: &str, at: f32) {
    let change = with_app(|app| {
        let track = app.session.as_ref().map(|s| s.track.clone())?;
        let ms = (at.max(0.0) * 1000.0) as u64;
        let old = track.trim.clone().unwrap_or(TrackTrim {
            start_ms: None,
            end_ms: None,
        });
        let trim = match kind {
            "start" => TrackTrim {
                start_ms: (ms > 0).then_some(ms as i64),
                // An end before the new start goes.
                end_ms: old.end_ms.filter(|e| e.get() > ms),
            },
            "end" => TrackTrim {
                start_ms: old.start_ms.filter(|&s| (s as u64) < ms),
                end_ms: NonZeroU64::new(ms),
            },
            _ => TrackTrim {
                start_ms: None,
                end_ms: None,
            },
        };
        Some((track.id.to_string(), trim))
    });
    if let Some((id, trim)) = change {
        save(id, trim);
    }
}

/// Saves `trim` for track `id` on the server, then plays by it.
fn save(id: String, trim: TrackTrim) {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.set_track_trim(&id, &trim),
        |track| with_app(|app| apply(app, &track)),
    );
}

/// Takes in a track's new trim: wherever it's held, and in the stream playing it.
pub(super) fn apply(app: &mut App, track: &types::Track) {
    let same = |t: &types::Track| t.id == track.id;
    if let Some(s) = app.session.as_mut().filter(|s| same(&s.track)) {
        s.track.trim = track.trim.clone();
        let at = s.position();
        s.bound(at);
    }
    if let Some(q) = app.queue.as_mut() {
        for e in q.entries.iter_mut().filter(|e| same(&e.track)) {
            e.track.trim = track.trim.clone();
        }
    }
    for t in app.album_tracks.iter_mut().filter(|t| same(t)) {
        t.trim = track.trim.clone();
    }
    if app
        .trim
        .offer
        .as_ref()
        .is_some_and(|(id, _)| *id == *track.id)
    {
        hide_offer(app);
    }
    show(app);
}

/// A track's silence has been found (with its waveform).
pub fn found(app: &mut App, track_id: &str, silence: Option<Silence>) {
    if let Some(s) = silence {
        app.trim.silences.insert(track_id.to_string(), s);
    }
    consider(app, track_id);
}

/// Offers to trim the silence in track `track_id` if it's the one playing, has a long
/// silence, and nobody has decided about it yet.
pub fn consider(app: &mut App, track_id: &str) {
    // Another track is playing now: its offer, if any, no longer applies.
    if app
        .trim
        .offer
        .as_ref()
        .is_some_and(|(id, _)| current_track(app).is_none_or(|t| *t.id != *id))
    {
        hide_offer(app);
    }
    let Some(track) = current_track(app).filter(|t| *t.id == *track_id) else {
        return;
    };
    if !app.admin || track.trim.is_some() || app.trim.put_off.contains(track_id) {
        return;
    }
    let Some(silence) = app.trim.silences.get(track_id) else {
        return;
    };
    let Some((trim, text)) = suggest(track.duration_ms, silence) else {
        return;
    };
    app.trim.offer = Some((track_id.to_string(), trim));
    if let Some(ui) = app.ui.upgrade() {
        ui.set_trim_offer(text.into());
    }
}

/// The trim that skips `silence`'s long gaps in a track `duration_ms` long, and its
/// description; none when there are no long gaps (or it's silent throughout).
fn suggest(duration_ms: i64, silence: &Silence) -> Option<(TrackTrim, String)> {
    let leading = silence.leading_ms >= LONG_GAP_MS;
    let trailing = silence.trailing_ms >= LONG_GAP_MS;
    let music = duration_ms - silence.leading_ms - silence.trailing_ms;
    if !(leading || trailing) || music < LONG_GAP_MS {
        return None;
    }
    let trim = TrackTrim {
        start_ms: leading.then(|| (silence.leading_ms - LEAD_IN_MS).max(0)),
        end_ms: trailing
            .then(|| duration_ms - silence.trailing_ms + TAIL_MS)
            .and_then(|ms| NonZeroU64::new(ms.max(0) as u64)),
    };
    let gap = |ms| fmt_duration(ms);
    let at = match (leading, trailing) {
        (true, true) => tr!(
            "{} of silence at the start of this track and {} at the end.",
            gap(silence.leading_ms),
            gap(silence.trailing_ms)
        ),
        (true, false) => tr!(
            "{} of silence at the start of this track.",
            gap(silence.leading_ms)
        ),
        _ => tr!(
            "{} of silence at the end of this track.",
            gap(silence.trailing_ms)
        ),
    };
    let text = tr!(
        "{} Skip it whenever it plays, for everyone? Right-click the waveform to change it later.",
        at
    );
    Some((trim, text))
}

/// The offer's buttons: "accept", "later" or "never".
pub fn answer(choice: &str) {
    let decided = with_app(|app| {
        let (id, trim) = app.trim.offer.clone()?;
        hide_offer(app);
        match choice {
            "accept" => Some((id, trim)),
            "never" => Some((
                id,
                TrackTrim {
                    start_ms: None,
                    end_ms: None,
                },
            )),
            _ => {
                app.trim.put_off.insert(id);
                None
            }
        }
    });
    if let Some((id, trim)) = decided {
        save(id, trim);
    }
}

fn hide_offer(app: &mut App) {
    app.trim.offer = None;
    if let Some(ui) = app.ui.upgrade() {
        ui.set_trim_offer("".into());
    }
}

/// A seek in the current track lands in its trimmed-off part: say so, as the end is
/// then played through.
pub fn note_seek(app: &App, target: Duration) {
    let Some(s) = &app.session else { return };
    if super::playback::trim_end(&s.track).is_some_and(|end| target >= end) {
        set_status(app, tr!("Playing past the trimmed end, this time"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn silence(leading_ms: i64, trailing_ms: i64) -> Silence {
        Silence {
            leading_ms,
            trailing_ms,
        }
    }

    #[test]
    fn long_gaps_are_offered_short_ones_are_not() {
        assert!(suggest(240_000, &silence(300, 4_000)).is_none());
        let (trim, text) = suggest(400_000, &silence(0, 150_000)).unwrap();
        assert_eq!(trim.start_ms, None);
        assert_eq!(trim.end_ms, NonZeroU64::new(251_000));
        assert!(text.starts_with("2:30 of silence at the end"), "{text}");
        let (trim, _) = suggest(400_000, &silence(60_000, 0)).unwrap();
        assert_eq!(trim.start_ms, Some(59_500));
        assert_eq!(trim.end_ms, None);
    }

    #[test]
    fn a_silent_track_is_not_offered() {
        assert!(suggest(60_000, &silence(60_000, 60_000)).is_none());
        assert!(suggest(30_000, &silence(12_000, 12_000)).is_none());
    }
}
