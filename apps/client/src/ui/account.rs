//! Signing in and out. Until a session is confirmed, the login screen covers the app.

use hyperplayer::{
    api::{Api, Unauthorized},
    credentials,
    trust::{self, UntrustedCertificate},
};

use super::{
    App, LoginState, Page, browse, library, local,
    playback::{self, Then},
    with_app,
};

const DEFAULT_SERVER: &str = "http://127.0.0.1:4533";

/// A session that may only replace its default password until it does.
pub struct Pending {
    server: String,
    username: String,
    token: String,
    /// The password just used to sign in; None after a restart (then it's asked for again).
    password: Option<String>,
    /// The built-in admin on a fresh server: after the password, offer to register the real user.
    first_run: bool,
}

/// The server to use: `HP_SERVER`, else the last one signed in to, else localhost.
pub fn initial_server(settings_server: &str) -> String {
    std::env::var("HP_SERVER")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| (!settings_server.is_empty()).then(|| settings_server.to_string()))
        .unwrap_or_else(|| DEFAULT_SERVER.into())
}

pub fn normalize_server(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    if url.contains("://") {
        return url.to_string();
    }
    // Servers speak HTTPS, except a development one only reachable from this machine.
    let host = url.rsplit_once(':').map_or(url, |(h, _)| h);
    if ["localhost", "127.0.0.1", "[::1]"].contains(&host) {
        format!("http://{url}")
    } else {
        format!("https://{url}")
    }
}

/// Human name for this device in the server's device list.
pub fn device_name() -> String {
    let host = std::fs::read_to_string("/etc/hostname")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "this computer".into());
    format!("HyperPlayer on {host}")
}

fn set_login(app: &App, change: impl FnOnce(&mut LoginState)) {
    if let Some(ui) = app.ui.upgrade() {
        let mut state = ui.get_login();
        change(&mut state);
        ui.set_login(state);
    }
}

/// Opening the music on this computer: the choice, with its button busy meanwhile.
pub fn show_opening_local(app: &App) {
    if let Some(ui) = app.ui.upgrade() {
        ui.set_signed_in(false);
    }
    let local_available = local::available();
    set_login(app, |l| {
        l.busy = true;
        l.choosing = true;
        l.local_available = local_available;
        l.error = "".into();
        l.trust_fingerprint = "".into();
    });
}

/// At startup: the music on this computer if that's what was chosen, else resume the saved
/// session if its token still works, else ask where the music is (or to sign in).
pub fn begin(has_token: bool) {
    let mode = with_app(|app| app.settings.mode.clone());
    if mode == "local" {
        return local::start();
    }
    // Not chosen yet (a first start, or a player from before the choice existed): where's
    // the music? HP_SERVER (development) means a server.
    if mode.is_empty() && std::env::var_os("HP_SERVER").is_none() && local::available() {
        return show_choice(None);
    }
    if !has_token {
        show_login(None);
        return;
    }
    let api = with_app(|app| app.api.clone());
    std::thread::spawn(move || {
        let result = api.me();
        let _ = slint::invoke_from_event_loop(move || match result {
            Ok(me) if me.user.must_change_password => {
                let (server, token) = with_app(|app| {
                    let server = app.api.base().to_string();
                    let token = credentials::load(&server, &me.user.username).unwrap_or_default();
                    (server, token)
                });
                let first_run = me.user.admin;
                ask_new_password(Pending {
                    server,
                    username: me.user.username,
                    token,
                    password: None,
                    first_run,
                });
            }
            Ok(me) => {
                let (server, token) = with_app(|app| {
                    let server = app.api.base().to_string();
                    let token = credentials::load(&server, &me.user.username).unwrap_or_default();
                    (server, token)
                });
                continue_as(server, token, me.user);
            }
            Err(e) if e.is::<UntrustedCertificate>() => ask_trust(&e),
            Err(e) if e.is::<Unauthorized>() => {
                with_app(|app| credentials::delete(app.api.base(), &app.settings.username));
                show_login(Some("Your session has ended; please sign in again.".into()));
            }
            Err(e) => show_login(Some(format!("Cannot reach the server: {e:#}"))),
        });
    });
}

