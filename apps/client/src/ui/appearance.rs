//! Colours that follow the music: the window's background gradient and the
//! accent, taken from the playing album's cover unless the user picked a colour.

use std::thread;

use hyperplayer::{
    api::types,
    palette::{self, Rgb},
};
use slint::{Color, ComponentHandle};

use super::{App, AppWindow, SettingsState, Theme, models::load_image, with_app};

/// The accent before any cover or choice applies.
const DEFAULT_ACCENT: Rgb = Rgb(
    0x1e as f32 / 255.0,
    0xd7 as f32 / 255.0,
    0x60 as f32 / 255.0,
);
/// Covers are sampled at this size: plenty for a palette.
const SAMPLE_PX: u32 = 64;

#[derive(Clone)]
pub struct Appearance {
    /// `cover`, or a `#rrggbb` colour.
    pub accent: String,
    pub cover_background: bool,
    pub visualizer: bool,
    /// The playing album's colours, and which artwork they came from.
    palette: Vec<Rgb>,
    palette_of: Option<String>,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            accent: "cover".into(),
            cover_background: true,
            visualizer: true,
            palette: Vec::new(),
            palette_of: None,
        }
    }
}

fn color(c: Rgb) -> Color {
    let (r, g, b) = c.to_u8();
    Color::from_rgb_u8(r, g, b)
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

/// Pushes the current gradient and accent to the UI.
pub fn apply(app: &App) {
    let Some(ui) = app.ui.upgrade() else { return };
    let a = &app.appearance;
    let bg = ui.global::<Theme>().get_bg();
    if a.cover_background && !a.palette.is_empty() {
        let [x, y, z] = palette::background(&a.palette);
        ui.set_tint_a(color(x));
        ui.set_tint_b(color(y));
        ui.set_tint_c(color(z));
    } else {
        ui.set_tint_a(bg);
        ui.set_tint_b(bg);
        ui.set_tint_c(bg);
    }
    let accent = match a.accent.as_str() {
        "cover" => palette::accent(&a.palette).unwrap_or(DEFAULT_ACCENT),
        hex => Rgb::from_hex(hex).unwrap_or(DEFAULT_ACCENT),
    };
    ui.global::<Theme>().set_accent(color(accent));
    show(app, &ui);
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
