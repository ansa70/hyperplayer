import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Album, ArtistPage, LibraryStatus, NowPlaying } from "@hyperplayer/schemas";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { parseRange } from "../src/stream/stream.ts";

/** Builds a 16-bit mono PCM WAV with a RIFF INFO tag chunk. */
function wav(tags: Record<string, string>, seconds = 1, sampleRate = 8000): Buffer {
  const pcm = Buffer.alloc(seconds * sampleRate * 2);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(1, 2); // channels
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const chunk = (id: string, body: Buffer) => {
    const header = Buffer.alloc(8);
    header.write(id, 0, "ascii");
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const info = Buffer.concat([
    Buffer.from("INFO"),
    ...Object.entries(tags).map(([k, v]) => chunk(k, Buffer.from(`${v}\0`))),
  ]);
  const body = Buffer.concat([
    Buffer.from("WAVE"),
    chunk("fmt ", fmt),
    chunk("data", pcm),
    chunk("LIST", info),
  ]);
  return chunk("RIFF", body);
}

let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;

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
  track("First", 1, "Opening");
  track("First", 2, "Closing");
  track("Second", 1, "Return");

  ctx = await buildApp(
    {
      libraryPath: lib,
      dataDir: join(dir, "data"),
      host: "127.0.0.1",
      port: 0,
      ffmpeg: "ffmpeg",
      validateResponses: true,
      enrich: { enabled: false, contact: "test", wikiLang: "en", fanartKey: null },
    },
    { logger: false },
  );
  await ctx.startScan();
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async <T>(url: string, schema: { parse: (v: unknown) => T }) => {
  const res = await ctx.app.inject({ method: "GET", url });
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

  const albums = await ctx.app.inject(`/api/artists/${artist.id}/albums`);
  const first = (albums.json() as { id: string; title: string }[]).find((a) => a.title === "First")!;
  const album = await get(`/api/albums/${first.id}`, Album);
  expect(album.tracks.map((t) => t.title)).toEqual(["Opening", "Closing"]);
  expect(album.tracks[0]!.format).toMatchObject({ lossless: true, sampleRate: 8000, channels: 1 });

  const np = await get(`/api/tracks/${album.tracks[0]!.id}/now-playing`, NowPlaying);
  expect(np.artist.genres).toEqual(["Ambient"]);
  expect(np.moreFromArtist.map((a) => a.title)).toEqual(["Second"]);
});

test("streams originals with range support", async () => {
  const album = (await ctx.app.inject("/api/albums")).json() as { items: { id: string }[] };
  const full = await get(`/api/albums/${album.items[0]!.id}`, Album);
  const id = full.tracks[0]!.id;

  const whole = await ctx.app.inject(`/api/stream/${id}`);
  expect(whole.statusCode).toBe(200);
  expect(whole.headers["accept-ranges"]).toBe("bytes");
  expect(whole.rawPayload.subarray(0, 4).toString()).toBe("RIFF");

  const part = await ctx.app.inject({ url: `/api/stream/${id}`, headers: { range: "bytes=8-11" } });
  expect(part.statusCode).toBe(206);
  expect(part.rawPayload.toString()).toBe("WAVE");
  expect(part.headers["content-range"]).toBe(`bytes 8-11/${full.tracks[0]!.fileSize}`);
});

test("unknown ids and bad queries return typed errors", async () => {
  const missing = await ctx.app.inject("/api/albums/nope");
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toMatchObject({ error: "not_found" });
  const bad = await ctx.app.inject("/api/artists?limit=9999");
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
