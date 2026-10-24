//! Playlists, the queue view, and the ⋯ menu actions on tracks and albums.

use std::rc::Rc;

use hyperplayer::api::types::{self, TrackSource};
use slint::{Image, ModelRc, SharedString, VecModel};

use super::{
    App, Page, PlaylistItem, PlaylistView, TrackItem, background, current_track,
    models::{fmt_duration, load_image, plural},
    playback::{Then, play_from, queue_op, repeat_mode},
    set_status, with_app,
};

fn track_ids(ids: &[&str]) -> TrackSource {
    TrackSource::Tracks {
        track_ids: ids
            .iter()
            .map(|id| (*id).try_into().expect("track id"))
            .collect(),
    }
}

fn source_id(id: &str) -> types::Id {
    id.try_into().expect("id")
}

// ----------------------------------------------------------------- playlists

pub fn load_playlists() {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.playlists(),
        |list| with_app(|app| show_playlists(app, list.0)),
    );
}

fn show_playlists(app: &mut App, list: Vec<types::PlaylistSummary>) {
    if let Some(ui) = app.ui.upgrade() {
        let items: Vec<PlaylistItem> = list
            .iter()
            .map(|p| PlaylistItem {
                id: p.id.to_string().into(),
                name: p.name.clone().into(),
                subtitle: p.track_count.to_string().into(),
            })
            .collect();
        ui.set_playlists(Rc::new(VecModel::from(items)).into());
    }
    app.playlists = list;
}

pub fn select_playlist(id: SharedString) {
    let api = with_app(|app| app.api.clone());
    let pid = id.to_string();
    background(
        move || api.playlist(&pid),
        |p| with_app(|app| show_playlist(app, p, true)),
    );
}

/// Displays a playlist; `open` switches to its page (otherwise only refreshes it if shown).
fn show_playlist(app: &mut App, p: types::Playlist, open: bool) {
    let Some(ui) = app.ui.upgrade() else { return };
    let shown = ui.get_page() == Page::Playlist && ui.get_selected_playlist_id() == p.id.as_str();
    if !open && !shown {
        return;
    }
    let playing = current_track(app).map(|t| t.id.to_string());
    let rows: Vec<TrackItem> = p
        .entries
        .iter()
        .enumerate()
        .map(|(i, e)| TrackItem {
            number: (i + 1).to_string().into(),
            title: e.snapshot.title.clone().into(),
            artist: format!("{} · {}", e.snapshot.artist_name, e.snapshot.album_title).into(),
            duration: fmt_duration(e.snapshot.duration_ms).into(),
            playing: e
                .track
                .as_ref()
                .is_some_and(|t| Some(t.id.as_str()) == playing.as_deref()),
            available: e.track.is_some(),
        })
        .collect();
    let previous_cover = ui.get_playlist();
    let same = previous_cover.id == p.id.as_str();
    ui.set_playlist(PlaylistView {
        id: p.id.to_string().into(),
        name: p.name.clone().into(),
        meta: format!(
            "{} · {}",
            plural(p.track_count, "track"),
            fmt_duration(p.duration_ms)
        )
        .into(),
        cover: if same {
            previous_cover.cover
        } else {
            Image::default()
        },
    });
    ui.set_playlist_tracks(Rc::new(VecModel::from(rows)).into());
    ui.set_selected_playlist_id(p.id.to_string().into());
    if open {
        ui.set_page(Page::Playlist);
    }
    let id: SharedString = p.id.to_string().into();
    load_image(
        app,
        p.covers.first(),
        480,
        false,
        Box::new(move |ui, img| {
            let mut v = ui.get_playlist();
            if v.id == id {
                v.cover = img;
                ui.set_playlist(v);
            }
        }),
    );
    app.playlist = Some(p);
}

/// After a playlist changed on the server: refresh the sidebar and, if open, the page.
fn playlist_changed(p: types::Playlist, open: bool) {
    with_app(|app| show_playlist(app, p, open));
    load_playlists();
}

/// "New playlist", "New playlist 2", … whichever is free.
fn fresh_name(app: &App, base: &str) -> String {
    let taken = |n: &str| app.playlists.iter().any(|p| p.name == n);
    if !taken(base) {
        return base.to_string();
    }
    (2..)
        .map(|i| format!("{base} {i}"))
        .find(|n| !taken(n))
        .expect("a free name")
}

pub fn new_playlist() {
    let (api, name) = with_app(|app| (app.api.clone(), fresh_name(app, "New playlist")));
    background(
        move || api.create_playlist(&name, vec![]),
        |p| playlist_changed(p, true),
    );
}

