//! Audio output: one rodio player per stream, feeding a mixer at the stream's own rate.
//!
//! The device is opened at the playing stream's sample rate, so a 192 kHz track
//! reaches the DAC at 192 kHz rather than resampled to the system's default rate.
//! It's open only while something plays: paused, stopped or idle, it's closed, which
//! also lets the sound server switch the DAC's rate for other apps.

use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use anyhow::{Context, Result};
use rodio::{
    ChannelCount, DeviceSinkBuilder, MixerDeviceSink, Player, Sample, SampleRate, Source,
    cpal::BufferSize,
    mixer::{self, Mixer, MixerSource},
};

use crate::pipeline::BufferedSource;

/// The players' mixer, at one sample rate. It outlives the device: closing the
/// device (on pause) and opening it again picks up where the players were.
struct Mixing {
    rate: SampleRate,
    channels: ChannelCount,
    mixer: Mixer,
    output: Arc<Mutex<MixerSource>>,
}

impl Mixing {
    fn new(rate: SampleRate, channels: ChannelCount) -> Self {
        let (mixer, output) = mixer::mixer(channels, rate);
        Self {
            rate,
            channels,
            mixer,
            output: Arc::new(Mutex::new(output)),
        }
    }
}

/// Feeds a `Mixing` into the device's own mixer. Only the audio callback ever locks
/// the mixer output, so the lock is never contended.
struct Feed {
    output: Arc<Mutex<MixerSource>>,
    channels: ChannelCount,
    rate: SampleRate,
}

impl Iterator for Feed {
    type Item = Sample;

    fn next(&mut self) -> Option<Sample> {
        // Silence while no player is connected: ending would detach the feed for good.
        let mut output = self.output.lock().unwrap_or_else(|e| e.into_inner());
        Some(output.next().unwrap_or(0.0))
    }
}

impl Source for Feed {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> ChannelCount {
        self.channels
    }

