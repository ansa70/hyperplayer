//! Internet radio: the Radio page (the server's station directory, favourites, stations
//! added by address) and playing a station live. A station plays outside the queue:
//! starting one pauses the queue where it is, and "back to the queue" picks it up again.

use std::{
    thread,
    time::{Duration, Instant},
};

use hyperplayer::{
    adaptive::Mode,
    api::{ServerError, types},
    pipeline::PipelineHandle,
    playback,
    stream::StreamHandle,
    tr,
};
use slint::{Image, Model, ModelRc, SharedString, Timer, VecModel};

use super::{
    App, AppWindow, NowPlayingView, Page, StationItem, current_track,
    models::{accent, load_radio_logo},
    set_status, with_app,
};

/// Stations per page of the directory.
const PAGE: usize = 50;
/// Genres offered in the filter.
const TAGS: usize = 60;
/// How often the song a station plays is asked for.
const POLL_EVERY: Duration = Duration::from_secs(15);
/// The first time, sooner: the server reads it from the stream once it's flowing.
const FIRST_POLL: Duration = Duration::from_secs(3);
/// Typing in the search box searches once it stops for this long.
const SEARCH_DELAY: Duration = Duration::from_millis(350);
/// A station that stops is reconnected this many times in a row before giving up.
const RECONNECTS: u32 = 3;
const LOGO_ROW: u32 = 96;
const LOGO_LARGE: u32 = 512;

pub struct Radio {
    favourites: Vec<types::RadioStation>,
    stations: Vec<types::RadioStation>,
    /// The filters' choices; index 0 in the UI is "all", so entry `i` is shown at `i + 1`.
    countries: Vec<types::RadioFacet>,
    tags: Vec<types::RadioFacet>,
    query: String,
    country: usize,
    tag: usize,
    order: types::RadioOrder,
    more: bool,
    /// Bumped per search; only the latest one's results are shown.
    seq: u64,
    loaded: bool,
    page_before: Page,
    live: Option<Live>,
    /// Bumped whenever a station starts or stops; an older opening's result is dropped.
    generation: u64,
}

impl Default for Radio {
    fn default() -> Self {
        Self {
            favourites: Vec::new(),
            stations: Vec::new(),
            countries: Vec::new(),
            tags: Vec::new(),
            query: String::new(),
            country: 0,
            tag: 0,
            order: types::RadioOrder::Popular,
            more: false,
            seq: 0,
            loaded: false,
            page_before: Page::Welcome,
            live: None,
            generation: 0,
        }
    }
}

/// The station that's the current thing playing (or paused: then without a session).
struct Live {
    station: types::RadioStation,
    session: Option<LiveSession>,
    /// Opening its stream.
    connecting: bool,
    title: Option<String>,
    /// When it started playing, for the elapsed time shown.
    since: Instant,
    next_poll: Instant,
    /// Reconnections in a row since it last played properly.
    failures: u32,
}

struct LiveSession {
    pipeline: PipelineHandle,
    stream: StreamHandle,
    opened: Instant,
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.pipeline.stop();
        self.stream.cancel();
    }
}

// ------------------------------------------------------------------ queries

/// A station is the current thing (playing, paused or connecting).
pub fn is_live(app: &App) -> bool {
    app.radio.live.is_some()
}

pub fn is_playing(app: &App) -> bool {
    app.radio
        .live
        .as_ref()
        .is_some_and(|l| l.session.is_some() || l.connecting)
}

pub fn pipeline(radio: &Radio) -> Option<&PipelineHandle> {
    radio.live.as_ref()?.session.as_ref().map(|s| &s.pipeline)
}

/// For the desktop's media controls: an id that changes with the song, the title, the
/// station's name, and whether it plays.
pub fn desktop_info(app: &App) -> Option<(String, String, String, bool)> {
    let live = app.radio.live.as_ref()?;
    let title = live
        .title
        .clone()
        .unwrap_or_else(|| live.station.name.clone());
    Some((
        format!("radio:{}:{title}", *live.station.id),
        title,
        live.station.name.clone(),
        live.session.is_some(),
    ))
}

// ------------------------------------------------------------------ the page

pub fn toggle_page() {
    let open = with_app(|app| {
        let ui = app.ui.upgrade()?;
        if ui.get_page() == Page::Radio {
            ui.set_page(app.radio.page_before);
            None
        } else {
            app.radio.page_before = ui.get_page();
            ui.set_page(Page::Radio);
            Some(!app.radio.loaded)
        }
    });
    if open == Some(true) {
        load();
    }
}

