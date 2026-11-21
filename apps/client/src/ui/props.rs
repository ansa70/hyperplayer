//! A track's Properties, opened from its menu: details, tags (edited in HyperPlayer, the
//! file is never changed), the user's rating and marks, and for everyone the part of the
//! track played and its volume. Changes apply together on Save.

use std::rc::Rc;

use chrono::{DateTime, Local, Utc};
use hyperplayer::{api::types, tr, trn};
use serde_json::{Map, Value, json};
use slint::{ComponentHandle, ModelRc, SharedString, VecModel};

use super::{
    App, DetailRow, TagRow, TrackProps, background,
    models::{fmt_duration, load_image},
    with_app,
};

/// The tags, in the order the dialog shows them.
const TAGS: [&str; 6] = [
    "title",
    "artist",
    "trackNumber",
    "discNumber",
    "year",
    "genres",
];

fn tag_label(key: &str) -> &'static str {
    match key {
        "title" => tr!("Title"),
        "artist" => tr!("Artist"),
        "trackNumber" => tr!("Track number"),
        "discNumber" => tr!("Disc number"),
        "year" => tr!("Year"),
        _ => tr!("Genres"),
    }
}

/// A tag as the dialog's text field shows it.
fn tag_text(tags: &types::TrackTags, key: &str) -> String {
    let number = |n: Option<u64>| n.map(|n| n.to_string()).unwrap_or_default();
    match key {
        "title" => tags.title.to_string(),
        "artist" => tags.artist.to_string(),
        "trackNumber" => number(tags.track_number.map(|n| n.get())),
        "discNumber" => number(tags.disc_number.map(|n| n.get())),
        "year" => tags.year.map(|y| y.to_string()).unwrap_or_default(),
        _ => tags
            .genres
            .iter()
            .map(|g| g.to_string())
            .collect::<Vec<_>>()
            .join(", "),
    }
}

fn is_edited(props: &types::TrackProperties, key: &str) -> bool {
    props.edited.iter().any(|f| {
        serde_json::to_value(f)
            .ok()
            .and_then(|v| v.as_str().map(|s| s == key))
            == Some(true)
    })
}

