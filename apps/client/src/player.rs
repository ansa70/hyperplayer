//! Audio output: one rodio player per stream, feeding the device mixer.

use std::sync::{Mutex, MutexGuard};

use anyhow::Result;
use rodio::{DeviceSinkBuilder, MixerDeviceSink, Player};

use crate::pipeline::BufferedSource;

#[derive(Default)]
struct Players {
    current: Option<Player>,
    /// The following track, already in the mixer but held back until `current` ends.
    next: Option<Player>,
}

pub struct Audio {
    // Dropping the device sink stops all output, so it lives as long as the players.
    sink: MixerDeviceSink,
    players: Mutex<Players>,
    volume: Mutex<f32>,
}

impl Audio {
    pub fn open() -> Result<Self> {
        let mut sink = DeviceSinkBuilder::open_default_sink()?;
        sink.log_on_drop(false);
        Ok(Self {
            sink,
            players: Mutex::default(),
            volume: Mutex::new(1.0),
        })
    }

    fn players(&self) -> MutexGuard<'_, Players> {
        self.players.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Each stream gets a fresh player: a player's queue is resampled to the device
    /// rate with the rate of the first source it played, and our sources report no
    /// span boundaries for it to re-check at, so reusing one would play e.g. a 48 kHz
    /// transcode 4× too fast after a 192 kHz original.
    fn player_for(&self, source: BufferedSource, paused: bool) -> Player {
        let player = Player::connect_new(self.sink.mixer());
        player.set_volume(*self.volume.lock().unwrap_or_else(|e| e.into_inner()));
        if paused {
            player.pause();
        }
        player.append(source);
        player
    }

    /// Replaces whatever is playing (and whatever was queued after it) with `source`.
    pub fn play(&self, source: BufferedSource) {
        let player = self.player_for(source, false);
        let mut p = self.players();
        for old in [p.current.take(), p.next.take()].into_iter().flatten() {
            old.stop();
        }
        p.current = Some(player);
    }

    /// Queues `source` to follow the current one; it must be gated with
    /// `BufferedSource::play_after` so it stays silent until then.
    pub fn queue_next(&self, source: BufferedSource) {
        let mut p = self.players();
        let paused = p.current.as_ref().is_some_and(|c| c.is_paused());
        let player = self.player_for(source, paused);
        if let Some(old) = p.next.replace(player) {
            old.stop();
        }
    }

    /// Drops the queued source, if any.
    pub fn cancel_next(&self) {
        if let Some(old) = self.players().next.take() {
            old.stop();
        }
    }

    /// The queued source has taken over: it becomes the current one.
    pub fn promote_next(&self) {
        let mut p = self.players();
        if let Some(next) = p.next.take()
            && let Some(old) = p.current.replace(next)
        {
            old.stop();
        }
    }

    pub fn toggle(&self) {
        let p = self.players();
        let pause = !self.is_paused_locked(&p);
        for player in [&p.current, &p.next].into_iter().flatten() {
            if pause { player.pause() } else { player.play() }
        }
    }

    fn is_paused_locked(&self, p: &Players) -> bool {
        p.current.as_ref().is_none_or(|c| c.is_paused())
    }

    pub fn is_paused(&self) -> bool {
        self.is_paused_locked(&self.players())
    }

    pub fn set_volume(&self, v: f32) {
        *self.volume.lock().unwrap_or_else(|e| e.into_inner()) = v;
        let p = self.players();
        for player in [&p.current, &p.next].into_iter().flatten() {
            player.set_volume(v);
        }
    }
}
