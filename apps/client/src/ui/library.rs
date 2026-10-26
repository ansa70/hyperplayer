//! Playlists, the queue view, and the ⋯ menu actions on tracks and albums.

use std::{rc::Rc, time::Duration};

use hyperplayer::api::types::{self, TrackSource};
use slint::{Image, Model, ModelRc, SharedString, Timer, VecModel};

use super::{
    AddItem, App, Page, PlaylistItem, PlaylistView, TrackItem, background, current_track,
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
                smart: p.rules.is_some(),
            })
            .collect();
        let editable: Vec<PlaylistItem> = items.iter().filter(|p| !p.smart).cloned().collect();
        ui.set_playlists(Rc::new(VecModel::from(items)).into());
        ui.set_editable_playlists(Rc::new(VecModel::from(editable)).into());
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
    let tracks = match p.matching {
        Some(all) if all > p.track_count => {
            format!(
                "Smart · {} of {all} matching",
                plural(p.track_count, "track")
            )
        }
        Some(_) => format!("Smart · {}", plural(p.track_count, "track")),
        None => plural(p.track_count, "track"),
    };
    ui.set_playlist(PlaylistView {
        id: p.id.to_string().into(),
        name: p.name.clone().into(),
        meta: format!("{tracks} · {}", fmt_duration(p.duration_ms)).into(),
        cover: if same {
            previous_cover.cover
        } else {
            Image::default()
        },
    });
    ui.set_playlist_tracks(Rc::new(VecModel::from(rows)).into());
    if !same {
        // Another playlist: its own search starts empty.
        app.playlist_search_seq += 1;
        ui.set_playlist_add_query("".into());
        ui.set_playlist_add_message("".into());
        show_add_results(&ui, None);
    }
    ui.set_selected_playlist_id(p.id.to_string().into());
    if open {
        ui.set_page(Page::Playlist);
    }
    super::smart::show(app, &ui, &p, open && !same);
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

/// Debounce for the playlist page's search-as-you-type.
const ADD_SEARCH_DELAY: Duration = Duration::from_millis(250);
/// Results per kind: enough to pick from, few enough to see the playlist below.
const ADD_SEARCH_LIMIT: u32 = 6;

/// Typing in the playlist page's search: finds what could be added.
pub fn playlist_add_search(text: SharedString) {
    let seq = with_app(|app| {
        app.playlist_search_seq += 1;
        if let Some(ui) = app.ui.upgrade() {
            ui.set_playlist_add_pending(true);
            ui.set_playlist_add_message("".into());
        }
        app.playlist_search_seq
    });
    let query = text.trim().to_string();
    if query.is_empty() {
        return;
    }
    Timer::single_shot(ADD_SEARCH_DELAY, move || {
        // Typing continued: a newer search supersedes this one.
        if with_app(|app| app.playlist_search_seq) != seq {
            return;
        }
        let api = with_app(|app| app.api.clone());
        background(
            move || api.search(&query, ADD_SEARCH_LIMIT),
            move |results| {
                with_app(|app| {
                    if app.playlist_search_seq == seq
                        && let Some(ui) = app.ui.upgrade()
                    {
                        show_add_results(&ui, Some(&results));
                    }
                })
            },
        );
    });
}

fn show_add_results(ui: &super::AppWindow, results: Option<&types::SearchResults>) {
    let model = |items: Vec<AddItem>| ModelRc::new(VecModel::from(items));
    let Some(r) = results else {
        for set in [
            super::AppWindow::set_playlist_add_tracks,
            super::AppWindow::set_playlist_add_albums,
            super::AppWindow::set_playlist_add_artists,
            super::AppWindow::set_playlist_add_genres,
        ] {
            set(ui, model(Vec::new()));
        }
        return;
    };
    let item = |id: &str, title: &str, detail: String| AddItem {
        id: id.into(),
        title: title.into(),
        detail: detail.into(),
    };
    ui.set_playlist_add_tracks(model(
        r.tracks
            .iter()
            .map(|t| {
                item(
                    &t.id,
                    &t.title,
                    format!("{} · {}", t.artist_name, t.album_title),
                )
            })
            .collect(),
    ));
    ui.set_playlist_add_albums(model(
        r.albums
            .iter()
            .map(|a| {
                let year = a.year.map(|y| format!(" · {y}")).unwrap_or_default();
                item(
                    &a.id,
                    &a.title,
                    format!(
                        "{}{year} · {}",
                        a.artist_name,
                        plural(a.track_count, "track")
                    ),
                )
            })
            .collect(),
    ));
    ui.set_playlist_add_artists(model(
        r.artists
            .iter()
            .map(|a| item(&a.id, &a.name, plural(a.track_count, "track")))
            .collect(),
    ));
    ui.set_playlist_add_genres(model(
        r.genres
            .iter()
            .map(|g| item(&g.name, &g.name, plural(g.track_count, "track")))
            .collect(),
    ));
    ui.set_playlist_add_pending(false);
}

