import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { z } from "zod";
import { openDb, type Db } from "../src/db.ts";
import { NotFound, type HttpClient } from "../src/enrich/http.ts";
import { ArtworkStore } from "../src/library/artwork.ts";
import { Scanner } from "../src/library/scanner.ts";
import { LyricsService, parseLrc } from "../src/lyrics/lyrics.ts";
import { wav } from "./helpers.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
let dir: string;
let album: string;
let db: Db;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-lyrics-"));
  album = join(dir, "music", "Band", "Album");
  mkdirSync(album, { recursive: true });
  const tags = (title: string, n: number) => ({ INAM: title, IART: "Band", IPRD: "Album", ITRK: String(n) });
  writeFileSync(join(album, "01 Sidecar.wav"), wav(tags("Sidecar", 1), 2));
  writeFileSync(
    join(album, "01 Sidecar.lrc"),
    "[ar:Band]\n[offset:+500]\n[00:01.50]First line\n[00:00.75][00:03.00]Twice\n",
  );
  writeFileSync(join(album, "02 Online.wav"), wav(tags("Online", 2), 2));
  writeFileSync(join(album, "03 Elsewhere.wav"), wav(tags("Elsewhere", 3), 2));
  writeFileSync(join(album, "04 Unknown.wav"), wav(tags("Unknown", 4), 2));
  if (hasFfmpeg) {
    // How taggers usually embed lyrics in FLAC: LRC text in a LYRICS comment.
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
      "title=Tagged",
      "-metadata",
      "artist=Band",
      "-metadata",
      "album=Album",
      "-metadata",
      "track=5",
      "-metadata",
      "LYRICS=[00:00.20]Embedded",
      join(album, "05 Tagged.flac"),
    ]);
  }
  db = openDb(join(dir, "library.db"));
  await new Scanner(db, new ArtworkStore(db, dir), { settleMs: 0 }).scan([join(dir, "music")]);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const trackId = (title: string) =>
  String((db.prepare("SELECT id FROM tracks WHERE title = ?").get(title) as { id: string }).id);

function fakeLrcLib(): HttpClient & { requested: string[] } {
  const requested: string[] = [];
  const hit = (over: object) => ({
    duration: 2,
    instrumental: false,
    plainLyrics: null,
    syncedLyrics: null,
    ...over,
  });
  return {
    requested,
    async json<S extends z.ZodType>(url: string, schema: S) {
      requested.push(url);
      const u = new URL(url);
      const title = u.searchParams.get("track_name");
      if (u.pathname === "/api/get" && title === "Online")
        return schema.parse(
          hit({ syncedLyrics: "[00:00.50]Hello\n[00:01.00]World", plainLyrics: "Hello\nWorld" }),
        );
      if (u.pathname === "/api/search" && title === "Elsewhere")
        // A live version: twice as long, so its timings don't apply but its words do.
        return schema.parse([
          hit({ duration: 300, syncedLyrics: "[01:00.00]Live", plainLyrics: "Studio words" }),
        ]);
      if (u.pathname === "/api/search") return schema.parse([]) as z.output<S>;
      throw new NotFound(url);
    },
    async bytes(url: string) {
      throw new NotFound(url);
    },
  };
}

test("parses LRC timestamps, repeated stamps, offsets and plain text", () => {
  expect(parseLrc("[ti:Song]\n[offset:250]\n[00:10.00]Later\n[00:01.5][01:02.345]Both\n")).toEqual({
    synced: true,
    lines: [
      { timeMs: 1250, text: "Both" },
      { timeMs: 9750, text: "Later" },
      { timeMs: 62095, text: "Both" },
    ],
  });
  expect(parseLrc("\nOne\n\n\n\nTwo\n\n")).toEqual({
    synced: false,
    lines: [
      { timeMs: null, text: "One" },
      { timeMs: null, text: "" },
      { timeMs: null, text: "Two" },
    ],
  });
});

test("prefers a .lrc beside the track, then tags, then LRCLIB", async () => {
  const http = fakeLrcLib();
  const lyrics = new LyricsService(db, http);

  const sidecar = await lyrics.get(trackId("Sidecar"))!;
  expect(sidecar).toMatchObject({ source: "file", synced: true });
  expect(sidecar.lines.map((l) => [l.timeMs, l.text])).toEqual([
    [250, "Twice"],
    [1000, "First line"],
    [2500, "Twice"],
  ]);

  if (hasFfmpeg) {
    const tagged = await lyrics.get(trackId("Tagged"))!;
    expect(tagged).toMatchObject({
      source: "tags",
      synced: true,
      lines: [{ timeMs: 200, text: "Embedded" }],
    });
  }

  const online = await lyrics.get(trackId("Online"))!;
  expect(online).toMatchObject({ source: "lrclib", synced: true });
  expect(online.lines.map((l) => l.text)).toEqual(["Hello", "World"]);

  const elsewhere = await lyrics.get(trackId("Elsewhere"))!;
  expect(elsewhere).toMatchObject({
    source: "lrclib",
    synced: false,
    lines: [{ timeMs: null, text: "Studio words" }],
  });

  expect(await lyrics.get(trackId("Unknown"))!).toMatchObject({ source: "none", lines: [] });
  expect(lyrics.get("no-such-track")).toBeNull();
  // Local files never went online.
  expect(http.requested.some((u) => u.includes("Sidecar") || u.includes("Tagged"))).toBe(false);
});

test("results are cached until the file changes, and none means none offline", async () => {
  const http = fakeLrcLib();
  const lyrics = new LyricsService(db, http);
  await lyrics.get(trackId("Online"));
  await lyrics.get(trackId("Unknown"));
  expect(http.requested).toEqual([]); // both answered from the previous test's cache

  // Retagging the file invalidates its entry.
  const path = join(album, "02 Online.wav");
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  await new Scanner(db, new ArtworkStore(db, dir), { settleMs: 0 }).scan([join(dir, "music")]);
  await lyrics.get(trackId("Online"));
  expect(http.requested).toHaveLength(1);

  const offline = new LyricsService(db, null);
  db.exec("DELETE FROM lyrics");
  expect(await offline.get(trackId("Online"))!).toMatchObject({ source: "none" });
});
