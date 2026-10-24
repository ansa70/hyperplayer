//! Runs the HyperPlayer server as a Windows service ("HyperPlayer"): starts the bundled
//! Node.js with the server, restarts it if it stops, and connects the network shares
//! its music folders are on with the saved credentials (a service can't use the
//! signed-in user's connections).
//!
//!   hyperplayer-service install     registers the service (the installer does this)
//!   hyperplayer-service uninstall   stops and removes it
//!   hyperplayer-service start, stop starts or stops it (stop waits until it has)
//!   hyperplayer-service run         runs the server here, in the console (for troubleshooting)
//!
//! Settings are in %ProgramData%\HyperPlayer\server.env (KEY='value' lines, as on Linux),
//! data in %ProgramData%\HyperPlayer\data, the log in %ProgramData%\HyperPlayer\logs.

// Used by the Windows service; built everywhere so its tests run on any platform.
#[cfg_attr(not(windows), allow(dead_code))]
mod settings;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
fn main() {
    if let Err(e) = windows::main() {
        eprintln!("hyperplayer-service: {e}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("hyperplayer-service runs the server as a Windows service; elsewhere use install.sh");
    std::process::exit(1);
}
