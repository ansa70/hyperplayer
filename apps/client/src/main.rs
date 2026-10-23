mod api;
mod player;

use std::{cell::RefCell, collections::HashMap, rc::Rc, sync::mpsc, thread, time::Duration};

use api::{Api, types};
use image::imageops::FilterType;
use player::Audio;
use slint::{
    Image, Model, ModelRc, Rgba8Pixel, SharedPixelBuffer, SharedString, Timer, TimerMode, VecModel,
};

slint::include_modules!();

/// Applies a decoded image to the UI; runs on the UI thread.
type ApplyImage = Box<dyn FnOnce(&AppWindow, Image) + Send>;

struct ImageJob {
    artwork_id: String,
    size: u32,
    blur: bool,
    apply: ApplyImage,
}

/// UI-thread state. Background threads never touch it directly: they hand
/// results back through `slint::invoke_from_event_loop`, which runs on this thread.
struct App {
    ui: slint::Weak<AppWindow>,
    api: Api,
    audio: Option<Audio>,
    images: mpsc::Sender<ImageJob>,
    album_tracks: Vec<types::Track>,
    queue: Vec<types::Track>,
    index: usize,
    /// True between asking the server for a track and handing it to the decoder.
    loading: bool,
    started: bool,
    /// Now-playing refreshes done for the current track while enrichment is pending.
    np_polls: u32,
    np_had_banner: bool,
}

thread_local! {
    static APP: RefCell<Option<App>> = const { RefCell::new(None) };
}

fn with_app<R>(f: impl FnOnce(&mut App) -> R) -> R {
    APP.with(|a| f(a.borrow_mut().as_mut().expect("app initialised")))
}

/// Runs `work` on a background thread and `done` with its result on the UI thread.
fn background<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
    done: impl FnOnce(T) + Send + 'static,
) {
    thread::spawn(move || match work() {
        Ok(value) => {
            let _ = slint::invoke_from_event_loop(move || done(value));
        }
        Err(err) => {
            let msg = format!("{err:#}");
            eprintln!("{msg}");
            let _ = slint::invoke_from_event_loop(move || with_app(|app| set_status(app, &msg)));
        }
    });
}

fn set_status(app: &App, msg: &str) {
    if let Some(ui) = app.ui.upgrade() {
        ui.set_status(msg.into());
    }
}

/// Single image worker: fetches, decodes, resizes and caches pixel buffers.
fn spawn_image_worker(api: Api) -> mpsc::Sender<ImageJob> {
    let (tx, rx) = mpsc::channel::<ImageJob>();
    thread::spawn(move || {
        let mut cache: HashMap<(String, u32, bool), SharedPixelBuffer<Rgba8Pixel>> = HashMap::new();
        for job in rx {
            let key = (job.artwork_id.clone(), job.size, job.blur);
            let buffer = match cache.get(&key) {
                Some(b) => b.clone(),
                None => match decode(&api, &job) {
                    Ok(b) => {
                        cache.insert(key, b.clone());
                        b
                    }
                    Err(err) => {
                        eprintln!("artwork {}: {err:#}", job.artwork_id);
                        continue;
                    }
                },
            };
            let apply = job.apply;
            let _ = slint::invoke_from_event_loop(move || {
                if let Some(ui) = APP.with(|a| a.borrow().as_ref().and_then(|app| app.ui.upgrade()))
                {
                    apply(&ui, Image::from_rgba8(buffer));
                }
            });
        }
    });
    tx
}

fn decode(api: &Api, job: &ImageJob) -> anyhow::Result<SharedPixelBuffer<Rgba8Pixel>> {
    // Backdrops only need a tiny source: blurred and upscaled by the renderer they look smooth.
    let fetch_size = if job.blur { 64 } else { job.size };
    let bytes = api.artwork(&job.artwork_id, fetch_size)?;
    let mut img = image::load_from_memory(&bytes)?;
    if job.blur {
        img = img.resize(48, 48, FilterType::Triangle).blur(5.0);
    }
    let rgba = img.to_rgba8();
    Ok(SharedPixelBuffer::clone_from_slice(
        rgba.as_raw(),
        rgba.width(),
        rgba.height(),
    ))
}

