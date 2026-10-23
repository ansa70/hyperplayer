//! The Settings page: per-user options kept on the server (scrobbling for now).

use std::thread;

use hyperplayer::api::types;
use slint::SharedString;

use super::{AppWindow, Page, background, with_app};

pub fn toggle_page() {
    let open = with_app(|app| {
        let ui = app.ui.upgrade()?;
        if ui.get_page() == Page::Settings {
            ui.set_page(app.page_before_settings);
            return None;
        }
        app.page_before_settings = ui.get_page();
        ui.set_page(Page::Settings);
        Some(())
    });
    if open.is_some() {
        load();
    }
}

fn load() {
    let api = with_app(|app| app.api.clone());
    background(move || api.scrobbling(), |s| with_ui(|ui| show(ui, &s)));
}

fn with_ui(f: impl FnOnce(&AppWindow)) {
    if let Some(ui) = with_app(|app| app.ui.upgrade()) {
        f(&ui);
    }
}

fn show(ui: &AppWindow, s: &types::ScrobbleSettings) {
    let lb = &s.listenbrainz;
    ui.set_lb_connected(lb.connected);
    ui.set_lb_username(lb.username.clone().unwrap_or_default().into());
    ui.set_lb_status(
        match (&lb.last_error, lb.pending) {
            (Some(e), _) => e.clone(),
            (None, 0) => "Your listens are sent as you play.".into(),
            (None, n) => format!("{n} listens waiting to be sent."),
        }
        .into(),
    );
    ui.set_lb_failing(lb.last_error.is_some());
}

/// Connects (or reconnects) ListenBrainz with the pasted token.
pub fn connect_listenbrainz(token: SharedString) {
    let token = token.trim().to_string();
    if token.is_empty() {
        return;
    }
    with_ui(|ui| {
        ui.set_lb_busy(true);
        ui.set_lb_error("".into());
    });
    let api = with_app(|app| app.api.clone());
    // Not `background`: a refused token is shown on the page, not in the status line.
    thread::spawn(move || {
        let result = api.connect_listenbrainz(&token);
        let _ = slint::invoke_from_event_loop(move || {
            with_ui(|ui| {
                ui.set_lb_busy(false);
                match result {
                    Ok(s) => {
                        ui.set_lb_token("".into());
                        show(ui, &s);
                    }
                    Err(e) => ui.set_lb_error(format!("{e:#}").into()),
                }
            })
        });
    });
}

pub fn disconnect_listenbrainz() {
    let api = with_app(|app| app.api.clone());
    background(move || api.disconnect_listenbrainz(), |s| with_ui(|ui| show(ui, &s)));
}
