use std::{
    collections::BTreeMap,
    error::Error,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    os::windows::{ffi::OsStrExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use crate::settings::{decode, parse_settings, shares};
use windows_service::{
    define_windows_service,
    service::{
        ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode,
        ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
    service_manager::{ServiceManager, ServiceManagerAccess},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const NAME: &str = "HyperPlayer";
/// Settings only the service uses: they're not passed on to the server.
const SMB_USER: &str = "HP_SMB_USER";
const SMB_PASSWORD: &str = "HP_SMB_PASSWORD";
/// The log is started afresh (the old one kept as server.log.1) beyond this size.
const LOG_LIMIT: u64 = 10 * 1024 * 1024;
const RESTART_AFTER: Duration = Duration::from_secs(5);
/// How long the server must have run for a crash not to count as a failed start.
const STARTED: Duration = Duration::from_secs(60);

pub fn main() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("install") => install(),
        Some("uninstall") => uninstall(),
        Some("start") => start(),
        Some("stop") => stop(),
        Some("run") => {
            let stop = Arc::new(AtomicBool::new(false));
            supervise(&stop, true)
        }
        Some(other) => {
            Err(format!("unknown command {other} (install, uninstall, start, stop or run)").into())
        }
        None => Ok(service_dispatcher::start(NAME, ffi_service_main)?),
    }
}

// ----------------------------------------------------------------- the service

define_windows_service!(ffi_service_main, service_main);

fn service_main(_args: Vec<OsString>) {
    if let Err(e) = run_service() {
        log(&format!("service failed: {e}"));
    }
}

fn run_service() -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let status = service_control_handler::register(NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            flag.store(true, Ordering::SeqCst);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;
    let report = |state, accept| {
        status.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(10),
            process_id: None,
        })
    };
    report(
        ServiceState::Running,
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
    )?;
    let result = supervise(&stop, false);
    report(ServiceState::Stopped, ServiceControlAccept::empty())?;
    result
}

fn install() -> Result<()> {
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )?;
    let info = ServiceInfo {
        name: NAME.into(),
        display_name: "HyperPlayer server".into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: std::env::current_exe()?,
        launch_arguments: vec![],
        dependencies: vec![],
        // A low-privilege account: it reads the music and writes only its data folder.
        account_name: Some(r"NT AUTHORITY\LocalService".into()),
        account_password: None,
    };
    let access = ServiceAccess::CHANGE_CONFIG | ServiceAccess::QUERY_STATUS;
    let service = match manager.open_service(NAME, access) {
        Ok(existing) => {
            existing.change_config(&info)?;
            existing
        }
        Err(_) => manager.create_service(&info, access)?,
    };
    service.set_description("Streams your music library to HyperPlayer players.")?;
    println!("Installed the {NAME} service");
    Ok(())
}

fn uninstall() -> Result<()> {
    stop()?;
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    if let Ok(service) = manager.open_service(NAME, ServiceAccess::DELETE) {
        service.delete()?;
        println!("Removed the {NAME} service");
    }
    Ok(())
}

fn start() -> Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service = manager.open_service(NAME, ServiceAccess::START | ServiceAccess::QUERY_STATUS)?;
    if service.query_status()?.current_state == ServiceState::Stopped {
        service.start::<&str>(&[])?;
    }
    Ok(())
}