fn load_image(
    app: &App,
    artwork: Option<&types::Artwork>,
    size: u32,
    blur: bool,
    apply: ApplyImage,
) {
    if let Some(art) = artwork {
        let _ = app.images.send(ImageJob {
            artwork_id: (*art.id).clone(),
            size,
            blur,
            apply,
        });
    }
}

// ---------------------------------------------------------------- formatting

fn fmt_duration(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

fn plural(n: i64, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

fn accent(art: Option<&types::Artwork>) -> slint::Color {
    art.and_then(|a| a.dominant_color.as_ref())
        .and_then(|c| u32::from_str_radix(c.trim_start_matches('#'), 16).ok())
        .map(|rgb| slint::Color::from_argb_encoded(0xff00_0000 | rgb))
        .unwrap_or(slint::Color::from_rgb_u8(0x5b, 0x6c, 0xff))
}

fn quality(f: &types::AudioFormat) -> String {
    let rate = f
        .sample_rate
        .map(|r| format!("{:.1} kHz", r.get() as f64 / 1000.0).replace(".0 ", " "));
    if f.lossless {
        match (f.bit_depth, rate) {
            (Some(d), Some(r)) => format!("{d}-bit · {r}"),
            (None, Some(r)) => r,
            _ => String::new(),
        }
    } else {
        f.bitrate
            .map(|b| format!("{} kbps", b.get() / 1000))
            .unwrap_or_default()
    }
}

fn album_item(a: &types::AlbumSummary, subtitle: String) -> AlbumItem {
    AlbumItem {
        id: (*a.id).clone().into(),
        title: a.title.clone().into(),
        subtitle: subtitle.into(),
        cover: Image::default(),
    }
}

/// One line describing the artist: "jazz trumpeter, bandleader · Alton, United States · 1926–1991".
fn artist_meta(a: &types::Artist) -> String {
    let kind = a.kind.map(|k| {
        let k = k.to_string();
        let mut c = k.chars();
        c.next()
            .map(|f| f.to_uppercase().chain(c).collect::<String>())
            .unwrap_or_default()
    });
    [
        a.disambiguation.clone().or(kind),
        a.area.clone(),
        a.active_years.clone(),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

fn credit_heading(c: types::CreditCategory) -> &'static str {
    use types::CreditCategory::*;
    match c {
        Performance => "MUSICIANS",
        Composition => "WRITTEN BY",
        Production => "PRODUCTION",
        Engineering => "ENGINEERING",
        Other => "OTHER",
    }
}

/// Credits grouped under a heading per category (the server already sorts by category).
fn credit_model(credits: &[types::Credit]) -> ModelRc<CreditItem> {
    let mut last = None;
    let rows: Vec<CreditItem> = credits
        .iter()
        .map(|c| {
            let heading = if last != Some(c.category) {
                credit_heading(c.category)
            } else {
                ""
            };
            last = Some(c.category);
            let mut detail = c.roles.join(", ");
            if c.scope == types::CreditScope::Album {
                detail.push_str(" · album");
            }
            CreditItem {
                heading: heading.into(),
                name: c.name.clone().into(),
                detail: detail.into(),
                artist_id: c
                    .artist_id
                    .as_ref()
                    .map(|i| i.to_string())
                    .unwrap_or_default()
                    .into(),
            }
        })
        .collect();
    Rc::new(VecModel::from(rows)).into()
}

fn member_model(members: &[types::BandMember], heading: &str) -> ModelRc<CreditItem> {
    let rows: Vec<CreditItem> = members
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let detail = [Some(m.roles.join(", ")), m.years.clone()]
                .into_iter()
                .flatten()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
            CreditItem {
                heading: if i == 0 { heading.into() } else { "".into() },
                name: m.name.clone().into(),
                detail: detail.into(),
                artist_id: m
                    .artist_id
                    .as_ref()
                    .map(|i| i.to_string())
                    .unwrap_or_default()
                    .into(),
            }
        })
        .collect();
    Rc::new(VecModel::from(rows)).into()
}

/// Fills a model of album cards and queues their covers.
fn album_model(
    app: &App,
    albums: &[types::AlbumSummary],
    subtitle: impl Fn(&types::AlbumSummary) -> String,
    pick: fn(&AppWindow) -> ModelRc<AlbumItem>,
) -> ModelRc<AlbumItem> {
    let model = Rc::new(VecModel::from(
        albums
            .iter()
            .map(|a| album_item(a, subtitle(a)))
            .collect::<Vec<_>>(),
    ));
    for (i, a) in albums.iter().enumerate() {
        let id: SharedString = (*a.id).clone().into();
        load_image(
            app,
            a.cover.as_ref(),
            360,
            false,
            Box::new(move |ui, img| {
                let model = pick(ui);
                if let Some(mut row) = model.row_data(i).filter(|r| r.id == id) {
                    row.cover = img;
                    model.set_row_data(i, row);
                }
            }),
        );
    }
    model.into()
}

// ---------------------------------------------------------------- navigation

fn load_artists() {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.artists(0, 500),
        |page| {
            with_app(|app| {
                let Some(ui) = app.ui.upgrade() else { return };
                let items: Vec<ArtistItem> = page
                    .items
                    .iter()
                    .map(|a| ArtistItem {
                        id: (*a.id).clone().into(),
                        name: a.name.clone().into(),
                        subtitle: format!(
                            "{} · {}",
                            plural(a.album_count, "album"),
                            plural(a.track_count, "track")
                        )
                        .into(),
                        image: Image::default(),
                    })
                    .collect();
                ui.set_artists(Rc::new(VecModel::from(items)).into());
                ui.set_status(format!("{} on server", plural(page.total, "artist")).into());
                for (i, a) in page.items.iter().enumerate() {
                    let id: SharedString = (*a.id).clone().into();
                    load_image(
                        app,
                        a.image.as_ref(),
                        96,
                        false,
                        Box::new(move |ui, img| {
                            let model = ui.get_artists();
                            if let Some(mut row) = model.row_data(i).filter(|r| r.id == id) {
                                row.image = img;
                                model.set_row_data(i, row);
                            }
                        }),
                    );
                }
            })
        },
    );
}

