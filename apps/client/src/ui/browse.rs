//! Library browsing: artists, albums, search and the now-playing panel.

use std::time::Duration;

use hyperplayer::api::types;
use slint::{Image, SharedString, Timer};

use super::{
    AlbumView, App, ArtistView, NowPlayingView, Page, background, current_track,
    models::{
        accent, album_model, artist_meta, artist_model, credit_model, fmt_duration, load_image,
        member_model, plural, quality, search_track_model, track_model,
    },
    with_app,
};

pub fn load_artists() {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.artists(0, 500),
        |page| {
            with_app(|app| {
                let Some(ui) = app.ui.upgrade() else { return };
                ui.set_artists(artist_model(app, &page.items, |ui| ui.get_artists()));
                ui.set_status(format!("{} on server", plural(page.total, "artist")).into());
            })
        },
    );
}

/// Debounce for search-as-you-type.
const SEARCH_DELAY: Duration = Duration::from_millis(250);

pub fn search_changed(text: SharedString) {
    let seq = with_app(|app| {
        app.search_seq += 1;
        app.search_seq
    });
    let query = text.trim().to_string();
    if query.is_empty() {
        with_app(|app| {
            if let Some(ui) = app.ui.upgrade()
                && ui.get_page() == Page::Search
            {
                ui.set_page(app.page_before_search);
            }
        });
        return;
    }
    Timer::single_shot(SEARCH_DELAY, move || {
        // Typing continued: a newer search supersedes this one.
        if with_app(|app| app.search_seq) != seq {
            return;
        }
        let api = with_app(|app| app.api.clone());
        let q = query.clone();
        background(
            move || api.search(&q, 24),
            move |results| {
                with_app(|app| {
                    let Some(ui) = app.ui.upgrade() else { return };
                    if app.search_seq != seq {
                        return;
                    }
                    if ui.get_page() != Page::Search {
                        app.page_before_search = ui.get_page();
                    }
                    ui.set_search_query(query.clone().into());
                    ui.set_search_artists(artist_model(app, &results.artists, |ui| {
                        ui.get_search_artists()
                    }));
                    ui.set_search_albums(album_model(
                        app,
                        &results.albums,
                        |a| {
                            [a.artist_name.clone()]
                                .into_iter()
                                .chain(a.year.map(|y| y.to_string()))
                                .collect::<Vec<_>>()
                                .join(" · ")
                        },
                        |ui| ui.get_search_albums(),
                    ));
                    let playing = current_track(app).map(|t| t.id.to_string());
                    ui.set_search_tracks(search_track_model(&results.tracks, playing.as_deref()));
                    app.search_tracks = results.tracks;
                    ui.set_page(Page::Search);
                })
            },
        );
    });
}

pub fn select_artist(id: SharedString) {
    let api = with_app(|app| app.api.clone());
    if let Some(ui) = with_app(|app| app.ui.upgrade()) {
        ui.set_selected_artist_id(id.clone());
    }
    let artist_id = id.to_string();
    background(
        move || Ok((api.artist(&artist_id)?, api.artist_albums(&artist_id)?)),
        move |(artist, albums)| {
            with_app(|app| {
                let Some(ui) = app.ui.upgrade() else { return };
                ui.set_artist(ArtistView {
                    id: id.clone(),
                    name: artist.name.clone().into(),
                    stats: format!(
                        "{} · {}",
                        plural(artist.album_count, "album"),
                        plural(artist.track_count, "track")
                    )
                    .into(),
                    genres: artist.genres.join(" · ").into(),
                    meta: artist_meta(&artist).into(),
                    biography: artist.biography.clone().unwrap_or_default().into(),
                    image: Image::default(),
                });
                ui.set_artist_members(member_model(&artist.members, ""));
                ui.set_artist_albums(album_model(
                    app,
                    &albums.0,
                    |a| a.year.map(|y| y.to_string()).unwrap_or_default(),
                    |ui| ui.get_artist_albums(),
                ));
                ui.set_page(Page::Artist);
                load_image(
                    app,
                    artist.image.as_ref(),
                    360,
                    false,
                    Box::new(move |ui, img| {
                        let mut v = ui.get_artist();
                        if v.id == id {
                            v.image = img;
                            ui.set_artist(v);
                        }
                    }),
                );
            })
        },
    );
}