/// Stops the service if it's running and waits until it has (fine when it isn't installed).
fn stop() -> Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let Ok(service) = manager.open_service(NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP)
    else {
        return Ok(());
    };
    if service.query_status()?.current_state != ServiceState::Stopped {
        let _ = service.stop();
        let deadline = Instant::now() + Duration::from_secs(30);
        while service.query_status()?.current_state != ServiceState::Stopped {
            if Instant::now() > deadline {
                return Err("the service didn't stop in 30 seconds".into());
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ the server

fn program_data() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join(NAME)
}

/// Where node.exe, the server and ffmpeg.exe are: next to this program.
fn install_dir() -> Result<PathBuf> {
    Ok(std::env::current_exe()?
        .parent()
        .ok_or("no install folder")?
        .to_path_buf())
}

/// `KEY='value'` / `KEY=value` lines; `#` starts a comment.
fn read_settings(path: &Path) -> Result<BTreeMap<String, String>> {
    let bytes = fs::read(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    Ok(parse_settings(&decode(&bytes)))
}

fn log(line: &str) {
    let dir = program_data().join("logs");
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("service.log"))
    {
        let _ = writeln!(f, "{}", line);
    }
}

/// Runs the server until `stop`, starting it again (after a pause) whenever it exits.
fn supervise(stop: &AtomicBool, console: bool) -> Result<()> {
    let dir = install_dir()?;
    let data = program_data();
    let settings = read_settings(&data.join("server.env"))?;
    let mut failures = 0u32;
    while !stop.load(Ordering::SeqCst) {
        connect_shares(&settings);
        let started = Instant::now();
        let mut child = start_server(&dir, &data, &settings, console)?;
        let code = loop {
            if let Some(status) = child.try_wait()? {
                break Some(status);
            }
            if stop.load(Ordering::SeqCst) {
                // Node can't be asked to stop on Windows; its database is safe to cut off.
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            thread::sleep(Duration::from_millis(300));
        };
        let Some(status) = code else { break };
        log(&format!("the server exited ({status}); starting it again"));
        failures = if started.elapsed() > STARTED {
            0
        } else {
            failures + 1
        };
        // Back off when it keeps failing right away (e.g. a bad setting), up to a minute.
        let pause = RESTART_AFTER * 2u32.pow(failures.min(4));
        let until = Instant::now() + pause.min(Duration::from_secs(60));
        while Instant::now() < until && !stop.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(300));
        }
    }
    Ok(())
}

fn start_server(
    dir: &Path,
    data: &Path,
    settings: &BTreeMap<String, String>,
    console: bool,
) -> Result<Child> {
    let mut command = Command::new(dir.join("node.exe"));
    command
        .arg(dir.join("dist").join("main.mjs"))
        .current_dir(dir)
        .env("NODE_ENV", "production")
        .env("HP_DATA_DIR", data.join("data"))
        .env("HP_FFMPEG", dir.join("ffmpeg.exe"));
    for (key, value) in settings {
        if key != SMB_USER && key != SMB_PASSWORD {
            command.env(key, value);
        }
    }
    if !console {
        let logs = data.join("logs");
        fs::create_dir_all(&logs)?;
        let path = logs.join("server.log");
        if fs::metadata(&path).is_ok_and(|m| m.len() > LOG_LIMIT) {
            let _ = fs::rename(&path, logs.join("server.log.1"));
        }
        let out = OpenOptions::new().create(true).append(true).open(&path)?;
        let err = out.try_clone()?;
        // CREATE_NO_WINDOW: no console window for the server.
        command
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .stdin(Stdio::null())
            .creation_flags(0x0800_0000);
    }
    Ok(command
        .spawn()
        .map_err(|e| format!("starting node.exe: {e}"))?)
}

/// Connects the library's network shares with the saved credentials (for this service's
/// session). Without credentials the computer's own access applies.
fn connect_shares(settings: &BTreeMap<String, String>) {
    use windows_sys::Win32::NetworkManagement::WNet::{
        NETRESOURCEW, RESOURCETYPE_DISK, WNetAddConnection2W,
    };
    let Some(user) = settings.get(SMB_USER).filter(|u| !u.is_empty()) else {
        return;
    };
    let password = settings.get(SMB_PASSWORD).cloned().unwrap_or_default();
    let wide = |s: &str| -> Vec<u16> { std::ffi::OsStr::new(s).encode_wide().chain([0]).collect() };
    for share in shares(settings.get("HP_LIBRARY").map_or("", String::as_str)) {
        let mut remote = wide(&share);
        let resource = NETRESOURCEW {
            dwScope: 0,
            dwType: RESOURCETYPE_DISK,
            dwDisplayType: 0,
            dwUsage: 0,
            lpLocalName: std::ptr::null_mut(),
            lpRemoteName: remote.as_mut_ptr(),
            lpComment: std::ptr::null_mut(),
            lpProvider: std::ptr::null_mut(),
        };
        let (user, password) = (wide(user), wide(&password));
        let result = unsafe { WNetAddConnection2W(&resource, password.as_ptr(), user.as_ptr(), 0) };
        // 0: connected; 1219: already connected (with these or other credentials).
        if result != 0 && result != 1219 {
            log(&format!(
                "connecting {share} failed (Windows error {result})"
            ));
        }
    }
}
