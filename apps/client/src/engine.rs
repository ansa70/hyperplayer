//! The local library engine: the HyperPlayer server, run by the player itself for the
//! music on this computer (standalone mode). It listens only on 127.0.0.1 and lives as
//! long as the player: it stops when its stdin closes, which also happens when the
//! player crashes. Everything else talks to it like to any server, through `Api`.

use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// The line the engine prints on stdout once it listens (see the server's `main.ts`).
const READY: &str = "HYPERPLAYER-READY ";
/// The first start of a big library, or an antivirus checking every file, takes a while.
const READY_TIMEOUT: Duration = Duration::from_secs(90);
/// How long it gets to close the database once asked to stop.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// The log is started afresh each run; the previous one is kept beside it.
const LOG: &str = "engine.log";

/// How to start the engine: a program, its arguments and the folder to run it in.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub dir: PathBuf,
    /// A bundled ffmpeg (for waveforms and transcoding), else the one on the PATH is used.
    pub ffmpeg: Option<PathBuf>,
}

fn executable(dir: &Path, name: &str) -> PathBuf {
    if cfg!(windows) {
        dir.join(format!("{name}.exe"))
    } else {
        dir.join(name)
    }
}

/// How the engine in `dir` is started: a bundled one (`node dist/main.mjs`, as releases
/// ship it) or, for development, the server's sources (`vpx src/main.ts`).
fn launch_in(dir: &Path) -> Option<Launch> {
    let node = executable(dir, "node");
    let ffmpeg = Some(executable(dir, "ffmpeg"))
        .filter(|f| f.is_file())
        .or_else(homebrew_ffmpeg);
    if node.is_file() && dir.join("dist/main.mjs").is_file() {
        return Some(Launch {
            program: node,
            args: vec!["dist/main.mjs".into()],
            dir: dir.to_path_buf(),
            ffmpeg,
        });
    }
    if dir.join("src/main.ts").is_file() {
        // vpx is a script on Windows: start it through the shell.
        let (program, mut args): (PathBuf, Vec<OsString>) = if cfg!(windows) {
            ("cmd".into(), vec!["/c".into(), "vpx".into()])
        } else {
            ("vpx".into(), vec![])
        };
        args.push("src/main.ts".into());
        return Some(Launch {
            program,
            args,
            dir: dir.to_path_buf(),
            ffmpeg,
        });
    }
    None
}

/// macOS: apps started from the Finder don't get Homebrew's PATH, so its ffmpeg is looked
/// for where Homebrew puts it (Apple Silicon, then Intel).
fn homebrew_ffmpeg() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

/// Finds the engine: `HP_ENGINE` (a folder), else the one shipped with the player, else
/// (Linux) the server `install.sh` put in /opt, else in a development build the sources.
pub fn locate() -> Option<Launch> {
    if let Some(dir) = std::env::var_os("HP_ENGINE").filter(|d| !d.is_empty()) {
        return launch_in(Path::new(&dir));
    }
    let mut candidates = Vec::new();
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|e| e.canonicalize().ok())
        .and_then(|e| e.parent().map(Path::to_path_buf))
    {
        candidates.push(exe_dir.join("server"));
        // A .deb / Flatpak: /usr/bin/hyperplayer and /usr/lib/hyperplayer/server.
        candidates.push(exe_dir.join("../lib/hyperplayer/server"));
        // macOS: Contents/MacOS/hyperplayer and Contents/Resources/server.
        candidates.push(exe_dir.join("../Resources/server"));
    }
    if cfg!(target_os = "linux") {
        candidates.push("/opt/hyperplayer/server".into());
    }
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../server"));
    }
    candidates.iter().find_map(|d| launch_in(d))
}

/// Where the engine keeps its database, artwork and certificates.
pub fn data_dir() -> Option<PathBuf> {
    Some(crate::dirs::data_dir()?.join("library"))
}

/// The folder music is usually in on this computer, for a first start.
pub fn default_music_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    if let Some(dir) = windows_music_dir() {
        return Some(dir);
    }
    let home = crate::dirs::home_dir()?;
    if cfg!(target_os = "linux")
        && let Some(dir) = xdg_music_dir(&home)
    {
        return Some(dir);
    }
    Some(home.join("Music"))
}