pub fn show_login(error: Option<String>) {
    with_app(|app| {
        let Some(ui) = app.ui.upgrade() else { return };
        ui.set_login_server(app.api.base().into());
        ui.set_login_username(app.settings.username.clone().into());
        ui.set_login_password("".into());
        ui.set_signed_in(false);
        let local_available = local::available();
        set_login(app, |s| {
            s.busy = false;
            s.choosing = false;
            s.picking_folder = false;
            s.local_available = local_available;
            s.changing_password = false;
            s.onboarding = false;
            s.error = error.unwrap_or_default().into();
            s.trust_fingerprint = "".into();
        });
    });
    check_server();
}

/// Asks where the music is: on this computer, or on a server.
pub fn show_choice(error: Option<String>) {
    with_app(|app| {
        let Some(ui) = app.ui.upgrade() else { return };
        ui.set_signed_in(false);
        ui.set_status("".into());
        let local_available = local::available();
        set_login(app, |s| {
            s.busy = false;
            s.choosing = true;
            s.picking_folder = false;
            s.local_available = local_available;
            s.changing_password = false;
            s.onboarding = false;
            // The library being left failed to open: going back to it would only fail again.
            if error.is_some() {
                s.can_go_back = false;
            }
            s.error = error.unwrap_or_default().into();
            s.trust_fingerprint = "".into();
        });
    });
}

