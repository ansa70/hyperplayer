//! Audio output: one rodio player per stream, feeding the device mixer.

use std::sync::{Mutex, MutexGuard};

use anyhow::Result;
use rodio::{DeviceSinkBuilder, MixerDeviceSink, Player};

use crate::pipeline::BufferedSource;

pub struct Audio {
    // Dropping the device sink stops all output, so it lives as long as the player.
    sink: MixerDeviceSink,
    player: Mutex<Player>,
}

impl Audio {
    pub fn open() -> Result<Self> {
        let mut sink = DeviceSinkBuilder::open_default_sink()?;
        sink.log_on_drop(false);
        let player = Mutex::new(Player::connect_new(sink.mixer()));
        Ok(Self { sink, player })
    }

    fn player(&self) -> MutexGuard<'_, Player> {
        self.player.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Replaces whatever is playing with `source`.
    ///
    /// Each stream gets a fresh player: a player's queue is resampled to the device
    /// rate with the rate of the first source it played, and our sources report no
    /// span boundaries for it to re-check at, so reusing one would play e.g. a 48 kHz
    /// transcode 4× too fast after a 192 kHz original.
    pub fn play(&self, source: BufferedSource) {
        let player = Player::connect_new(self.sink.mixer());
        let mut current = self.player();
        player.set_volume(current.volume());
        player.append(source);
        current.stop();
        *current = player;
    }

    pub fn toggle(&self) {
        let player = self.player();
        if player.is_paused() {
            player.play()
        } else {
            player.pause()
        }
    }

    pub fn is_paused(&self) -> bool {
        self.player().is_paused()
    }

    pub fn set_volume(&self, v: f32) {
        self.player().set_volume(v);
    }
}
