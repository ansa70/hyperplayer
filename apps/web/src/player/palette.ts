// Colours from album artwork, as the Rust player makes them (apps/client/src/palette.rs):
// a small palette, and from it the window's background gradient and an accent colour,
// and text colours kept legible on whatever those make.

/** A colour as red, green and blue in 0..1. */
export type Rgb = [number, number, number];

export const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];

export function fromHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

export function toU8(c: Rgb): [number, number, number] {
  return c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)) as [number, number, number];
}

export function toHex(c: Rgb): string {
  return `#${toU8(c)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Relative luminance, as WCAG defines it (0 black .. 1 white). */
export function luminance(c: Rgb): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const dist2 = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Hue (0..1), saturation and lightness. */
export function hsl(c: Rgb): [number, number, number] {
  const [r, g, b] = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max - min < 1e-6) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  return [h, s, l];
}

export function fromHsl(h: number, s: number, l: number): Rgb {
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

/**
 * The main colours of an RGBA image, most prominent first (at most `k`): k-means over a
 * subsample of the pixels, seeded deterministically, each cluster weighted by its size
 * and a little by its saturation, so a vivid detail can beat a large expanse of grey.
 */
export function extract(rgba: Uint8ClampedArray | number[], k: number): Rgb[] {
  const pixels: Rgb[] = [];
  const step = Math.max(1, Math.floor(rgba.length / 4 / 4096));
  for (let i = 0; i + 3 < rgba.length; i += 4 * step) {
    if (rgba[i + 3]! > 128) pixels.push([rgba[i]! / 255, rgba[i + 1]! / 255, rgba[i + 2]! / 255]);
  }
  if (pixels.length === 0 || k === 0) return [];
  const centres: Rgb[] = Array.from({ length: k }, (_, i) => pixels[Math.floor((i * pixels.length) / k)]!);
  const counts = Array.from({ length: k }, () => 0);
  for (let round = 0; round < 12; round++) {
    const sums = Array.from({ length: k }, () => [0, 0, 0]);
    counts.fill(0);
    for (const p of pixels) {
      let best = 0;
      let bestD = Infinity;
      centres.forEach((c, i) => {
        const d = dist2(p, c);
        if (d < bestD) [best, bestD] = [i, d];
      });
      sums[best]![0]! += p[0];
      sums[best]![1]! += p[1];
      sums[best]![2]! += p[2];
      counts[best]!++;
    }
    for (let i = 0; i < k; i++) {
      const n = counts[i]!;
      if (n > 0) centres[i] = [sums[i]![0]! / n, sums[i]![1]! / n, sums[i]![2]! / n];
    }
  }
  return centres
    .map((c, i) => ({ c, n: counts[i]! }))
    .filter((x) => x.n > 0)
    .map((x) => ({ c: x.c, w: x.n * (0.5 + hsl(x.c)[1]) }))
    .sort((a, b) => b.w - a.w)
    .map((x) => x.c);
}

/**
 * `fg` with its lightness moved away from `bg` just enough for a contrast of at least
 * `ratio` (hue and saturation kept); unchanged if it already has it.
 */
export function legible(fg: Rgb, bg: Rgb, ratio: number): Rgb {
  if (contrast(fg, bg) >= ratio) return fg;
  const [h, s, l] = hsl(fg);
  const lighten = contrast(WHITE, bg) >= contrast(BLACK, bg);
  let near = l;
  let far = lighten ? 1 : 0;
  for (let i = 0; i < 20; i++) {
    const mid = (near + far) / 2;
    if (contrast(fromHsl(h, s, mid), bg) >= ratio) far = mid;
    else near = mid;
  }
  return fromHsl(h, s, far);
}

export interface TextColours {
  text: Rgb;
  muted: Rgb;
  faint: Rgb;
}

/** WCAG AAA for body text, AA for secondary text, AA-large for the faintest labels. */
export const TEXT_CONTRAST = 7;
export const MUTED_CONTRAST = 4.5;
export const FAINT_CONTRAST = 3;

/** `base` lightened where needed to read on `bg`, the lightest colour the text can sit on. */
export function textColours(base: TextColours, bg: Rgb): TextColours {
  return {
    text: legible(base.text, bg, TEXT_CONTRAST),
    muted: legible(base.muted, bg, MUTED_CONTRAST),
    faint: legible(base.faint, bg, FAINT_CONTRAST),
  };
}

/** Three dark, gently saturated colours for the background, each dark enough for white text. */
export function background(palette: Rgb[]): [Rgb, Rgb, Rgb] {
  const fallback: Rgb = [0.05, 0.05, 0.065];
  const tone = (c: Rgb, l: number) => {
    const [h, s] = hsl(c);
    return legible(fromHsl(h, Math.min(s * 0.9, 0.65), l), WHITE, TEXT_CONTRAST);
  };
  const pick = (i: number) => palette[i] ?? palette[0] ?? fallback;
  return [tone(pick(0), 0.26), tone(pick(1), 0.16), tone(pick(2), 0.09)];
}

/** The palette's most vivid colour, brightened to stand out on the dark background; null for a grey cover. */
export function accent(palette: Rgb[]): Rgb | null {
  const vivid = palette.filter((c) => hsl(c)[1] > 0.25).sort((a, b) => hsl(b)[1] - hsl(a)[1])[0];
  if (!vivid) return null;
  const [h, s, l] = hsl(vivid);
  return fromHsl(h, Math.max(s, 0.55), Math.min(0.7, Math.max(0.55, l)));
}
