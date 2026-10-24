//! The Settings page: playback preferences, the account (profile, password,
//! devices), scrobbling, and for admins the server's library and users.
//! Its state lives in the `SettingsState` Slint global.

use std::thread;

use chrono::{DateTime, Local, Utc};
use hyperplayer::{api::types, replaygain};
use slint::{ComponentHandle, ModelRc, SharedString, VecModel};

use super::{
    App, AppWindow, DeviceItem, FolderItem, Page, SettingsState, UserItem, background,
    models::plural, with_app,
};

/// Connects the page's actions; called once at startup.
pub fn init(ui: &AppWindow) {
    let s = ui.global::<SettingsState>();
    s.on_set_quality(|key| super::set_quality_mode(super::mode_from(&key)));
    s.on_set_replaygain(|key| super::set_replaygain_mode(replaygain::Mode::from_name(&key)));
    s.on_preamp_changed(super::set_replaygain_preamp);
    s.on_preamp_released(|db| {
        super::set_replaygain_preamp(db);
        super::save_replaygain_preamp();
    });
    s.on_set_accent(|key| super::appearance::update(serde_json::json!({ "accent": key.as_str() })));
    s.on_set_cover_background(|on| {
        super::appearance::update(serde_json::json!({ "coverBackground": on }))
    });
    s.on_set_visualizer(|on| super::appearance::update(serde_json::json!({ "visualizer": on })));
    s.on_set_system_title_bar(|on| {
        with_app(|app| {
            app.settings.system_title_bar = on;
            app.settings.save();
        });
        state(|s| s.set_system_title_bar(on));
    });
    s.on_save_name(save_name);
    s.on_change_password(change_password);
    s.on_revoke_device(revoke_device);
    s.on_lb_connect(connect_listenbrainz);
    s.on_lb_disconnect(disconnect_listenbrainz);
    s.on_rescan(rescan);
    s.on_set_admin(|id, admin| update_user(id, serde_json::json!({ "admin": admin }), "Saved."));
    s.on_reset_password(|id, password| {
        if password.chars().count() < 8 {
            return users_message("A password needs at least 8 characters.", true);
        }
        update_user(
            id,
            serde_json::json!({ "password": password.as_str() }),
            "Temporary password set: they're signed out, and choose their own at the next sign-in.",
        )
    });
    s.on_delete_user(delete_user);
    s.on_create_user(create_user);
}

/// Mirrors the playback preferences (also changed from the transport bar).
pub fn show_preferences(app: &App, ui: &AppWindow) {
    let s = ui.global::<SettingsState>();
    s.set_quality(super::mode_name(app.mode).into());
    s.set_replaygain(app.rg_mode.name().into());
    s.set_preamp(app.rg_preamp);
}

fn state(f: impl FnOnce(SettingsState)) {
    if let Some(ui) = with_app(|app| app.ui.upgrade()) {
        f(ui.global::<SettingsState>());
    }
}

pub fn toggle_page() {
    let open = with_app(|app| {
        let ui = app.ui.upgrade()?;
        if ui.get_page() == Page::Settings {
            ui.set_page(app.page_before_settings);
            return None;
        }
        app.page_before_settings = ui.get_page();
        ui.set_page(Page::Settings);
        show_preferences(app, &ui);
        ui.global::<SettingsState>()
            .set_system_title_bar(app.settings.system_title_bar);
        Some(())
    });
    if open.is_some() {
        load();
    }
}

fn load() {
    let api = with_app(|app| app.api.clone());
    background(
        move || Ok((api.me()?, api.devices()?, api.scrobbling()?)),
        |(me, devices, scrobbling)| {
            state(|s| {
                s.set_is_admin(me.user.admin);
                if !me.user.admin && s.get_tab() == "admin" {
                    s.set_tab("playback".into());
                }
                s.set_full_name(me.user.full_name.clone().unwrap_or_default().into());
                s.set_name_message("".into());
                show_devices(&s, &devices);
                show_scrobbling(&s, &scrobbling);
            });
            if me.user.admin {
                load_admin(me.user.id.to_string());
            }
        },
    );
}

// ----------------------------------------------------------------- account