fn select_artist(id: SharedString) {
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

fn select_album(id: SharedString) {
    let api = with_app(|app| app.api.clone());
    let album_id = id.to_string();
    background(
        move || api.album(&album_id),
        move |album| {
            with_app(|app| {
                let Some(ui) = app.ui.upgrade() else { return };
                let playing = app.queue.get(app.index).map(|t| (*t.id).clone());
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
            })
        },
    );
}

fn track_model(tracks: &[types::Track], playing: Option<&str>) -> ModelRc<TrackItem> {
    Rc::new(VecModel::from(
        tracks
            .iter()
            .enumerate()
            .map(|(i, t)| TrackItem {
                number: t
                    .track_number
                    .map(|n| n.get() as usize)
                    .unwrap_or(i + 1)
                    .to_string()
                    .into(),
                title: t.title.clone().into(),
                artist: t.artist_name.clone().into(),
                duration: fmt_duration(t.duration_ms).into(),
                playing: playing == Some(t.id.as_str()),
            })
            .collect::<Vec<_>>(),
    ))
    .into()
}

// ---------------------------------------------------------------- playback

fn play_index(index: usize) {
    let (api, track) = with_app(|app| {
        app.index = index;
        app.loading = true;
        app.started = false;
        (app.api.clone(), app.queue.get(index).cloned())
    });
    let Some(track) = track else { return };
    refresh_playing_marks();

    let id = (*track.id).clone();
    let (audio_api, audio_track) = (api.clone(), track.clone());
    background(
        move || audio_api.audio(&audio_track),
        move |bytes| {
            with_app(|app| {
                // Ignore downloads that finished after the user moved on to another track.
                if app.queue.get(app.index).map(|t| t.id.as_str()) != Some(id.as_str()) {
                    return;
                }
                app.loading = false;
                match app.audio.as_ref().map(|a| a.play_bytes(bytes)) {
                    Some(Ok(())) => app.started = true,
                    Some(Err(err)) => {
                        set_status(app, &format!("Cannot play {}: {err:#}", track.title))
                    }
                    None => set_status(app, "No audio output device"),
                }
            })
        },
    );

    with_app(|app| app.np_polls = 0);
    fetch_now_playing(track.id.to_string());
}

/// How often, and for how long, to re-fetch now-playing data while the server is still enriching it.
const NP_POLL_INTERVAL: Duration = Duration::from_secs(2);
const NP_MAX_POLLS: u32 = 30;

fn fetch_now_playing(track_id: String) {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.now_playing(&track_id),
        move |np| with_app(|app| show_now_playing(app, np)),
    );
}

