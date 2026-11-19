//! Standalone mode: the music on this computer, through the library engine the player
//! runs itself (see `hyperplayer::engine`). There's no sign-in: the engine signs the
//! player in as its local account, with a new token each start.

use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use hyperplayer::{
    api::Api,
    engine::{self, Engine, Launch},
    tr,
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

/// Switches to standalone mode: asks for the music folder the first time, then starts
/// the engine (unless it's running) and signs in to it.
pub fn start() {
    if launch().is_none() {
        account::show_choice(Some(
            tr!("This copy of HyperPlayer can only connect to a server: it has no library of its own.")
                .into(),
        ));
        return;
    }
    if with_app(|app| app.settings.music_folder.is_empty()) && !engine::has_library() {
        let suggested = engine::default_music_dir()
            .filter(|d| d.is_dir())
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default();
        return account::show_folder_step(suggested);
    }
    open();
}

/// The library's first folder, from the folder step: remembered, then the library opens.
pub fn use_folder(folder: String) {
    if folder.trim().is_empty() {
        return;
    }
    with_app(|app| {
        app.settings.music_folder = folder.trim().to_string();
        app.settings.save();
    });
    open();
}

/// Starts the engine (unless it's running) and signs in to it.
fn open() {
    let Some(launch) = launch() else { return };
    let (device_id, device_name, music) = with_app(|app| {
        if let Some(ui) = app.ui.upgrade() {
            ui.set_status(tr!("Opening your music library…").into());
        }
        account::show_opening_local(app);
        let music = Some(&app.settings.music_folder)
            .filter(|f| !f.is_empty())
            .map(PathBuf::from);
        (
            app.settings.device_id.clone(),
            account::device_name(),
            music,
        )
    });
    let generation = next_generation();
    thread::spawn(move || {
        let result = running().map(Ok).unwrap_or_else(|| {
            let engine = Engine::start(launch, &device_id, &device_name, music.as_deref())?;
            let session = (engine.url.clone(), engine.token.clone());
            *ENGINE.lock().unwrap() = Some(engine);
            Ok::<_, anyhow::Error>(session)
        });
        let _ = slint::invoke_from_event_loop(move || match result {
            Ok((url, token)) => {
                connected(url, token);
                watch(generation, device_id, device_name, music);
            }
            Err(e) => {
                eprintln!("{e:#}");
                account::show_choice(Some(tr!(
                    "Your music library couldn't be opened: {}",
                    format!("{e:#}")
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
        #[cfg(target_os = "linux")]
        use_host_folders(&api);
        let me = api.me();
        let _ = slint::invoke_from_event_loop(move || match me {
            Ok(me) => account::signed_in_locally(&me.user),
            Err(e) => account::show_choice(Some(tr!(
                "Your music library isn't answering: {}",
                format!("{e:#}")
            ))),
        });
    });
}

/// Restarts the engine if it stops by itself (a crash), and hands the new connection to
/// the app. Its port and token change; the device, so the queue, stays the same.
fn watch(generation: u64, device_id: String, device_name: String, music: Option<PathBuf>) {
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
                        tr!("Your music library keeps stopping. Its log (engine.log, next to HyperPlayer's) says why.").into(),
                    ));
                });
                return;
            }
            let Some(launch) = launch() else { return };
            match Engine::start(launch, &device_id, &device_name, music.as_deref()) {
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

/**
 * The folder itself, for one the portal handed over as its own copy (`/run/user/<uid>/doc/<id>/…`)
 * when the sandbox can read the real one (the Flatpak sees home, /mnt and /media). The portal's
 * copy can turn up empty (seen with a CIFS share mounted over a VPN), and the engine then
 * finds no music. None when the folder isn't the portal's, or isn't readable.
 */
#[cfg(target_os = "linux")]
fn host_path(picked: &str) -> Option<String> {
    use std::collections::HashMap;
    use std::path::Path;
    let (id, below) = portal_document(picked)?;
    let bus = zbus::blocking::Connection::session().ok()?;
    let paths: HashMap<String, Vec<u8>> = bus
        .call_method(
            Some("org.freedesktop.portal.Documents"),
            "/org/freedesktop/portal/documents",
            Some("org.freedesktop.portal.Documents"),
            "GetHostPaths",
            &(vec![id],),
        )
        .ok()?
        .body()
        .deserialize()
        .ok()?;
    let host = paths.get(id)?;
    let host = String::from_utf8_lossy(host.strip_suffix(&[0]).unwrap_or(host)).into_owned();
    let real = if below.is_empty() {
        host
    } else {
        format!("{host}/{below}")
    };
    let readable = portal_document(&real).is_none() && Path::new(&real).read_dir().is_ok();
    readable.then_some(real)
}

/// A path in the document portal (`/run/user/<uid>/doc/<id>/<name>/…`, or `/run/flatpak/doc/…`
/// inside the sandbox): the document's id, and the path below the document (its `<name>`
/// stands for the folder itself).
#[cfg(target_os = "linux")]
fn portal_document(path: &str) -> Option<(&str, &str)> {
    let rest = match path.strip_prefix("/run/flatpak/doc/") {
        Some(rest) => rest,
        None => path
            .strip_prefix("/run/user/")?
            .split_once('/')?
            .1
            .strip_prefix("doc/")?,
    };
    let (id, inside) = rest.split_once('/')?;
    Some((id, inside.split_once('/').map_or("", |(_, below)| below)))
}

/// Swaps library folders saved as the portal's copies (picked before `host_path` was
/// used) for the folders themselves.
#[cfg(target_os = "linux")]
fn use_host_folders(api: &Api) {
    let Ok(status) = api.library_status() else {
        return;
    };
    let paths: Vec<String> = status.folders.iter().map(|f| f.path.clone()).collect();
    let fixed: Vec<String> = paths
        .iter()
        .map(|p| host_path(p).unwrap_or_else(|| p.clone()))
        .collect();
    if fixed != paths
        && let Err(e) = api.set_library_folders(fixed)
    {
        eprintln!("using the music folders themselves, not the portal's copies: {e:#}");
    }
}

/// Asks for a folder with the system's dialog (the desktop portal on Linux).
pub fn pick_folder(title: &'static str, done: impl FnOnce(Option<String>) + Send + 'static) {
    let ask = move || {
        let mut dialog = rfd::FileDialog::new().set_title(title);
        if let Some(dir) = engine::default_music_dir().filter(|d| d.is_dir()) {
            dialog = dialog.set_directory(dir);
        }
        dialog.pick_folder().map(|p| {
            let picked = p.to_string_lossy().into_owned();
            #[cfg(target_os = "linux")]
            if let Some(real) = host_path(&picked) {
                return real;
            }
            picked
        })
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

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::portal_document;

    #[test]
    fn portal_paths() {
        assert_eq!(
            portal_document("/run/user/1000/doc/1bd01f28/Lidarr"),
            Some(("1bd01f28", ""))
        );
        assert_eq!(
            portal_document("/run/user/1000/doc/1bd01f28/Lidarr/Area"),
            Some(("1bd01f28", "Area"))
        );
        assert_eq!(
            portal_document("/run/flatpak/doc/ab/Music/a/b"),
            Some(("ab", "a/b"))
        );
        assert_eq!(portal_document("/mnt/storage/Music/Lidarr"), None);
        assert_eq!(portal_document("/run/user/1000/gvfs/smb-share/Music"), None);
    }
}