thread_local! {
    /// The mode "Switch library" left (`local` or `server`), for "Back to my library".
    static SWITCHED_FROM: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// "Switch library": back to the choice between a standalone player and a server. A
/// server's session is kept (in the keyring), so choosing it again needs no password.
pub fn switch_library() {
    playback::stop();
    let mode = with_app(|app| {
        let mode = app.settings.mode.clone();
        forget_session(app);
        // Standalone: the engine keeps running until something else is chosen, in case it's
        // chosen again. A server stays the mode until another is chosen, so that quitting
        // here starts with it as before.
        if app.settings.is_local() {
            app.settings.mode = String::new();
            app.settings.save();
        }
        set_login(app, |l| l.can_go_back = true);
        mode
    });
    SWITCHED_FROM.with(|m| *m.borrow_mut() = mode);
    show_choice(None);
}

/// "Back to my library" on the choice screen: the library switched away from.
pub fn back_to_library() {
    if SWITCHED_FROM.with(|m| m.borrow().clone()) == "local" {
        local::start();
    } else {
        use_server();
    }
}

/// Standalone mode's first start: which folder the library starts with (`suggested`, the
/// usual Music folder, if there is one).
pub fn show_folder_step(suggested: String) {
    with_app(|app| {
        let Some(ui) = app.ui.upgrade() else { return };
        ui.set_signed_in(false);
        ui.set_status("".into());
        set_login(app, |s| {
            s.busy = false;
            s.choosing = true;
            s.picking_folder = true;
            s.music_folder = suggested.into();
            s.changing_password = false;
            s.onboarding = false;
            s.error = "".into();
            s.trust_fingerprint = "".into();
        });
    });
}

/// The folder step's "Choose another folder…": the system's dialog.
pub fn browse_music_folder() {
    local::pick_folder("Choose your music folder", |picked| {
        if let Some(folder) = picked {
            with_app(|app| set_login(app, |l| l.music_folder = folder.into()));
        }
    });
}

/// The folder step's "Use this folder".
pub fn use_music_folder() {
    let folder = with_app(|app| {
        app.ui
            .upgrade()
            .map(|ui| ui.get_login().music_folder.to_string())
    })
    .unwrap_or_default();
    local::use_folder(folder);
}

/// Chose a server: the sign-in form, for the last server used.
pub fn use_server() {
    // The last server signed in to (not the library engine), resuming its saved session.
    let has_token = with_app(|app| {
        let server = initial_server(&app.settings.server);
        let token = (!app.settings.username.is_empty())
            .then(|| credentials::load(&server, &app.settings.username))
            .flatten();
        app.api = Api::with_token(server, token.as_deref());
        if token.is_some() {
            app.settings.mode = "server".into();
            app.settings.save();
        }
        token.is_some()
    });
    if has_token {
        // The session is checked as at startup: still valid, or the sign-in form.
        with_app(|app| set_login(app, |l| l.choosing = false));
        begin(true);
    } else {
        show_login(None);
    }
}

/// Signed in to the library engine on this computer.
pub fn signed_in_locally(user: &hyperplayer::api::types::User) {
    with_app(|app| {
        set_login(app, |l| {
            l.choosing = false;
            l.picking_folder = false;
        })
    });
    signed_in(&display_name(user));
}

/// Asks whether to trust the certificate `err` (an `UntrustedCertificate`) is about.
fn ask_trust(err: &anyhow::Error) {
    let Some(e) = err.downcast_ref::<UntrustedCertificate>() else {
        return;
    };
    with_app(|app| {
        if let Some(ui) = app.ui.upgrade() {
            ui.set_signed_in(false);
        }
        set_login(app, |l| {
            l.busy = false;
            l.error = "".into();
            l.trust_server = e.server.clone().into();
            l.trust_fingerprint = e.fingerprint.clone().into();
        });
    });
}

/// Trusts the server's certificate from now on, then carries on: resuming the saved
/// session for that server, or back to signing in.
pub fn trust_server() {
    let (server, resume) = with_app(|app| {
        let Some(ui) = app.ui.upgrade() else {
            return (String::new(), false);
        };
        let login = ui.get_login();
        let server = login.trust_server.to_string();
        trust::trust(&server, &login.trust_fingerprint);
        set_login(app, |l| {
            l.trust_fingerprint = "".into();
            l.trust_server = "".into();
        });
        let token = (app.settings.server == server)
            .then(|| credentials::load(&server, &app.settings.username))
            .flatten();
        // Connections are set up with the trusted certificates, so make new ones.
        app.api = Api::with_token(server.clone(), token.as_deref());
        (server, token.is_some())
    });
    if server.is_empty() {
        return;
    }
    if resume {
        begin(true);
    } else {
        check_server();
    }
}

/// Not trusted: stay on the sign-in form, without asking again until the server changes.
pub fn cancel_trust() {
    with_app(|app| {
        set_login(app, |l| {
            l.error = format!(
                "{} isn't trusted, so HyperPlayer won't connect to it.",
                l.trust_server
            )
            .into();
            l.trust_fingerprint = "".into();
            l.trust_server = "".into();
        });
    });
}

/// Asks the server whether it needs first-time setup (and whether it's reachable at all).
pub fn check_server() {
    let server = with_app(|app| {
        app.ui
            .upgrade()
            .map(|ui| normalize_server(&ui.get_login_server()))
    });
    let Some(server) = server else { return };
    std::thread::spawn(move || {
        let status = Api::new(server.clone()).auth_status();
        let _ = slint::invoke_from_event_loop(move || match status {
            Ok(s) => with_app(|app| {
                set_login(app, |l| {
                    l.default_admin = s.default_admin;
                    if l.error.starts_with("Cannot reach") {
                        l.error = "".into();
                    }
                });
                if let Some(ui) = app.ui.upgrade()
                    && s.default_admin
                    && ui.get_login_username().is_empty()
                {
                    ui.set_login_username("admin".into());
                }
            }),
            // Takes the app itself.
            Err(e) if e.is::<UntrustedCertificate>() => ask_trust(&e),
            Err(e) => with_app(|app| {
                set_login(app, |l| {
                    l.error = format!("Cannot reach {server}: {e:#}").into()
                })
            }),
        });
    });
}

pub fn submit() {
    let Some((server, username, password, device_id)) = with_app(|app| {
        let ui = app.ui.upgrade()?;
        set_login(app, |l| {
            l.busy = true;
            l.error = "".into();
        });
        Some((
            normalize_server(&ui.get_login_server()),
            ui.get_login_username().trim().to_string(),
            ui.get_login_password().to_string(),
            app.settings.device_id.clone(),
        ))
    }) else {
        return;
    };
    std::thread::spawn(move || {
        let result =
            Api::new(server.clone()).login(&username, &password, &device_name(), &device_id);
        let _ = slint::invoke_from_event_loop(move || match result {
            Ok(session) => {
                let username = session.user.username.clone();
                with_app(|app| {
                    app.settings.mode = "server".into();
                    app.settings.server = server.clone();
                    app.settings.username = username.clone();
                    // The server may assign a different id (e.g. ours belongs to another account).
                    app.settings.device_id = session.device.id.to_string();
                    app.settings.save();
                });
                // A server now: the music on this computer isn't needed anymore.
                std::thread::spawn(local::stop);
                // Stored even while restricted, so quitting mid-change resumes at the password step.
                let stored = credentials::save(&server, &username, &session.token);
                eprintln!("signed in as {username}; token stored in {stored}");
                if session.user.must_change_password {
                    let first_run = session.user.admin;
                    ask_new_password(Pending {
                        server,
                        username,
                        token: session.token,
                        password: Some(password),
                        first_run,
                    });
                } else {
                    continue_as(server, session.token, session.user);
                }
            }
            Err(e) => show_error(&e),
        });
    });
}

fn show_error(e: &anyhow::Error) {
    if e.is::<UntrustedCertificate>() {
        return ask_trust(e);
    }
    with_app(|app| {
        // The server's message ("Wrong username or password", "Too many failed sign-ins…") is the useful part.
        let msg = format!("{e:#}");
        let msg = msg.rsplit(": ").next().unwrap_or(&msg).to_string();
        set_login(app, |l| {
            l.busy = false;
            l.error = msg.into();
        });
    });
}

fn ask_new_password(pending: Pending) {
    with_app(|app| {
        if let Some(ui) = app.ui.upgrade() {
            ui.set_signed_in(false);
            ui.set_login_new_password("".into());
            ui.set_login_confirm_password("".into());
        }
        let need_current = pending.password.is_none();
        set_login(app, |l| {
            l.busy = false;
            l.error = "".into();
            l.changing_password = true;
            l.need_current = need_current;
        });
        app.pending = Some(pending);
    });
}

pub fn change_password() {
    let Some((api, current, new, confirm)) = with_app(|app| {
        let ui = app.ui.upgrade()?;
        let p = app.pending.as_ref()?;
        let current = p
            .password
            .clone()
            .unwrap_or_else(|| ui.get_login_password().to_string());
        Some((
            Api::with_token(p.server.clone(), Some(&p.token)),
            current,
            ui.get_login_new_password().to_string(),
            ui.get_login_confirm_password().to_string(),
        ))
    }) else {
        return;
    };
    let complain = |msg: &str| with_app(|app| set_login(app, |l| l.error = msg.into()));
    if new.chars().count() < 8 {
        return complain("Use at least 8 characters.");
    }
    if new != confirm {
        return complain("The two passwords don't match.");
    }
    with_app(|app| {
        set_login(app, |l| {
            l.busy = true;
            l.error = "".into();
        })
    });
    std::thread::spawn(move || {
        let result = api.change_password(&current, &new);
        let _ = slint::invoke_from_event_loop(move || match result {
            Ok(()) => {
                let first_run = with_app(|app| {
                    set_login(app, |l| {
                        l.changing_password = false;
                        l.default_admin = false;
                    });
                    if let Some(ui) = app.ui.upgrade() {
                        ui.set_login_new_password("".into());
                        ui.set_login_confirm_password("".into());
                    }
                    app.pending.as_ref().is_some_and(|p| p.first_run)
                });
                if first_run {
                    ask_onboarding();
                } else if let Some(p) = with_app(|app| app.pending.take()) {
                    finish(&p.server, &p.token, &p.username);
                }
            }
            Err(e) => show_error(&e),
        });
    });
}

/// The session is fully usable: switch the client over to it.
fn finish(server: &str, token: &str, display: &str) {
    with_app(|app| {
        app.api = Api::with_token(server.to_string(), Some(token));
        if let Some(ui) = app.ui.upgrade() {
            ui.set_login_password("".into());
        }
    });
    signed_in(display);
}

fn ask_onboarding() {
    with_app(|app| {
        if let Some(ui) = app.ui.upgrade() {
            ui.set_login_full_name("".into());
            ui.set_login_username("".into());
        }
        set_login(app, |l| {
            l.busy = false;
            l.error = "".into();
            l.onboarding = true;
        });
    });
}

/// Registers the everyday user from the admin's session; this device moves to the new account.
pub fn onboard() {
    let Some((api, server, admin, full_name, username, password, confirm)) = with_app(|app| {
        let ui = app.ui.upgrade()?;
        let p = app.pending.as_ref()?;
        Some((
            Api::with_token(p.server.clone(), Some(&p.token)),
            p.server.clone(),
            p.username.clone(),
            ui.get_login_full_name().to_string(),
            ui.get_login_username().trim().to_string(),
            ui.get_login_new_password().to_string(),
            ui.get_login_confirm_password().to_string(),
        ))
    }) else {
        return;
    };
    let complain = |msg: &str| with_app(|app| set_login(app, |l| l.error = msg.into()));
    if username.is_empty() {
        return complain("Choose a username.");
    }
    if password.chars().count() < 8 {
        return complain("Use at least 8 characters for the password.");
    }
    if password != confirm {
        return complain("The two passwords don't match.");
    }
    with_app(|app| {
        set_login(app, |l| {
            l.busy = true;
            l.error = "".into();
        })
    });
    std::thread::spawn(move || {
        let result = api.onboard(&full_name, &username, &password);
        let _ = slint::invoke_from_event_loop(move || match result {
            Ok(session) => {
                // This device now belongs to the new user: swap the stored credentials over.
                credentials::delete(&server, &admin);
                let stored = credentials::save(&server, &session.user.username, &session.token);
                eprintln!(
                    "registered {}; token stored in {stored}",
                    session.user.username
                );
                with_app(|app| {
                    app.pending = None;
                    app.settings.username = session.user.username.clone();
                    app.settings.save();
                    set_login(app, |l| l.onboarding = false);
                    if let Some(ui) = app.ui.upgrade() {
                        ui.set_login_new_password("".into());
                        ui.set_login_confirm_password("".into());
                    }
                });
                finish(&server, &session.token, &display_name(&session.user));
            }
            Err(e) => show_error(&e),
        });
    });
}

/// Signed in with a usable session. An admin on a server with no other account yet is
/// offered to register the everyday user first (unless that was skipped on this device).
fn continue_as(server: String, token: String, user: hyperplayer::api::types::User) {
    let skipped = with_app(|app| app.settings.onboarding_skipped);
    if !user.admin || skipped {
        return finish(&server, &token, &display_name(&user));
    }
    let api = Api::with_token(server.clone(), Some(&token));
    std::thread::spawn(move || {
        let alone = api.users().map(|u| u.0.len() == 1).unwrap_or(false);
        let _ = slint::invoke_from_event_loop(move || {
            if alone {
                with_app(|app| {
                    if let Some(ui) = app.ui.upgrade() {
                        ui.set_signed_in(false);
                    }
                    app.pending = Some(Pending {
                        server,
                        username: user.username.clone(),
                        token,
                        password: None,
                        first_run: true,
                    });
                });
                ask_onboarding();
            } else {
                finish(&server, &token, &display_name(&user));
            }
        });
    });
}

pub fn skip_onboarding() {
    let Some(p) = with_app(|app| {
        set_login(app, |l| l.onboarding = false);
        app.settings.onboarding_skipped = true;
        app.settings.save();
        app.pending.take()
    }) else {
        return;
    };
    finish(&p.server, &p.token, &p.username);
}

fn display_name(user: &hyperplayer::api::types::User) -> String {
    user.full_name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| user.username.clone())
}

