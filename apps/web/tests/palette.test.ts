import { expect, test } from "vite-plus/test";
import {
  accent,
  background,
  contrast,
  extract,
  FAINT_CONTRAST,
  fromHex,
  fromHsl,
  hsl,
  legible,
  luminance,
  MUTED_CONTRAST,
  TEXT_CONTRAST,
  textColours,
  toU8,
  WHITE,
  type Rgb,
} from "../src/player/palette.ts";

// The Rust player's palette tests, so both players colour alike.
const image = (colours: [[number, number, number], number][]) =>
  colours.flatMap(([[r, g, b], n]) => Array.from({ length: n }, () => [r, g, b, 255]).flat());
const close = (a: Rgb, b: [number, number, number]) => toU8(a).every((v, i) => Math.abs(v - b[i]!) <= 3);

test("finds the main colours, biggest first", () => {
  const p = extract(
    image([
      [[200, 30, 30], 3000],
      [[20, 40, 180], 1500],
      [[240, 240, 240], 500],
    ]),
    3,
  );
  expect(p).toHaveLength(3);
  expect(close(p[0]!, [200, 30, 30])).toBe(true);
  expect(close(p[1]!, [20, 40, 180])).toBe(true);
});

test("the background is dark and the accent bright", () => {
  const p = extract(
    image([
      [[200, 30, 30], 3000],
      [[20, 40, 180], 1000],
    ]),
    2,
  );
  for (const c of background(p)) expect(hsl(c)[2]).toBeLessThanOrEqual(0.27);
  expect(hsl(accent(p)!)[2]).toBeGreaterThanOrEqual(0.55);
  expect(accent(extract(image([[[128, 128, 128], 100]]), 2))).toBeNull();
});

test("contrast matches WCAG", () => {
  expect(contrast(WHITE, [0, 0, 0])).toBeCloseTo(21, 2);
  expect(contrast(fromHex("#777777")!, WHITE)).toBeCloseTo(4.48, 2);
});

test("legible moves lightness only as needed", () => {
  const bg = fromHex("#6e5a17")!;
  const grey = fromHex("#9097a3")!;
  const fixed = legible(grey, bg, 4.5);
  expect(contrast(fixed, bg)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(fixed, bg)).toBeLessThan(4.6);
  expect(luminance(fixed)).toBeGreaterThan(luminance(grey));
  expect(legible(WHITE, bg, 4.5)).toEqual(WHITE);
  expect(luminance(legible(grey, WHITE, 4.5))).toBeLessThan(luminance(grey));
  expect(toU8(legible(grey, [0.2, 0.2, 0.2], 21))).toEqual([255, 255, 255]);
});

test("every cover gives legible text", () => {
  const base = { text: fromHex("#f2f3f5")!, muted: fromHex("#9097a3")!, faint: fromHex("#5c6370")! };
  for (let i = 0; i < 36; i++) {
    for (const bg of background([fromHsl(i / 36, 0.9, 0.5), [0.95, 0.95, 0.95]])) {
      expect(contrast(WHITE, bg)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      const t = textColours(base, bg);
      expect(contrast(t.text, bg)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      expect(contrast(t.muted, bg)).toBeGreaterThanOrEqual(MUTED_CONTRAST);
      expect(contrast(t.faint, bg)).toBeGreaterThanOrEqual(FAINT_CONTRAST);
    }
  }
  expect(textColours(base, fromHex("#0c0d10")!)).toEqual(base);
});

test("hsl round-trips", () => {
  for (const c of [
    [0.8, 0.1, 0.3],
    [0.1, 0.7, 0.2],
    [0.5, 0.5, 0.5],
  ] as Rgb[]) {
    const back = fromHsl(...hsl(c));
    c.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 4));
  }
});
