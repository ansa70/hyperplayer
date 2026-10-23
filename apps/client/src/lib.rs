//! HyperPlayer client core: API access, progressive streaming, adaptive quality
//! and the decode pipeline. The binary (`main.rs`) adds the Slint UI on top.

pub mod adaptive;
pub mod api;
pub mod pipeline;
pub mod playback;
pub mod player;
pub mod stream;
