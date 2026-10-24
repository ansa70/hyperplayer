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

test("queue: upNext says where the current track's end will advance to", async () => {
  const upNext = (q: QueueState) => (q.upNext === null ? null : q.entries[q.upNext]!.track.title);
  let q = await playAlbum(4);
  expect(upNext(q)).toBe("Six");
  q = await next(true);
  expect(upNext(q)).toBeNull(); // last track, no repeat
  q = await update({ repeat: "all" });
  expect(upNext(q)).toBe("One");
  q = await update({ repeat: "one" });
  expect(upNext(q)).toBe("Six");
  q = await update({ repeat: "all", shuffle: true });
  // Mid-lap the shuffled order is known; at the lap's end it isn't yet.
  while (q.index! + 1 < q.entries.length) {
    expect(upNext(q)).toBe(q.entries[q.index! + 1]!.track.title);
    expect(current(await next(true))).toBe(upNext(q));
    q = await call("GET", DEVICE, QueueState);
  }
  expect(q.upNext).toBeNull();
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

// ------------------------------------------------------------- shuffle button

/** Adds an album to the library and rescans. */
async function addAlbum(artist: string, album: string, titles: string[], genre?: string) {
  mkdirSync(join(lib, artist, album), { recursive: true });
  titles.forEach((title, i) =>
    writeFileSync(
      join(lib, artist, album, `${i + 1}.wav`),
      wav({ INAM: title, IART: artist, IPRD: album, ITRK: String(i + 1), ...(genre ? { IGNR: genre } : {}) }),
    ),
  );
  await ctx.startScan();
}

const JAZZ = ["Blue", "Green", "Red"];
const SOLO = ["Alone", "Again"];
const setScope = (shuffleScope: string) =>
  inject({ method: "PATCH", url: "/api/me/preferences", payload: { shuffleScope } });
const jumpTo = async (title: string) => {
  const q = await call("GET", DEVICE, QueueState);
  const entry = q.entries.find((e) => e.track.title === title)!;
  return call("POST", `${DEVICE}/jump`, QueueState, { entryId: entry.entryId });
};

test("shuffle button: draws from the whole library; off returns to the album", async () => {
  await addAlbum("Quartet", "Jazz Album", JAZZ, "Jazz");
  await playAlbum(2);
  let q = await update({ shuffle: true });
  expect(q.origin).toMatchObject({ kind: "shuffle", name: "Library" });
  expect(q.shuffleScope).toBe("library");
  expect(current(q)).toBe("Three");
  expect(q.index).toBe(0);
  expect([...order(q)].sort()).toEqual([...ALBUM, ...JAZZ].sort()); // each track once

  // Off on one of the album's tracks: the album, in order, from there.
  await jumpTo("Five");
  q = await update({ shuffle: false });
  expect(order(q)).toEqual(ALBUM);
  expect(current(q)).toBe("Five");
  expect(q.shuffleScope).toBeNull();
  expect(q.origin).toMatchObject({ kind: "album", name: "Album" });

  // Off on a track from elsewhere: it plays last, after the album.
  await update({ shuffle: true });
  await jumpTo("Green");
  q = await update({ shuffle: false });
  expect(order(q)).toEqual([...ALBUM, "Green"]);
  expect(current(q)).toBe("Green");
  expect(q.upNext).toBeNull();
});

test("shuffle button: album, artist and genre scopes follow the playing track", async () => {
  await addAlbum("Quartet", "Jazz Album", JAZZ, "Jazz");
  await addAlbum("Quartet", "Live", SOLO, "Swing");
  await addAlbum("Band", "Second", ["Loud"], "jazz"); // genres match regardless of case
  const jazzAlbum = (
    (await inject("/api/albums")).json() as { items: { id: string; title: string }[] }
  ).items.find((a) => a.title === "Jazz Album")!.id;
  await call("PUT", DEVICE, QueueState, { source: { kind: "album", id: jazzAlbum }, start: 0 });

  await setScope("genre");
  let q = await update({ shuffle: true });
  expect(q.origin).toMatchObject({ kind: "shuffle", name: "Jazz" });
  expect(q.shuffleScope).toBe("genre");
  expect([...order(q)].sort()).toEqual([...JAZZ, "Loud"].sort());

  // A new scope redraws, still around the playing track.
  await setScope("artist");
  q = await update({ shuffle: true });
  expect(q.origin).toMatchObject({ kind: "shuffle", name: "Quartet" });
  expect(current(q)).toBe("Blue");
  expect([...order(q)].sort()).toEqual([...JAZZ, ...SOLO].sort());

  await setScope("album");
  q = await update({ shuffle: true });
  expect(q.origin).toMatchObject({ kind: "shuffle", name: "Jazz Album" });
  expect([...order(q)].sort()).toEqual([...JAZZ].sort());

  expect((await setScope("decade")).statusCode).toBe(400);
});

test("shuffle button: a large library is drawn a window at a time, without repeats", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `Song ${i}`);
  await addAlbum("Crowd", "Many", many);
  await playAlbum(0);
  let q = await update({ shuffle: true });
  expect(q.entries).toHaveLength(26); // the current track and 25 ahead
  const played = [current(q)];
  for (let i = 1; i < ALBUM.length + many.length; i++) {
    q = await next(true);
    played.push(current(q));
    expect(q.entries.length).toBeLessThanOrEqual(51 + 25);
  }
  // One whole lap: every track once.
  expect(new Set(played).size).toBe(ALBUM.length + many.length);
  expect(q.upNext).toBeNull();
  expect((await next(true)).index).toBeNull(); // no repeat: the lap ends it

  // With repeat all, the next lap starts when reached, not with the track just played.
  await jumpTo(played.at(-1)!);
  await update({ repeat: "all" });
  const last = current(await call("GET", DEVICE, QueueState));
  q = await next(true);
  expect(current(q)).not.toBe(last);
  expect(current(q)).not.toBeNull();
});

