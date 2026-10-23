//! ReplayGain: turning a track's loudness tags into a playback gain.

use crate::api::types::ReplayGain;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Album gain while an album plays in order, track gain otherwise.
    Auto,
    Track,
    Album,
    Off,
}

impl Mode {
    pub fn next(self) -> Self {
        match self {
            Mode::Auto => Mode::Track,
            Mode::Track => Mode::Album,
            Mode::Album => Mode::Off,
            Mode::Off => Mode::Auto,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Mode::Auto => "auto",
            Mode::Track => "track",
            Mode::Album => "album",
            Mode::Off => "off",
        }
    }

    pub fn from_name(name: &str) -> Self {
        match name {
            "track" => Mode::Track,
            "album" => Mode::Album,
            "off" => Mode::Off,
            _ => Mode::Auto,
        }
    }
}

/// Which tag a gain came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Basis {
    Track,
    Album,
    /// ReplayGain off, or the file has no tags: played as is.
    None,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Applied {
    pub db: f32,
    pub linear: f32,
    pub basis: Basis,
    /// Reduced below the requested gain because the peak would have clipped.
    pub limited: bool,
}

impl Applied {
    pub const UNITY: Applied = Applied {
        db: 0.0,
        linear: 1.0,
        basis: Basis::None,
        limited: false,
    };

    /// Short description for the player, e.g. "RG −6.4 dB album".
    pub fn label(&self) -> String {
        let basis = match self.basis {
            Basis::Track => "track",
            Basis::Album => "album",
            Basis::None => return String::new(),
        };
        let sign = if self.db < 0.0 { "−" } else { "+" };
        let limited = if self.limited { ", peak-limited" } else { "" };
        format!("RG {sign}{:.1} dB {basis}{limited}", self.db.abs())
    }
}

/// The gain to play `rg` with. `in_album_order` means the queue is an album played
/// in sequence (Auto mode then keeps the album's internal loudness differences).
pub fn compute(rg: &ReplayGain, mode: Mode, in_album_order: bool, preamp_db: f32) -> Applied {
    let track = rg
        .track_gain
        .map(|g| (g as f32, rg.track_peak, Basis::Track));
    let album = rg
        .album_gain
        .map(|g| (g as f32, rg.album_peak, Basis::Album));
    let chosen = match mode {
        Mode::Off => None,
        Mode::Track => track.or(album),
        Mode::Album => album.or(track),
        Mode::Auto if in_album_order => album.or(track),
        Mode::Auto => track.or(album),
    };
    let Some((gain, peak, basis)) = chosen else {
        return Applied::UNITY;
    };

    let db = gain + preamp_db;
    let linear = 10f32.powf(db / 20.0);
    // Never boost a sample past full scale: cap the gain at 1/peak.
    match peak {
        Some(p) if p > 0.0 && linear * p as f32 > 1.0 => {
            let capped = 1.0 / p as f32;
            Applied {
                db: 20.0 * capped.log10(),
                linear: capped,
                basis,
                limited: true,
            }
        }
        _ => Applied {
            db,
            linear,
            basis,
            limited: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rg(tg: Option<f64>, tp: Option<f64>, ag: Option<f64>, ap: Option<f64>) -> ReplayGain {
        ReplayGain {
            track_gain: tg,
            track_peak: tp,
            album_gain: ag,
            album_peak: ap,
        }
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 0.01
    }

    #[test]
    fn auto_uses_album_gain_only_for_albums_played_in_order() {
        // Bitches Brew, track 1: -6.5 dB track, -7.5 dB album.
        let r = rg(Some(-6.5), Some(1.0), Some(-7.5), Some(1.0));
        assert_eq!(compute(&r, Mode::Auto, true, 0.0).basis, Basis::Album);
        assert!(close(compute(&r, Mode::Auto, true, 0.0).db, -7.5));
        assert_eq!(compute(&r, Mode::Auto, false, 0.0).basis, Basis::Track);
        assert!(close(compute(&r, Mode::Auto, false, 0.0).linear, 0.4732));
    }

    #[test]
    fn falls_back_to_whichever_tag_exists() {
        let only_track = rg(Some(-3.0), None, None, None);
        assert_eq!(
            compute(&only_track, Mode::Album, true, 0.0).basis,
            Basis::Track
        );
        let none = rg(None, None, None, None);
        assert_eq!(compute(&none, Mode::Auto, true, 0.0), Applied::UNITY);
        assert_eq!(compute(&only_track, Mode::Off, true, 0.0), Applied::UNITY);
    }

    #[test]
    fn boosts_are_capped_by_the_peak() {
        // Kind of Blue, So What: +1.09 dB with a peak of 0.882 fits (0.882 × 1.134 < 1)…
        let quiet = rg(Some(1.09), Some(0.882), None, None);
        let a = compute(&quiet, Mode::Track, false, 0.0);
        assert!(!a.limited && close(a.db, 1.09));
        // …but with a +3 dB preamp it would clip, so it's held at 1/peak.
        let b = compute(&quiet, Mode::Track, false, 3.0);
        assert!(b.limited);
        assert!(close(b.linear, 1.0 / 0.882));
        assert!(close(b.db, 1.09));
    }

    #[test]
    fn labels() {
        let r = rg(Some(-6.43), Some(0.5), None, None);
        assert_eq!(
            compute(&r, Mode::Track, false, 0.0).label(),
            "RG −6.4 dB track"
        );
        assert_eq!(Applied::UNITY.label(), "");
    }
}
