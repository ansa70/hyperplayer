//! Opens a track for playback: progressive download, quality check during the
//! prebuffer, decoder, and the buffered pipeline that feeds the audio device.

use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rodio::Decoder;

use crate::{
    adaptive::{self, Mode, Quality},
    api::{Api, types::Track},
    pipeline::{self, BufferedSource, PipelineHandle},
    stream::{RemoteStream, StreamHandle, StreamStats},
};

/// Audio buffered before playback starts, in seconds of the chosen quality.
const PREBUFFER_SECS: f64 = 1.5;
const PREBUFFER_MIN: u64 = 96 * 1024;
const PREBUFFER_MAX: u64 = 2 << 20;
const PREBUFFER_TIMEOUT: Duration = Duration::from_secs(15);

/// Receiving time after which the throughput measurement is trusted for an early decision.
const MEASURE_AFTER: Duration = Duration::from_millis(500);

/// Waits for `target` bytes, but returns early once the measured throughput clearly
/// can't fill it in time, so a too-ambitious quality is abandoned within a second.
fn prebuffer(stream: &StreamHandle, target: u64) -> Result<StreamStats> {
    let deadline = Instant::now() + PREBUFFER_TIMEOUT;
    loop {
        let stats = stream.wait_for(target, Duration::from_millis(100))?;
        let filled = stats.complete || stats.downloaded >= target;
        let slow = stats.receiving_time >= MEASURE_AFTER
            && stats.throughput_kbps.is_some_and(|kbps| {
                let remaining = target.saturating_sub(stats.downloaded) as f64 * 8.0 / 1000.0;
                // At this rate, finishing the prebuffer would take more than another second.
                remaining / kbps > 1.0
            });
        if filled || slow || Instant::now() >= deadline {
            return Ok(stats);
        }
    }
}

pub struct Opened {
    pub source: BufferedSource,
    pub pipeline: PipelineHandle,
    pub stream: StreamHandle,
    pub quality: Quality,
    /// Added to the pipeline position: transcodes resumed with `start` count from zero.
    pub offset: Duration,
    /// Throughput measured while prebuffering, in kbit/s.
    pub measured_kbps: Option<f64>,
}

/// Starts streaming `track` at `start`. In `Auto` mode, a prebuffer slower than
/// `quality` needs makes it retry at a rung the measured bandwidth sustains.
pub fn open(
    api: &Api,
    track: &Track,
    mode: Mode,
    mut quality: Quality,
    start: Duration,
) -> Result<Opened> {
    loop {
        let resume = (!quality.seekable() && !start.is_zero()).then_some(start);
        let url = api.stream_url(&track.id, quality, resume);
        let (reader, stream) = RemoteStream::open(api.stream_client(), url, quality.seekable());

        let target = ((quality.kbps(track) * 1000.0 / 8.0 * PREBUFFER_SECS) as u64)
            .clamp(PREBUFFER_MIN, PREBUFFER_MAX);
        let stats = prebuffer(&stream, target)?;
        // A download that already finished says nothing about the link except that it's fast.
        let measured = stats.throughput_kbps.filter(|_| !stats.complete);
        if mode == Mode::Auto
            && let Some(kbps) = measured
            && !adaptive::sustains(track, quality, kbps)
        {
            let lower = adaptive::choose(track, Mode::Auto, Some(kbps));
            if lower != quality {
                eprintln!(
                    "stream: {} needs {:.0} kbit/s, measured {kbps:.0}; switching to {}",
                    quality.label(track),
                    quality.kbps(track),
                    lower.label(track)
                );
                stream.cancel();
                quality = lower;
                continue;
            }
        }

        let mut builder = Decoder::builder()
            .with_data(reader)
            .with_seekable(quality.seekable())
            .with_hint(&quality.hint(track));
        if let Some(len) = stats.len {
            builder = builder.with_byte_len(len);
        }
        let decoder = builder
            .build()
            .with_context(|| format!("decoding {}", quality.label(track)))?;
        let (source, pipeline) = pipeline::spawn(decoder);
        if quality.seekable() && !start.is_zero() {
            pipeline.seek(start, PREBUFFER_TIMEOUT);
        }
        return Ok(Opened {
            source,
            pipeline,
            stream,
            quality,
            offset: if quality.seekable() {
                Duration::ZERO
            } else {
                start
            },
            measured_kbps: measured.or(stats.throughput_kbps),
        });
    }
}