test("shuffle button: starts something when nothing plays; a chosen album shuffles around its track", async () => {
  let q = await update({ shuffle: true });
  expect(current(q)).not.toBeNull();
  expect(q.origin).toMatchObject({ kind: "shuffle", name: "Library" });

  q = await playAlbum(3);
  expect(q).toMatchObject({ shuffle: true, index: 0, origin: { kind: "shuffle" } });
  expect(current(q)).toBe("Four");
  q = await update({ shuffle: false });
  expect(order(q)).toEqual(ALBUM);
  expect(current(q)).toBe("Four");
});

test("shuffle button: a track without a genre shuffles the whole library", async () => {
  await addAlbum("Quartet", "Jazz Album", JAZZ, "Jazz");
  await playAlbum(0); // untagged
  await setScope("genre");
  const q = await update({ shuffle: true });
  expect(q).toMatchObject({ shuffleScope: "library", origin: { kind: "shuffle", name: "Library" } });
  expect([...order(q)].sort()).toEqual([...ALBUM, ...JAZZ].sort());
});

test("a source's own Shuffle keeps to that source", async () => {
  await addAlbum("Quartet", "Jazz Album", JAZZ, "Jazz");
  await update({ shuffle: true });
  const q = await playAlbum(0, true);
  expect(q).toMatchObject({ origin: { kind: "album" }, shuffle: true, shuffleScope: null });
  expect([...order(q)].sort()).toEqual([...ALBUM].sort());
});

test("the shuffle button's draw survives a server restart", async () => {
  const many = Array.from({ length: 30 }, (_, i) => `Song ${i}`);
  await addAlbum("Crowd", "Many", many);
  await playAlbum(0);
  const before = await update({ shuffle: true });
  await ctx.app.close();
  await start(token);
  let q = await call("GET", DEVICE, QueueState);
  expect(order(q)).toEqual(order(before));
  expect(q.origin).toMatchObject({ kind: "shuffle" });
  // Drawing carries on where it was: still no repeats.
  const played = new Set([current(q)]);
  for (let i = 1; i < ALBUM.length + many.length; i++) played.add(current((q = await next(true))));
  expect(played.size).toBe(ALBUM.length + many.length);
  q = await update({ shuffle: false });
  expect(order(q)).toEqual(ALBUM.includes(current(q)!) ? ALBUM : [...ALBUM, current(q)]);
});

test("a whole genre can be added to a playlist, or played", async () => {
  await addAlbum("Quartet", "Jazz Album", JAZZ, "Jazz");
  await addAlbum("Band", "Second", ["Loud"], "jazz");
  let p = await call("POST", "/api/playlists", Playlist, { name: "Jazz" });
  p = await call("POST", `/api/playlists/${p.id}/entries`, Playlist, {
    source: { kind: "genre", name: "JAZZ" },
  });
  // By artist (sort name), then album and track order.
  expect(titles(p)).toEqual(["Loud", ...JAZZ]);
  const q = await call("PUT", DEVICE, QueueState, { source: { kind: "genre", name: "Jazz" }, start: 0 });
  expect(q.origin).toMatchObject({ kind: "genre", name: "Jazz" });
  const none = await inject({
    method: "PUT",
    url: DEVICE,
    payload: { source: { kind: "genre", name: "Polka" }, start: 0 },
  });
  expect(none.statusCode).toBe(400);
});

test("a playlist's Shuffle draws from that playlist, as the shuffle button's playlist scope", async () => {
  await addAlbum("Quartet", "Jazz Album", JAZZ, "Jazz");
  const album = await albumId();
  let p = await call("POST", "/api/playlists", Playlist, { name: "Mix" });
  const two = (
    await call("PUT", DEVICE, QueueState, { source: { kind: "album", id: album }, start: 0 })
  ).entries
    .slice(0, 2)
    .map((e) => e.track.id);
  p = await call("POST", `/api/playlists/${p.id}/entries`, Playlist, {
    source: { kind: "tracks", trackIds: two },
  });
  p = await call("POST", `/api/playlists/${p.id}/entries`, Playlist, {
    source: { kind: "genre", name: "Jazz" },
  });
  p = await call("POST", `/api/playlists/${p.id}/entries`, Playlist, {
    source: { kind: "tracks", trackIds: two },
  });
  expect(p.entries).toHaveLength(7); // One and Two are listed twice

  let q = await call("PUT", DEVICE, QueueState, {
    source: { kind: "playlist", id: p.id },
    start: 0,
    shuffle: true,
    shuffleScope: "playlist",
  });
  expect(q).toMatchObject({
    shuffle: true,
    shuffleScope: "playlist",
    origin: { kind: "shuffle", name: "Mix" },
  });
  expect([...order(q)].sort()).toEqual(["Blue", "Green", "One", "Red", "Two"]); // each track once
  // The user's own choice is left as it was.
  expect((await inject("/api/me/preferences")).json()).toMatchObject({ shuffleScope: "library" });
  q = await update({ shuffle: false });
  expect(order(q)).toEqual(titles(p));
  expect(q.origin).toMatchObject({ kind: "playlist", name: "Mix" });

  // Chosen in the button's menu, it follows whichever playlist is playing...
  await setScope("playlist");
  q = await update({ shuffle: true });
  expect(q).toMatchObject({ shuffleScope: "playlist", origin: { name: "Mix" } });
  // ...and falls back to the library for anything else.
  await update({ shuffle: false });
  await playAlbum(0);
  q = await update({ shuffle: true });
  expect(q).toMatchObject({ shuffleScope: "library", origin: { name: "Library" } });
});
