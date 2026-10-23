import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Playlist, PlaylistList, QueueState, type RepeatMode } from "@hyperplayer/schemas";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

let dir: string;
let lib: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;

const ALBUM = ["One", "Two", "Three", "Four", "Five", "Six"];

let token: string;
let inject: ReturnType<typeof authed>;

async function start(existingToken?: string) {
  ctx = await buildApp(testConfig(lib, join(dir, "data")), { logger: false });
  await ctx.startScan();
  token = existingToken ?? (await setupAdmin(ctx.app));
  inject = authed(ctx.app, token);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-collections-"));
  lib = join(dir, "music");
  mkdirSync(join(lib, "Band", "Album"), { recursive: true });
  ALBUM.forEach((title, i) =>
    writeFileSync(
      join(lib, "Band", "Album", `${i + 1}.wav`),
      wav({ INAM: title, IART: "Band", IPRD: "Album", ITRK: String(i + 1) }),
    ),
  );
  await start();
});

afterEach(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call<T>(method: string, url: string, schema: { parse: (v: unknown) => T }, payload?: unknown) {
  const res = await inject({ method: method as "GET", url, payload: payload as object });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(200);
  return schema.parse(res.json());
}

const albumId = async () =>
  ((await inject("/api/albums")).json() as { items: { id: string }[] }).items[0]!.id;
const titles = (p: Playlist) => p.entries.map((e) => e.track?.title ?? `(missing) ${e.snapshot.title}`);

// ---------------------------------------------------------------- playlists

test("playlists: create, add, move, remove, rename, delete", async () => {
  const album = await albumId();
  let p = await call("POST", "/api/playlists", Playlist, { name: "Favourites" });
  p = await call("POST", `/api/playlists/${p.id}/entries`, Playlist, {
    source: { kind: "album", id: album },
  });
  expect(titles(p)).toEqual(ALBUM);
  expect(p.trackCount).toBe(6);

  // Insert at a position, move, remove.
  const two = p.entries[1]!.track!.id;
  p = await call("POST", `/api/playlists/${p.id}/entries`, Playlist, {
    source: { kind: "tracks", trackIds: [two] },
    position: 0,
  });
  expect(titles(p).slice(0, 3)).toEqual(["Two", "One", "Two"]);
  p = await call("POST", `/api/playlists/${p.id}/entries/${p.entries[0]!.entryId}/move`, Playlist, {
    toIndex: 6,
  });
  expect(titles(p)).toEqual([...ALBUM, "Two"]);
  p = await call("DELETE", `/api/playlists/${p.id}/entries/${p.entries[6]!.entryId}`, Playlist);
  expect(titles(p)).toEqual(ALBUM);

  p = await call("PATCH", `/api/playlists/${p.id}`, Playlist, { name: "Best of", description: "Mine" });
  expect([p.name, p.description]).toEqual(["Best of", "Mine"]);
  expect((await call("GET", "/api/playlists", PlaylistList)).map((x) => x.name)).toEqual(["Best of"]);
  await call("DELETE", `/api/playlists/${p.id}`, { parse: (v) => v });
  expect(await call("GET", "/api/playlists", PlaylistList)).toEqual([]);
});

test("playlist entries survive their file moving, and relink on the next scan", async () => {
  const album = await albumId();
  const created = await call("POST", "/api/playlists", Playlist, { name: "Keep" });
  await call("POST", `/api/playlists/${created.id}/entries`, Playlist, {
    source: { kind: "album", id: album },
  });

  // Moving the files changes every track id (ids derive from paths).
  renameSync(join(lib, "Band", "Album"), join(lib, "Band", "Album (moved)"));
  await ctx.startScan();
  const p = await call("GET", `/api/playlists/${created.id}`, Playlist);
  expect(titles(p)).toEqual(ALBUM);
  expect(p.entries.every((e) => e.track !== null)).toBe(true);
});

test("an unmounted library is not mistaken for an empty one", async () => {
  const p = await call("POST", "/api/playlists", Playlist, { name: "Safe", trackIds: [] });
  await call("POST", `/api/playlists/${p.id}/entries`, Playlist, {
    source: { kind: "album", id: await albumId() },
  });

  renameSync(lib, `${lib}-unmounted`);
  await ctx.startScan(); // fails internally and is logged; must not touch the catalog
  mkdirSync(lib); // a mount point without its share: exists but empty
  await ctx.startScan();

  const status = (await inject("/api/library/status")).json() as { tracks: number };
  expect(status.tracks).toBe(6);
  expect((await call("GET", `/api/playlists/${p.id}`, Playlist)).entries.every((e) => e.track)).toBe(true);
});

// -------------------------------------------------------------------- queue

const DEVICE = "/api/queue";
const current = (q: QueueState) => (q.index === null ? null : q.entries[q.index]!.track.title);
const order = (q: QueueState) => q.entries.map((e) => e.track.title);

async function playAlbum(start = 0, shuffle?: boolean) {
  return call("PUT", DEVICE, QueueState, { source: { kind: "album", id: await albumId() }, start, shuffle });
}
const next = (auto = false) => call("POST", `${DEVICE}/next`, QueueState, { auto });
const previous = () => call("POST", `${DEVICE}/previous`, QueueState);
const update = (changes: { shuffle?: boolean; repeat?: RepeatMode; positionMs?: number }) =>
  call("PATCH", DEVICE, QueueState, changes);

test("queue: plays in order and finishes without repeat", async () => {
  let q = await playAlbum(4);
  expect(q.origin).toMatchObject({ kind: "album", name: "Album" });
  expect(current(q)).toBe("Five");
  q = await next(true);
  expect(current(q)).toBe("Six");
  q = await next(true);
  expect(q.index).toBeNull();
  // Play after the end starts over.
  expect(current(await next())).toBe("One");
});

test("queue: repeat one replays only on auto-advance; repeat all wraps both ways", async () => {
  await playAlbum(5);
  await update({ repeat: "one" });
  expect(current(await next(true))).toBe("Six");
  expect(current(await next(false))).toBe("One"); // the next button moves on and loops
  await update({ repeat: "all" });
  expect(current(await previous())).toBe("Six");
  await update({ repeat: "off" });
  expect(current(await previous())).toBe("Five");
});

test("queue: shuffle keeps the current track first; turning it off restores album order", async () => {
  await playAlbum(2);
  let q = await update({ shuffle: true });
  expect(current(q)).toBe("Three");
  expect(q.index).toBe(0);
  expect([...order(q)].sort()).toEqual([...ALBUM].sort());
  q = await next();
  const playing = current(q);
  q = await update({ shuffle: false });
  expect(order(q)).toEqual(ALBUM);
  expect(current(q)).toBe(playing);
});

test("queue: add next/end, jump, remove current", async () => {
  const album = await albumId();
  let q = await playAlbum(0);
  const six = q.entries[5]!.track.id;
  q = await call("POST", `${DEVICE}/entries`, QueueState, {
    source: { kind: "tracks", trackIds: [six] },
    placement: "next",
  });
  expect(order(q).slice(0, 3)).toEqual(["One", "Six", "Two"]);
  q = await call("POST", `${DEVICE}/entries`, QueueState, {
    source: { kind: "album", id: album },
    placement: "end",
  });
  expect(q.entries).toHaveLength(13);

  q = await call("POST", `${DEVICE}/jump`, QueueState, { entryId: q.entries[3]!.entryId });
  expect(current(q)).toBe("Three");
  q = await call("DELETE", `${DEVICE}/entries/${q.entries[3]!.entryId}`, QueueState);
  expect(current(q)).toBe("Four"); // the following entry becomes current
});

test("queue state persists across server restarts", async () => {
  await playAlbum(3);
  await update({ shuffle: true, repeat: "all", positionMs: 61_000 });
  const before = await call("GET", DEVICE, QueueState);
  await ctx.app.close();
  await start(token); // the device's token survives the restart too
  const after = await call("GET", DEVICE, QueueState);
  expect(order(after)).toEqual(order(before));
  expect(after).toMatchObject({ index: before.index, shuffle: true, repeat: "all", positionMs: 61_000 });
});

test("unknown queue entries are rejected", async () => {
  await playAlbum();
  const res = await inject({ method: "POST", url: `${DEVICE}/jump`, payload: { entryId: "nope" } });
  expect(res.statusCode).toBe(404);
});