/// Runs `work` in the background and `done` with its result; a failure is shown on the
/// Radio page (a server without radio says so plainly).
fn request<T: Send + 'static>(
    work: impl FnOnce(&hyperplayer::api::Api) -> anyhow::Result<T> + Send + 'static,
    done: impl FnOnce(&mut App, &AppWindow, T) + Send + 'static,
) {
    let api = with_app(|app| app.api.clone());
    thread::spawn(move || {
        let result = work(&api);
        let _ = slint::invoke_from_event_loop(move || {
            with_app(|app| {
                let Some(ui) = app.ui.upgrade() else { return };
                match result {
                    Ok(value) => done(app, &ui, value),
                    Err(err) => {
                        eprintln!("radio: {err:#}");
                        // An older server has no such route (its 404 isn't one of ours).
                        let missing = match err.downcast_ref::<ServerError>() {
                            Some(e) => {
                                e.status == reqwest::StatusCode::NOT_FOUND && e.code != "not_found"
                            }
                            None => format!("{err:#}").contains(": 404"),
                        };
                        ui.set_radio_loading(false);
                        ui.set_radio_message(
                            if missing {
                                tr!("This server doesn't offer radio yet: it needs HyperPlayer 0.7 or newer.").to_string()
                            } else if err.downcast_ref::<ServerError>().is_some_and(|e| e.code == "radio_directory_unavailable") {
                                tr!("The radio directory can't be reached right now. Your favourites still play.").to_string()
                            } else {
                                format!("{err:#}")
                            }
                            .into(),
                        );
                    }
                }
            })
        });
    });
}

/// Runs `f` once the current callback has returned the app (`request`'s `done` holds it).
fn later(f: impl FnOnce() + 'static) {
    Timer::single_shot(Duration::ZERO, f);
}

/// Favourites, the filters' choices and the first page of stations.
pub fn load() {
    with_app(|app| app.radio.loaded = true);
    load_favourites();
    request(
        |api| Ok((api.radio_countries()?, api.radio_tags(TAGS)?)),
        |app, ui, (countries, tags)| {
            app.radio.countries = countries.items;
            app.radio.tags = tags.items;
            // The system's country first, when the directory has it.
            if let Some(code) = sys_locale::get_locale()
                .and_then(|l| l.split(['-', '_']).nth(1).map(|c| c.to_uppercase()))
                && app.radio.country == 0
                && let Some(i) = app.radio.countries.iter().position(|c| c.value == code)
            {
                app.radio.country = i + 1;
            }
            show_filters(app, ui);
            later(|| search(true));
        },
    );
}

fn show_filters(app: &App, ui: &AppWindow) {
    let names = |all: String, facets: &[types::RadioFacet]| {
        let mut v: Vec<SharedString> = vec![all.into()];
        v.extend(facets.iter().map(|f| SharedString::from(f.label.as_str())));
        ModelRc::new(VecModel::from(v))
    };
    ui.set_radio_countries(names(
        tr!("All countries").to_string(),
        &app.radio.countries,
    ));
    ui.set_radio_tags(names(tr!("All genres").to_string(), &app.radio.tags));
    ui.set_radio_country(app.radio.country as i32);
    ui.set_radio_tag(app.radio.tag as i32);
    ui.set_radio_order(match app.radio.order {
        types::RadioOrder::Trending => 1,
        _ => 0,
    });
}

fn load_favourites() {
    request(
        |api| api.radio_favourites(),
        |app, ui, list| {
            app.radio.favourites = list.items;
            // The directory's pages say which stations are favourites too.
            let favourite = |id: &str| app.radio.favourites.iter().any(|f| *f.id == id);
            let flags: Vec<bool> = app
                .radio
                .stations
                .iter()
                .map(|s| favourite(&s.id))
                .collect();
            for (s, f) in app.radio.stations.iter_mut().zip(flags) {
                s.favourite = f;
            }
            if let Some(live) = app.radio.live.as_mut() {
                live.station.favourite =
                    app.radio.favourites.iter().any(|f| f.id == live.station.id);
            }
            show_lists(app, ui);
            show_live(app);
        },
    );
}

