//! The Settings page: playback preferences, the account (profile, password,
//! devices), scrobbling, and for admins the server's library and users.
//! Its state lives in the `SettingsState` Slint global.

use std::{
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

use chrono::{DateTime, Local, Utc};
use hyperplayer::{
    api::{ServerError, types},
    replaygain,
};
use slint::{ComponentHandle, Model, ModelRc, SharedString, VecModel};

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
    s.on_fm_connect(connect_lastfm);
    s.on_fm_open(|url| open_in_browser(&url));
    s.on_fm_cancel(|| {
        LASTFM_ATTEMPT.fetch_add(1, Ordering::Relaxed);
        state(|s| s.set_fm_waiting(false));
    });
    s.on_fm_disconnect(disconnect_lastfm);
    s.on_rescan(rescan);
    s.on_add_folder(add_folder);
    s.on_remove_folder(|path| {
        let paths = folder_paths()
            .into_iter()
            .filter(|p| *p != path.as_str())
            .collect();
        set_folders(paths, "Folder removed; rescanning.");
    });
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
    // Outcomes of earlier actions (perhaps by another account) are stale now.
    users_message("", false);
    state(|s| s.set_folders_message("".into()));
    let api = with_app(|app| app.api.clone());
    background(
        move || {
            let server = api.auth_status()?.server_version;
            Ok((api.me()?, api.devices()?, api.scrobbling()?, server))
        },
        |(me, devices, scrobbling, server)| {
            state(|s| {
                s.set_versions(
                    format!(
                        "HyperPlayer {} · server {server}",
                        env!("CARGO_PKG_VERSION")
                    )
                    .into(),
                );
                s.set_is_admin(me.user.admin);
                s.set_full_name(me.user.full_name.clone().unwrap_or_default().into());
                s.set_name_message("".into());
                show_devices(&s, &devices);
                show_scrobbling(&s, &scrobbling);
            });
            load_library();
            if me.user.admin {
                load_users(me.user.id.to_string());
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
    s.set_lb_status(account_status(lb).into());
    s.set_lb_failing(lb.last_error.is_some());
    let fm = &settings.lastfm;
    s.set_fm_available(fm.available);
    s.set_fm_connected(fm.connected);
    s.set_fm_username(fm.username.clone().unwrap_or_default().into());
    s.set_fm_status(account_status(fm).into());
    s.set_fm_failing(fm.last_error.is_some());
}

fn account_status(account: &types::ScrobbleAccount) -> String {
    match (&account.last_error, account.pending) {
        (Some(e), _) => e.clone(),
        (None, 0) => "Your listens are sent as you play.".into(),
        (None, n) => format!("{n} listens waiting to be sent."),
    }
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

/// Bumped to stop waiting for a Last.fm authorization (cancelled, or started again).
static LASTFM_ATTEMPT: AtomicU64 = AtomicU64::new(0);
/// How often to ask whether the user has allowed HyperPlayer, and for how long
/// (Last.fm's tokens last an hour).
const LASTFM_POLL: Duration = Duration::from_secs(3);
const LASTFM_WAIT: Duration = Duration::from_secs(15 * 60);

/// Opens Last.fm's authorization page in the browser, then waits for the user to allow it.
fn connect_lastfm() {
    let attempt = LASTFM_ATTEMPT.fetch_add(1, Ordering::Relaxed) + 1;
    let current = move || LASTFM_ATTEMPT.load(Ordering::Relaxed) == attempt;
    state(|s| {
        s.set_fm_busy(true);
        s.set_fm_error("".into());
    });
    let api = with_app(|app| app.api.clone());
    let report = move |f: Box<dyn FnOnce(SettingsState) + Send>| {
        let _ = slint::invoke_from_event_loop(move || state(f));
    };
    thread::spawn(move || {
        let auth = match api.authorize_lastfm() {
            Ok(auth) => auth,
            Err(e) => {
                return report(Box::new(move |s| {
                    s.set_fm_busy(false);
                    s.set_fm_error(format!("{e:#}").into());
                }));
            }
        };
        open_in_browser(&auth.url);
        let url = SharedString::from(auth.url.as_str());
        report(Box::new(move |s| {
            s.set_fm_busy(false);
            s.set_fm_url(url);
            s.set_fm_waiting(true);
        }));
        let started = Instant::now();
        while current() && started.elapsed() < LASTFM_WAIT {
            thread::sleep(LASTFM_POLL);
            if !current() {
                return;
            }
            let result = api.connect_lastfm(&auth.token);
            let waiting = matches!(&result, Err(e)
                if e.downcast_ref::<ServerError>().is_some_and(|e| e.code == "not_authorized"));
            // A network hiccup while waiting: just ask again.
            if waiting
                || result
                    .as_ref()
                    .is_err_and(|e| e.downcast_ref::<ServerError>().is_none())
            {
                continue;
            }
            return report(Box::new(move |s| {
                s.set_fm_waiting(false);
                match result {
                    Ok(settings) => show_scrobbling(&s, &settings),
                    Err(e) => s.set_fm_error(format!("{e:#}").into()),
                }
            }));
        }
        if current() {
            report(Box::new(|s| {
                s.set_fm_waiting(false);
                s.set_fm_error(
                    "Last.fm wasn't allowed in time; connect again when you're ready.".into(),
                );
            }));
        }
    });
}

fn disconnect_lastfm() {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.disconnect_lastfm(),
        |settings| state(|s| show_scrobbling(&s, &settings)),
    );
}

fn open_in_browser(url: &str) {
    let mut command = if cfg!(target_os = "windows") {
        // Not `cmd /C start`: cmd would cut the URL at its first `&`.
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else if cfg!(target_os = "macos") {
        Command::new("open")
    } else {
        Command::new("xdg-open")
    };
    if let Err(e) = command.arg(url).spawn() {
        eprintln!("opening {url}: {e}");
    }
}

// ------------------------------------------------------------------ server

/// For everyone: listeners get the counts, admins the folders too.
fn load_library() {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.library_status(),
        |library| state(|s| show_library(&s, &library)),
    );
}

fn load_users(me: String) {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.users(),
        move |users| state(|s| show_users(&s, &users, &me)),
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
    s.set_folder_example(match l.path_style {
        types::LibraryStatusPathStyle::Windows => r"D:\Music".into(),
        types::LibraryStatusPathStyle::Posix => "/mnt/music".into(),
    });
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
        let result = action(&api).and_then(|_| {
            let me = api.me()?;
            // Took away our own admin role: the user list isn't ours to see any more.
            let users = if me.user.admin {
                Some(api.users()?)
            } else {
                None
            };
            Ok((users, me))
        });
        let _ = slint::invoke_from_event_loop(move || match result {
            Ok((Some(users), me)) => {
                state(|s| show_users(&s, &users, me.user.id.as_str()));
                users_message(done, false);
            }
            // Back to the listener's view of the page.
            Ok((None, _)) => load(),
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

/// The folders as last shown.
fn folder_paths() -> Vec<String> {
    with_app(|app| {
        app.ui.upgrade().map_or_else(Vec::new, |ui| {
            let folders = ui.global::<SettingsState>().get_folders();
            folders.iter().map(|f| f.path.to_string()).collect()
        })
    })
}

fn add_folder() {
    let path = with_app(|app| {
        app.ui.upgrade().map(|ui| {
            ui.global::<SettingsState>()
                .get_new_folder()
                .trim()
                .to_string()
        })
    })
    .unwrap_or_default();
    if path.is_empty() {
        return;
    }
    let mut paths = folder_paths();
    paths.push(path);
    set_folders(paths, "Folder added; scanning it now.");
}

/// Sends the new folder list; the server refuses paths that aren't folders on it.
fn set_folders(paths: Vec<String>, done: &'static str) {
    let api = with_app(|app| app.api.clone());
    thread::spawn(move || {
        let result = api.set_library_folders(paths);
        let _ = slint::invoke_from_event_loop(move || {
            state(|s| match result {
                Ok(library) => {
                    show_library(&s, &library);
                    s.set_new_folder("".into());
                    s.set_folders_message(done.into());
                    s.set_folders_error(false);
                }
                Err(e) => {
                    // The server's own words ("There's no folder … on the server") are the useful part.
                    let msg = format!("{e:#}");
                    s.set_folders_message(msg.rsplit(": ").next().unwrap_or(&msg).into());
                    s.set_folders_error(true);
                }
            })
        });
    });
}

fn rescan() {
    let api = with_app(|app| app.api.clone());
    background(
        move || api.rescan_library(),
        |library| state(|s| show_library(&s, &library)),
    );
}
