//! Colours from album artwork: a small palette, and from it the window's
//! background gradient and an accent colour (Amberol-style); and text colours
//! kept legible on whatever those make.

/// A colour as red, green and blue in 0..=1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb(pub f32, pub f32, pub f32);

impl Rgb {
    pub fn from_hex(hex: &str) -> Option<Self> {
        let v = u32::from_str_radix(hex.strip_prefix('#')?, 16).ok()?;
        Some(Rgb(
            ((v >> 16) & 0xff) as f32 / 255.0,
            ((v >> 8) & 0xff) as f32 / 255.0,
            (v & 0xff) as f32 / 255.0,
        ))
    }

    pub fn to_u8(self) -> (u8, u8, u8) {
        let c = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        (c(self.0), c(self.1), c(self.2))
    }

    pub const WHITE: Rgb = Rgb(1.0, 1.0, 1.0);

    /// Relative luminance, as WCAG defines it (0 black ..= 1 white).
    pub fn luminance(self) -> f32 {
        let lin = |v: f32| {
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(self.0) + 0.7152 * lin(self.1) + 0.0722 * lin(self.2)
    }

    /// WCAG contrast ratio between two colours, 1..=21.
    pub fn contrast(self, o: Rgb) -> f32 {
        let (a, b) = (self.luminance(), o.luminance());
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    /// `self` painted over `under` with the given opacity.
    pub fn over(self, alpha: f32, under: Rgb) -> Rgb {
        let mix = |a: f32, b: f32| a * alpha + b * (1.0 - alpha);
        Rgb(
            mix(self.0, under.0),
            mix(self.1, under.1),
            mix(self.2, under.2),
        )
    }

    fn dist2(self, o: Rgb) -> f32 {
        (self.0 - o.0).powi(2) + (self.1 - o.1).powi(2) + (self.2 - o.2).powi(2)
    }

    /// Hue (0..1), saturation and lightness.
    pub fn hsl(self) -> (f32, f32, f32) {
        let (r, g, b) = (self.0, self.1, self.2);
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let l = (max + min) / 2.0;
        if max - min < 1e-6 {
            return (0.0, 0.0, l);
        }
        let d = max - min;
        let s = if l > 0.5 {
            d / (2.0 - max - min)
        } else {
            d / (max + min)
        };
        let h = if max == r {
            (g - b) / d + if g < b { 6.0 } else { 0.0 }
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        } / 6.0;
        (h, s, l)
    }

    pub fn from_hsl(h: f32, s: f32, l: f32) -> Self {
        if s <= 0.0 {
            return Rgb(l, l, l);
        }
        let q = if l < 0.5 {
            l * (1.0 + s)
        } else {
            l + s - l * s
        };
        let p = 2.0 * l - q;
        let hue = |mut t: f32| {
            t = t.rem_euclid(1.0);
            if t < 1.0 / 6.0 {
                p + (q - p) * 6.0 * t
            } else if t < 0.5 {
                q
            } else if t < 2.0 / 3.0 {
                p + (q - p) * (2.0 / 3.0 - t) * 6.0
            } else {
                p
            }
        };
        Rgb(hue(h + 1.0 / 3.0), hue(h), hue(h - 1.0 / 3.0))
    }
}

/// The main colours of an RGBA image, most prominent first (at most `k`).
///
/// k-means over a subsample of the pixels, seeded deterministically, with each
/// cluster weighted by its size and a little by its saturation, so a vivid
/// detail can beat a large expanse of grey.
pub fn extract(rgba: &[u8], k: usize) -> Vec<Rgb> {
    let pixels: Vec<Rgb> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .step_by((rgba.len() / 4 / 4096).max(1))
        .filter(|p| p[3] > 128)
        .map(|p| {
            Rgb(
                p[0] as f32 / 255.0,
                p[1] as f32 / 255.0,
                p[2] as f32 / 255.0,
            )
        })
        .collect();
    if pixels.is_empty() || k == 0 {
        return Vec::new();
    }
    // Seeds spread through the image (pixels are in reading order).
    let mut centres: Vec<Rgb> = (0..k).map(|i| pixels[i * pixels.len() / k]).collect();
    let mut counts = vec![0usize; k];
    for _ in 0..12 {
        let mut sums = vec![(0.0f32, 0.0f32, 0.0f32); k];
        counts.iter_mut().for_each(|c| *c = 0);
        for &p in &pixels {
            let (i, _) = centres
                .iter()
                .enumerate()
                .map(|(i, c)| (i, p.dist2(*c)))
                .fold((0, f32::MAX), |best, x| if x.1 < best.1 { x } else { best });
            sums[i].0 += p.0;
            sums[i].1 += p.1;
            sums[i].2 += p.2;
            counts[i] += 1;
        }
        for i in 0..k {
            if counts[i] > 0 {
                let n = counts[i] as f32;
                centres[i] = Rgb(sums[i].0 / n, sums[i].1 / n, sums[i].2 / n);
            }
        }
    }
    let mut ranked: Vec<(f32, Rgb)> = centres
        .into_iter()
        .zip(counts)
        .filter(|(_, n)| *n > 0)
        .map(|(c, n)| (n as f32 * (0.5 + c.hsl().1), c))
        .collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    ranked.into_iter().map(|(_, c)| c).collect()
}

/// `fg` with its lightness moved away from `bg` just enough for a contrast of
/// at least `ratio` (hue and saturation kept); unchanged if it already has it.
/// Lighter on a dark background, darker on a light one, and as far as white or
/// black when the ratio can't be reached.
pub fn legible(fg: Rgb, bg: Rgb, ratio: f32) -> Rgb {
    if fg.contrast(bg) >= ratio {
        return fg;
    }
    let (h, s, l) = fg.hsl();
    let lighten = Rgb::WHITE.contrast(bg) >= Rgb(0.0, 0.0, 0.0).contrast(bg);
    // Luminance only grows with lightness, so bisect between `l` and the end.
    let (mut near, mut far) = if lighten { (l, 1.0) } else { (l, 0.0) };
    for _ in 0..20 {
        let mid = (near + far) / 2.0;
        if Rgb::from_hsl(h, s, mid).contrast(bg) >= ratio {
            far = mid;
        } else {
            near = mid;
        }
    }
    Rgb::from_hsl(h, s, far)
}

/// The three levels of text, brightest first.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextColours {
    pub text: Rgb,
    pub muted: Rgb,
    pub faint: Rgb,
}

/// The minimum contrast of each level: WCAG AAA for body text, AA for secondary
/// text and AA-large for the faintest labels and hints.
pub const TEXT_CONTRAST: f32 = 7.0;
pub const MUTED_CONTRAST: f32 = 4.5;
pub const FAINT_CONTRAST: f32 = 3.0;

/// `base` (the theme's own colours) lightened where needed to read on `bg`, the
/// lightest colour the text can sit on.
pub fn text_colours(base: TextColours, bg: Rgb) -> TextColours {
    TextColours {
        text: legible(base.text, bg, TEXT_CONTRAST),
        muted: legible(base.muted, bg, MUTED_CONTRAST),
        faint: legible(base.faint, bg, FAINT_CONTRAST),
    }
}

/// Darkens the pixels of an RGBA image too light for white text at `ratio`.
pub fn dim(rgba: &mut [u8], ratio: f32) {
    for p in rgba.as_chunks_mut::<4>().0 {
        let c = Rgb(
            p[0] as f32 / 255.0,
            p[1] as f32 / 255.0,
            p[2] as f32 / 255.0,
        );
        let (r, g, b) = legible(c, Rgb::WHITE, ratio).to_u8();
        (p[0], p[1], p[2]) = (r, g, b);
    }
}

/// The lightest colour of an RGBA image, skipping transparent pixels.
pub fn lightest(rgba: &[u8]) -> Option<Rgb> {
    rgba.as_chunks::<4>()
        .0
        .iter()
        .filter(|p| p[3] > 128)
        .map(|p| {
            Rgb(
                p[0] as f32 / 255.0,
                p[1] as f32 / 255.0,
                p[2] as f32 / 255.0,
            )
        })
        .max_by(|a, b| a.luminance().total_cmp(&b.luminance()))
}

/// Three dark, gently saturated colours for the window background, so light text
/// stays readable on top of them: each dark enough for white text at the
/// body-text contrast (so a bright yellow cover gives a darker tone than a blue).
pub fn background(palette: &[Rgb]) -> [Rgb; 3] {
    let fallback = Rgb(0.05, 0.05, 0.065);
    let tone = |c: Rgb, l: f32| {
        let (h, s, _) = c.hsl();
        let c = Rgb::from_hsl(h, (s * 0.9).min(0.65), l);
        legible(c, Rgb::WHITE, TEXT_CONTRAST)
    };
    let pick = |i: usize| {
        palette
            .get(i)
            .or(palette.first())
            .copied()
            .unwrap_or(fallback)
    };
    [
        tone(pick(0), 0.26),
        tone(pick(1), 0.16),
        tone(pick(2), 0.09),
    ]
}

/// The palette's most vivid colour, brightened enough to stand out on the dark
/// background; None for an all-grey cover (callers keep their default).
pub fn accent(palette: &[Rgb]) -> Option<Rgb> {
    let vivid = palette
        .iter()
        .copied()
        .filter(|c| c.hsl().1 > 0.25)
        .max_by(|a, b| a.hsl().1.total_cmp(&b.hsl().1))?;
    let (h, s, l) = vivid.hsl();
    Some(Rgb::from_hsl(h, s.max(0.55), l.clamp(0.55, 0.7)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(colours: &[((u8, u8, u8), usize)]) -> Vec<u8> {
        colours
            .iter()
            .flat_map(|&((r, g, b), n)| std::iter::repeat_n([r, g, b, 255], n))
            .flatten()
            .collect()
    }

    fn close(a: Rgb, b: (u8, u8, u8)) -> bool {
        let (r, g, bl) = a.to_u8();
        (r as i32 - b.0 as i32).abs() <= 3
            && (g as i32 - b.1 as i32).abs() <= 3
            && (bl as i32 - b.2 as i32).abs() <= 3
    }

    #[test]
    fn finds_the_main_colours_biggest_first() {
        let img = image(&[
            ((200, 30, 30), 3000),
            ((20, 40, 180), 1500),
            ((240, 240, 240), 500),
        ]);
        let p = extract(&img, 3);
        assert_eq!(p.len(), 3);
        assert!(close(p[0], (200, 30, 30)), "{:?}", p[0].to_u8());
        assert!(close(p[1], (20, 40, 180)), "{:?}", p[1].to_u8());
    }

    #[test]
    fn background_is_dark_and_accent_is_bright() {
        let p = extract(&image(&[((200, 30, 30), 3000), ((20, 40, 180), 1000)]), 2);
        for c in background(&p) {
            assert!(c.hsl().2 <= 0.27);
        }
        let a = accent(&p).unwrap();
        assert!(a.hsl().2 >= 0.55);
        // A grey cover has no accent of its own.
        assert_eq!(accent(&extract(&image(&[((128, 128, 128), 100)]), 2)), None);
    }

    #[test]
    fn contrast_matches_wcag() {
        let black = Rgb(0.0, 0.0, 0.0);
        assert!((Rgb::WHITE.contrast(black) - 21.0).abs() < 0.01);
        assert!((black.contrast(black) - 1.0).abs() < 1e-6);
        // #777777 on white is the classic just-under-4.5:1 grey.
        let grey = Rgb::from_hex("#777777").unwrap();
        assert!((grey.contrast(Rgb::WHITE) - 4.48).abs() < 0.01);
    }

    #[test]
    fn legible_moves_lightness_only_as_needed() {
        let bg = Rgb::from_hex("#6e5a17").unwrap();
        let grey = Rgb::from_hex("#9097a3").unwrap();
        let fixed = legible(grey, bg, 4.5);
        assert!(fixed.contrast(bg) >= 4.5);
        assert!(fixed.contrast(bg) < 4.6, "overshot: {}", fixed.contrast(bg));
        assert!(fixed.luminance() > grey.luminance());
        assert!((fixed.hsl().0 - grey.hsl().0).abs() < 0.01, "hue kept");
        // Already fine: untouched; on a light background, darkened instead.
        assert_eq!(legible(Rgb::WHITE, bg, 4.5), Rgb::WHITE);
        let on_light = legible(grey, Rgb::WHITE, 4.5);
        assert!(on_light.luminance() < grey.luminance());
        assert!(on_light.contrast(Rgb::WHITE) >= 4.5);
        // Unreachable: as far as it goes.
        assert_eq!(
            legible(grey, Rgb(0.2, 0.2, 0.2), 21.0).to_u8(),
            (255, 255, 255)
        );
    }

    #[test]
    fn every_cover_gives_legible_text() {
        let base = TextColours {
            text: Rgb::from_hex("#f2f3f5").unwrap(),
            muted: Rgb::from_hex("#9097a3").unwrap(),
            faint: Rgb::from_hex("#5c6370").unwrap(),
        };
        // A sweep of hues and greys, the brightest stop of each gradient.
        for i in 0..36 {
            let cover = Rgb::from_hsl(i as f32 / 36.0, 0.9, 0.5);
            for bg in background(&[cover, Rgb(0.95, 0.95, 0.95)]) {
                assert!(Rgb::WHITE.contrast(bg) >= TEXT_CONTRAST, "{:?}", bg.to_u8());
                let t = text_colours(base, bg);
                assert!(t.text.contrast(bg) >= TEXT_CONTRAST);
                assert!(t.muted.contrast(bg) >= MUTED_CONTRAST);
                assert!(t.faint.contrast(bg) >= FAINT_CONTRAST);
                // Still three distinct levels.
                assert!(t.text.luminance() > t.muted.luminance());
                assert!(t.muted.luminance() > t.faint.luminance());
            }
        }
        // On the plain theme background nothing needs to change.
        assert_eq!(text_colours(base, Rgb::from_hex("#0c0d10").unwrap()), base);
    }

    #[test]
    fn dimmed_images_keep_white_text_readable() {
        let mut img = image(&[
            ((255, 255, 255), 10),
            ((250, 220, 40), 10),
            ((10, 20, 30), 10),
        ]);
        dim(&mut img, TEXT_CONTRAST);
        let top = lightest(&img).unwrap();
        assert!(Rgb::WHITE.contrast(top) >= TEXT_CONTRAST - 0.05);
        // Dark pixels are left alone.
        assert_eq!(&img[img.len() - 4..], &[10, 20, 30, 255]);
    }

    #[test]
    fn hsl_round_trips() {
        for c in [Rgb(0.8, 0.1, 0.3), Rgb(0.1, 0.7, 0.2), Rgb(0.5, 0.5, 0.5)] {
            let (h, s, l) = c.hsl();
            let back = Rgb::from_hsl(h, s, l);
            assert!(c.dist2(back) < 1e-6, "{c:?} → {back:?}");
        }
        assert_eq!(
            Rgb::from_hex("#ff8000").map(Rgb::to_u8),
            Some((255, 128, 0))
        );
    }
}
