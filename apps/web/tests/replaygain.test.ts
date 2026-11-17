import { expect, test } from "vite-plus/test";
import { compute, label, UNITY } from "../src/player/replaygain.ts";

const rg = (
  trackGain: number | null,
  trackPeak: number | null,
  albumGain: number | null,
  albumPeak: number | null,
) => ({
  trackGain,
  trackPeak,
  albumGain,
  albumPeak,
});

// The same cases as the Rust player's tests, so both level alike.
test("auto uses album gain only for albums played in order", () => {
  const r = rg(-6.5, 1, -7.5, 1);
  expect(compute(r, "auto", true, 0)).toMatchObject({ basis: "album", db: -7.5 });
  const t = compute(r, "auto", false, 0);
  expect(t.basis).toBe("track");
  expect(t.linear).toBeCloseTo(0.4732, 3);
});

test("falls back to whichever tag exists", () => {
  const onlyTrack = rg(-3, null, null, null);
  expect(compute(onlyTrack, "album", true, 0).basis).toBe("track");
  expect(compute(rg(null, null, null, null), "auto", true, 0)).toEqual(UNITY);
  expect(compute(onlyTrack, "off", true, 0)).toEqual(UNITY);
});

test("boosts are capped by the peak", () => {
  const quiet = rg(1.09, 0.882, null, null);
  const a = compute(quiet, "track", false, 0);
  expect(a.limited).toBe(false);
  expect(a.db).toBeCloseTo(1.09, 2);
  const b = compute(quiet, "track", false, 3);
  expect(b.limited).toBe(true);
  expect(b.linear).toBeCloseTo(1 / 0.882, 3);
  expect(b.db).toBeCloseTo(1.09, 2);
});

test("labels", () => {
  expect(label(compute(rg(-6.43, 0.5, null, null), "track", false, 0))).toBe("RG −6.4 dB track");
  expect(label(UNITY)).toBe("");
});