/// Windows' Music folder, wherever it is (OneDrive often moves it).
#[cfg(windows)]
fn windows_music_dir() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_Music, SHGetKnownFolderPath},
    };
    let mut path: windows_sys::core::PWSTR = std::ptr::null_mut();
    let ok =
        unsafe { SHGetKnownFolderPath(&FOLDERID_Music, 0, std::ptr::null_mut(), &mut path) } == 0;
    let dir = (ok && !path.is_null()).then(|| unsafe {
        let len = (0..).take_while(|&i| *path.add(i) != 0).count();
        PathBuf::from(OsString::from_wide(std::slice::from_raw_parts(path, len)))
    });
    unsafe { CoTaskMemFree(path.cast()) };
    dir
}

/// XDG_MUSIC_DIR from `user-dirs.dirs` (localised, e.g. ~/Musica).
fn xdg_music_dir(home: &Path) -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let text = fs::read_to_string(config.join("user-dirs.dirs")).ok()?;
    parse_music_dir(&text, home)
}

fn parse_music_dir(text: &str, home: &Path) -> Option<PathBuf> {
    let value = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("XDG_MUSIC_DIR="))?
        .trim()
        .trim_matches('"');
    let dir = match value.strip_prefix("$HOME") {
        Some(rest) => home.join(rest.trim_start_matches('/')),
        None => PathBuf::from(value),
    };
    // "$HOME/" alone means the desktop has no music folder.
    (dir != home && dir.is_absolute()).then_some(dir)
}

#[derive(Deserialize)]
struct Ready {
    port: u16,
    token: String,
}

/// A running engine. Dropping it stops the engine.
pub struct Engine {
    child: Arc<Mutex<Child>>,
    /// Held open while the engine should run; closing it asks the engine to stop.
    stdin: Option<ChildStdin>,
    pub url: String,
    pub token: String,
}

impl Engine {
    /// Starts the engine for this device and waits until it answers.
    pub fn start(launch: &Launch, device_id: &str, device_name: &str) -> Result<Self> {
        let data = data_dir().context("no folder for the library's data")?;
        fs::create_dir_all(&data).with_context(|| format!("creating {}", data.display()))?;
        let mut cmd = Command::new(&launch.program);
        cmd.args(&launch.args)
            .current_dir(&launch.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Our own settings only: none from the environment the player was started in.
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("HP_") {
                cmd.env_remove(&key);
            }
        }
        cmd.env("NODE_ENV", "production")
            .env("HP_EMBEDDED", "1")
            .env("HP_EMBEDDED_DEVICE", device_id)
            .env("HP_EMBEDDED_DEVICE_NAME", device_name)
            .env("HP_DATA_DIR", &data);
        // The first start's folder. Folders chosen in Settings replace it, as long as it stays the same.
        if let Some(music) = default_music_dir() {
            cmd.env("HP_LIBRARY", music);
        }
        if let Some(ffmpeg) = &launch.ffmpeg {
            cmd.env("HP_FFMPEG", ffmpeg);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let log = open_log();
        let mut child = cmd
            .spawn()
            .with_context(|| format!("starting {}", launch.program.display()))?;
        #[cfg(windows)]
        kill_with_player(&child);
        let stdin = child.stdin.take();
        let (tx, rx) = mpsc::channel();
        if let Some(out) = child.stdout.take() {
            let log = log.clone();
            thread::spawn(move || read_stdout(out, log, tx));
        }
        if let Some(err) = child.stderr.take() {
            thread::spawn(move || copy_to_log(err, log));
        }
        let child = Arc::new(Mutex::new(child));
        let mut engine = Self {
            child,
            stdin,
            url: String::new(),
            token: String::new(),
        };

        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(ready) => {
                    engine.url = format!("http://127.0.0.1:{}", ready.port);
                    engine.token = ready.token;
                    return Ok(engine);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(status) = engine.exited() {
                        bail!(
                            "the library engine stopped ({status}); see {}",
                            log_path_text()
                        );
                    }
                    if Instant::now() > deadline {
                        bail!(
                            "the library engine didn't start in time; see {}",
                            log_path_text()
                        );
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // Its output closed: it's exiting. Give it a moment to report how.
                    thread::sleep(Duration::from_millis(300));
                    let how = engine
                        .exited()
                        .map_or("its output closed".into(), |s| s.to_string());
                    bail!(
                        "the library engine stopped ({how}); see {}",
                        log_path_text()
                    );
                }
            }
        }
    }

