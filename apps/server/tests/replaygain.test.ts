import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Album } from "@hyperplayer/schemas";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";
import { writeFileSync } from "node:fs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let inject: ReturnType<typeof authed>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-rg-"));
  const album = join(dir, "music", "Band", "Album");
  mkdirSync(album, { recursive: true });
  if (hasFfmpeg) {
    // Tagged the way taggers (Picard, foobar2000, Lidarr) write Vorbis comments.
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:d=1",
      "-c:a",
      "flac",
      "-metadata",
      "title=Loud",
      "-metadata",
      "artist=Band",
      "-metadata",
      "album=Album",
      "-metadata",
      "track=1",
      "-metadata",
      "REPLAYGAIN_TRACK_GAIN=-7.50 dB",
      "-metadata",
      "REPLAYGAIN_TRACK_PEAK=0.988",
      "-metadata",
      "REPLAYGAIN_ALBUM_GAIN=-6.25 dB",
      "-metadata",
      "REPLAYGAIN_ALBUM_PEAK=1.000000",
      join(album, "1.flac"),
    ]);
  }
  writeFileSync(join(album, "2.wav"), wav({ INAM: "Untagged", IART: "Band", IPRD: "Album", ITRK: "2" }));
  ctx = await buildApp(testConfig(join(dir, "music"), join(dir, "data")), { logger: false });
  await ctx.startScan();
  inject = authed(ctx.app, await setupAdmin(ctx.app));
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!hasFfmpeg)("ReplayGain tags are read and served with tracks", async () => {
  const { items } = (await inject("/api/albums")).json() as { items: { id: string }[] };
  const album = Album.parse((await inject(`/api/albums/${items[0]!.id}`)).json());
  const byTitle = Object.fromEntries(album.tracks.map((t) => [t.title, t.replayGain]));
  expect(byTitle.Loud).toEqual({ trackGain: -7.5, trackPeak: 0.988, albumGain: -6.25, albumPeak: 1 });
  expect(byTitle.Untagged).toEqual({ trackGain: null, trackPeak: null, albumGain: null, albumPeak: null });
});

test("ReplayGain preferences have defaults and are validated", async () => {
  expect((await inject("/api/me/preferences")).json()).toEqual({
    quality: "auto",
    replayGain: "auto",
    replayGainPreamp: 0,
    accent: "cover",
    coverBackground: true,
    visualizer: true,
  });
  // Appearance preferences validate too: an accent is "cover" or a #rrggbb colour.
  const accent = await inject({
    method: "PATCH",
    url: "/api/me/preferences",
    payload: { accent: "#ff5fa2" },
  });
  expect(accent.json()).toMatchObject({ accent: "#ff5fa2" });
  const notAColour = await inject({
    method: "PATCH",
    url: "/api/me/preferences",
    payload: { accent: "pink" },
  });
  expect(notAColour.statusCode).toBe(400);
  const set = await inject({
    method: "PATCH",
    url: "/api/me/preferences",
    payload: { replayGain: "album", replayGainPreamp: 3 },
  });
  expect(set.json()).toMatchObject({ replayGain: "album", replayGainPreamp: 3 });
  const bad = await inject({
    method: "PATCH",
    url: "/api/me/preferences",
    payload: { replayGainPreamp: 40 },
  });
  expect(bad.statusCode).toBe(400);
});
