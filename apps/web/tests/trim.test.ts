import { expect, test, vi } from "vite-plus/test";

// The trim helpers import the player store, which needs a browser; only `suggest` and
// `picked` are tested here, so stub it.
vi.mock("../src/stores/player.ts", () => ({ usePlayer: { getState: () => ({}) } }));
const { picked, suggest } = await import("../src/player/trim.ts");

// The same cases as the Rust player's tests.
test("long gaps are offered, short ones are not", () => {
  expect(suggest(240_000, { leadingMs: 300, trailingMs: 4_000 })).toBeNull();
  const end = suggest(400_000, { leadingMs: 0, trailingMs: 150_000 })!;
  expect(end.trim).toEqual({ startMs: null, endMs: 251_000 });
  expect(end.text.startsWith("2:30 of silence at the end")).toBe(true);
  expect(suggest(400_000, { leadingMs: 60_000, trailingMs: 0 })!.trim).toEqual({
    startMs: 59_500,
    endMs: null,
  });
});

test("a silent track is not offered", () => {
  expect(suggest(60_000, { leadingMs: 60_000, trailingMs: 60_000 })).toBeNull();
  expect(suggest(30_000, { leadingMs: 12_000, trailingMs: 12_000 })).toBeNull();
});

test("picking a start or end keeps the other end when it still fits", () => {
  const track = { trim: { startMs: 2_000, endMs: 100_000 } } as Parameters<typeof picked>[0];
  expect(picked(track, "start", 5)).toEqual({ startMs: 5_000, endMs: 100_000 });
  expect(picked(track, "start", 120)).toEqual({ startMs: 120_000, endMs: null });
  expect(picked(track, "end", 1)).toEqual({ startMs: null, endMs: 1_000 });
  expect(picked(track, "clear", 0)).toEqual({ startMs: null, endMs: null });
});
