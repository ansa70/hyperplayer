//! Decodes on its own thread into a lock-free ring buffer that the audio callback drains.
//!
//! rodio pulls samples from the real-time audio callback; decoding a network
//! stream there would block the callback whenever the network is slow. Here
//! the callback only pops from a single-producer/single-consumer ring (no
//! locks, no waiting), playing silence and counting an underrun when it's empty.

use std::{
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};

use rodio::{ChannelCount, Sample, SampleRate, Source, source::SeekError};
use rtrb::{Consumer, Producer, RingBuffer};

/// Decoded audio kept ahead of playback.
const BUFFER: Duration = Duration::from_secs(2);
/// How long the decode thread sleeps when the ring is full.
const FULL_BACKOFF: Duration = Duration::from_millis(10);

/// Requests from the control handle to the decode thread (never touched by the audio thread).
#[derive(Default)]
struct Control {
    seek_to: Option<Duration>,
    seek_result: Option<bool>,
    stopped: bool,
}

struct Shared {
    control: Mutex<Control>,
    cond: Condvar,
    channels: ChannelCount,
    sample_rate: SampleRate,
    /// Frames actually played (excludes underrun silence); the source of truth for position.
    frames_played: AtomicU64,
    underrun_frames: AtomicU64,
    /// The decoder has produced its last sample.
    decoded_all: AtomicBool,
    /// The audio side has played the last sample.
    ended: AtomicBool,
    /// After a seek, the decode thread parks a fresh ring here for the audio side to adopt.
    replacement: Mutex<Option<Consumer<Sample>>>,
    replace: AtomicBool,
}

impl Shared {
    fn control(&self) -> MutexGuard<'_, Control> {
        self.control.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn capacity(&self) -> usize {
        (self.sample_rate.get() as f64 * BUFFER.as_secs_f64()) as usize
            * self.channels.get() as usize
    }

    fn frames_to_duration(&self, frames: u64) -> Duration {
        Duration::from_secs_f64(frames as f64 / self.sample_rate.get() as f64)
    }
}

/// Control and statistics side of a pipeline.
#[derive(Clone)]
pub struct PipelineHandle(Arc<Shared>);

impl PipelineHandle {
    /// Position in the stream, counting only audio that was really played.
    pub fn position(&self) -> Duration {
        self.0
            .frames_to_duration(self.0.frames_played.load(Ordering::Relaxed))
    }

    /// Silence played because decoding fell behind, since the last call.
    pub fn take_underrun(&self) -> Duration {
        self.0
            .frames_to_duration(self.0.underrun_frames.swap(0, Ordering::Relaxed))
    }

    /// Everything has been decoded and played.
    pub fn finished(&self) -> bool {
        self.0.ended.load(Ordering::Relaxed)
    }

    /// Seeks the decoder; blocks until done (or `timeout`). Returns false if unsupported.
    pub fn seek(&self, to: Duration, timeout: Duration) -> bool {
        let mut c = self.0.control();
        c.seek_to = Some(to);
        c.seek_result = None;
        self.0.cond.notify_all();
        let (mut c, _) = self
            .0
            .cond
            .wait_timeout_while(c, timeout, |c| c.seek_result.is_none())
            .unwrap_or_else(|e| e.into_inner());
        c.seek_result.take().unwrap_or(false)
    }

    pub fn stop(&self) {
        self.0.control().stopped = true;
        self.0.cond.notify_all();
    }
}

/// The rodio-facing end. Never blocks.
pub struct BufferedSource {
    shared: Arc<Shared>,
    ring: Consumer<Sample>,
    /// Sample index within the current frame, to count frames.
    channel: u16,
    started: bool,
}

