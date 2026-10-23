//! Audio output: one rodio player, fed a single buffered pipeline at a time.

use std::sync::Arc;

use anyhow::Result;
use rodio::{DeviceSinkBuilder, MixerDeviceSink, Player};

use crate::pipeline::BufferedSource;

pub struct Audio {
    // Dropping the device sink stops all output, so it lives as long as the player.
    _sink: MixerDeviceSink,
    player: Arc<Player>,
}

impl Audio {
    pub fn open() -> Result<Self> {
        let mut sink = DeviceSinkBuilder::open_default_sink()?;
        sink.log_on_drop(false);
        let player = Arc::new(Player::connect_new(sink.mixer()));
        Ok(Self {
            _sink: sink,
            player,
        })
    }

    /// Replaces whatever is playing with `source`.
    pub fn play(&self, source: BufferedSource) {
        self.player.clear();
        self.player.append(source);
        self.player.play();
    }

    pub fn toggle(&self) {
        if self.player.is_paused() {
            self.player.play()
        } else {
            self.player.pause()
        }
    }

    pub fn is_paused(&self) -> bool {
        self.player.is_paused()
    }

    pub fn set_volume(&self, v: f32) {
        self.player.set_volume(v);
    }
}