fn show_devices(s: &SettingsState, devices: &[types::Device]) {
    let items: Vec<DeviceItem> = devices
        .iter()
        .map(|d| DeviceItem {
            id: d.id.to_string().into(),
            name: d.name.clone().into(),
            detail: format!(
                "Last used {} · signed in {}",
                when(d.last_seen_at),
                when(d.created_at)
            )
            .into(),
            current: d.current,
        })
        .collect();
    s.set_devices(ModelRc::new(VecModel::from(items)));
}

fn when(t: DateTime<Utc>) -> String {
    t.with_timezone(&Local)
        .format("%-d %b %Y, %H:%M")
        .to_string()
}

fn save_name() {
    let (api, name) = with_app(|app| {
        let name = app
            .ui
            .upgrade()
            .map(|ui| {
                ui.global::<SettingsState>()
                    .get_full_name()
                    .trim()
                    .to_string()
            })
            .unwrap_or_default();
        (app.api.clone(), name)
    });
    background(
        move || api.update_me((!name.is_empty()).then_some(name.as_str())),
        |_| state(|s| s.set_name_message("Saved.".into())),
    );
}

fn change_password() {
    let Some((current, new, confirm)) = with_app(|app| {
        let ui = app.ui.upgrade()?;
        let s = ui.global::<SettingsState>();
        Some((s.get_pw_current(), s.get_pw_new(), s.get_pw_confirm()))
    }) else {
        return;
    };
    let fail = |msg: &str| {
        state(|s| {
            s.set_pw_message(msg.into());
            s.set_pw_error(true);
        })
    };
    if new.chars().count() < 8 {
        return fail("The new password needs at least 8 characters.");
    }
    if new != confirm {
        return fail("The new passwords don't match.");
    }
    let api = with_app(|app| app.api.clone());
    thread::spawn(move || {
        let result = api
            .change_password(&current, &new)
            .and_then(|_| api.devices());
        let _ = slint::invoke_from_event_loop(move || {
            state(|s| match result {
                Ok(devices) => {
                    s.set_pw_current("".into());
                    s.set_pw_new("".into());
                    s.set_pw_confirm("".into());
                    s.set_pw_message(
                        "Password changed; your other devices were signed out.".into(),
                    );
                    s.set_pw_error(false);
                    show_devices(&s, &devices);
                }
                Err(e) => {
                    s.set_pw_message(format!("{e:#}").into());
                    s.set_pw_error(true);
                }
            })
        });
    });
}

fn revoke_device(id: SharedString) {
    let api = with_app(|app| app.api.clone());
    background(
        move || {
            api.revoke_device(&id)?;
            api.devices()
        },
        |devices| state(|s| show_devices(&s, &devices)),
    );
}

// -------------------------------------------------------------- scrobbling

fn show_scrobbling(s: &SettingsState, settings: &types::ScrobbleSettings) {
    let lb = &settings.listenbrainz;
    s.set_lb_connected(lb.connected);
    s.set_lb_username(lb.username.clone().unwrap_or_default().into());
    s.set_lb_status(
        match (&lb.last_error, lb.pending) {
            (Some(e), _) => e.clone(),
            (None, 0) => "Your listens are sent as you play.".into(),
            (None, n) => format!("{n} listens waiting to be sent."),
        }
        .into(),
    );
    s.set_lb_failing(lb.last_error.is_some());
}

/// Connects (or reconnects) ListenBrainz with the pasted token.
fn connect_listenbrainz(token: SharedString) {
    let token = token.trim().to_string();
    if token.is_empty() {
        return;
    }
    state(|s| {
        s.set_lb_busy(true);
        s.set_lb_error("".into());
    });
    let api = with_app(|app| app.api.clone());
    // Not `background`: a refused token is shown on the page, not in the status line.
    thread::spawn(move || {
        let result = api.connect_listenbrainz(&token);
        let _ = slint::invoke_from_event_loop(move || {
            state(|s| {
                s.set_lb_busy(false);
                match result {
                    Ok(settings) => {
                        s.set_lb_token("".into());
                        show_scrobbling(&s, &settings);
                    }
                    Err(e) => s.set_lb_error(format!("{e:#}").into()),
                }
            })
        });
    });
}

fn disconnect_listenbrainz() {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.disconnect_listenbrainz(),
        |settings| state(|s| show_scrobbling(&s, &settings)),
    );
}

// ------------------------------------------------------------------- admin

fn load_admin(me: String) {
    let api = with_app(|app| app.api.clone());
    background(
        move || Ok((api.library_status()?, api.users()?)),
        move |(library, users)| {
            state(|s| {
                show_library(&s, &library);
                show_users(&s, &users, &me);
            })
        },
    );
}

