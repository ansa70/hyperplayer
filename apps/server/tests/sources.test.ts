import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

let dir: string;
const open: Ctx[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-sources-"));
});

afterEach(async () => {
  for (const ctx of open.splice(0)) await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

function put(lib: string, rel: string, tags: Record<string, string>) {
  const path = join(lib, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, wav(tags));
  return path;
}

/** A server with its own music, listening for real (the engine connects over the network). */
async function server(opts: { tls?: boolean } = {}) {
  const lib = join(dir, "server-music");
  put(lib, "Band/Album/1.wav", { INAM: "One", IART: "Band", IPRD: "Album", ITRK: "1" });
  put(lib, "Band/Album/2.wav", { INAM: "Two", IART: "Band", IPRD: "Album", ITRK: "2" });
  put(lib, "Solo/Live/1.wav", { INAM: "Encore", IART: "Solo", IPRD: "Live", ITRK: "1" });
  const cover = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#c03030" } })
    .jpeg()
    .toBuffer();
  writeFileSync(join(lib, "Band/Album/cover.jpg"), cover);
  const ctx = await buildApp(
    testConfig(lib, join(dir, "server-data"), {
      tls: opts.tls ? { certFile: null, keyFile: null, names: [] } : null,
    }),
    { logger: false },
  );
  open.push(ctx);
  await ctx.startScan();
  await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = ctx.app.server.address() as AddressInfo;
  const token = await setupAdmin(ctx.app);
  return { ctx, lib, token, url: `${opts.tls ? "https" : "http"}://127.0.0.1:${port}`, cover };
}

/** A standalone player's engine, with music of its own (one album shares the server's band). */
async function engine() {
  const lib = join(dir, "local-music");
  put(lib, "Band/Album/3.wav", { INAM: "Three", IART: "Band", IPRD: "Album", ITRK: "3" });
  put(lib, "Mine/Home/1.wav", { INAM: "Homegrown", IART: "Mine", IPRD: "Home", ITRK: "1" });
  const ctx = await buildApp(
    testConfig(lib, join(dir, "engine-data"), {
      embedded: { deviceId: "dev-player-0001", deviceName: "HyperPlayer on test", username: "me" },
    }),
    { logger: false },
  );
  open.push(ctx);
  await ctx.startScan();
  return { ctx, lib, inject: authed(ctx.app, ctx.embeddedSession!.token) };
}

type Status = {
  scanning: boolean;
  tracks: number;
  albums: number;
  sources: { id: string; tracks: number; syncing: boolean; error: string | null }[];
};

/** Waits for the engine's background sync to settle. */
async function settled(inject: ReturnType<typeof authed>): Promise<Status> {
  for (let i = 0; i < 200; i++) {
    const s = (await inject("/api/library/status")).json() as Status;
    if (!s.scanning && s.sources.every((x) => !x.syncing)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the sync didn't finish");
}

test("the sync lists everything, then only what changed", async () => {
  const s = await server();
  const inject = authed(s.ctx.app, s.token);
  const all = (await inject("/api/sync")).json();
  expect(all).toMatchObject({ full: true, removed: [], next: null });
  expect(all.tracks).toHaveLength(3);
  const one = all.tracks.find((t: { title: string }) => t.title === "One");
  expect(one).toMatchObject({
    artist: { name: "Band" },
    albumArtist: { name: "Band" },
    album: { title: "Album" },
    trackNumber: 1,
    cover: { mime: "image/jpeg" },
  });

  const paged = (await inject("/api/sync?limit=2")).json();
  expect(paged.tracks).toHaveLength(2);
  const rest = (await inject(`/api/sync?limit=2&after=${paged.next}`)).json();
  expect(rest.tracks).toHaveLength(1);
  expect(rest.next).toBeNull();

  // Nothing changed since: nothing listed.
  const since = all.revision;
  expect((await inject(`/api/sync?since=${since}`)).json()).toMatchObject({
    full: false,
    tracks: [],
    removed: [],
  });

  unlinkSync(join(s.lib, "Solo/Live/1.wav"));
  put(s.lib, "Band/Album/4.wav", { INAM: "Four", IART: "Band", IPRD: "Album", ITRK: "4" });
  await s.ctx.startScan();
  const changes = (await inject(`/api/sync?since=${since}`)).json();
  expect(changes.full).toBe(false);
  expect(changes.tracks.map((t: { title: string }) => t.title)).toEqual(["Four"]);
  expect(changes.removed).toEqual([all.tracks.find((t: { title: string }) => t.title === "Encore").id]);
  expect(changes.libraryId).toBe(all.libraryId);
});

test("a server's music joins the player's library, and plays from the server", async () => {
  const s = await server();
  const e = await engine();
  const add = await e.inject({
    method: "POST",
    url: "/api/library/sources",
    payload: { url: s.url, token: s.token, username: "admin", fingerprint: null },
  });
  expect(add.statusCode, add.body).toBe(200);
  const status = await settled(e.inject);
  expect(status.sources).toMatchObject([{ tracks: 3, error: null }]);
  expect(status.tracks).toBe(5);
  // The band's album is one album, with the server's tracks and this computer's.
  expect(status.albums).toBe(3);
  const albums = (await e.inject("/api/albums?sort=title")).json().items as { id: string; title: string }[];
  const album = (await e.inject(`/api/albums/${albums.find((a) => a.title === "Album")!.id}`)).json();
  expect(album.tracks.map((t: { title: string }) => t.title)).toEqual(["One", "Two", "Three"]);

  // Streams come from the server, ranges included.
  const one = album.tracks[0] as { id: string; cover: { id: string } };
  const file = readFileSync(join(s.lib, "Band/Album/1.wav"));
  const whole = await e.inject(`/api/stream/${one.id}`);
  expect(whole.statusCode).toBe(200);
  expect(whole.rawPayload.equals(file)).toBe(true);
  const part = await e.inject({ url: `/api/stream/${one.id}`, headers: { range: "bytes=10-19" } });
  expect(part.statusCode).toBe(206);
  expect(part.headers["content-range"]).toBe(`bytes 10-19/${file.length}`);
  expect(part.rawPayload.equals(file.subarray(10, 20))).toBe(true);

  // So does the cover, fetched once.
  const art = await e.inject(`/api/artwork/${one.cover.id}`);
  expect(art.statusCode).toBe(200);
  expect(art.rawPayload.equals(s.cover)).toBe(true);

  // Search finds the server's tracks too.
  expect((await e.inject("/api/search?q=encore")).json().tracks).toMatchObject([{ title: "Encore" }]);
});

test("changes on the server reach the player at the next sync; removing the server takes its music out", async () => {
  const s = await server();
  const e = await engine();
  await e.inject({
    method: "POST",
    url: "/api/library/sources",
    payload: { url: s.url, token: s.token, username: "admin", fingerprint: null },
  });
  await settled(e.inject);

  unlinkSync(join(s.lib, "Solo/Live/1.wav"));
  put(s.lib, "Band/Album/4.wav", { INAM: "Four", IART: "Band", IPRD: "Album", ITRK: "4" });
  await s.ctx.startScan();
  await e.ctx.startScan();
  const after = await settled(e.inject);
  expect(after.sources[0]!.tracks).toBe(3);
  expect((await e.inject("/api/search?q=encore")).json().tracks).toEqual([]);
  expect((await e.inject("/api/search?q=four")).json().tracks).toMatchObject([{ title: "Four" }]);

  const removed = await e.inject({ method: "DELETE", url: `/api/library/sources/${after.sources[0]!.id}` });
  expect(removed.statusCode).toBe(200);
  // The library's session on the server ends too.
  for (let i = 0; i < 100 && (await authed(s.ctx.app, s.token)("/api/me")).statusCode === 200; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect((await authed(s.ctx.app, s.token)("/api/me")).statusCode).toBe(401);
  expect(removed.json()).toMatchObject({ tracks: 2, albums: 2, sources: [] });
  // This computer's own music stays.
  expect((await e.inject("/api/search?q=three")).json().tracks).toMatchObject([{ title: "Three" }]);
});

test("a server signed out shows why, and its tracks stay meanwhile", async () => {
  const s = await server();
  const e = await engine();
  await e.inject({
    method: "POST",
    url: "/api/library/sources",
    payload: { url: s.url, token: s.token, username: "admin", fingerprint: null },
  });
  await settled(e.inject);
  await authed(s.ctx.app, s.token)({ method: "POST", url: "/api/auth/logout" });
  await e.ctx.startScan();
  const status = await settled(e.inject);
  expect(status.sources[0]!.tracks).toBe(3);
  expect(status.sources[0]!.error).toMatch(/no longer accepts/);
});

test("a wrong token, or a server that isn't one, can't be added", async () => {
  const s = await server();
  const e = await engine();
  const bad = await e.inject({
    method: "POST",
    url: "/api/library/sources",
    payload: { url: s.url, token: "nope", username: "admin", fingerprint: null },
  });
  expect(bad.statusCode).toBe(502);
  expect((await e.inject("/api/library/status")).json().sources).toEqual([]);
});

test("only a standalone player's library adds servers", async () => {
  const s = await server();
  const other = await buildApp(testConfig(join(dir, "none"), join(dir, "other-data")), { logger: false });
  open.push(other);
  const token = await setupAdmin(other.app);
  const res = await authed(
    other.app,
    token,
  )({
    method: "POST",
    url: "/api/library/sources",
    payload: { url: s.url, token: s.token, username: "admin", fingerprint: null },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("not_standalone");
});

test("a self-signed certificate is accepted once trusted, and only that one", async () => {
  const s = await server({ tls: true });
  const e = await engine();
  const fingerprint = s.ctx.tls!.fingerprint;
  const wrong = await e.inject({
    method: "POST",
    url: "/api/library/sources",
    payload: { url: s.url, token: s.token, username: "admin", fingerprint: fingerprint.replace(/^../, "00") },
  });
  expect(wrong.statusCode).toBe(400);
  expect(wrong.json().error).toBe("certificate_changed");
  // Not trusted at all: the usual authorities don't know it.
  const untrusted = await e.inject({
    method: "POST",
    url: "/api/library/sources",
    payload: { url: s.url, token: s.token, username: "admin", fingerprint: null },
  });
  expect(untrusted.statusCode).toBe(502);

  const ok = await e.inject({
    method: "POST",
    url: "/api/library/sources",
    payload: { url: s.url, token: s.token, username: "admin", fingerprint },
  });
  expect(ok.statusCode, ok.body).toBe(200);
  const status = await settled(e.inject);
  expect(status.sources).toMatchObject([{ tracks: 3, error: null }]);
  const track = (await e.inject("/api/search?q=encore")).json().tracks[0] as { id: string };
  expect((await e.inject(`/api/stream/${track.id}`)).statusCode).toBe(200);
});
