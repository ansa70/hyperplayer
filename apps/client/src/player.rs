//! Audio output: a single rodio player fed with fully downloaded tracks.

use std::{io::Cursor, sync::Arc, time::Duration};

use anyhow::Result;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};

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

    pub fn play_bytes(&self, data: Vec<u8>) -> Result<()> {
        let len = data.len() as u64;
        let source = Decoder::builder()
            .with_data(Cursor::new(data))
            .with_byte_len(len)
            .with_seekable(true)
            .build()?;
        self.player.clear();
        self.player.append(source);
        self.player.play();
        Ok(())
    }

    pub fn toggle(&self) {
        if self.player.is_paused() {
            self.player.play()
        } else {
            self.player.pause()
        }
    }

    pub fn is_playing(&self) -> bool {
        !self.player.is_paused() && !self.player.empty()
    }

    /// True once the current track has played to the end.
    pub fn finished(&self) -> bool {
        self.player.empty()
    }

    pub fn position(&self) -> Duration {
        self.player.get_pos()
    }

    pub fn seek(&self, to: Duration) {
        let _ = self.player.try_seek(to);
    }

    pub fn set_volume(&self, v: f32) {
        self.player.set_volume(v);
    }
}