    fn sample_rate(&self) -> SampleRate {
        self.rate
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

#[derive(Default)]
struct State {
    mixing: Option<Mixing>,
    /// The open device, while playing.
    device: Option<MixerDeviceSink>,
    current: Option<Player>,
    /// The following track, already in the mixer but held back until `current` ends
    /// (or until the crossfade into it starts).
    next: Option<Player>,
    /// The track before `current`, still fading out (a crossfade).
    fading: Option<Player>,
    /// A following track at another rate: it can't share the mixer, so it starts on
    /// a reopened device once `current` ends.
    pending: Option<BufferedSource>,
}

pub struct Audio {
    state: Mutex<State>,
    volume: Mutex<f32>,
}

impl Audio {
    /// Checks there's an output device; it's opened only once something plays.
    pub fn open() -> Result<Self> {
        DeviceSinkBuilder::from_default_device()?;
        Ok(Self {
            state: Mutex::default(),
            volume: Mutex::new(1.0),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn volume(&self) -> f32 {
        *self.volume.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Each stream gets a fresh player: a player's queue is resampled to the mixer
    /// rate with the rate of the first source it played, and our sources report no
    /// span boundaries for it to re-check at, so reusing one would play e.g. a 48 kHz
    /// transcode 4× too fast after a 192 kHz original.
    fn player_for(&self, mixer: &Mixer, source: BufferedSource, paused: bool) -> Player {
        let player = Player::connect_new(mixer);
        player.set_volume(self.volume());
        if paused {
            player.pause();
        }
        player.append(source);
        player
    }

    /// Replaces whatever is playing (and whatever was queued after it) with `source`,
    /// reopening the device if `source` has another rate.
    pub fn play(&self, source: BufferedSource) -> Result<()> {
        let mut s = self.state();
        Self::clear(&mut s);
        let rate = source.sample_rate();
        if s.mixing.as_ref().is_none_or(|m| m.rate != rate) {
            s.device = None;
            s.mixing = None;
        }
        Self::ensure_device(&mut s, rate)?;
        let mixing = s.mixing.as_ref().expect("opened with the device");
        let player = self.player_for(&mixing.mixer, source, false);
        s.current = Some(player);
        Ok(())
    }

    /// Stops all players, keeping the mixer.
    fn clear(s: &mut State) {
        for old in [s.current.take(), s.next.take(), s.fading.take()]
            .into_iter()
            .flatten()
        {
            old.stop();
        }
        s.pending = None;
    }

    /// Opens the device at `rate` (keeping the mixer, or making one at that rate).
    fn ensure_device(s: &mut State, rate: SampleRate) -> Result<()> {
        if s.device.is_some() {
            return Ok(());
        }
        let device = open_device(rate)?;
        let mixing = s
            .mixing
            .get_or_insert_with(|| Mixing::new(rate, device.config().channel_count()));
        device.mixer().add(Feed {
            output: mixing.output.clone(),
            channels: mixing.channels,
            rate: mixing.rate,
        });
        s.device = Some(device);
        Ok(())
    }

    /// Queues `source` to follow the current one; it must be gated with
    /// `BufferedSource::play_after` so it stays silent until then. At the same rate
    /// it shares the mixer, for a gapless change; otherwise it waits for `promote_next`.
    pub fn queue_next(&self, source: BufferedSource) {
        let mut s = self.state();
        if let Some(old) = s.next.take() {
            old.stop();
        }
        s.pending = None;
        let paused = s.current.as_ref().is_some_and(|c| c.is_paused());
        match &s.mixing {
            Some(m) if m.rate == source.sample_rate() => {
                let player = self.player_for(&m.mixer, source, paused);
                s.next = Some(player);
            }
            _ => s.pending = Some(source),
        }
    }

    /// Drops the queued source, if any.
    pub fn cancel_next(&self) {
        let mut s = self.state();
        if let Some(old) = s.next.take() {
            old.stop();
        }
        s.pending = None;
    }

    /// The queued source takes over: at the same rate it already has (and the one it
    /// replaces plays on until it ends, for a crossfade); otherwise it starts now, on the
    /// device reopened at its rate.
    pub fn promote_next(&self) -> Result<()> {
        let mut s = self.state();
        if let Some(next) = s.next.take() {
            let old = s.current.replace(next);
            if let Some(gone) = std::mem::replace(&mut s.fading, old) {
                gone.stop();
            }
            return Ok(());
        }
        let Some(pending) = s.pending.take() else {
            return Ok(());
        };
        drop(s);
        self.play(pending)
    }

    /// Replaces the current source with `source`, the current one fading out (its
    /// pipeline set to) while `source` fades in. Only at the same rate; otherwise it's `play`.
    pub fn crossfade_to(&self, source: BufferedSource) -> Result<()> {
        let mut s = self.state();
        let same_rate = s.mixing.as_ref().map(|m| m.rate) == Some(source.sample_rate());
        if !same_rate || s.device.is_none() || s.current.is_none() {
            drop(s);
            return self.play(source);
        }
        for old in [s.next.take(), s.fading.take()].into_iter().flatten() {
            old.stop();
        }
        s.pending = None;
        let mixing = s.mixing.as_ref().expect("checked above");
        let player = self.player_for(&mixing.mixer, source, false);
        s.fading = s.current.replace(player);
        Ok(())
    }

    /// The sample rate the current source plays at.
    pub fn rate(&self) -> Option<u32> {
        let s = self.state();
        s.current.as_ref()?;
        s.mixing.as_ref().map(|m| m.rate.get())
    }

    /// Stops playback and closes the device.
    pub fn stop(&self) {
        let mut s = self.state();
        Self::clear(&mut s);
        s.device = None;
    }

    /// Pauses (closing the device) or resumes (reopening it).
    pub fn toggle(&self) -> Result<()> {
        let mut s = self.state();
        let Some(current) = &s.current else {
            return Ok(());
        };
        if current.is_paused() {
            let rate = s.mixing.as_ref().expect("a player has a mixer").rate;
            Self::ensure_device(&mut s, rate)?;
            for player in [&s.current, &s.next, &s.fading].into_iter().flatten() {
                player.play();
            }
        } else {
            for player in [&s.current, &s.next, &s.fading].into_iter().flatten() {
                player.pause();
            }
            s.device = None;
        }
        Ok(())
    }

    pub fn is_paused(&self) -> bool {
        self.state().current.as_ref().is_none_or(|c| c.is_paused())
    }

    pub fn set_volume(&self, v: f32) {
        *self.volume.lock().unwrap_or_else(|e| e.into_inner()) = v;
        let s = self.state();
        for player in [&s.current, &s.next, &s.fading].into_iter().flatten() {
            player.set_volume(v);
        }
    }
}

/// Opens the default device at `rate`; failing that, at its default rate (the
/// device's mixer then resamples).
fn open_device(rate: SampleRate) -> Result<MixerDeviceSink> {
    // About 50 ms, as rodio picks for the default rate.
    let frames = (rate.get() / 20).next_power_of_two();
    let mut device = DeviceSinkBuilder::from_default_device()
        .and_then(|b| {
            b.with_sample_rate(rate)
                .with_buffer_size(BufferSize::Fixed(frames))
                .open_stream()
        })
        .or_else(|e| {
            eprintln!("cannot open audio output at {rate} Hz ({e}), resampling instead");
            DeviceSinkBuilder::open_default_sink()
        })
        .context("opening audio output")?;
    device.log_on_drop(false);
    Ok(device)
}