fn signed_in(display: &str) {
    with_app(|app| {
        if let Some(ui) = app.ui.upgrade() {
            let local = app.settings.is_local();
            ui.set_local_library(local);
            ui.set_can_switch_library(local::available());
            slint::ComponentHandle::global::<super::SettingsState>(&ui)
                .set_can_switch(local::available());
            slint::ComponentHandle::global::<super::SettingsState>(&ui).set_local(local);
            ui.set_signed_in(true);
            ui.set_account(display.into());
            set_login(app, |l| {
                l.busy = false;
                l.can_go_back = false;
            });
        }
    });
    load_preferences();
    browse::load_artists();
    if with_app(|app| app.settings.is_local()) {
        browse::follow_local_library();
    }
    library::load_playlists();
    // Restore this device's queue: show the current track, ready to resume where it stopped.
    playback::queue_op(Then::Show, |api| api.queue());
    super::restore_now_playing_when_ready();
}

pub fn sign_out() {
    playback::stop();
    // The music on this computer: nothing to sign out of; ask where the music is instead.
    if with_app(|app| app.settings.is_local()) {
        return switch_library();
    }
    let api = with_app(|app| {
        let api = app.api.clone();
        credentials::delete(api.base(), &app.settings.username);
        forget_session(app);
        api
    });
    // Revoke the token server-side too; if the server is unreachable it's already forgotten here.
    std::thread::spawn(move || {
        let _ = api.logout();
    });
    show_login(None);
}

