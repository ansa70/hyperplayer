//! The live spectrum: frequency bands of the audio being played, for the visualizer.

use std::f32::consts::PI;

/// Samples analysed per frame (about 46 ms at 44.1 kHz).
pub const WINDOW: usize = 2048;
const LOW_HZ: f32 = 40.0;
const HIGH_HZ: f32 = 16_000.0;
/// Levels below this show as empty bars, above `TOP_DB` as full ones.
const FLOOR_DB: f32 = -75.0;
const TOP_DB: f32 = -15.0;

/// In-place radix-2 FFT of `re`/`im` (length a power of two).
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let angle = -2.0 * PI / len as f32;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (s, c) = (angle * k as f32).sin_cos();
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * c - im[b] * s;
                let ti = re[b] * s + im[b] * c;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
        len <<= 1;
    }
}

/// Turns windows of samples into `bands` bar heights (0..1), smoothed over time:
/// bars jump up with a beat and fall back gently.
pub struct Analyzer {
    levels: Vec<f32>,
    window: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
}

impl Analyzer {
    pub fn new(bands: usize) -> Self {
        Self {
            levels: vec![0.0; bands],
            // Hann window, against spectral leakage.
            window: (0..WINDOW)
                .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (WINDOW - 1) as f32).cos())
                .collect(),
            re: vec![0.0; WINDOW],
            im: vec![0.0; WINDOW],
        }
    }

    /// Analyses the latest `WINDOW` samples (mono) at `rate` Hz.
    pub fn update(&mut self, samples: &[f32], rate: u32) -> &[f32] {
        for i in 0..WINDOW {
            self.re[i] = samples.get(i).copied().unwrap_or(0.0) * self.window[i];
            self.im[i] = 0.0;
        }
        fft(&mut self.re, &mut self.im);
        let bands = self.levels.len();
        let bin_hz = rate as f32 / WINDOW as f32;
        let top = HIGH_HZ.min(rate as f32 / 2.0);
        for b in 0..bands {
            // Logarithmic bands, as hearing works: each spans the same musical interval.
            let lo = LOW_HZ * (top / LOW_HZ).powf(b as f32 / bands as f32);
            let hi = LOW_HZ * (top / LOW_HZ).powf((b + 1) as f32 / bands as f32);
            let (first, last) = (
                (lo / bin_hz) as usize,
                ((hi / bin_hz) as usize).max((lo / bin_hz) as usize + 1),
            );
            let peak = (first..last.min(WINDOW / 2))
                .map(|k| (self.re[k].powi(2) + self.im[k].powi(2)).sqrt())
                .fold(0.0f32, f32::max);
            // Amplitude of a full-scale sine after the Hann window is WINDOW / 4.
            let db = 20.0 * (peak / (WINDOW as f32 / 4.0)).max(1e-9).log10();
            let target = ((db - FLOOR_DB) / (TOP_DB - FLOOR_DB)).clamp(0.0, 1.0);
            let level = &mut self.levels[b];
            *level = if target > *level {
                *level + (target - *level) * 0.6
            } else {
                *level * 0.85 + target * 0.15
            };
        }
        &self.levels
    }

    /// Nothing playing: the bars settle down.
    pub fn decay(&mut self) -> &[f32] {
        self.levels.iter_mut().for_each(|l| *l *= 0.8);
        &self.levels
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, rate: u32) -> Vec<f32> {
        (0..WINDOW)
            .map(|i| 0.5 * (2.0 * PI * hz * i as f32 / rate as f32).sin())
            .collect()
    }

    #[test]
    fn a_tone_lights_up_its_own_band() {
        let mut a = Analyzer::new(24);
        let mut levels = Vec::new();
        for _ in 0..10 {
            levels = a.update(&sine(1000.0, 44_100), 44_100).to_vec();
        }
        let loudest = levels
            .iter()
            .enumerate()
            .max_by(|x, y| x.1.total_cmp(y.1))
            .unwrap()
            .0;
        // 1 kHz on a 40 Hz–16 kHz log scale of 24 bands sits around band 12.
        assert!((11..=13).contains(&loudest), "{levels:?}");
        assert!(levels[loudest] > 0.8);
        assert!(levels[0] < 0.2 && levels[23] < 0.2, "{levels:?}");
    }

    #[test]
    fn silence_and_pauses_settle_to_nothing() {
        let mut a = Analyzer::new(8);
        a.update(&sine(200.0, 48_000), 48_000);
        for _ in 0..40 {
            a.decay();
        }
        assert!(
            a.update(&vec![0.0; WINDOW], 48_000)
                .iter()
                .all(|&l| l < 0.01)
        );
    }
}