pub fn play_playlist(index: i32) {
    let Some((id, start)) = with_app(|app| {
        let p = app.playlist.as_ref()?;
        // The server skips missing entries, so count only playable ones before the clicked row.
        let start = p
            .entries
            .iter()
            .take(index.max(0) as usize)
            .filter(|e| e.track.is_some())
            .count();
        Some((p.id.clone(), start))
    }) else {
        return;
    };
    play_from(TrackSource::Playlist { id }, start, Some(false));
}

pub fn shuffle_playlist() {
    if let Some(id) = with_app(|app| app.playlist.as_ref().map(|p| p.id.clone())) {
        play_from(TrackSource::Playlist { id }, 0, Some(true));
    }
}

pub fn rename_playlist(name: SharedString) {
    let Some((api, id)) = with_app(|app| {
        app.playlist
            .as_ref()
            .map(|p| (app.api.clone(), p.id.to_string()))
    }) else {
        return;
    };
    let name = name.trim().to_string();
    if name.is_empty() {
        return;
    }
    background(
        move || api.rename_playlist(&id, &name),
        |p| playlist_changed(p, false),
    );
}

pub fn delete_playlist() {
    let Some((api, id)) = with_app(|app| {
        app.playlist
            .as_ref()
            .map(|p| (app.api.clone(), p.id.to_string()))
    }) else {
        return;
    };
    background(
        move || api.delete_playlist(&id),
        |()| {
            with_app(|app| {
                app.playlist = None;
                if let Some(ui) = app.ui.upgrade() {
                    ui.set_page(Page::Welcome);
                }
            });
            load_playlists();
        },
    );
}

// --------------------------------------------------------------- menu actions

/// What a ⋯ menu acts on: some tracks (for queue/playlist actions) and, when it
/// is an entry of a playlist or the queue, that entry.
struct Target {
    source: TrackSource,
    /// Name for a new playlist created from this target.
    name: String,
    entry: Option<String>,
}

fn track_target(app: &App, list: &str, index: i32) -> Option<Target> {
    let track = |t: &types::Track, entry: Option<String>| Target {
        source: track_ids(&[t.id.as_str()]),
        name: t.title.clone(),
        entry,
    };
    match list {
        "album" => app.album_tracks.get(index as usize).map(|t| track(t, None)),
        "search" => app
            .search_tracks
            .get(index as usize)
            .map(|t| track(t, None)),
        "history-top" => app.history_top.get(index as usize).map(|t| track(t, None)),
        "history-recent" => app
            .history_recent
            .get(index as usize)
            .map(|t| track(t, None)),
        "playlist" => {
            let e = app.playlist.as_ref()?.entries.get(index as usize)?;
            let source = e
                .track
                .as_ref()
                .map_or_else(|| track_ids(&[]), |t| track_ids(&[t.id.as_str()]));
            Some(Target {
                source,
                name: e.snapshot.title.clone(),
                entry: Some(e.entry_id.to_string()),
            })
        }
        "queue" => {
            let q = app.queue.as_ref()?;
            let current = q.index? as usize;
            // -1 is the now-playing row; others count from the entry after it.
            let at = if index < 0 {
                current
            } else {
                current + 1 + index as usize
            };
            q.entries
                .get(at)
                .map(|e| track(&e.track, Some(e.entry_id.to_string())))
        }
        _ => None,
    }
}

pub fn track_action(
    list: SharedString,
    index: i32,
    action: SharedString,
    playlist_id: SharedString,
) {
    let Some(target) = with_app(|app| track_target(app, &list, index)) else {
        return;
    };
    run_action(&list, index, &action, playlist_id.as_str(), target);
}

pub fn album_action(action: SharedString, playlist_id: SharedString) {
    let target = with_app(|app| {
        let id = app.album_id.clone()?;
        let name = app
            .ui
            .upgrade()
            .map(|ui| ui.get_album().title.to_string())
            .unwrap_or_default();
        Some(Target {
            source: TrackSource::Album { id: source_id(&id) },
            name,
            entry: None,
        })
    });
    if let Some(target) = target {
        run_action("album-header", -1, &action, playlist_id.as_str(), target);
    }
}