/// The Properties being changed, until saved or closed.
pub struct Editing {
    props: types::TrackProperties,
    /// The tags' text fields, by key, as typed.
    tags: Vec<(&'static str, String)>,
    /// Edited tags taken back to the file's.
    reset: Vec<&'static str>,
}

fn state(f: impl FnOnce(TrackProps)) {
    with_app(|app| {
        if let Some(ui) = app.ui.upgrade() {
            f(ui.global::<TrackProps>());
        }
    });
}

/// Connects the dialog's actions; called once at startup.
pub fn init(ui: &super::AppWindow) {
    let s = ui.global::<TrackProps>();
    s.on_tag_edited(|key, text| {
        with_app(|app| {
            if let Some(e) = app.props.as_mut()
                && let Some(tag) = e.tags.iter_mut().find(|(k, _)| *k == key.as_str())
            {
                tag.1 = text.to_string();
            }
        })
    });
    s.on_reset_tag(reset_tag);
    s.on_save(save);
    s.on_close(close);
}

pub fn open(track: &types::Track) {
    let id = track.id.to_string();
    let api = with_app(|app| {
        app.props = None;
        if let Some(ui) = app.ui.upgrade() {
            let s = ui.global::<TrackProps>();
            s.set_title(track.title.clone().into());
            s.set_subtitle(format!("{} · {}", track.artist_name, track.album_title).into());
            s.set_cover(Default::default());
            s.set_message("".into());
            s.set_saving(false);
            s.set_loading(true);
            s.set_open(true);
        }
        app.api.clone()
    });
    background(
        move || api.track_properties(&id),
        |props| with_app(|app| show(app, props, true)),
    );
}

fn close() {
    with_app(|app| {
        app.props = None;
        if let Some(ui) = app.ui.upgrade() {
            ui.global::<TrackProps>().set_open(false);
        }
    });
}

/// Shows `props`; `fresh` when just opened (the cover is loaded, the marks set).
fn show(app: &mut App, props: types::TrackProperties, fresh: bool) {
    let Some(ui) = app.ui.upgrade() else { return };
    let s = ui.global::<TrackProps>();
    if !s.get_open() {
        return;
    }
    let t = &props.track;
    s.set_title(t.title.clone().into());
    s.set_subtitle(format!("{} · {}", t.artist_name, t.album_title).into());
    s.set_details(ModelRc::new(VecModel::from(details(&props))));
    let duration = t.duration_ms as f32 / 1000.0;
    s.set_duration(duration);
    s.set_range_start(
        t.trim
            .as_ref()
            .and_then(|r| r.start_ms)
            .map_or(0.0, |ms| ms as f32 / 1000.0),
    );
    s.set_range_end(
        t.trim
            .as_ref()
            .and_then(|r| r.end_ms)
            .map_or(duration, |ms| (ms.get() as f32 / 1000.0).min(duration)),
    );
    s.set_volume_db(t.volume_db as f32);
    s.set_favourite(t.favourite);
    s.set_shuffle_excluded(t.shuffle_excluded);
    s.set_rating(t.rating as i32);
    s.set_loading(false);
    s.set_saving(false);
    if fresh {
        load_image(
            app,
            t.cover.as_ref(),
            160,
            false,
            Box::new(|ui, img| ui.global::<TrackProps>().set_cover(img)),
        );
    }
    let tags = TAGS
        .iter()
        .map(|key| (*key, tag_text(&props.tags, key)))
        .collect();
    app.props = Some(Editing {
        props,
        tags,
        reset: Vec::new(),
    });
    push_tags(app, &s);
}

/// Shows the tags' rows from what's being edited.
fn push_tags(app: &App, s: &TrackProps) {
    let Some(e) = &app.props else { return };
    let rows: Vec<TagRow> = e
        .tags
        .iter()
        .map(|(key, value)| {
            let edited = is_edited(&e.props, key) && !e.reset.contains(key);
            TagRow {
                key: (*key).into(),
                label: tag_label(key).into(),
                value: value.clone().into(),
                original: tag_text(&e.props.original, key).into(),
                edited,
            }
        })
        .collect();
    s.set_tags(Rc::new(VecModel::from(rows)).into());
}

fn reset_tag(key: SharedString) {
    with_app(|app| {
        let Some(e) = app.props.as_mut() else { return };
        let Some(&key) = TAGS.iter().find(|k| **k == key.as_str()) else {
            return;
        };
        if !e.reset.contains(&key) {
            e.reset.push(key);
        }
        let original = tag_text(&e.props.original, key);
        if let Some(tag) = e.tags.iter_mut().find(|(k, _)| *k == key) {
            tag.1 = original;
        }
        if let Some(ui) = app.ui.upgrade() {
            push_tags(app, &ui.global::<TrackProps>());
        }
    });
}

fn details(p: &types::TrackProperties) -> Vec<DetailRow> {
    let t = &p.track;
    let f = &t.format;
    let mut format = vec![f.codec.clone()];
    if f.container != f.codec {
        format.push(f.container.clone());
    }
    format.push(
        if f.lossless {
            tr!("lossless")
        } else {
            tr!("lossy")
        }
        .to_string(),
    );
    if let Some(b) = f.bitrate {
        format.push(format!("{} kbit/s", b.get() / 1000));
    }
    if let Some(r) = f.sample_rate {
        format.push(format!("{} kHz", r.get() as f64 / 1000.0));
    }
    if let Some(d) = f.bit_depth {
        format.push(format!("{} bit", d.get()));
    }
    if let Some(c) = f.channels {
        format.push(match c.get() {
            1 => tr!("mono").to_string(),
            2 => tr!("stereo").to_string(),
            n => trn!("{n} channel", "{n} channels", n as i64),
        });
    }
    let date = |d: &DateTime<Utc>| d.with_timezone(&Local).format("%Y-%m-%d").to_string();
    let db = |g: f64| format!("{}{:.1} dB", if g >= 0.0 { "+" } else { "−" }, g.abs());
    let rg = &t.replay_gain;
    let mut gains = Vec::new();
    if let Some(g) = rg.track_gain {
        gains.push(tr!("track {}", db(g)));
    }
    if let Some(g) = rg.album_gain {
        gains.push(tr!("album {}", db(g)));
    }
    let mut rows = vec![
        (tr!("Album").to_string(), t.album_title.clone()),
        (tr!("Duration").to_string(), fmt_duration(t.duration_ms)),
        (tr!("Format").to_string(), format.join(" · ")),
        (
            tr!("File size").to_string(),
            format!("{:.1} MB", t.file_size as f64 / 1_048_576.0),
        ),
        (tr!("File").to_string(), p.path.clone()),
        (
            tr!("ReplayGain").to_string(),
            if gains.is_empty() {
                tr!("none in the file").to_string()
            } else {
                gains.join(" · ")
            },
        ),
        (
            tr!("Your plays").to_string(),
            match &p.last_played_at {
                Some(last) => trn!("{n} · last on {}", "{n} · last on {}", p.plays, date(last)),
                None => tr!("never played").to_string(),
            },
        ),
    ];
    if let Some(added) = &p.added_at {
        rows.push((tr!("Added").to_string(), date(added)));
    }
    if let Some(mbid) = &p.musicbrainz_recording_id {
        rows.push((tr!("MusicBrainz ID").to_string(), mbid.clone()));
    }
    rows.into_iter()
        .map(|(label, value)| DetailRow {
            label: label.into(),
            value: value.into(),
        })
        .collect()
}

/// What Save sends: the changes for everyone, and the user's own marks.
fn changes(app: &App) -> Result<(Option<Value>, Option<types::TrackMarks>), String> {
    let e = app.props.as_ref().ok_or_default()?;
    let ui = app.ui.upgrade().ok_or_default()?;
    let s = ui.global::<TrackProps>();
    let shown = &e.props.tags;

    let mut tags = Map::new();
    for (key, text) in &e.tags {
        let text = text.trim();
        if text == tag_text(shown, key).trim()
            || e.reset.contains(key) && text == tag_text(&e.props.original, key)
        {
            continue;
        }
        let number = |what: &str, max: u64, positive: bool| -> Result<Value, String> {
            if text.is_empty() {
                return Ok(Value::Null);
            }
            match text.parse::<u64>() {
                Ok(n) if n <= max && (n > 0 || !positive) => Ok(json!(n)),
                _ => Err(tr!("{} isn't a valid {}", text, what)),
            }
        };
        let value = match *key {
            "title" | "artist" if text.is_empty() => {
                return Err(tr!("{} can't be empty", tag_label(key)));
            }
            "title" | "artist" => json!(text),
            "trackNumber" => number(tr!("track number"), 9999, true)?,
            "discNumber" => number(tr!("disc number"), 999, true)?,
            "year" => number(tr!("year"), 9999, false)?,
            _ => json!(
                text.split(',')
                    .map(str::trim)
                    .filter(|g| !g.is_empty())
                    .collect::<Vec<_>>()
            ),
        };
        tags.insert((*key).into(), value);
    }

    let mut body = Map::new();
    if !tags.is_empty() {
        body.insert("tags".into(), Value::Object(tags));
    }
    if !e.reset.is_empty() {
        body.insert("reset".into(), json!(e.reset));
    }
    let t = &e.props.track;
    let volume = s.get_volume_db() as f64;
    if (volume - t.volume_db).abs() > 0.01 {
        body.insert("volumeDb".into(), json!(volume));
    }
    let duration_ms = t.duration_ms;
    let start = (s.get_range_start() * 1000.0).round() as i64;
    let end = (s.get_range_end() * 1000.0).round() as i64;
    let start = (start > 0).then_some(start);
    let end = (end < duration_ms - 500).then_some(end);
    let was_start = t.trim.as_ref().and_then(|r| r.start_ms);
    let was_end = t
        .trim
        .as_ref()
        .and_then(|r| r.end_ms)
        .map(|e| e.get() as i64);
    let near = |a: Option<i64>, b: Option<i64>| match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() < 500,
        (a, b) => a == b,
    };
    if !near(start, was_start) || !near(end, was_end) {
        body.insert("trim".into(), json!({ "startMs": start, "endMs": end }));
    }

