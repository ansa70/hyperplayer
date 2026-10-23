//! Headless end-to-end check of progressive streaming and adaptive quality.
//!
//! Plays a track without an audio device: a thread pulls samples in real time
//! like a sound card would, while the adaptive monitor watches the stream.
//!
//! ```sh
//! HP_SERVER=http://127.0.0.1:4533 cargo run --example stream_probe -- "Freddie Freeloader" 30 [original]
//! ```
//! The optional third argument forces the first stream to the original file,
//! skipping the prebuffer check, to simulate a link that degrades mid-track.

use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use hyperplayer::{
    adaptive::{self, Mode, Monitor, Quality},
    api::Api,
    pipeline::BufferedSource,
    playback::{self, Opened},
};
use rodio::Source;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let query = args.first().map(String::as_str).unwrap_or("So What");
    let seconds: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(30);
    let force_original = args.get(2).is_some_and(|s| s == "original");
    let api =
        Api::new(std::env::var("HP_SERVER").unwrap_or_else(|_| "http://127.0.0.1:4533".into()));

    let track = api
        .search(query, 1)?
        .tracks
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no track matches {query:?}"))?;
    println!(
        "track: {} — {} ({}, {:.0} kbit/s source, {:.0}s)",
        track.artist_name,
        track.title,
        track.format.codec,
        adaptive::source_kbps(&track),
        track.duration_ms as f64 / 1000.0
    );

    let started = Instant::now();
    let log = |msg: String| println!("[{:5.1}s] {msg}", started.elapsed().as_secs_f64());

    let (mode, first) = if force_original {
        (Mode::Original, Quality::Original)
    } else {
        (Mode::Auto, adaptive::choose(&track, Mode::Auto, None))
    };
    let mut current: Opened = playback::open(&api, &track, mode, first, Duration::ZERO)?;
    log(format!(
        "playing {} (prebuffer measured {})",
        current.quality.label(&track),
        current
            .measured_kbps
            .map_or("n/a".into(), |k| format!("{k:.0} kbit/s"))
    ));

    // The "sound card": drains whichever source is current at real-time pace.
    let slot: Arc<Mutex<Option<BufferedSource>>> = Arc::new(Mutex::new(None));
    let rate_info = (
        current.source.sample_rate().get(),
        current.source.channels().get(),
    );
    *slot.lock().unwrap() = Some(std::mem::replace(&mut current.source, placeholder()));
    let sink = slot.clone();
    thread::spawn(move || {
        let tick = Duration::from_millis(10);
        loop {
            let mut guard = sink.lock().unwrap();
            if let Some(src) = guard.as_mut() {
                let per_tick =
                    (src.sample_rate().get() as usize * src.channels().get() as usize) / 100;
                for _ in 0..per_tick {
                    if src.next().is_none() {
                        break;
                    }
                }
            }
            drop(guard);
            thread::sleep(tick);
        }
    });
    log(format!("output {} Hz × {} ch", rate_info.0, rate_info.1));

    let mut monitor = Monitor::default();
    let mut seeked = false;
    let mut total_underrun = Duration::ZERO;
    while started.elapsed() < Duration::from_secs(seconds) {
        thread::sleep(Duration::from_millis(250));
        let pos = current.offset + current.pipeline.position();
        let stats = current.stream.stats();
        let underrun = current.pipeline.take_underrun();
        total_underrun += underrun;
        if current.pipeline.finished() {
            log("track finished".into());
            break;
        }

        // Halfway through the run, jump to 60% of the track.
        if !seeked && started.elapsed() > Duration::from_secs(seconds / 2) {
            seeked = true;
            let target = Duration::from_millis(track.duration_ms as u64 * 6 / 10);
            let t = Instant::now();
            if current.quality.seekable() {
                let ok = current.pipeline.seek(target, Duration::from_secs(15));
                log(format!(
                    "seek to {:.0}s via byte range: ok={ok} in {:?}",
                    target.as_secs_f64(),
                    t.elapsed()
                ));
            } else {
                current = swap(
                    &slot,
                    playback::open(&api, &track, Mode::Auto, current.quality, target)?,
                );
                log(format!(
                    "seek to {:.0}s by restarting the transcode in {:?}",
                    target.as_secs_f64(),
                    t.elapsed()
                ));
            }
            continue;
        }

        if let Some(q) = monitor.check(&track, current.quality, true, &stats, underrun) {
            let t = Instant::now();
            current = swap(&slot, playback::open(&api, &track, Mode::Auto, q, pos)?);
            monitor.reset();
            log(format!(
                "switched to {} at {:.1}s in {:?}",
                q.label(&track),
                pos.as_secs_f64(),
                t.elapsed()
            ));
        }
        if started.elapsed().as_millis() % 2000 < 250 {
            log(format!(
                "pos {:6.1}s  {}  downloaded {:>6} KiB{}  in memory {:>5} KiB  throughput {}  underrun total {:?}",
                pos.as_secs_f64(),
                current.quality.label(&track),
                stats.downloaded / 1024,
                if stats.complete { " (complete)" } else { "" },
                stats.held / 1024,
                stats
                    .throughput_kbps
                    .map_or("n/a".into(), |k| format!("{k:.0} kbit/s")),
                total_underrun
            ));
        }
    }
    Ok(())
}

/// Installs the new stream's source in the sink, returning the stream for monitoring.
fn swap(slot: &Mutex<Option<BufferedSource>>, mut opened: Opened) -> Opened {
    *slot.lock().unwrap() = Some(std::mem::replace(&mut opened.source, placeholder()));
    opened
}

/// An empty pipeline to leave behind in `Opened` once its real source has moved to the sink.
fn placeholder() -> BufferedSource {
    hyperplayer::pipeline::spawn(
        rodio::source::Zero::new(
            rodio::ChannelCount::new(1).unwrap(),
            rodio::SampleRate::new(8000).unwrap(),
        )
        .take_duration(Duration::ZERO),
    )
    .0
}
