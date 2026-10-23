//! The Albums page: every album in the library as a grid of covers.
//!
//! A library can hold thousands of albums, so the grid is a list of rows (only
//! the rows on screen exist as UI elements), and covers are loaded for the rows
//! in view plus a margin, then dropped again far out of view to bound memory.

use std::{
    collections::HashSet,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use hyperplayer::api::types;
use slint::{Image, Model, ModelRc, SharedString, VecModel};

use super::{
    AlbumItem, AlbumRow, App, Page, background,
    models::{album_item, load_image_if, plural},
    with_app,
};

/// Rows beyond the visible ones whose covers are loaded ahead of scrolling.
const PRELOAD_ROWS: usize = 3;
/// Rows further than this from view lose their covers (they're refetched from cache on return).
const KEEP_ROWS: usize = 8;
const COVER_PX: u32 = 360;
const PAGE: i64 = 500;

/// The rows currently on screen, readable from the image worker to skip stale jobs.
#[derive(Default)]
pub struct Visible {
    first: AtomicUsize,
    last: AtomicUsize,
    /// Albums whose cover request the worker skipped as out of view: to be asked again.
    skipped: Mutex<Vec<usize>>,
}

#[derive(Default)]
pub struct AlbumsView {
    sort: String,
    albums: Vec<types::AlbumSummary>,
    columns: usize,
    rows: Vec<Rc<VecModel<AlbumItem>>>,
    /// Album indices whose cover is shown or requested.
    covered: HashSet<usize>,
    visible: Arc<Visible>,
}

pub fn toggle_page() {
    let open = with_app(|app| {
        let ui = app.ui.upgrade()?;
        if ui.get_page() == Page::Albums {
            ui.set_page(app.page_before_albums);
            return None;
        }
        app.page_before_albums = ui.get_page();
        ui.set_page(Page::Albums);
        // Loaded once; sorting reloads, and a rescan shows up the next time the app starts.
        app.albums.albums.is_empty().then(|| app.albums.sort.clone())
    });
    if let Some(sort) = open {
        load(if sort.is_empty() { "artist".into() } else { sort });
    }
}

/// Fetches every album (in pages) in `sort` order.
pub fn load(sort: String) {
    let api = with_app(|app| {
        app.albums.sort = sort.clone();
        if let Some(ui) = app.ui.upgrade() {
            ui.set_albums_sort(sort.as_str().into());
            ui.set_albums_summary("Loading…".into());
        }
        app.api.clone()
    });
    let wanted = sort.clone();
    background(
        move || {
            let mut all = Vec::new();
            loop {
                let page = api.albums(all.len() as i64, PAGE, &sort)?;
                let done = page.items.is_empty() || all.len() + page.items.len() >= page.total as usize;
                all.extend(page.items);
                if done {
                    return Ok(all);
                }
            }
        },
        move |albums| {
            with_app(|app| {
                // A newer sort was picked meanwhile.
                if app.albums.sort != wanted {
                    return;
                }
                if let Some(ui) = app.ui.upgrade() {
                    ui.set_albums_summary(plural(albums.len() as i64, "album").into());
                    ui.invoke_albums_scroll_to_top();
                }
                app.albums.albums = albums;
                regroup(app);
            })
        },
    );
}

/// The page's width allows `columns` covers per row.
pub fn set_columns(columns: i32) {
    with_app(|app| {
        let columns = columns.max(1) as usize;
        if columns != app.albums.columns {
            app.albums.columns = columns;
            regroup(app);
        }
    });
}

/// Rebuilds the rows for the current albums and column count.
fn regroup(app: &mut App) {
    let view = &mut app.albums;
    if view.columns == 0 {
        return;
    }
    view.covered.clear();
    view.rows = view
        .albums
        .chunks(view.columns)
        .map(|chunk| {
            Rc::new(VecModel::from(
                chunk.iter().map(|a| album_item(a, subtitle(a))).collect::<Vec<_>>(),
            ))
        })
        .collect();
    let rows: Vec<AlbumRow> = view
        .rows
        .iter()
        .map(|r| AlbumRow { items: ModelRc::from(r.clone()) })
        .collect();
    if let Some(ui) = app.ui.upgrade() {
        ui.set_albums_rows(ModelRc::new(VecModel::from(rows)));
    }
    let (first, last) = (
        app.albums.visible.first.load(Ordering::Relaxed),
        app.albums.visible.last.load(Ordering::Relaxed),
    );
    show_rows(app, first, last);
}

fn subtitle(a: &types::AlbumSummary) -> String {
    [a.artist_name.clone()]
        .into_iter()
        .chain(a.year.map(|y| y.to_string()))
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Rows `first..=last` are on screen: load their covers (and a few rows around),
/// and drop covers far out of view.
pub fn visible_rows(first: i32, last: i32) {
    with_app(|app| show_rows(app, first.max(0) as usize, last.max(0) as usize));
}

fn show_rows(app: &mut App, first: usize, last: usize) {
    let view = &mut app.albums;
    view.visible.first.store(first, Ordering::Relaxed);
    view.visible.last.store(last, Ordering::Relaxed);
    let columns = view.columns.max(1);
    for i in std::mem::take(&mut *view.visible.skipped.lock().unwrap_or_else(|e| e.into_inner())) {
        view.covered.remove(&i);
    }

    // Far out of view: release the pixels.
    let far = |row: usize| row + KEEP_ROWS < first || row > last + KEEP_ROWS;
    let dropped: Vec<usize> = view.covered.iter().copied().filter(|&i| far(i / columns)).collect();
    for i in dropped {
        view.covered.remove(&i);
        if let Some(row) = view.rows.get(i / columns)
            && let Some(mut item) = row.row_data(i % columns)
        {
            item.cover = Image::default();
            row.set_row_data(i % columns, item);
        }
    }

    let from = first.saturating_sub(PRELOAD_ROWS) * columns;
    let to = ((last + PRELOAD_ROWS + 1) * columns).min(view.albums.len());
    let wanted: Vec<usize> = (from..to).filter(|i| !view.covered.contains(i)).collect();
    for i in wanted {
        app.albums.covered.insert(i);
        let album = &app.albums.albums[i];
        let id: SharedString = (*album.id).clone().into();
        let visible = app.albums.visible.clone();
        load_image_if(
            app,
            album.cover.as_ref(),
            COVER_PX,
            false,
            Box::new(move |_ui, img| {
                with_app(|app| {
                    // Located now: the columns may have changed since (the id check covers re-sorting).
                    let columns = app.albums.columns.max(1);
                    if let Some(r) = app.albums.rows.get(i / columns)
                        && let Some(mut item) = r.row_data(i % columns).filter(|it| it.id == id)
                    {
                        item.cover = img;
                        r.set_row_data(i % columns, item);
                    }
                })
            }),
            Some(Box::new(move || {
                let row = i / columns;
                let (first, last) = (visible.first.load(Ordering::Relaxed), visible.last.load(Ordering::Relaxed));
                let wanted = row + PRELOAD_ROWS + 1 >= first && row <= last + PRELOAD_ROWS + 1;
                if !wanted {
                    visible.skipped.lock().unwrap_or_else(|e| e.into_inner()).push(i);
                }
                wanted
            })),
        );
    }
}
