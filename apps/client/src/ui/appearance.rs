//! Colours that follow the music: the window's background gradient and the
//! accent, taken from the playing album's cover unless the user picked a colour;
//! and the text colours, kept legible on whatever those make.

use std::{cell::Cell, thread, time::Duration};

use hyperplayer::{
    api::types,
    palette::{self, Rgb},
};
use slint::{Color, ComponentHandle, Image, Timer};

use super::{App, AppWindow, SettingsState, Theme, models::load_image, with_app};

/// The accent before any cover or choice applies.
const DEFAULT_ACCENT: Rgb = Rgb(
    0x1e as f32 / 255.0,
    0xd7 as f32 / 255.0,
    0x60 as f32 / 255.0,
);
/// Covers are sampled at this size: plenty for a palette.
const SAMPLE_PX: u32 = 64;
/// The minimum contrast of the accent with the background: it marks things
/// (the playing track, toggles, the seek bar) rather than carrying body text.
const ACCENT_CONTRAST: f32 = 3.0;
/// How long the window's gradient cross-fades to new colours (app.slint).
const CROSSFADE: Duration = Duration::from_millis(900);
/// The Now Playing panel's layers (app.slint), top of the panel, where its
/// cover tint is strongest: the panel colour over the window, the backdrop
/// over that, and the accent over everything.
const PANEL_ALPHA: f32 = 0.6;
const BACKDROP_ALPHA: f32 = 0.55;
const PANEL_TINT_ALPHA: f32 = 0.25;

#[derive(Clone)]
pub struct Appearance {
    /// `cover`, or a `#rrggbb` colour.
    pub accent: String,
    pub cover_background: bool,
    pub visualizer: bool,
    /// The playing album's colours, and which artwork they came from.
    palette: Vec<Rgb>,
    palette_of: Option<String>,
    /// The lightest colour of the Now Playing backdrop, if one is showing.
    backdrop: Option<Rgb>,
    /// Bumped whenever the text colours are recomputed, so a delayed change
    /// can tell it has been superseded.
    text_seq: Cell<u64>,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            accent: "cover".into(),
            cover_background: true,
            visualizer: true,
            palette: Vec::new(),
            palette_of: None,
            backdrop: None,
            text_seq: Cell::new(0),
        }
    }
}

fn color(c: Rgb) -> Color {
    let (r, g, b) = c.to_u8();
    Color::from_rgb_u8(r, g, b)
}

fn rgb(c: Color) -> Rgb {
    Rgb(
        c.red() as f32 / 255.0,
        c.green() as f32 / 255.0,
        c.blue() as f32 / 255.0,
    )
}

/// Takes the account's appearance preferences.
pub fn set_preferences(app: &mut App, prefs: &types::Preferences) {
    app.appearance.accent = prefs.accent.to_string();
    app.appearance.cover_background = prefs.cover_background;
    app.appearance.visualizer = prefs.visualizer;
    apply(app);
}

/// The playing track's cover: sample its colours (once per artwork).
pub fn cover_changed(app: &mut App, cover: Option<&types::Artwork>) {
    let id = cover.map(|c| c.id.to_string());
    if id == app.appearance.palette_of {
        return;
    }
    app.appearance.palette_of = id.clone();
    if cover.is_none() {
        app.appearance.palette.clear();
        return apply(app);
    }
    load_image(
        app,
        cover,
        SAMPLE_PX,
        false,
        Box::new(move |_ui, image| {
            let Some(pixels) = image.to_rgba8() else {
                return;
            };
            let colours = palette::extract(pixels.as_bytes(), 4);
            with_app(|app| {
                // Superseded by another track meanwhile.
                if app.appearance.palette_of != id {
                    return;
                }
                app.appearance.palette = colours;
                apply(app);
            })
        }),
    );
}

/// The Now Playing panel's (dimmed) backdrop arrived, or went: re-check the
/// panel's text against it.
pub fn backdrop_changed(app: &mut App, backdrop: &Image) {
    app.appearance.backdrop = backdrop
        .to_rgba8()
        .and_then(|px| palette::lightest(px.as_bytes()));
    apply(app);
}

