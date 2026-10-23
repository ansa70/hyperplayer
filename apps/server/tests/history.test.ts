import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStats, ListenPage, TrackPage } from "@hyperplayer/schemas";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { isListen } from "../src/history/history.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let admin: ReturnType<typeof authed>;
let other: ReturnType<typeof authed>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-history-"));
  const lib = join(dir, "music");
  const track = (artist: string, title: string, n: number, seconds: number) => {
    mkdirSync(join(lib, artist), { recursive: true });
    writeFileSync(
      join(lib, artist, `${n}.wav`),
      wav({ INAM: title, IART: artist, IPRD: `${artist} Album`, ITRK: String(n) }, seconds, 1000),
    );
  };
  track("Band", "Long", 1, 600);
  track("Band", "Medium", 2, 100);
  track("Other", "Short", 1, 20);
  ctx = await buildApp(testConfig(lib, join(dir, "data")), { logger: false });
  await ctx.startScan();
  admin = authed(ctx.app, await setupAdmin(ctx.app));
  await ctx.auth.createUser("someone", "someone's password", false);
  const login = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "someone", password: "someone's password", deviceName: "other" },
  });
  other = authed(ctx.app, (login.json() as { token: string }).token);
  for (const t of TrackPage.parse((await admin("/api/tracks")).json()).items) ids[t.title] = t.id;
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const listen = (who: typeof admin, title: string, playedMs: number, startedAt = minutesAgo(10)) =>
  who({ method: "POST", url: "/api/history", payload: { trackId: ids[title], startedAt, playedMs } });

test("a listen is half the track or four minutes, of a track of at least 30 s", () => {
  expect(isListen(100_000, 50_000)).toBe(true);
  expect(isListen(100_000, 49_999)).toBe(false);
  expect(isListen(600_000, 240_000)).toBe(true); // 4 minutes of a 10 minute track
  expect(isListen(20_000, 20_000)).toBe(false); // too short to ever count
});

test("records listens per user, ignoring repeats and plays that don't count", async () => {
  expect((await listen(admin, "Medium", 49_000)).statusCode).toBe(400);
  expect((await listen(admin, "Short", 20_000)).statusCode).toBe(400);
  const fiveMinutesAgo = minutesAgo(5);
  expect((await listen(admin, "Medium", 60_000, fiveMinutesAgo)).statusCode).toBe(200);
  // The same listen reported again, further along: still one listen.
  expect((await listen(admin, "Medium", 90_000, fiveMinutesAgo)).statusCode).toBe(200);
  expect((await listen(admin, "Long", 250_000, minutesAgo(30))).statusCode).toBe(200);
  expect((await listen(admin, "Medium", 50_000, minutesAgo(60))).statusCode).toBe(200);
  expect((await listen(admin, "Medium", 50_000, minutesAgo(60 * 24 * 40))).statusCode).toBe(200); // 40 days ago
  expect((await listen(other, "Long", 300_000)).statusCode).toBe(200);
  expect(
    (await listen(admin, "Long", 300_000, new Date(Date.now() + 3600_000).toISOString())).statusCode,
  ).toBe(400);

  const history = ListenPage.parse((await admin("/api/history")).json());
  expect(history.total).toBe(4);
  expect(history.items.map((l) => [l.track.title, l.playedMs])).toEqual([
    ["Medium", 90_000],
    ["Long", 250_000],
    ["Medium", 50_000],
    ["Medium", 50_000],
  ]);
  expect(ListenPage.parse((await other("/api/history")).json()).total).toBe(1);

  const stats = HistoryStats.parse((await admin("/api/history/stats?days=30")).json());
  expect(stats).toMatchObject({ days: 30, listens: 3, listenedMs: 390_000 });
  expect(stats.topTracks.map((t) => [t.track.title, t.plays])).toEqual([
    ["Medium", 2],
    ["Long", 1],
  ]);
  expect(stats.topArtists.map((a) => [a.artist.name, a.plays])).toEqual([["Band", 3]]);
  expect(HistoryStats.parse((await admin("/api/history/stats?days=365")).json()).listens).toBe(4);
});

test("unknown tracks are rejected", async () => {
  const res = await admin({
    method: "POST",
    url: "/api/history",
    payload: { trackId: "nope", startedAt: minutesAgo(1), playedMs: 100_000 },
  });
  expect(res.statusCode).toBe(404);
});
