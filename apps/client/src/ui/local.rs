//! Standalone mode: the music on this computer, through the library engine the player
//! runs itself (see `hyperplayer::engine`). There's no sign-in: the engine signs the
//! player in as its local account, with a new token each start.

use std::{
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use hyperplayer::{
    api::Api,
    engine::{self, Engine, Launch},
};

use super::{account, playback, with_app};

/// The running engine, kept apart from `App` so it outlives it while the player quits.
static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);
/// Bumped whenever the engine is started or stopped on purpose, so the watchdog leaves it be.
static GENERATION: Mutex<u64> = Mutex::new(0);

/// Restarts tolerated in a row before giving up (a broken install would loop forever).
const MAX_RESTARTS: u32 = 3;
/// A restart this long after the previous one starts the count afresh.
const STABLE: Duration = Duration::from_secs(120);

/// How to start the engine, if this player has one.
pub fn launch() -> Option<&'static Launch> {
    static LAUNCH: OnceLock<Option<Launch>> = OnceLock::new();
    LAUNCH
        .get_or_init(|| {
            let found = engine::locate();
            match &found {
                Some(l) => eprintln!(
                    "library engine: {} in {}",
                    l.program.display(),
                    l.dir.display()
                ),
                None => eprintln!("no library engine found: only servers can be used"),
            }
            found
        })
        .as_ref()
}

pub fn available() -> bool {
    launch().is_some()
}

/// Switches to the music on this computer: starts the engine (unless it's running) and
/// signs in to it.
pub fn start() {
    let Some(launch) = launch() else {
        account::show_choice(Some("This copy of HyperPlayer can't play music from this computer: it only connects to servers.".into()));
        return;
    };
    let (device_id, device_name) = with_app(|app| {
        if let Some(ui) = app.ui.upgrade() {
            ui.set_status("Opening your music library…".into());
        }
        account::show_opening_local(app);
        (app.settings.device_id.clone(), account::device_name())
    });
    let generation = next_generation();
    thread::spawn(move || {
        let result = running().map(Ok).unwrap_or_else(|| {
            let engine = Engine::start(launch, &device_id, &device_name)?;
            let session = (engine.url.clone(), engine.token.clone());
            *ENGINE.lock().unwrap() = Some(engine);
            Ok::<_, anyhow::Error>(session)
        });
        let _ = slint::invoke_from_event_loop(move || match result {
            Ok((url, token)) => {
                connected(url, token);
                watch(generation, device_id, device_name);
            }
            Err(e) => {
                eprintln!("{e:#}");
                account::show_choice(Some(format!(
                    "Your music library couldn't be opened: {e:#}"
                )));
            }
        });
    });
}

/// The running engine's address and token, if it's still running.
fn running() -> Option<(String, String)> {
    let guard = ENGINE.lock().unwrap();
    let engine = guard.as_ref()?;
    engine
        .exited()
        .is_none()
        .then(|| (engine.url.clone(), engine.token.clone()))
}

fn next_generation() -> u64 {
    let mut g = GENERATION.lock().unwrap();
    *g += 1;
    *g
}

/// Uses the engine at `url`, signed in with `token`.
fn connected(url: String, token: String) {
    let api = Api::with_token(url, Some(&token));
    with_app(|app| {
        app.api = api.clone();
        app.settings.mode = "local".into();
        app.settings.save();
    });
    thread::spawn(move || {
        let me = api.me();
        let _ = slint::invoke_from_event_loop(move || match me {
            Ok(me) => account::signed_in_locally(&me.user),
            Err(e) => {
                account::show_choice(Some(format!("Your music library isn't answering: {e:#}")))
            }
        });
    });
}

/// Restarts the engine if it stops by itself (a crash), and hands the new connection to
/// the app. Its port and token change; the device, so the queue, stays the same.
fn watch(generation: u64, device_id: String, device_name: String) {
    thread::spawn(move || {
        let mut restarts = 0;
        let mut last_restart = Instant::now();
        loop {
            thread::sleep(Duration::from_secs(2));
            if *GENERATION.lock().unwrap() != generation {
                return;
            }
            let status = match ENGINE.lock().unwrap().as_ref() {
                None => return,
                Some(engine) => match engine.exited() {
                    None => continue,
                    Some(status) => status,
                },
            };
            eprintln!("the library engine stopped ({status}); restarting it");
            if last_restart.elapsed() > STABLE {
                restarts = 0;
            }
            restarts += 1;
            last_restart = Instant::now();
            if restarts > MAX_RESTARTS {
                let _ = slint::invoke_from_event_loop(|| {
                    playback::stop();
                    account::show_choice(Some(
                        "Your music library keeps stopping. Its log (engine.log, next to HyperPlayer's) says why.".into(),
                    ));
                });
                return;
            }
            let Some(launch) = launch() else { return };
            match Engine::start(launch, &device_id, &device_name) {
                Ok(engine) => {
                    let api = Api::with_token(engine.url.clone(), Some(&engine.token));
                    {
                        // Stopped on purpose meanwhile: this one isn't wanted either.
                        if *GENERATION.lock().unwrap() != generation {
                            return;
                        }
                        *ENGINE.lock().unwrap() = Some(engine);
                    }
                    let _ = slint::invoke_from_event_loop(move || {
                        with_app(|app| app.api = api);
                    });
                }
                Err(e) => eprintln!("restarting the library engine: {e:#}"),
            }
        }
    });
}

/// Stops the engine (quitting, or not using it anymore), waiting until it has.
pub fn stop() {
    next_generation();
    let engine = ENGINE.lock().unwrap().take();
    drop(engine);
}

/// Asks for a folder with the system's dialog (the desktop portal on Linux).
pub fn pick_folder(done: impl FnOnce(Option<String>) + Send + 'static) {
    let ask = || {
        let mut dialog = rfd::FileDialog::new().set_title("Add a music folder");
        if let Some(dir) = engine::default_music_dir().filter(|d| d.is_dir()) {
            dialog = dialog.set_directory(dir);
        }
        dialog
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned())
    };
    // macOS shows dialogs from the main thread only; elsewhere the UI keeps drawing meanwhile.
    if cfg!(target_os = "macos") {
        done(ask());
    } else {
        thread::spawn(move || {
            let picked = ask();
            let _ = slint::invoke_from_event_loop(move || done(picked));
        });
    }
}