/// A "+ Add" in the playlist page's search: adds that track, album, artist or genre.
pub fn playlist_add(kind: SharedString, id: SharedString, title: SharedString) {
    let source = match kind.as_str() {
        "track" => track_ids(&[id.as_str()]),
        "album" => TrackSource::Album { id: source_id(&id) },
        "artist" => TrackSource::Artist { id: source_id(&id) },
        _ => TrackSource::Genre {
            name: id.to_string().try_into().expect("genre name"),
        },
    };
    let Some((api, pid, before)) = with_app(|app| {
        let p = app.playlist.as_ref()?;
        Some((app.api.clone(), p.id.to_string(), p.track_count))
    }) else {
        return;
    };
    background(
        move || api.add_to_playlist(&pid, source),
        move |p| {
            let added = p.track_count - before;
            with_app(|app| {
                if let Some(ui) = app.ui.upgrade() {
                    ui.set_playlist_add_message(
                        format!("Added “{title}”: {}", plural(added, "track")).into(),
                    );
                }
            });
            playlist_changed(p, false);
        },
    );
}

/// The playing track changed: move the playlist page's mark, in place (a new model would
/// lose the list's scroll position).
pub fn refresh_playlist_playing(app: &App, ui: &super::AppWindow, playing: Option<&str>) {
    let Some(p) = &app.playlist else { return };
    let rows = ui.get_playlist_tracks();
    for (i, e) in p.entries.iter().enumerate() {
        let now = e
            .track
            .as_ref()
            .is_some_and(|t| Some(t.id.as_str()) == playing);
        if let Some(mut row) = rows.row_data(i)
            && row.playing != now
        {
            row.playing = now;
            rows.set_row_data(i, row);
        }
    }
}

/// After a playlist changed on the server: refresh the sidebar and, if open, the page.
pub fn playlist_changed(p: types::Playlist, open: bool) {
    with_app(|app| show_playlist(app, p, open));
    load_playlists();
}

/// "New playlist", "New playlist 2", … whichever is free.
pub fn fresh_name(app: &App, base: &str) -> String {
    let taken = |n: &str| app.playlists.iter().any(|p| p.name == n);
    if !taken(base) {
        return base.to_string();
    }
    (2..)
        .map(|i| format!("{base} {i}"))
        .find(|n| !taken(n))
        .expect("a free name")
}

/// The sidebar's "+": an empty playlist, or a smart one from a template (see smart.rs).
pub fn new_playlist(kind: SharedString) {
    let smart = super::smart::template(&kind);
    let base = smart.as_ref().map_or("New playlist", |(name, _)| name);
    let (api, name) = with_app(|app| (app.api.clone(), fresh_name(app, base)));
    background(
        move || match smart {
            Some((_, rules)) => api.create_smart_playlist(&name, rules),
            None => api.create_playlist(&name, vec![]),
        },
        |p| playlist_changed(p, true),
    );
}

pub fn play_playlist(index: i32) {
    let Some((source, start)) = with_app(|app| {
        let p = app.playlist.as_ref()?;
        // The server skips missing entries, so count only playable ones before the clicked row.
        let start = p
            .entries
            .iter()
            .take(index.max(0) as usize)
            .filter(|e| e.track.is_some())
            .count();
        Some((shown_playlist(p), start))
    }) else {
        return;
    };
    play_from(source, start, Some(false));
}

/// The playlist as shown: a smart one's rules may pick differently on the server (random
/// order), so it gets the tracks on screen.
fn shown_playlist(p: &types::Playlist) -> TrackSource {
    let track_ids = match p.rules {
        Some(_) => p
            .entries
            .iter()
            .filter_map(|e| e.track.as_ref().map(|t| t.id.clone()))
            .collect(),
        None => vec![],
    };
    TrackSource::Playlist {
        id: p.id.clone(),
        track_ids,
    }
}

/// The playlist's own Shuffle: the shuffle button's playlist scope, for this playlist.
pub fn shuffle_playlist() {
    if let Some(source) = with_app(|app| app.playlist.as_ref().map(shown_playlist)) {
        queue_op(Then::Play, move |api| {
            api.shuffle_queue(source, types::ShuffleScope::Playlist)
        });
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
    // Also called when the field loses focus, usually unchanged.
    let unchanged = with_app(|app| app.playlist.as_ref().is_some_and(|p| p.name == name));
    if name.is_empty() || unchanged {
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
            Some(types::ShuffleScope::Playlist) => format!("Playlist: {name}"),
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