fn show_library(s: &SettingsState, l: &types::LibraryStatus) {
    let scanned = l
        .last_scan_at
        .map(|t| format!(" · last scan {}", when(t)))
        .unwrap_or_default();
    let enriching = if l.enrichment_queue > 0 {
        format!(
            " · {} waiting for artist and album info",
            l.enrichment_queue
        )
    } else {
        String::new()
    };
    s.set_library_summary(
        format!(
            "{} · {} · {}{scanned}{enriching}",
            plural(l.tracks, "track"),
            plural(l.albums, "album"),
            plural(l.artists, "artist")
        )
        .into(),
    );
    let folders: Vec<FolderItem> = l
        .folders
        .iter()
        .map(|f| FolderItem {
            path: f.path.clone().into(),
            detail: if f.available {
                plural(f.tracks, "track")
            } else {
                format!("unavailable · keeping {}", plural(f.tracks, "track"))
            }
            .into(),
            available: f.available,
        })
        .collect();
    s.set_folders(ModelRc::new(VecModel::from(folders)));
    s.set_scanning(l.scanning);
}

fn show_users(s: &SettingsState, users: &[types::User], me: &str) {
    let items: Vec<UserItem> = users
        .iter()
        .map(|u| {
            let mut detail = vec![u.full_name.clone().unwrap_or_default()];
            detail.push(if u.admin {
                "admin".into()
            } else {
                "listener".into()
            });
            if u.must_change_password {
                detail.push("must choose a new password".into());
            }
            detail.push(format!(
                "since {}",
                u.created_at.with_timezone(&Local).format("%-d %b %Y")
            ));
            UserItem {
                id: u.id.to_string().into(),
                username: u.username.clone().into(),
                detail: detail
                    .into_iter()
                    .filter(|d| !d.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · ")
                    .into(),
                admin: u.admin,
                me: u.id.as_str() == me,
            }
        })
        .collect();
    s.set_users(ModelRc::new(VecModel::from(items)));
}

fn users_message(msg: &str, error: bool) {
    state(|s| {
        s.set_users_message(msg.into());
        s.set_users_error(error);
    })
}

/// Runs an admin action, then reloads the user list and reports the outcome on the page.
fn admin_action(
    action: impl FnOnce(&hyperplayer::api::Api) -> anyhow::Result<()> + Send + 'static,
    done: &'static str,
) {
    let api = with_app(|app| app.api.clone());
    thread::spawn(move || {
        let result = action(&api).and_then(|_| Ok((api.users()?, api.me()?)));
        let _ = slint::invoke_from_event_loop(move || match result {
            Ok((users, me)) => {
                state(|s| show_users(&s, &users, me.user.id.as_str()));
                users_message(done, false);
            }
            Err(e) => users_message(&format!("{e:#}"), true),
        });
    });
}

fn update_user(id: SharedString, changes: serde_json::Value, done: &'static str) {
    admin_action(move |api| api.update_user(&id, changes).map(|_| ()), done);
}

fn delete_user(id: SharedString) {
    admin_action(move |api| api.delete_user(&id), "User deleted.");
}

fn create_user() {
    let Some((username, full_name, password, admin)) = with_app(|app| {
        let ui = app.ui.upgrade()?;
        let s = ui.global::<SettingsState>();
        Some((
            s.get_new_username().trim().to_string(),
            s.get_new_full_name().trim().to_string(),
            s.get_new_password().to_string(),
            s.get_new_admin(),
        ))
    }) else {
        return;
    };
    if username.is_empty() {
        return users_message("Choose a username.", true);
    }
    if password.chars().count() < 8 {
        return users_message("A password needs at least 8 characters.", true);
    }
    admin_action(
        move |api| {
            api.create_user(
                &username,
                &password,
                (!full_name.is_empty()).then_some(full_name.as_str()),
                admin,
            )?;
            let _ = slint::invoke_from_event_loop(|| {
                state(|s| {
                    s.set_new_username("".into());
                    s.set_new_full_name("".into());
                    s.set_new_password("".into());
                    s.set_new_admin(false);
                })
            });
            Ok(())
        },
        "User added.",
    );
}

fn rescan() {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.rescan_library(),
        |library| state(|s| show_library(&s, &library)),
    );
}
