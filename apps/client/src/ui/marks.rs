//! The user's marks on tracks: favourites, and tracks left out of the whole-library
//! shuffle. The track menus (⋯ or right-click) toggle them, every track list shows them,
//! the Favourites page lists the favourites and Settings' Shuffle tab the others.

use std::{rc::Rc, time::SystemTime};

use hyperplayer::{api::types, tr, trn};
use slint::{Model, ModelRc, VecModel};

use super::{
    App, AppWindow, Page, TrackItem, background, models::fmt_duration, playback::play_from,
    set_status, with_app,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    Favourite,
    ShuffleExcluded,
}

/// A row of a list mixing albums: the subtitle names the artist and the album.
fn row(i: usize, t: &types::Track, playing: Option<&str>) -> TrackItem {
    TrackItem {
        id: t.id.to_string().into(),
        number: (i + 1).to_string().into(),
        title: t.title.clone().into(),
        artist: format!("{} · {}", t.artist_name, t.album_title).into(),
        duration: fmt_duration(t.duration_ms).into(),
        playing: playing == Some(t.id.as_str()),
        available: true,
        favourite: t.favourite,
        shuffle_excluded: t.shuffle_excluded,
    }
}

/// Turns `mark` on a track the other way.
pub fn toggle(track: &types::Track, mark: Mark) {
    let on = match mark {
        Mark::Favourite => !track.favourite,
        Mark::ShuffleExcluded => !track.shuffle_excluded,
    };
    set(track.id.to_string(), mark, on);
}

pub fn set(id: String, mark: Mark, on: bool) {
    let api = with_app(|app| app.api.clone());
    let marks = types::TrackMarks {
        favourite: (mark == Mark::Favourite).then_some(on),
        shuffle_excluded: (mark == Mark::ShuffleExcluded).then_some(on),
    };
    background(
        move || api.set_track_marks(&id, &marks),
        move |track| {
            let page = with_app(|app| {
                apply(app, &track);
                let message = match (mark, on) {
                    (Mark::Favourite, true) => tr!("Added to favourites: “{}”", track.title),
                    (Mark::Favourite, false) => tr!("Removed from favourites: “{}”", track.title),
                    (Mark::ShuffleExcluded, true) => {
                        tr!("Left out of the library shuffle: “{}”", track.title)
                    }
                    (Mark::ShuffleExcluded, false) => {
                        tr!("Back in the library shuffle: “{}”", track.title)
                    }
                };
                set_status(app, &message);
                app.ui.upgrade().map(|ui| ui.get_page())
            });
            // The lists of marked tracks gain or lose it.
            match page {
                Some(Page::Favourites) if mark == Mark::Favourite => load_favourites(),
                Some(Page::Settings) if mark == Mark::ShuffleExcluded => load_excluded(),
                _ => {}
            }
        },
    );
}

/// Takes in a track's new marks: wherever it's held, and in every list showing it.
fn apply(app: &mut App, track: &types::Track) {
    let update = |t: &mut types::Track| {
        if t.id == track.id {
            t.favourite = track.favourite;
            t.shuffle_excluded = track.shuffle_excluded;
        }
    };
    app.album_tracks.iter_mut().for_each(update);
    app.search_tracks.iter_mut().for_each(update);
    app.history_top.iter_mut().for_each(update);
    app.history_recent.iter_mut().for_each(update);
    app.favourites.iter_mut().for_each(update);
    app.shuffle_excluded.iter_mut().for_each(update);
    if let Some(p) = app.playlist.as_mut() {
        p.entries
            .iter_mut()
            .filter_map(|e| e.track.as_mut())
            .for_each(update);
    }
    if let Some(q) = app.queue.as_mut() {
        q.entries.iter_mut().map(|e| &mut e.track).for_each(update);
    }
    let Some(ui) = app.ui.upgrade() else { return };
    for model in [
        ui.get_album_tracks(),
        ui.get_search_tracks(),
        ui.get_playlist_tracks(),
        ui.get_queue_now(),
        ui.get_queue_next(),
        ui.get_history_top(),
        ui.get_history_recent(),
        ui.get_favourites(),
        ui.get_shuffle_excluded(),
    ] {
        for i in 0..model.row_count() {
            if let Some(mut row) = model.row_data(i)
                && row.id == track.id.as_str()
                && (row.favourite != track.favourite
                    || row.shuffle_excluded != track.shuffle_excluded)
            {
                row.favourite = track.favourite;
                row.shuffle_excluded = track.shuffle_excluded;
                model.set_row_data(i, row);
            }
        }
    }
}