/// The server rejected our token mid-session (revoked from another device, password changed…).
pub fn session_ended() {
    let signed_in = with_app(|app| app.ui.upgrade().is_some_and(|ui| ui.get_signed_in()));
    if !signed_in {
        return;
    }
    playback::stop();
    // The engine restarted (with a new token) under a request: connect again.
    if with_app(|app| app.settings.is_local()) {
        return local::start();
    }
    with_app(|app| {
        credentials::delete(app.api.base(), &app.settings.username);
        forget_session(app);
    });
    show_login(Some("Your session has ended; please sign in again.".into()));
}

fn forget_session(app: &mut App) {
    app.api = Api::new(app.api.base().to_string());
    app.pending = None;
    app.queue = None;
    app.playlist = None;
    app.playlists.clear();
    if let Some(ui) = app.ui.upgrade() {
        ui.set_page(Page::Welcome);
        ui.set_account("".into());
    }
}

/// Lets `background` route auth failures here without depending on this module's details.
pub fn handle_error(err: &anyhow::Error) -> bool {
    if err.is::<UntrustedCertificate>() {
        // The server's certificate changed mid-session: nothing works until it's trusted.
        playback::stop();
        ask_trust(err);
        true
    } else if err.is::<Unauthorized>() {
        session_ended();
        true
    } else {
        false
    }
}

/// Applies the account's preferences (unless overridden with HP_QUALITY for this run).
fn load_preferences() {
    let api = with_app(|app| app.api.clone());
    super::background(
        move || api.preferences(),
        |prefs| {
            with_app(|app| {
                // HP_QUALITY overrides the stored quality mode for this run.
                if std::env::var_os("HP_QUALITY").is_none() {
                    app.mode = super::mode_from(&prefs.quality.to_string());
                    app.settings.quality = prefs.quality.to_string();
                }
                app.rg_mode =
                    hyperplayer::replaygain::Mode::from_name(&prefs.replay_gain.to_string());
                app.rg_preamp = prefs.replay_gain_preamp as f32;
                playback::apply_replaygain(app);
                super::appearance::set_preferences(app, &prefs);
                if let Some(ui) = app.ui.upgrade() {
                    ui.set_shuffle_scope(prefs.shuffle_scope.to_string().into());
                }
            })
        },
    );
}
