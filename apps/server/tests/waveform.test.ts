import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrackPage, Waveform } from "@hyperplayer/schemas";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { envelope, POINTS } from "../src/library/waveform.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let inject: ReturnType<typeof authed>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-waveform-"));
  const album = join(dir, "music", "Band");
  mkdirSync(album, { recursive: true });
  if (hasFfmpeg) {
    // Silence, then a tone: the waveform's first half is flat, its second half full.
    const args =
      "-v error -f lavfi -i anullsrc=r=8000:cl=mono:d=2 -f lavfi -i sine=f=220:r=8000:d=2 " +
      "-filter_complex [0][1]concat=n=2:v=0:a=1 -metadata title=Half -metadata artist=Band";
    spawnSync("ffmpeg", [...args.split(" "), join(album, "half.flac")]);
  } else {
    writeFileSync(join(album, "half.wav"), wav({ INAM: "Half", IART: "Band" }, 4));
  }
  ctx = await buildApp(testConfig(join(dir, "music"), join(dir, "data")), { logger: false });
  await ctx.startScan();
  inject = authed(ctx.app, await setupAdmin(ctx.app));
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the envelope is the peak per slice, relative to the loudest", () => {
  const pcm = new Int16Array(1000);
  pcm.fill(16000, 500, 750);
  pcm.fill(-32000, 750);
  const points = envelope(pcm, 4);
  expect(points).toEqual([0, 0, Math.round(Math.pow(0.5, 0.7) * 100), 100]);
  expect(envelope(new Int16Array(0), 3)).toEqual([0, 0, 0]);
});

test.skipIf(!hasFfmpeg)("tracks get a waveform, computed once", async () => {
  const id = TrackPage.parse((await inject("/api/tracks")).json()).items[0]!.id;
  const started = Date.now();
  const first = Waveform.parse((await inject(`/api/tracks/${id}/waveform`)).json());
  expect(first.points).toHaveLength(POINTS);
  const quiet = first.points.slice(0, POINTS / 2 - 5);
  const loud = first.points.slice(POINTS / 2 + 5);
  expect(Math.max(...quiet)).toBe(0);
  expect(Math.min(...loud)).toBeGreaterThan(80);
  const computing = Date.now() - started;
  // From the cache: same answer, no decode.
  const t = Date.now();
  expect(Waveform.parse((await inject(`/api/tracks/${id}/waveform`)).json())).toEqual(first);
  expect(Date.now() - t).toBeLessThanOrEqual(Math.max(computing, 50));
  expect((await inject("/api/tracks/nope/waveform")).statusCode).toBe(404);
});