/// Searches the directory with the current filters: from the top (`reset`), or the next page.
pub fn search(reset: bool) {
    let (seq, query, country, tag, order, offset) = with_app(|app| {
        let r = &mut app.radio;
        r.seq += 1;
        if let Some(ui) = app.ui.upgrade() {
            ui.set_radio_loading(true);
            ui.set_radio_message(SharedString::new());
        }
        let r = &app.radio;
        let pick = |facets: &[types::RadioFacet], i: usize| {
            i.checked_sub(1)
                .and_then(|i| facets.get(i))
                .map(|f| f.value.clone())
                .unwrap_or_default()
        };
        (
            r.seq,
            r.query.clone(),
            pick(&r.countries, r.country),
            pick(&r.tags, r.tag),
            r.order,
            if reset { 0 } else { r.stations.len() },
        )
    });
    request(
        move |api| api.radio_search(&query, &country, &tag, order, offset, PAGE),
        move |app, ui, page| {
            if app.radio.seq != seq {
                return;
            }
            if reset {
                app.radio.stations = page.items;
            } else {
                // A page may repeat a station the previous one ended with (the order moves).
                let known: Vec<_> = app.radio.stations.iter().map(|s| s.id.clone()).collect();
                app.radio
                    .stations
                    .extend(page.items.into_iter().filter(|s| !known.contains(&s.id)));
            }
            app.radio.more = page.more;
            ui.set_radio_loading(false);
            ui.set_radio_more(page.more);
            ui.set_radio_message(
                if app.radio.stations.is_empty() {
                    tr!("No stations match.").to_string()
                } else {
                    String::new()
                }
                .into(),
            );
            show_lists(app, ui);
        },
    );
}

pub fn search_changed(text: SharedString) {
    let seq = with_app(|app| {
        app.radio.query = text.trim().to_string();
        app.radio.seq += 1;
        app.radio.seq
    });
    Timer::single_shot(SEARCH_DELAY, move || {
        if with_app(|app| app.radio.seq) == seq {
            search(true);
        }
    });
}

pub fn set_filters(country: i32, tag: i32, order: i32) {
    with_app(|app| {
        app.radio.country = country.max(0) as usize;
        app.radio.tag = tag.max(0) as usize;
        app.radio.order = if order == 1 {
            types::RadioOrder::Trending
        } else {
            types::RadioOrder::Popular
        };
        if let Some(ui) = app.ui.upgrade() {
            show_filters(app, &ui);
        }
    });
    search(true);
}

pub fn load_more() {
    if with_app(|app| app.radio.more) {
        search(false);
    }
}

