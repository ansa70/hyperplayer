//! Turning API data into Slint models, plus the background image pipeline.

use std::{collections::HashMap, rc::Rc, sync::mpsc, thread};

use hyperplayer::api::{Api, types};
use image::imageops::FilterType;
use slint::{Image, Model, ModelRc, Rgba8Pixel, SharedPixelBuffer, SharedString, VecModel};

use super::{APP, AlbumItem, App, AppWindow, ArtistItem, CreditItem, TrackItem};

/// Applies a decoded image to the UI; runs on the UI thread.
pub type ApplyImage = Box<dyn FnOnce(&AppWindow, Image) + Send>;

pub struct ImageJob {
    /// The client to fetch with, so a sign-in change applies to queued jobs too.
    api: Api,
    artwork_id: String,
    size: u32,
    blur: bool,
    apply: ApplyImage,
}

/// Single image worker: fetches, decodes, resizes and caches pixel buffers.
pub fn spawn_image_worker() -> mpsc::Sender<ImageJob> {
    let (tx, rx) = mpsc::channel::<ImageJob>();
    thread::spawn(move || {
        let mut cache: HashMap<(String, u32, bool), SharedPixelBuffer<Rgba8Pixel>> = HashMap::new();
        for job in rx {
            let key = (job.artwork_id.clone(), job.size, job.blur);
            let buffer = match cache.get(&key) {
                Some(b) => b.clone(),
                None => match decode(&job.api, &job) {
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

pub fn load_image(
    app: &App,
    artwork: Option<&types::Artwork>,
    size: u32,
    blur: bool,
    apply: ApplyImage,
) {
    if let Some(art) = artwork {
        let _ = app.images.send(ImageJob {
            api: app.api.clone(),
            artwork_id: (*art.id).clone(),
            size,
            blur,
            apply,
        });
    }
}

// ---------------------------------------------------------------- formatting

pub fn fmt_duration(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

pub fn plural(n: i64, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

pub fn accent(art: Option<&types::Artwork>) -> slint::Color {
    art.and_then(|a| a.dominant_color.as_ref())
        .and_then(|c| u32::from_str_radix(c.trim_start_matches('#'), 16).ok())
        .map(|rgb| slint::Color::from_argb_encoded(0xff00_0000 | rgb))
        .unwrap_or(slint::Color::from_rgb_u8(0x5b, 0x6c, 0xff))
}

pub fn quality(f: &types::AudioFormat) -> String {
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

pub fn album_item(a: &types::AlbumSummary, subtitle: String) -> AlbumItem {
    AlbumItem {
        id: (*a.id).clone().into(),
        title: a.title.clone().into(),
        subtitle: subtitle.into(),
        cover: Image::default(),
    }
}

/// One line describing the artist: "jazz trumpeter, bandleader · Alton, United States · 1926–1991".
pub fn artist_meta(a: &types::Artist) -> String {
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

pub fn credit_heading(c: types::CreditCategory) -> &'static str {
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
pub fn credit_model(credits: &[types::Credit]) -> ModelRc<CreditItem> {
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

pub fn member_model(members: &[types::BandMember], heading: &str) -> ModelRc<CreditItem> {
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
pub fn album_model(
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

/// Fills a model of artist rows and queues their images.
pub fn artist_model(
    app: &App,
    artists: &[types::ArtistSummary],
    pick: fn(&AppWindow) -> ModelRc<ArtistItem>,
) -> ModelRc<ArtistItem> {
    let items: Vec<ArtistItem> = artists
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
    for (i, a) in artists.iter().enumerate() {
        let id: SharedString = (*a.id).clone().into();
        load_image(
            app,
            a.image.as_ref(),
            96,
            false,
            Box::new(move |ui, img| {
                let model = pick(ui);
                if let Some(mut row) = model.row_data(i).filter(|r| r.id == id) {
                    row.image = img;
                    model.set_row_data(i, row);
                }
            }),
        );
    }
    Rc::new(VecModel::from(items)).into()
}

/// Track rows for search results: the subtitle names artist and album, since results mix albums.
pub fn search_track_model(tracks: &[types::Track], playing: Option<&str>) -> ModelRc<TrackItem> {
    Rc::new(VecModel::from(
        tracks
            .iter()
            .enumerate()
            .map(|(i, t)| TrackItem {
                number: (i + 1).to_string().into(),
                title: t.title.clone().into(),
                artist: format!("{} · {}", t.artist_name, t.album_title).into(),
                duration: fmt_duration(t.duration_ms).into(),
                playing: playing == Some(t.id.as_str()),
                available: true,
            })
            .collect::<Vec<_>>(),
    ))
    .into()
}

pub fn track_model(tracks: &[types::Track], playing: Option<&str>) -> ModelRc<TrackItem> {
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
                available: true,
            })
            .collect::<Vec<_>>(),
    ))
    .into()
}