/// Starts decoding `source` on a background thread.
pub fn spawn<S>(source: S) -> (BufferedSource, PipelineHandle)
where
    S: Source + Send + 'static,
{
    let shared = Arc::new(Shared {
        control: Mutex::new(Control::default()),
        cond: Condvar::new(),
        channels: source.channels(),
        sample_rate: source.sample_rate(),
        frames_played: AtomicU64::new(0),
        underrun_frames: AtomicU64::new(0),
        decoded_all: AtomicBool::new(false),
        ended: AtomicBool::new(false),
        replacement: Mutex::new(None),
        replace: AtomicBool::new(false),
    });
    let (producer, consumer) = RingBuffer::new(shared.capacity());
    let worker = shared.clone();
    thread::Builder::new()
        .name("decode".into())
        .spawn(move || decode(&worker, source, producer))
        .expect("spawning decode thread");
    let source = BufferedSource {
        shared: shared.clone(),
        ring: consumer,
        channel: 0,
        started: false,
    };
    (source, PipelineHandle(shared))
}

fn decode<S: Source>(shared: &Shared, mut source: S, mut ring: Producer<Sample>) {
    let mut pending: Option<Sample> = None;
    loop {
        {
            let c = shared.control();
            if c.stopped || ring.is_abandoned() {
                return;
            }
            if let Some(to) = c.seek_to {
                drop(c);
                let ok = source.try_seek(to).is_ok();
                if ok {
                    // Hand the audio side a fresh ring so nothing decoded before the seek is played.
                    let (producer, consumer) = RingBuffer::new(shared.capacity());
                    ring = producer;
                    pending = None;
                    *shared.replacement.lock().unwrap_or_else(|e| e.into_inner()) = Some(consumer);
                    shared.replace.store(true, Ordering::Release);
                    shared.decoded_all.store(false, Ordering::Relaxed);
                    shared.ended.store(false, Ordering::Relaxed);
                    let frames = (to.as_secs_f64() * shared.sample_rate.get() as f64) as u64;
                    shared.frames_played.store(frames, Ordering::Relaxed);
                }
                let mut c = shared.control();
                c.seek_to = None;
                c.seek_result = Some(ok);
                shared.cond.notify_all();
                continue;
            }
            if shared.decoded_all.load(Ordering::Relaxed) {
                // Idle until a seek or stop arrives.
                drop(shared.cond.wait_timeout(c, Duration::from_millis(100)));
                continue;
            }
        }

        // Fill the ring; decoding may block on the network, which is fine on this thread.
        for _ in 0..4096 {
            let Some(sample) = pending.take().or_else(|| source.next()) else {
                shared.decoded_all.store(true, Ordering::Relaxed);
                break;
            };
            if ring.push(sample).is_err() {
                pending = Some(sample);
                thread::sleep(FULL_BACKOFF);
                break;
            }
        }
    }
}

impl Iterator for BufferedSource {
    type Item = Sample;

    fn next(&mut self) -> Option<Sample> {
        if self.shared.replace.load(Ordering::Acquire)
            && let Ok(mut slot) = self.shared.replacement.try_lock()
            && let Some(ring) = slot.take()
        {
            self.ring = ring;
            self.channel = 0;
            self.shared.replace.store(false, Ordering::Release);
        }
        let popped = self.ring.pop().ok();
        if popped.is_none()
            && self.shared.decoded_all.load(Ordering::Relaxed)
            && self.ring.is_empty()
        {
            self.shared.ended.store(true, Ordering::Relaxed);
            return None;
        }
        let last_in_frame = self.channel + 1 == self.shared.channels.get();
        self.channel = if last_in_frame { 0 } else { self.channel + 1 };
        match popped {
            Some(sample) => {
                self.started = true;
                if last_in_frame {
                    self.shared.frames_played.fetch_add(1, Ordering::Relaxed);
                }
                Some(sample)
            }
            None => {
                // Silence before the first sample is the initial fill, not an underrun.
                if last_in_frame && self.started {
                    self.shared.underrun_frames.fetch_add(1, Ordering::Relaxed);
                }
                Some(0.0)
            }
        }
    }
}

impl Source for BufferedSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> ChannelCount {
        self.shared.channels
    }

    fn sample_rate(&self) -> SampleRate {
        self.shared.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }

    fn try_seek(&mut self, _: Duration) -> Result<(), SeekError> {
        // Seeks go through `PipelineHandle::seek` so they never run on the audio thread.
        Err(SeekError::NotSupported {
            underlying_source: "BufferedSource",
        })
    }
}