fn run_action(list: &str, index: i32, action: &str, playlist_id: &str, target: Target) {
    let api = with_app(|app| app.api.clone());
    // A missing playlist entry has no track to queue or copy.
    let empty = matches!(&target.source, TrackSource::Tracks { track_ids } if track_ids.is_empty());
    match action {
        "next" | "end" if !empty => {
            let next = action == "next";
            let what = target.name.clone();
            let source = target.source;
            queue_op(Then::Show, move |api| api.add_to_queue(source, next));
            with_app(|app| {
                set_status(
                    app,
                    &format!(
                        "{} “{what}”",
                        if next { "Playing next:" } else { "Queued:" }
                    ),
                )
            });
        }
        "playlist" if !empty => {
            let pid = playlist_id.to_string();
            let source = target.source;
            background(
                move || api.add_to_playlist(&pid, source),
                |p| {
                    with_app(|app| set_status(app, &format!("Added to “{}”", p.name)));
                    playlist_changed(p, false);
                },
            );
        }
        "new-playlist" if !empty => {
            let name = with_app(|app| fresh_name(app, &target.name));
            let source = target.source;
            background(
                move || {
                    let p = api.create_playlist(&name, vec![])?;
                    api.add_to_playlist(&p.id, source)
                },
                |p| playlist_changed(p, true),
            );
        }
        "remove" => match (list, target.entry) {
            ("playlist", Some(entry)) => {
                let Some(pid) = with_app(|app| app.playlist.as_ref().map(|p| p.id.to_string()))
                else {
                    return;
                };
                background(
                    move || api.remove_from_playlist(&pid, &entry),
                    |p| playlist_changed(p, false),
                );
            }
            ("queue", Some(entry)) => {
                queue_op(Then::PlayIfChanged, move |api| {
                    api.remove_from_queue(&entry)
                });
            }
            _ => {}
        },
        "up" | "down" => {
            let (Some(entry), Some(pid)) = (
                target.entry,
                with_app(|app| app.playlist.as_ref().map(|p| p.id.to_string())),
            ) else {
                return;
            };
            let to = if action == "up" {
                index.saturating_sub(1).max(0)
            } else {
                index + 1
            } as usize;
            background(
                move || api.move_playlist_entry(&pid, &entry, to),
                |p| playlist_changed(p, false),
            );
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------- queue

/// Mirrors the server's queue state into the transport controls, queue page and now-playing marks.
pub fn sync_queue_ui(app: &mut App) {
    // Shuffle or a new queue can change which ReplayGain (album or track) applies.
    super::playback::apply_replaygain(app);
    super::playback::revalidate_preload(app);
    let Some(ui) = app.ui.upgrade() else { return };
    let Some(q) = &app.queue else { return };
    ui.set_shuffle(q.shuffle);
    let name = q
        .origin
        .as_ref()
        .and_then(|o| o.name.as_deref())
        .unwrap_or_default();
    ui.set_shuffle_label(
        match q.shuffle_scope {
            None => String::new(),
            Some(types::ShuffleScope::Library) => "Whole library".into(),
            Some(types::ShuffleScope::Album) => format!("Album: {name}"),
            Some(types::ShuffleScope::Artist) => format!("Artist: {name}"),
            Some(types::ShuffleScope::Genre) => format!("Genre: {name}"),
        }
        .into(),
    );
    ui.set_repeat(repeat_mode(q.repeat));
    ui.set_queue_origin(
        q.origin
            .as_ref()
            .and_then(|o| o.name.clone())
            .unwrap_or_default()
            .into(),
    );

    let row = |i: usize, t: &types::Track, playing: bool| TrackItem {
        number: (i + 1).to_string().into(),
        title: t.title.clone().into(),
        artist: format!("{} · {}", t.artist_name, t.album_title).into(),
        duration: fmt_duration(t.duration_ms).into(),
        playing,
        available: true,
    };
    let current = q.index.map(|i| i as usize);
    let now: Vec<TrackItem> = current
        .and_then(|i| q.entries.get(i))
        .map(|e| row(0, &e.track, true))
        .into_iter()
        .collect();
    let next: Vec<TrackItem> = q
        .entries
        .iter()
        .skip(current.map_or(0, |i| i + 1))
        .enumerate()
        .map(|(i, e)| row(i, &e.track, false))
        .collect();
    ui.set_queue_now(ModelRc::new(VecModel::from(now)));
    ui.set_queue_next(ModelRc::new(VecModel::from(next)));
}

pub fn show_queue() {
    with_app(|app| {
        let Some(ui) = app.ui.upgrade() else { return };
        if ui.get_page() == Page::Queue {
            ui.set_page(app.page_before_queue);
        } else {
            app.page_before_queue = ui.get_page();
            ui.set_page(Page::Queue);
        }
    });
}

pub fn jump_in_queue(index: i32) {
    let entry = with_app(|app| {
        let q = app.queue.as_ref()?;
        let at = q.index.map_or(0, |i| i as usize + 1) + index.max(0) as usize;
        q.entries.get(at).map(|e| e.entry_id.to_string())
    });
    if let Some(entry) = entry {
        queue_op(Then::Play, move |api| api.jump_in_queue(&entry));
    }
}

pub fn clear_queue() {
    queue_op(Then::PlayIfChanged, |api| api.clear_queue());
}