// ---------------------------------------------------------------- favourites

pub fn toggle_page() {
    let open = with_app(|app| {
        let ui = app.ui.upgrade()?;
        if ui.get_page() == Page::Favourites {
            ui.set_page(app.page_before_favourites);
            None
        } else {
            app.page_before_favourites = ui.get_page();
            ui.set_page(Page::Favourites);
            Some(())
        }
    });
    if open.is_some() {
        load_favourites();
    }
}

pub fn load_favourites() {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.favourites(),
        |list| with_app(|app| show_favourites(app, list.0)),
    );
}

fn show_favourites(app: &mut App, tracks: Vec<types::Track>) {
    app.favourites = tracks;
    let Some(ui) = app.ui.upgrade() else { return };
    let playing = super::playing_track(app).map(|t| t.id.to_string());
    let rows: Vec<TrackItem> = app
        .favourites
        .iter()
        .enumerate()
        .map(|(i, t)| row(i, t, playing.as_deref()))
        .collect();
    let total: i64 = app.favourites.iter().map(|t| t.duration_ms).sum();
    ui.set_favourites_summary(
        if app.favourites.is_empty() {
            String::new()
        } else {
            format!(
                "{} · {}",
                trn!("{n} track", "{n} tracks", app.favourites.len() as i64),
                fmt_duration(total)
            )
        }
        .into(),
    );
    ui.set_favourites(ModelRc::new(VecModel::from(rows)));
    ui.set_favourites_loaded(true);
}

fn ids(tracks: &[types::Track]) -> Vec<types::Id> {
    tracks.iter().map(|t| t.id.clone()).collect()
}

pub fn play_favourite(index: i32) {
    let ids = with_app(|app| ids(&app.favourites));
    if !ids.is_empty() {
        play_from(
            types::TrackSource::Tracks { track_ids: ids },
            index.max(0) as usize,
            None,
        );
    }
}

/// Plays the favourites shuffled, from one picked at random.
pub fn shuffle_favourites() {
    let ids = with_app(|app| ids(&app.favourites));
    if ids.is_empty() {
        return;
    }
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos() as usize);
    let start = nanos % ids.len();
    play_from(
        types::TrackSource::Tracks { track_ids: ids },
        start,
        Some(true),
    );
}

// -------------------------------------------------- left out of the shuffle

/// Fetches the tracks left out of the library shuffle, for Settings' Shuffle tab.
pub fn load_excluded() {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.shuffle_exclusions(),
        |list| with_app(|app| show_excluded(app, list.0)),
    );
}

fn show_excluded(app: &mut App, tracks: Vec<types::Track>) {
    app.shuffle_excluded = tracks;
    let Some(ui) = app.ui.upgrade() else { return };
    let playing = super::playing_track(app).map(|t| t.id.to_string());
    let rows: Vec<TrackItem> = app
        .shuffle_excluded
        .iter()
        .enumerate()
        .map(|(i, t)| row(i, t, playing.as_deref()))
        .collect();
    ui.set_shuffle_excluded(Rc::new(VecModel::from(rows)).into());
}

pub fn play_excluded(index: i32) {
    let ids = with_app(|app| ids(&app.shuffle_excluded));
    if !ids.is_empty() {
        play_from(
            types::TrackSource::Tracks { track_ids: ids },
            index.max(0) as usize,
            None,
        );
    }
}

/// Marks the playing track in the Favourites page's list.
pub fn refresh_playing(app: &App, ui: &AppWindow) {
    let playing = super::playing_track(app).map(|t| t.id.as_str());
    let model = ui.get_favourites();
    for (i, t) in app.favourites.iter().enumerate() {
        if let Some(mut row) = model.row_data(i)
            && row.playing != (playing == Some(t.id.as_str()))
        {
            row.playing = !row.playing;
            model.set_row_data(i, row);
        }
    }
}
