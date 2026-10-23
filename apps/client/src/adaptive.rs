//! Chooses what to stream for a track given the measured bandwidth.

use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

use crate::{api::types::Track, stream::StreamStats};

/// Lossy rungs, in kbit/s, from best to smallest.
pub const LADDER: [u32; 5] = [320, 192, 128, 96, 64];
/// Required share of spare bandwidth over a stream's bitrate.
const HEADROOM: f64 = 1.3;
/// Codecs the local decoder handles; others must be transcoded.
const NATIVE_CODECS: &[&str] = &[
    "mpeg 1 layer 3",
    "mp3",
    "flac",
    "vorbis",
    "aac",
    "mpeg-4/aac",
    "pcm",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    /// The file as stored.
    Original,
    /// Lossless transcode, for lossless sources the client can't decode (WavPack, APE, ALAC…).
    Flac,
    /// Lossy transcode at this bitrate.
    Vorbis(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Best quality the connection sustains, adapting during playback.
    Auto,
    /// Always the best quality, regardless of bandwidth.
    Original,
    /// Never above 128 kbit/s.
    DataSaver,
}

impl Mode {
    pub fn next(self) -> Self {
        match self {
            Mode::Auto => Mode::Original,
            Mode::Original => Mode::DataSaver,
            Mode::DataSaver => Mode::Auto,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Mode::Auto => "AUTO",
            Mode::Original => "ORIGINAL",
            Mode::DataSaver => "DATA SAVER",
        }
    }
}

pub fn is_native(track: &Track) -> bool {
    let codec = track.format.codec.to_lowercase();
    NATIVE_CODECS.iter().any(|c| codec.contains(c))
}

/// Average bitrate of the stored file, in kbit/s.
pub fn source_kbps(track: &Track) -> f64 {
    let secs = (track.duration_ms as f64 / 1000.0).max(1.0);
    track.file_size as f64 * 8.0 / 1000.0 / secs
}

impl Quality {
    /// Expected stream bitrate in kbit/s.
    pub fn kbps(self, track: &Track) -> f64 {
        match self {
            Quality::Original | Quality::Flac => source_kbps(track),
            Quality::Vorbis(k) => k as f64,
        }
    }

    /// `format`/`bitrate` query parameters for the stream endpoint.
    pub fn query(self) -> String {
        match self {
            Quality::Original => "format=original".into(),
            Quality::Flac => "format=flac".into(),
            Quality::Vorbis(k) => format!("format=vorbis&bitrate={k}"),
        }
    }

    /// Byte-range seekable on the server (only files served as-is).
    pub fn seekable(self) -> bool {
        self == Quality::Original
    }

    /// Container hint for the decoder's format probe.
    pub fn hint(self, track: &Track) -> String {
        match self {
            Quality::Original => match track.format.container.to_lowercase().as_str() {
                c if c.contains("flac") => "flac".into(),
                c if c.contains("mpeg") || c.contains("mp3") => "mp3".into(),
                c if c.contains("mp4") || c.contains("m4a") => "m4a".into(),
                c if c.contains("ogg") => "ogg".into(),
                c if c.contains("wav") => "wav".into(),
                c => c.into(),
            },
            Quality::Flac => "flac".into(),
            Quality::Vorbis(_) => "ogg".into(),
        }
    }

    pub fn label(self, track: &Track) -> String {
        match self {
            Quality::Original => format!("Original {}", track.format.codec.to_uppercase()),
            Quality::Flac => "FLAC (transcoded)".into(),
            Quality::Vorbis(k) => format!("Vorbis {k} kbit/s"),
        }
    }
}

/// Highest quality available for a track, ignoring bandwidth.
fn best(track: &Track) -> Quality {
    if is_native(track) {
        Quality::Original
    } else if track.format.lossless {
        Quality::Flac
    } else {
        Quality::Vorbis(320)
    }
}

/// Candidate qualities from best to smallest. Lossy rungs at or above the
/// source's own bitrate are skipped: re-encoding can't add quality.
fn ladder(track: &Track) -> Vec<Quality> {
    let top = best(track);
    let ceiling = if track.format.lossless {
        f64::INFINITY
    } else {
        top.kbps(track)
    };
    let mut out = vec![top];
    out.extend(
        LADDER
            .iter()
            .filter(|&&k| (k as f64) < ceiling)
            .map(|&k| Quality::Vorbis(k)),
    );
    out.dedup();
    out
}

/// What to stream given the mode and, when known, the measured bandwidth (kbit/s).
pub fn choose(track: &Track, mode: Mode, bandwidth_kbps: Option<f64>) -> Quality {
    let ladder = ladder(track);
    match mode {
        Mode::Original => ladder[0],
        Mode::DataSaver => *ladder
            .iter()
            .find(|q| q.kbps(track) <= 128.5)
            .unwrap_or(ladder.last().unwrap()),
        Mode::Auto => match bandwidth_kbps {
            // Unknown: start optimistic; the prebuffer measurement corrects it within a second.
            None => ladder[0],
            Some(bw) => *ladder
                .iter()
                .find(|q| q.kbps(track) * HEADROOM <= bw)
                .unwrap_or(ladder.last().unwrap()),
        },
    }
}

/// Next rung below `current`, if any.
pub fn step_down(track: &Track, current: Quality) -> Option<Quality> {
    let ladder = ladder(track);
    let i = ladder.iter().position(|&q| q == current)?;
    ladder.get(i + 1).copied()
}

/// Whether `measured` kbit/s comfortably sustains `quality`.
pub fn sustains(track: &Track, quality: Quality, measured_kbps: f64) -> bool {
    quality.kbps(track) * HEADROOM <= measured_kbps
}

/// Exponentially weighted bandwidth estimate across downloads.
#[derive(Default, Debug)]
pub struct Bandwidth(Option<f64>);

impl Bandwidth {
    pub fn get(&self) -> Option<f64> {
        self.0
    }

    pub fn update(&mut self, sample_kbps: f64) {
        self.0 = Some(match self.0 {
            // React faster to drops than to recoveries.
            Some(prev) if sample_kbps < prev => prev * 0.4 + sample_kbps * 0.6,
            Some(prev) => prev * 0.7 + sample_kbps * 0.3,
            None => sample_kbps,
        });
    }
}

/// Underrun silence within this window that triggers a downgrade.
const UNDERRUN_WINDOW: Duration = Duration::from_secs(10);
const UNDERRUN_LIMIT: Duration = Duration::from_millis(800);
/// Minimum time between switches, so a brief dip doesn't cascade.
const SWITCH_COOLDOWN: Duration = Duration::from_secs(6);
/// Download time after which a stream's throughput is trusted for a pre-emptive downgrade.
const THROUGHPUT_TRUST: Duration = Duration::from_secs(4);

/// Watches a playing stream and decides when to step quality down: after
/// audible underruns, or earlier when the download is slower than the bitrate.
#[derive(Default)]
pub struct Monitor {
    underruns: VecDeque<(Instant, Duration)>,
    last_switch: Option<Instant>,
}

impl Monitor {
    /// Forget underruns (a new stream started).
    pub fn reset(&mut self) {
        self.underruns.clear();
    }

    /// Call periodically with the latest stats; returns the quality to switch to.
    pub fn check(
        &mut self,
        track: &Track,
        quality: Quality,
        adaptive: bool,
        stats: &StreamStats,
        underrun: Duration,
    ) -> Option<Quality> {
        let now = Instant::now();
        if !underrun.is_zero() {
            self.underruns.push_back((now, underrun));
        }
        while self
            .underruns
            .front()
            .is_some_and(|(t, _)| now - *t > UNDERRUN_WINDOW)
        {
            self.underruns.pop_front();
        }
        if !adaptive || self.last_switch.is_some_and(|t| now - t < SWITCH_COOLDOWN) {
            return None;
        }

        let starving = self.underruns.iter().map(|(_, d)| *d).sum::<Duration>() > UNDERRUN_LIMIT;
        let lagging = !stats.complete
            && stats.receiving_time > THROUGHPUT_TRUST
            && stats
                .throughput_kbps
                .is_some_and(|k| k < quality.kbps(track) * 1.05);
        if !starving && !lagging {
            return None;
        }
        let one_down = step_down(track, quality)?;
        // Whichever is lower: the measured rate may justify skipping several rungs.
        let target = match stats
            .throughput_kbps
            .map(|k| choose(track, Mode::Auto, Some(k)))
        {
            Some(q) if q.kbps(track) < one_down.kbps(track) => q,
            _ => one_down,
        };
        eprintln!(
            "adaptive: {} {} at {:.0} kbit/s; switching to {}",
            quality.label(track),
            if starving { "underran" } else { "is lagging" },
            stats.throughput_kbps.unwrap_or(0.0),
            target.label(track)
        );
        self.last_switch = Some(now);
        self.underruns.clear();
        Some(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::types::{AudioFormat, Track};

    fn track(codec: &str, lossless: bool, kbps: f64) -> Track {
        serde_json::from_value(serde_json::json!({
            "id": "t", "title": "T", "artistId": "a", "artistName": "A", "albumId": "b", "albumTitle": "B",
            "trackNumber": 1, "discNumber": 1, "year": 1959, "durationMs": 100_000, "genres": [],
            "format": serde_json::to_value(AudioFormat {
                codec: codec.into(), container: "x".into(), lossless,
                bitrate: None, sample_rate: None, bit_depth: None, channels: None,
            }).unwrap(),
            "fileSize": (kbps * 1000.0 / 8.0 * 100.0) as i64, "cover": null,
            "replayGain": { "trackGain": null, "trackPeak": null, "albumGain": null, "albumPeak": null },
        }))
        .unwrap()
    }

    #[test]
    fn auto_picks_the_best_rung_the_bandwidth_sustains() {
        let hires = track("FLAC", true, 4600.0);
        assert_eq!(choose(&hires, Mode::Auto, None), Quality::Original);
        assert_eq!(
            choose(&hires, Mode::Auto, Some(50_000.0)),
            Quality::Original
        );
        assert_eq!(
            choose(&hires, Mode::Auto, Some(1000.0)),
            Quality::Vorbis(320)
        );
        assert_eq!(
            choose(&hires, Mode::Auto, Some(200.0)),
            Quality::Vorbis(128)
        );
        assert_eq!(choose(&hires, Mode::Auto, Some(10.0)), Quality::Vorbis(64));
    }

    #[test]
    fn lossy_sources_are_never_transcoded_upwards() {
        let mp3 = track("MPEG 1 Layer 3", false, 192.0);
        assert_eq!(
            ladder(&mp3),
            vec![
                Quality::Original,
                Quality::Vorbis(128),
                Quality::Vorbis(96),
                Quality::Vorbis(64)
            ]
        );
        assert_eq!(choose(&mp3, Mode::DataSaver, None), Quality::Vorbis(128));
    }

    #[test]
    fn non_native_codecs_are_transcoded() {
        assert_eq!(
            choose(&track("WavPack", true, 900.0), Mode::Original, None),
            Quality::Flac
        );
        assert_eq!(
            choose(&track("Opus", false, 160.0), Mode::Original, None),
            Quality::Vorbis(320)
        );
    }

    #[test]
    fn steps_down_one_rung_at_a_time() {
        let flac = track("FLAC", true, 1000.0);
        assert_eq!(
            step_down(&flac, Quality::Original),
            Some(Quality::Vorbis(320))
        );
        assert_eq!(
            step_down(&flac, Quality::Vorbis(320)),
            Some(Quality::Vorbis(192))
        );
        assert_eq!(step_down(&flac, Quality::Vorbis(64)), None);
    }

    fn stats(kbps: f64, receiving_secs: u64) -> StreamStats {
        StreamStats {
            throughput_kbps: Some(kbps),
            receiving_time: Duration::from_secs(receiving_secs),
            ..Default::default()
        }
    }

    #[test]
    fn monitor_downgrades_on_underruns_and_lag_but_not_when_healthy() {
        let flac = track("FLAC", true, 1000.0);
        let mut m = Monitor::default();
        let ok = stats(5000.0, 10);
        assert_eq!(
            m.check(&flac, Quality::Original, true, &ok, Duration::ZERO),
            None
        );
        // Audible underruns: step down even if the average throughput looks fine.
        assert_eq!(
            m.check(&flac, Quality::Original, true, &ok, Duration::from_secs(1)),
            Some(Quality::Vorbis(320))
        );
        // Cooldown: no second switch right away.
        assert_eq!(
            m.check(
                &flac,
                Quality::Vorbis(320),
                true,
                &stats(10.0, 10),
                Duration::from_secs(5)
            ),
            None
        );

        // Lagging download: jump straight to what the measured rate sustains.
        let mut m = Monitor::default();
        assert_eq!(
            m.check(
                &flac,
                Quality::Original,
                true,
                &stats(150.0, 5),
                Duration::ZERO
            ),
            Some(Quality::Vorbis(96))
        );
        // Not adaptive (user picked Original): never switch.
        let mut m = Monitor::default();
        assert_eq!(
            m.check(
                &flac,
                Quality::Original,
                false,
                &stats(10.0, 5),
                Duration::from_secs(5)
            ),
            None
        );
    }

    #[test]
    fn bandwidth_estimate_drops_quickly_and_recovers_slowly() {
        let mut bw = Bandwidth::default();
        bw.update(10_000.0);
        bw.update(1_000.0);
        assert!(bw.get().unwrap() < 5_000.0);
        let low = bw.get().unwrap();
        bw.update(10_000.0);
        assert!(bw.get().unwrap() < low + 0.5 * (10_000.0 - low));
    }
}