    let rating = s.get_rating().clamp(0, 5) as i64;
    let marks = types::TrackMarks {
        favourite: (s.get_favourite() != t.favourite).then_some(s.get_favourite()),
        shuffle_excluded: (s.get_shuffle_excluded() != t.shuffle_excluded)
            .then_some(s.get_shuffle_excluded()),
        rating: (rating != t.rating).then_some(rating),
    };
    let marks =
        (marks.favourite.is_some() || marks.shuffle_excluded.is_some() || marks.rating.is_some())
            .then_some(marks);
    Ok(((!body.is_empty()).then_some(Value::Object(body)), marks))
}

trait OkOrDefault<T> {
    fn ok_or_default(self) -> Result<T, String>;
}

impl<T> OkOrDefault<T> for Option<T> {
    fn ok_or_default(self) -> Result<T, String> {
        self.ok_or_else(String::new)
    }
}

fn save() {
    let (api, id, change) = with_app(|app| {
        let id = app.props.as_ref().map(|e| e.props.track.id.to_string());
        (app.api.clone(), id, changes(app))
    });
    let Some(id) = id else { return };
    let (body, marks) = match change {
        Ok(c) => c,
        Err(message) => {
            state(|s| s.set_message(message.into()));
            return;
        }
    };
    if body.is_none() && marks.is_none() {
        close();
        return;
    }
    state(|s| {
        s.set_saving(true);
        s.set_message("".into());
    });
    std::thread::spawn(move || {
        let result = (|| {
            if let Some(body) = &body {
                api.update_track_properties(&id, body)?;
            }
            if let Some(marks) = &marks {
                api.set_track_marks(&id, marks)?;
            }
            api.track_properties(&id)
        })();
        let _ = slint::invoke_from_event_loop(move || match result {
            Ok(props) => {
                let track = props.track.clone();
                with_app(|app| {
                    super::marks::track_changed(app, &track);
                    super::set_status(app, &tr!("Saved: “{}”", track.title));
                });
                close();
            }
            Err(e) => {
                let msg = format!("{e:#}");
                state(|s| {
                    s.set_saving(false);
                    // The server's own words are the useful part.
                    s.set_message(msg.rsplit(": ").next().unwrap_or(&msg).into());
                });
            }
        });
    });
}