pub fn select_album(id: SharedString) {
    let api = with_app(|app| app.api.clone());
    let album_id = id.to_string();
    background(
        move || api.album(&album_id),
        move |album| {
            with_app(|app| {
                let Some(ui) = app.ui.upgrade() else { return };
                let playing = current_track(app).map(|t| t.id.to_string());
                ui.set_album(AlbumView {
                    id: id.clone(),
                    title: album.title.clone().into(),
                    artist: album.artist_name.clone().into(),
                    meta: [
                        album.year.map(|y| y.to_string()),
                        Some(plural(album.track_count, "track")),
                        Some(fmt_duration(album.duration_ms)),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · ")
                    .into(),
                    genres: album.genres.join(" · ").into(),
                    cover: Image::default(),
                });
                ui.set_selected_artist_id(album.artist_id.to_string().into());
                ui.set_album_tracks(track_model(&album.tracks, playing.as_deref()));
                ui.set_page(Page::Album);
                load_image(
                    app,
                    album.cover.as_ref(),
                    480,
                    false,
                    Box::new(move |ui, img| {
                        let mut v = ui.get_album();
                        if v.id == id {
                            v.cover = img;
                            ui.set_album(v);
                        }
                    }),
                );
                app.album_tracks = album.tracks;
                app.album_id = Some(album.id.to_string());
            })
        },
    );
}

/// How often, and for how long, to re-fetch now-playing data while the server is still enriching it.
const NP_POLL_INTERVAL: Duration = Duration::from_secs(2);
const NP_MAX_POLLS: u32 = 30;

pub fn fetch_now_playing(track_id: String) {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.now_playing(&track_id),
        move |np| with_app(|app| show_now_playing(app, np)),
    );
}

pub fn show_now_playing(app: &mut App, np: types::NowPlaying) {
    let Some(ui) = app.ui.upgrade() else { return };
    let t = &np.track;
    let track_id: SharedString = (*t.id).clone().into();
    // Ignore responses for a track that is no longer playing.
    if current_track(app).map(|q| q.id.as_str()) != Some(t.id.as_str()) {
        return;
    }
    let previous = ui.get_np();
    let refresh = previous.track_id == track_id;
    let had_banner = refresh && app.np_had_banner;
    app.np_had_banner = np.artist.banner.is_some();
    let pending = np.enrichment == types::EnrichmentState::Pending;

    let cover = t.cover.as_ref().or(np.album.cover.as_ref());
    ui.set_np(NowPlayingView {
        active: true,
        track_id: track_id.clone(),
        title: t.title.clone().into(),
        artist: t.artist_name.clone().into(),
        album: np.album.title.clone().into(),
        year: t
            .year
            .or(np.album.year)
            .map(|y| y.to_string())
            .unwrap_or_default()
            .into(),
        format: t.format.codec.to_uppercase().into(),
        quality: quality(&t.format).into(),
        genres: np.artist.genres.join(" · ").into(),
        artist_id: np.artist.id.to_string().into(),
        artist_meta: artist_meta(&np.artist).into(),
        biography: np.artist.biography.clone().unwrap_or_default().into(),
        loading_details: pending,
        // A refresh only adds details: keep the images already on screen.
        cover: if refresh {
            previous.cover
        } else {
            Image::default()
        },
        backdrop: if refresh {
            previous.backdrop
        } else {
            Image::default()
        },
        accent: accent(cover),
    });
    ui.set_credits(credit_model(&np.credits));
    ui.set_np_members(member_model(&np.artist.members, "MEMBERS"));

    if pending && app.np_polls < NP_MAX_POLLS {
        app.np_polls += 1;
        let id = t.id.to_string();
        Timer::single_shot(NP_POLL_INTERVAL, move || {
            let current = with_app(|app| current_track(app).map(|q| q.id.to_string()));
            if current.as_deref() == Some(id.as_str()) {
                fetch_now_playing(id);
            }
        });
    }
    if refresh && (had_banner || np.artist.banner.is_none()) {
        return;
    }
    ui.set_duration(t.duration_ms as f32 / 1000.0);
    ui.set_duration_text(fmt_duration(t.duration_ms).into());
    ui.set_more_from(album_model(
        app,
        &np.more_from_artist,
        |a| a.year.map(|y| y.to_string()).unwrap_or_default(),
        |ui| ui.get_more_from(),
    ));

    let id = track_id.clone();
    if !refresh {
        load_image(
            app,
            cover,
            720,
            false,
            Box::new(move |ui, img| {
                let mut v = ui.get_np();
                if v.track_id == id {
                    v.cover = img;
                    ui.set_np(v);
                }
            }),
        );
    }
    let backdrop = np.artist.banner.as_ref().or(cover);
    load_image(
        app,
        backdrop,
        64,
        true,
        Box::new(move |ui, img| {
            let mut v = ui.get_np();
            if v.track_id == track_id {
                v.backdrop = img;
                ui.set_np(v);
            }
        }),
    );
}