/// What's known of a station, in a line; `country`: unless the list is of one country.
fn detail(s: &types::RadioStation, country: bool) -> String {
    let mut parts = Vec::new();
    if s.custom {
        parts.push(tr!("Added by you").to_string());
    }
    if let Some(c) = s.country.as_ref().filter(|_| country) {
        parts.push(c.clone());
    }
    if !s.tags.is_empty() {
        parts.push(
            s.tags
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    if let Some(f) = format(s) {
        parts.push(f);
    }
    parts.join(" · ")
}

/// "MP3 128k", or what of it is known.
fn format(s: &types::RadioStation) -> Option<String> {
    match (&s.codec, s.bitrate) {
        (Some(c), Some(b)) => Some(format!("{c} {b}k")),
        (Some(c), None) => Some(c.clone()),
        (None, Some(b)) => Some(format!("{b}k")),
        (None, None) => None,
    }
}

fn item(s: &types::RadioStation, playing: Option<&str>, country: bool) -> StationItem {
    StationItem {
        id: s.id.as_str().into(),
        name: s.name.as_str().into(),
        detail: detail(s, country).into(),
        logo: Image::default(),
        favourite: s.favourite,
        playing: playing == Some(s.id.as_str()),
        custom: s.custom,
    }
}

fn playing_id(app: &App) -> Option<String> {
    app.radio.live.as_ref().map(|l| l.station.id.to_string())
}

/// Shows both lists, then fetches their logos.
fn show_lists(app: &App, ui: &AppWindow) {
    let playing = playing_id(app);
    let model = |list: &[types::RadioStation], country: bool| {
        let items: Vec<StationItem> = list
            .iter()
            .map(|s| item(s, playing.as_deref(), country))
            .collect();
        ModelRc::new(VecModel::from(items))
    };
    ui.set_radio_favourites(model(&app.radio.favourites, true));
    // Filtered by a country, every station would say it.
    ui.set_radio_stations(model(&app.radio.stations, app.radio.country == 0));
    for s in app.radio.favourites.iter().chain(&app.radio.stations) {
        let id: SharedString = s.id.as_str().into();
        load_radio_logo(
            app,
            s,
            LOGO_ROW,
            Box::new(move |ui, image| {
                for list in [ui.get_radio_favourites(), ui.get_radio_stations()] {
                    for i in 0..list.row_count() {
                        if let Some(mut row) = list.row_data(i)
                            && row.id == id
                        {
                            row.logo = image.clone();
                            list.set_row_data(i, row);
                        }
                    }
                }
            }),
            None,
        );
    }
}

/// Marks the playing station in the lists (keeping the logos already there).
fn mark_playing(app: &App, ui: &AppWindow) {
    let playing = playing_id(app);
    for list in [ui.get_radio_favourites(), ui.get_radio_stations()] {
        for i in 0..list.row_count() {
            if let Some(mut row) = list.row_data(i) {
                let now = playing.as_deref() == Some(row.id.as_str());
                if row.playing != now {
                    row.playing = now;
                    list.set_row_data(i, row);
                }
            }
        }
    }
}

fn find(app: &App, id: &str) -> Option<types::RadioStation> {
    app.radio
        .favourites
        .iter()
        .chain(&app.radio.stations)
        .chain(app.radio.live.as_ref().map(|l| &l.station))
        .find(|s| *s.id == id)
        .cloned()
}

pub fn set_favourite(id: SharedString, on: bool) {
    let id = id.to_string();
    request(
        move |api| {
            if on {
                api.add_radio_favourite(&id).map(|_| ())
            } else {
                api.remove_radio_favourite(&id)
            }
        },
        |_, _, ()| later(load_favourites),
    );
}

pub fn add_station(name: SharedString, url: SharedString) {
    let (name, url) = (name.trim().to_string(), url.trim().to_string());
    if name.is_empty() || !(url.starts_with("http://") || url.starts_with("https://")) {
        with_app(|app| {
            if let Some(ui) = app.ui.upgrade() {
                ui.set_radio_message(
                    tr!(
                        "Give the station a name and an address starting with http:// or https://."
                    )
                    .into(),
                );
            }
        });
        return;
    }
    request(
        move |api| api.add_radio_station(&name, &url),
        |_, ui, station| {
            ui.set_radio_message(tr!("{} was added to your favourites.", station.name).into());
            ui.set_radio_adding(false);
            ui.set_radio_add_name(SharedString::new());
            ui.set_radio_add_url(SharedString::new());
            later(load_favourites);
        },
    );
}

pub fn open_homepage() {
    let url = with_app(|app| {
        app.radio
            .live
            .as_ref()
            .and_then(|l| l.station.homepage.clone())
    });
    if let Some(url) = url {
        super::settings::open_in_browser(&url);
    }
}

/// After a language change: the text made here, again.
pub fn relabel() {
    with_app(|app| {
        let Some(ui) = app.ui.upgrade() else { return };
        if app.radio.loaded {
            show_filters(app, &ui);
            show_lists(app, &ui);
            ui.set_radio_message(SharedString::new());
        }
        show_live(app);
    });
}

// ------------------------------------------------------------------ playing

/// The bitrate and whether MP3 stations may come as they are, by the quality mode.
fn quality(app: &App) -> (bool, u32) {
    match app.mode {
        Mode::DataSaver => (false, 96),
        _ => (true, 192),
    }
}

/// Starts a station: the queue pauses where it is.
pub fn play(id: SharedString) {
    let Some(station) = with_app(|app| find(app, &id)) else {
        return;
    };
    // The queue's track stops; its position is kept to resume from.
    let had_session = with_app(|app| {
        let pos = app.session.as_ref().map(|s| s.position());
        if let Some(pos) = pos {
            super::playback::save_position(app);
            app.resume_at = pos;
        }
        pos.is_some()
    });
    if had_session {
        super::playback::stop();
    }
    with_app(|app| {
        if let Some(a) = &app.audio {
            a.stop();
        }
        app.radio.live = Some(Live {
            station,
            session: None,
            connecting: false,
            title: None,
            since: Instant::now(),
            next_poll: Instant::now() + FIRST_POLL,
            failures: 0,
        });
    });
    super::playback::refresh_playing_marks();
    connect();
}

/// Opens the live station's stream and plays it once it's coming.
fn connect() {
    let Some((api, id, direct, kbps, generation)) = with_app(|app| {
        let (direct, kbps) = quality(app);
        app.radio.generation += 1;
        let generation = app.radio.generation;
        let live = app.radio.live.as_mut()?;
        live.session = None;
        live.connecting = true;
        let id = live.station.id.to_string();
        let api = app.api.clone();
        show_live(app);
        Some((api, id, direct, kbps, generation))
    }) else {
        return;
    };
    thread::spawn(move || {
        let opened = playback::open_live(&api, &id, direct, kbps);
        let _ = slint::invoke_from_event_loop(move || {
            with_app(|app| {
                if app.radio.generation != generation {
                    return; // stopped or another station meanwhile
                }
                let Some(live) = app.radio.live.as_mut() else {
                    return;
                };
                live.connecting = false;
                let opened = match opened {
                    Ok(o) => o,
                    Err(err) => {
                        let name = live.station.name.clone();
                        show_live(app);
                        return set_status(
                            app,
                            &tr!("Cannot play {}: {}", name, format!("{err:#}")),
                        );
                    }
                };
                let Some(audio) = &app.audio else {
                    return set_status(app, tr!("No audio output device"));
                };
                if let Err(e) = audio.play(opened.source) {
                    return set_status(app, &format!("{e:#}"));
                }
                if live.failures == 0 {
                    live.since = Instant::now();
                }
                live.session = Some(LiveSession {
                    pipeline: opened.pipeline,
                    stream: opened.stream,
                    opened: Instant::now(),
                });
                set_status(app, "");
                show_live(app);
            })
        });
    });
}

/// Play/pause while a station is the current thing: pausing hangs up (live radio
/// doesn't wait), playing reconnects. Returns false when no station is.
pub fn toggle() -> bool {
    let playing = with_app(|app| {
        app.radio
            .live
            .as_ref()
            .map(|l| l.session.is_some() || l.connecting)
    });
    match playing {
        None => false,
        Some(true) => {
            with_app(|app| {
                app.radio.generation += 1;
                if let Some(live) = app.radio.live.as_mut() {
                    live.session = None;
                    live.connecting = false;
                }
                if let Some(a) = &app.audio {
                    a.stop();
                }
                show_live(app);
            });
            true
        }
        Some(false) => {
            with_app(|app| {
                if let Some(live) = app.radio.live.as_mut() {
                    live.failures = 0;
                    live.since = Instant::now();
                }
            });
            connect();
            true
        }
    }
}

/// Stops the station, if one is the current thing, and shows the queue's track again.
pub fn leave() {
    let left = with_app(|app| {
        let live = app.radio.live.take()?;
        app.radio.generation += 1;
        if live.session.is_some()
            && let Some(a) = &app.audio
        {
            a.stop();
        }
        drop(live);
        let ui = app.ui.upgrade()?;
        ui.set_radio_live(false);
        mark_playing(app, &ui);
        match current_track(app) {
            Some(t) => Some(Some(t.id.to_string())),
            None => {
                ui.set_np(NowPlayingView::default());
                ui.set_position(0.0);
                ui.set_position_text("0:00".into());
                ui.set_duration_text("0:00".into());
                Some(None)
            }
        }
    });
    if left.is_some() {
        super::playback::refresh_playing_marks();
    }
    if let Some(Some(id)) = left {
        // The panel, the bar and the window's colours follow the queue's track again.
        with_app(|app| {
            if let Some(ui) = app.ui.upgrade() {
                ui.set_position(app.resume_at.as_secs_f32());
                ui.set_position_text(
                    super::models::fmt_duration(app.resume_at.as_millis() as i64).into(),
                );
            }
        });
        super::browse::fetch_now_playing(id);
    }
}

/// "Back to the queue": the station stops and the queue plays on from where it was.
pub fn back_to_queue() {
    leave();
    let at = with_app(|app| current_track(app).map(|_| app.resume_at));
    if let Some(at) = at {
        super::playback::play_current(at);
    }
}

/// Shows the live station in the bar and the panel.
fn show_live(app: &mut App) {
    let Some(ui) = app.ui.upgrade() else { return };
    let Some(live) = app.radio.live.as_ref() else {
        return;
    };
    let (connecting, connected) = (live.connecting, live.session.is_some());
    let station = live.station.clone();
    let s = &station;
    let previous = ui.get_np();
    let track_id: SharedString = format!("radio:{}", *s.id).into();
    let same = previous.track_id == track_id;
    let song = live.title.clone().unwrap_or_default();
    ui.set_radio_live(true);
    ui.set_radio_can_go_back(current_track(app).is_some());
    ui.set_radio_now(StationItem {
        logo: if same {
            ui.get_radio_now().logo
        } else {
            Image::default()
        },
        ..item(s, Some(s.id.as_str()), true)
    });
    ui.set_radio_song(song.as_str().into());
    ui.set_radio_homepage(s.homepage.clone().unwrap_or_default().into());
    ui.set_radio_place(
        [
            s.country.clone().unwrap_or_default(),
            s.languages.join(", "),
        ]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
        .into(),
    );
    ui.set_radio_genres(s.tags.join(" · ").into());
    ui.set_np(NowPlayingView {
        active: true,
        track_id: track_id.clone(),
        title: if song.is_empty() {
            s.name.as_str().into()
        } else {
            song.as_str().into()
        },
        artist: if song.is_empty() {
            detail(s, true).into()
        } else {
            s.name.as_str().into()
        },
        album: SharedString::new(),
        year: SharedString::new(),
        format: s.codec.clone().unwrap_or_else(|| "LIVE".into()).into(),
        quality: s
            .bitrate
            .map(|b| format!("{b} kbit/s"))
            .unwrap_or_default()
            .into(),
        genres: s.tags.join(" · ").into(),
        artist_id: SharedString::new(),
        artist_meta: SharedString::new(),
        biography: SharedString::new(),
        loading_details: false,
        cover: if same {
            previous.cover
        } else {
            Image::default()
        },
        backdrop: Image::default(),
        accent: accent(None),
    });
    ui.set_waveform_ready(false);
    ui.set_duration(0.0);
    ui.set_duration_text(SharedString::new());
    let status = if connecting {
        tr!("Connecting…").to_string()
    } else if connected {
        tr!("LIVE").to_string()
    } else {
        tr!("Stopped").to_string()
    };
    ui.set_radio_live_text(status.into());
    ui.set_stream_info(
        format(s)
            .map(|f| format!("{f} · {}", tr!("Radio")))
            .unwrap_or_else(|| tr!("Radio").to_string())
            .into(),
    );
    mark_playing(app, &ui);
    if !same {
        // The previous track's lyrics don't go with a station.
        ui.set_lyrics_state(super::LyricsState::None);
        ui.set_lyrics_lines(ModelRc::default());
        super::appearance::cover_changed(app, None);
        super::appearance::backdrop_changed(app, &Image::default());
        let id = track_id.clone();
        load_radio_logo(
            app,
            s,
            LOGO_LARGE,
            Box::new(move |ui, image| {
                let mut np = ui.get_np();
                if np.track_id == id {
                    np.cover = image.clone();
                    ui.set_np(np);
                    let mut now = ui.get_radio_now();
                    now.logo = image;
                    ui.set_radio_now(now);
                }
            }),
            None,
        );
    }
}

/// From the playback tick while a station is live: the elapsed time, the song it plays,
/// and whether its stream stopped (then it's to be reconnected: returns true).
pub fn tick(app: &mut App, ui: &AppWindow) -> bool {
    let Some(live) = app.radio.live.as_mut() else {
        return false;
    };
    let Some(session) = &live.session else {
        return false;
    };
    let elapsed = live.since.elapsed();
    ui.set_position_text(super::models::fmt_duration(elapsed.as_millis() as i64).into());
    // Playing properly for a while: the next stop starts counting again.
    if live.failures > 0 && session.opened.elapsed() > Duration::from_secs(60) {
        live.failures = 0;
    }
    if session.pipeline.finished() {
        live.session = None;
        live.failures += 1;
        if live.failures > RECONNECTS {
            let name = live.station.name.clone();
            show_live(app);
            set_status(app, &tr!("{} stopped sending audio.", name));
            return false;
        }
        return true;
    }
    if Instant::now() >= live.next_poll {
        live.next_poll = Instant::now() + POLL_EVERY;
        poll_title(app);
    }
    false
}

/// Reconnects the live station after its stream stopped.
pub fn reconnect() {
    let wait = with_app(|app| app.radio.live.as_ref().map(|l| l.failures)).unwrap_or(0);
    // A moment first, longer each time: the station may be restarting.
    Timer::single_shot(Duration::from_secs(u64::from(wait)), connect);
}

fn poll_title(app: &App) {
    let Some(live) = app.radio.live.as_ref() else {
        return;
    };
    let id = live.station.id.to_string();
    let api = app.api.clone();
    thread::spawn(move || {
        let Ok(np) = api.radio_now_playing(&id) else {
            return;
        };
        let _ = slint::invoke_from_event_loop(move || {
            with_app(|app| {
                let Some(live) = app.radio.live.as_mut().filter(|l| *l.station.id == id) else {
                    return;
                };
                if live.title != np.title {
                    live.title = np.title;
                    show_live(app);
                }
            })
        });
    });
}