    /// The engine's exit status, once it has stopped.
    pub fn exited(&self) -> Option<ExitStatus> {
        self.child.lock().unwrap().try_wait().ok().flatten()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // Closing stdin asks it to stop; it closes its database and exits.
        drop(self.stdin.take());
        let deadline = Instant::now() + STOP_TIMEOUT;
        let mut child = self.child.lock().unwrap();
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Windows: puts the engine in a job that ends when the player does, however it ends.
/// (Its stdin closing already stops it; this also covers an engine that hangs.)
#[cfg(windows)]
fn kill_with_player(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    // One job for the player's lifetime: the handle is never closed, so Windows closes it
    // (killing what's in the job) when the player's process ends.
    static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const info).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job as usize
    });
    if job != 0 {
        unsafe { AssignProcessToJobObject(job as _, child.as_raw_handle() as _) };
    }
}

type Log = Arc<Mutex<Option<File>>>;

fn log_path() -> Option<PathBuf> {
    Some(crate::dirs::cache_dir()?.join(LOG))
}

fn log_path_text() -> String {
    log_path().map_or("the engine's log".into(), |p| p.display().to_string())
}

fn open_log() -> Log {
    let file = log_path().and_then(|path| {
        fs::create_dir_all(path.parent()?).ok()?;
        let _ = fs::rename(&path, path.with_extension("log.1"));
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .ok()
    });
    Arc::new(Mutex::new(file))
}

fn write_log(log: &Log, line: &str) {
    if let Some(f) = log.lock().unwrap().as_mut() {
        let _ = writeln!(f, "{line}");
    }
}

/// Logs the engine's output, except the ready line (it has the token), which goes to `tx`.
fn read_stdout(out: impl Read, log: Log, tx: mpsc::Sender<Ready>) {
    for line in BufReader::new(out).lines() {
        let Ok(line) = line else { break };
        match line.strip_prefix(READY) {
            Some(json) => match serde_json::from_str::<Ready>(json) {
                Ok(ready) => {
                    let _ = tx.send(ready);
                }
                Err(e) => write_log(&log, &format!("unreadable ready line: {e}")),
            },
            None => write_log(&log, &line),
        }
    }
}

fn copy_to_log(err: impl Read, log: Log) {
    for line in BufReader::new(err).lines() {
        let Ok(line) = line else { break };
        write_log(&log, &line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn music_dir_from_user_dirs() {
        let home = Path::new("/home/me");
        let text = "# comment\nXDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_MUSIC_DIR=\"$HOME/Musica\"\n";
        assert_eq!(
            parse_music_dir(text, home),
            Some(PathBuf::from("/home/me/Musica"))
        );
        assert_eq!(
            parse_music_dir("XDG_MUSIC_DIR=\"/data/music\"", home),
            Some(PathBuf::from("/data/music"))
        );
        assert_eq!(parse_music_dir("XDG_MUSIC_DIR=\"$HOME/\"", home), None);
        assert_eq!(parse_music_dir("XDG_VIDEOS_DIR=\"$HOME/V\"", home), None);
    }

    #[test]
    fn development_engine_is_found_from_the_sources() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../server");
        let launch = launch_in(&dir).expect("the server's sources");
        assert!(launch.args.iter().any(|a| a == "src/main.ts"));
    }

    /// Starts the development engine for real (needs `vpx`): `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn starts_answers_and_stops() {
        let scratch = std::env::temp_dir().join(format!("hp-engine-{}", std::process::id()));
        // Keeps the test's library and data out of the user's.
        unsafe {
            std::env::set_var("XDG_DATA_HOME", scratch.join("data"));
            std::env::set_var("XDG_CACHE_HOME", scratch.join("cache"));
            std::env::set_var("HOME", &scratch);
        }
        let launch = launch_in(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../server")).unwrap();
        let engine = Engine::start(&launch, "dev-engine-test1", "tests").unwrap();
        let api = crate::api::Api::with_token(engine.url.clone(), Some(&engine.token));
        let me = api.me().unwrap();
        assert!(me.user.admin);
        let child = engine.child.clone();
        drop(engine);
        assert!(child.lock().unwrap().try_wait().unwrap().unwrap().success());
        let _ = fs::remove_dir_all(scratch);
    }
}