/// Pushes the current gradient, accent and text colours to the UI.
pub fn apply(app: &App) {
    let Some(ui) = app.ui.upgrade() else { return };
    let a = &app.appearance;
    let theme = ui.global::<Theme>();
    let bg = rgb(theme.get_bg());
    let tints = if a.cover_background && !a.palette.is_empty() {
        palette::background(&a.palette)
    } else {
        [bg; 3]
    };
    ui.set_tint_a(color(tints[0]));
    ui.set_tint_b(color(tints[1]));
    ui.set_tint_c(color(tints[2]));
    // Text runs across the whole gradient: it has to read on its lightest part.
    let lightest = tints
        .into_iter()
        .max_by(|x, y| x.luminance().total_cmp(&y.luminance()))
        .unwrap_or(bg);

    let accent = match a.accent.as_str() {
        "cover" => palette::accent(&a.palette).unwrap_or(DEFAULT_ACCENT),
        hex => Rgb::from_hex(hex).unwrap_or(DEFAULT_ACCENT),
    };
    theme.set_accent(color(palette::legible(accent, lightest, ACCENT_CONTRAST)));

    let base = palette::TextColours {
        text: rgb(theme.get_text_base()),
        muted: rgb(theme.get_muted_base()),
        faint: rgb(theme.get_faint_base()),
    };
    let panel = {
        let under = rgb(theme.get_surface()).over(PANEL_ALPHA, lightest);
        let under = match a.backdrop {
            Some(b) => b.over(BACKDROP_ALPHA, under),
            None => under,
        };
        rgb(ui.get_np().accent).over(PANEL_TINT_ALPHA, under)
    };
    let art = palette::text_colours(base, panel);
    theme.set_art_text(color(art.text));
    theme.set_art_muted(color(art.muted));
    theme.set_art_faint(color(art.faint));

    let text = palette::text_colours(base, lightest);
    let seq = a.text_seq.get() + 1;
    a.text_seq.set(seq);
    // Lighter text reads on the old colours too, so it changes at once; darker
    // text waits for the gradient to finish fading to the new, darker colours.
    if text.muted.luminance() >= rgb(theme.get_muted()).luminance() {
        set_text(&ui, text);
    } else {
        Timer::single_shot(CROSSFADE, move || {
            with_app(|app| {
                if app.appearance.text_seq.get() == seq
                    && let Some(ui) = app.ui.upgrade()
                {
                    set_text(&ui, text);
                }
            })
        });
    }
    show(app, &ui);
}

fn set_text(ui: &AppWindow, t: palette::TextColours) {
    let theme = ui.global::<Theme>();
    theme.set_text(color(t.text));
    theme.set_muted(color(t.muted));
    theme.set_faint(color(t.faint));
}

/// Mirrors the choices on the Settings page.
fn show(app: &App, ui: &AppWindow) {
    let s = ui.global::<SettingsState>();
    s.set_accent(app.appearance.accent.as_str().into());
    s.set_cover_background(app.appearance.cover_background);
    s.set_visualizer(app.appearance.visualizer);
}

/// A choice on the Settings page: applied at once and saved to the account.
pub fn update(change: serde_json::Value) {
    let api = with_app(|app| {
        if let Some(v) = change.get("accent").and_then(|v| v.as_str()) {
            app.appearance.accent = v.to_string();
        }
        if let Some(v) = change.get("coverBackground").and_then(|v| v.as_bool()) {
            app.appearance.cover_background = v;
        }
        if let Some(v) = change.get("visualizer").and_then(|v| v.as_bool()) {
            app.appearance.visualizer = v;
        }
        apply(app);
        app.api.clone()
    });
    thread::spawn(move || {
        if let Err(e) = api.update_preferences(change) {
            eprintln!("saving preference: {e:#}");
        }
    });
}