fn show_now_playing(app: &mut App, np: types::NowPlaying) {
    let Some(ui) = app.ui.upgrade() else { return };
    let t = &np.track;
    let track_id: SharedString = (*t.id).clone().into();
    // Ignore responses for a track that is no longer playing.
    if app.queue.get(app.index).map(|q| q.id.as_str()) != Some(t.id.as_str()) {
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
            let current = with_app(|app| app.queue.get(app.index).map(|q| q.id.to_string()));
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

fn refresh_playing_marks() {
    with_app(|app| {
        let Some(ui) = app.ui.upgrade() else { return };
        let playing = app.queue.get(app.index).map(|t| (*t.id).clone());
        ui.set_album_tracks(track_model(&app.album_tracks, playing.as_deref()));
    });
}

fn tick() {
    let next = with_app(|app| {
        let (Some(ui), Some(audio)) = (app.ui.upgrade(), app.audio.as_ref()) else {
            return false;
        };
        let pos = audio.position();
        ui.set_playing(audio.is_playing() || app.loading);
        ui.set_position(pos.as_secs_f32());
        ui.set_position_text(fmt_duration(pos.as_millis() as i64).into());
        app.started && !app.loading && audio.finished()
    });
    if next {
        let more = with_app(|app| {
            app.started = false;
            app.index + 1 < app.queue.len()
        });
        if more {
            play_index(with_app(|app| app.index + 1));
        }
    }
}

// ---------------------------------------------------------------- main

fn main() -> anyhow::Result<()> {
    let server = std::env::var("HP_SERVER").unwrap_or_else(|_| "http://127.0.0.1:4533".into());
    let api = Api::new(server.clone());
    let ui = AppWindow::new()?;

    let audio = match Audio::open() {
        Ok(a) => Some(a),
        Err(err) => {
            eprintln!("audio output unavailable: {err:#}");
            None
        }
    };
    if let Some(a) = &audio {
        a.set_volume(ui.get_volume());
    }

    APP.with(|cell| {
        *cell.borrow_mut() = Some(App {
            ui: ui.as_weak(),
            images: spawn_image_worker(api.clone()),
            api,
            audio,
            album_tracks: Vec::new(),
            queue: Vec::new(),
            index: 0,
            loading: false,
            started: false,
            np_polls: 0,
            np_had_banner: false,
        })
    });
    ui.set_status(format!("Connecting to {server}…").into());

    ui.on_select_artist(select_artist);
    ui.on_select_album(select_album);
    ui.on_back_to_artist(|| {
        with_app(|app| {
            if let Some(ui) = app.ui.upgrade() {
                ui.set_page(Page::Artist)
            }
        })
    });
    ui.on_play_track(|i| {
        with_app(|app| app.queue = app.album_tracks.clone());
        play_index(i as usize);
    });
    ui.on_toggle(|| {
        let idle = with_app(|app| match &app.audio {
            Some(a) if app.started => {
                a.toggle();
                false
            }
            _ => !app.album_tracks.is_empty() && app.queue.is_empty(),
        });
        if idle {
            with_app(|app| app.queue = app.album_tracks.clone());
            play_index(0);
        }
    });
    ui.on_next(|| {
        let i = with_app(|app| (app.index + 1 < app.queue.len()).then_some(app.index + 1));
        if let Some(i) = i {
            play_index(i)
        }
    });
    ui.on_prev(|| {
        // Like most players: restart the track unless we're at its very beginning.
        let restart = with_app(|app| {
            app.audio
                .as_ref()
                .is_some_and(|a| a.position() > Duration::from_secs(3))
        });
        let i = with_app(|app| app.index.saturating_sub(1));
        if restart {
            with_app(|app| {
                if let Some(a) = &app.audio {
                    a.seek(Duration::ZERO)
                }
            });
        } else {
            play_index(i);
        }
    });
    ui.on_seek(|secs| {
        with_app(|app| {
            if let Some(a) = &app.audio {
                a.seek(Duration::from_secs_f32(secs.max(0.0)))
            }
        })
    });
    ui.on_volume_changed(|v| {
        with_app(|app| {
            if let Some(a) = &app.audio {
                a.set_volume(v)
            }
        })
    });

    let timer = Timer::default();
    timer.start(TimerMode::Repeated, Duration::from_millis(250), tick);

    load_artists();
    ui.run()?;
    Ok(())
}
