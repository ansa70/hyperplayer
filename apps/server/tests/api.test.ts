import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Album, ArtistPage, LibraryStatus, NowPlaying } from "@hyperplayer/schemas";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";
import { parseRange } from "../src/stream/stream.ts";

let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let inject: ReturnType<typeof authed>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-test-"));
  const lib = join(dir, "music");
  mkdirSync(join(lib, "Artist A", "First"), { recursive: true });
  mkdirSync(join(lib, "Artist A", "Second"), { recursive: true });
  const track = (album: string, n: number, title: string) =>
    writeFileSync(
      join(lib, "Artist A", album, `${n}.wav`),
      wav({ INAM: title, IART: "Artist A", IPRD: album, ITRK: String(n), ICRD: "2020", IGNR: "Ambient" }),
    );
  // Hi-res source: lossy encoders must resample it (libvorbis rejects 192 kHz).
  writeFileSync(
    join(lib, "Artist A", "First", "1.wav"),
    wav(
      { INAM: "Opening", IART: "Artist A", IPRD: "First", ITRK: "1", ICRD: "2020", IGNR: "Ambient" },
      1,
      192_000,
    ),
  );
  track("First", 2, "Closing");
  track("Second", 1, "Return");

  ctx = await buildApp(testConfig(lib, join(dir, "data")), { logger: false });
  await ctx.startScan();
  inject = authed(ctx.app, await setupAdmin(ctx.app));
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async <T>(url: string, schema: { parse: (v: unknown) => T }) => {
  const res = await inject({ method: "GET", url });
  expect(res.statusCode, res.body).toBe(200);
  return schema.parse(res.json());
};

test("scan populates the library", async () => {
  const status = await get("/api/library/status", LibraryStatus);
  expect(status).toMatchObject({ scanning: false, artists: 1, albums: 2, tracks: 3 });
  expect(status.lastScanAt).not.toBeNull();
});

test("browse artist → album → now playing", async () => {
  const artists = await get("/api/artists", ArtistPage);
  expect(artists.items).toHaveLength(1);
  const artist = artists.items[0]!;
  expect(artist).toMatchObject({ name: "Artist A", albumCount: 2, trackCount: 3 });

  const albums = await inject(`/api/artists/${artist.id}/albums`);
  const first = (albums.json() as { id: string; title: string }[]).find((a) => a.title === "First")!;
  const album = await get(`/api/albums/${first.id}`, Album);
  expect(album.tracks.map((t) => t.title)).toEqual(["Opening", "Closing"]);
  expect(album.tracks[0]!.format).toMatchObject({ lossless: true, sampleRate: 192_000, channels: 1 });

  const np = await get(`/api/tracks/${album.tracks[0]!.id}/now-playing`, NowPlaying);
  expect(np.artist.genres).toEqual(["Ambient"]);
  expect(np.moreFromArtist.map((a) => a.title)).toEqual(["Second"]);
});

test("streams originals with range support", async () => {
  const album = (await inject("/api/albums")).json() as { items: { id: string }[] };
  const full = await get(`/api/albums/${album.items[0]!.id}`, Album);
  const id = full.tracks[0]!.id;

  const whole = await inject(`/api/stream/${id}`);
  expect(whole.statusCode).toBe(200);
  expect(whole.headers["accept-ranges"]).toBe("bytes");
  expect(whole.rawPayload.subarray(0, 4).toString()).toBe("RIFF");

  const part = await inject({ url: `/api/stream/${id}`, headers: { range: "bytes=8-11" } });
  expect(part.statusCode).toBe(206);
  expect(part.rawPayload.toString()).toBe("WAVE");
  expect(part.headers["content-range"]).toBe(`bytes 8-11/${full.tracks[0]!.fileSize}`);
});

test("unknown ids and bad queries return typed errors", async () => {
  const missing = await inject("/api/albums/nope");
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toMatchObject({ error: "not_found" });
  const bad = await inject("/api/artists?limit=9999");
  expect(bad.statusCode).toBe(400);
});

test("parseRange", () => {
  expect(parseRange(undefined, 100)).toBeNull();
  expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
  expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
  expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  expect(parseRange("bytes=0-500", 100)).toEqual({ start: 0, end: 99 });
  expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
});

test("throttle caps throughput", async () => {
  const { Readable } = await import("node:stream");
  const { throttle } = await import("../src/stream/stream.ts");
  const started = Date.now();
  let bytes = 0;
  // 64 KB at 1024 kbit/s (128 KB/s) should take about half a second.
  for await (const chunk of throttle(Readable.from([Buffer.alloc(64 * 1024)]), 1024)) {
    bytes += (chunk as Buffer).length;
  }
  expect(bytes).toBe(64 * 1024);
  expect(Date.now() - started).toBeGreaterThanOrEqual(400);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test.skipIf(!hasFfmpeg)("transcodes hi-res sources to every lossy format, with a start offset", async () => {
  const search = (await inject("/api/search?q=Opening")).json() as { tracks: { id: string }[] };
  const id = search.tracks[0]!.id;
  // The fixture is mono: 320 kbit/s Vorbis is exactly what libvorbis's bitrate mode refuses.
  for (const [format, bitrate] of [
    ["vorbis", 320],
    ["vorbis", 64],
    ["opus", 128],
    ["mp3", 128],
    ["aac", 128],
    ["flac", 128],
  ]) {
    const res = await inject(`/api/stream/${id}?format=${format}&bitrate=${bitrate}&start=0.5`);
    expect(res.statusCode, `${format} ${bitrate}: ${res.body}`).toBe(200);
    expect(res.rawPayload.length, `${format} ${bitrate}`).toBeGreaterThan(100);
  }
});

test("a failing transcode is an error, not an empty 200", async () => {
  // `false` exits at once without output, like an encoder that rejects its input.
  const broken = await buildApp(
    testConfig(join(dir, "music"), join(dir, "data-broken"), { ffmpeg: "false" }),
    {
      logger: false,
    },
  );
  try {
    await broken.startScan();
    const brokenInject = authed(broken.app, await setupAdmin(broken.app));
    const search = (await brokenInject("/api/search?q=Opening")).json() as { tracks: { id: string }[] };
    const res = await brokenInject(`/api/stream/${search.tracks[0]!.id}?format=vorbis`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "transcode_failed" });
  } finally {
    await broken.app.close();
  }
});

test("vorbis quality mapping", async () => {
  const { vorbisQuality } = await import("../src/stream/stream.ts");
  expect([320, 192, 128, 96, 64, 32].map(vorbisQuality)).toEqual([9, 6, 4, 2, 0, -1]);
});