impl Drop for BufferedSource {
    fn drop(&mut self) {
        self.shared.control().stopped = true;
        self.shared.cond.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    const SECOND: Duration = Duration::from_secs(1);

    fn tone(seconds: f32) -> impl Source + Send {
        rodio::source::SineWave::new(440.0).take_duration(Duration::from_secs_f32(seconds))
    }

    /// Lets the decode thread fill the ring before draining, like the prebuffer does.
    fn settle() {
        thread::sleep(Duration::from_millis(100));
    }

    #[test]
    fn plays_everything_then_ends() {
        let (src, handle) = spawn(tone(0.5));
        settle();
        let played = src.count();
        assert!(played < 44_100 * 10, "source never ended");
        assert!(handle.finished());
        assert!(
            (handle.position().as_secs_f32() - 0.5).abs() < 0.01,
            "{:?}",
            handle.position()
        );
    }

    /// Mono source whose samples are their own index, so tests can tell where audio came from.
    struct Ramp {
        pos: u32,
        len: u32,
    }

    const RAMP_RATE: u32 = 8_000;

    impl Iterator for Ramp {
        type Item = Sample;
        fn next(&mut self) -> Option<Sample> {
            (self.pos < self.len).then(|| {
                self.pos += 1;
                (self.pos - 1) as Sample
            })
        }
    }

    impl Source for Ramp {
        fn current_span_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> ChannelCount {
            ChannelCount::new(1).unwrap()
        }
        fn sample_rate(&self) -> SampleRate {
            SampleRate::new(RAMP_RATE).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
        fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
            self.pos = (pos.as_secs_f64() * RAMP_RATE as f64) as u32;
            Ok(())
        }
    }

    #[test]
    fn seeking_moves_the_position_and_discards_old_audio() {
        let (mut src, handle) = spawn(Ramp {
            pos: 0,
            len: RAMP_RATE * 5,
        });
        settle();
        src.by_ref().take(1000).for_each(drop);
        assert!(handle.seek(Duration::from_secs(3), SECOND));
        assert_eq!(handle.position().as_secs(), 3);
        settle();
        // The very next sample comes from the seek target, not from the old buffer.
        assert_eq!(src.next(), Some((3 * RAMP_RATE) as Sample));
        assert_eq!(src.count() as u32, 2 * RAMP_RATE - 1);
    }

    #[test]
    fn a_steady_supply_has_no_underruns() {
        let (src, handle) = spawn(tone(0.5));
        settle();
        src.for_each(drop);
        assert_eq!(handle.take_underrun(), Duration::ZERO);
    }

    /// A source that stalls partway through, like a network stream running dry.
    struct Stalling<S> {
        inner: S,
        stall_at: usize,
        emitted: usize,
    }

    impl<S: Source> Iterator for Stalling<S> {
        type Item = Sample;
        fn next(&mut self) -> Option<Sample> {
            if self.emitted == self.stall_at {
                thread::sleep(Duration::from_millis(300));
            }
            self.emitted += 1;
            self.inner.next()
        }
    }

    impl<S: Source> Source for Stalling<S> {
        fn current_span_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> ChannelCount {
            self.inner.channels()
        }
        fn sample_rate(&self) -> SampleRate {
            self.inner.sample_rate()
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    #[test]
    fn a_stalled_decoder_is_reported_as_underrun() {
        let (mut src, handle) = spawn(Stalling {
            inner: tone(1.0),
            stall_at: 4410,
            emitted: 0,
        });
        settle();
        // Drain faster than real time so the stall shows up as silence.
        let started = Instant::now();
        while src.next().is_some() && started.elapsed() < Duration::from_secs(3) {}
        assert!(handle.take_underrun() > Duration::ZERO);
        let pos = handle.position().as_secs_f32();
        assert!(
            (pos - 1.0).abs() < 0.01,
            "silence must not advance the position: {pos}"
        );
    }
}
