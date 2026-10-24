// A release build on Windows is a GUI app: no console window next to it.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod ui;

use std::io::Write;

fn main() {
    // Without a console (Windows, or started from a launcher) nobody would see these:
    // they're also logged, and shown in a message box on Windows.
    std::panic::set_hook(Box::new(|info| {
        report(&format!("HyperPlayer stopped unexpectedly:\n{info}"))
    }));
    if let Err(e) = ui::run() {
        report(&format!("HyperPlayer couldn't start:\n{e:#}"));
        std::process::exit(1);
    }
}

fn report(message: &str) {
    eprintln!("{message}");
    if let Some(dir) = hyperplayer::dirs::cache_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut log) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("hyperplayer.log"))
        {
            let _ = writeln!(log, "{} {message}", chrono::Local::now().to_rfc3339());
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
        let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
        let (text, title) = (wide(message), wide("HyperPlayer"));
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            )
        };
    }
}
