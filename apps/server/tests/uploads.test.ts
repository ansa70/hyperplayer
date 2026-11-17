import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlbumPage,
  ArtistPage,
  SearchResults,
  SyncPage,
  Track,
  TrackPage,
  UploadInfo,
  User,
} from "@hyperplayer/schemas";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

let dir: string;
let uploadDir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let admin: ReturnType<typeof authed>;
let alice: ReturnType<typeof authed>;
let bob: ReturnType<typeof authed>;
let aliceId: string;
let bobId: string;

/** Small files, so the limits are cheap to reach. */
const MAX_FILE = 200_000;
const QUOTA = 300_000;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-uploads-"));
  const lib = join(dir, "music");
  uploadDir = join(dir, "uploads");
  mkdirSync(join(lib, "Band"), { recursive: true });
  writeFileSync(join(lib, "Band", "1.wav"), wav({ INAM: "Song", IART: "Band", IPRD: "Album", ITRK: "1" }));
  ctx = await buildApp(
    {
      ...testConfig(lib, join(dir, "data")),
      uploads: { dir: uploadDir, maxFileBytes: MAX_FILE, quotaBytes: QUOTA },
    },
    { logger: false },
  );
  await ctx.startScan();
  admin = authed(ctx.app, await setupAdmin(ctx.app));
  [aliceId, alice] = await user("alice");
  [bobId, bob] = await user("bob");
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Creates a user and signs them in, past the first password change. */
async function user(username: string): Promise<[string, ReturnType<typeof authed>]> {
  const created = User.parse(
    (
      await admin({ method: "POST", url: "/api/users", payload: { username, password: "first password" } })
    ).json(),
  );
  const login = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "first password", deviceName: "tests" },
  });
  const as = authed(ctx.app, (login.json() as { token: string }).token);
  if (created.mustChangePassword) {
    const changed = await as({
      method: "POST",
      url: "/api/me/password",
      payload: { currentPassword: "first password", newPassword: `${username} new password` },
    });
    expect(changed.statusCode).toBe(200);
  }
  return [created.id, as];
}

const put = (as: ReturnType<typeof authed>, name: string, body: Buffer) =>
  as({
    method: "PUT",
    url: `/api/uploads/${encodeURIComponent(name)}`,
    headers: { "content-type": "audio/wav" },
    payload: body,
  });

const titles = async (as: ReturnType<typeof authed>) =>
  TrackPage.parse((await as("/api/tracks?limit=500")).json()).items.map((t) => t.title);

let secret: Track;

test("an upload is filed by its tags and seen by its owner", async () => {
  const info = UploadInfo.parse((await alice("/api/uploads")).json());
  expect(info).toMatchObject({ enabled: true, maxFileBytes: MAX_FILE, quotaBytes: QUOTA, usedBytes: 0 });

  const res = await put(
    alice,
    "my song.wav",
    wav({ INAM: "Secret Song", IART: "Alice Band", IPRD: "Hidden", ITRK: "3" }),
  );
  expect(res.statusCode).toBe(200);
  secret = Track.parse(res.json());
  expect(secret).toMatchObject({ title: "Secret Song", artistName: "Alice Band", albumTitle: "Hidden" });
  expect(existsSync(join(uploadDir, aliceId, "Alice Band", "Hidden", "03 - Secret Song.wav"))).toBe(true);

  expect(await titles(alice)).toContain("Secret Song");
  const artists = ArtistPage.parse((await alice("/api/artists")).json()).items.map((a) => a.name);
  expect(artists).toContain("Alice Band");
  expect((await alice(`/api/albums/${secret.albumId}`)).statusCode).toBe(200);
  const found = SearchResults.parse((await alice("/api/search?q=secret")).json());
  expect(found.tracks.map((t) => t.id)).toEqual([secret.id]);
  const mine = TrackPage.parse((await alice("/api/uploads/tracks")).json());
  expect(mine.items.map((t) => t.id)).toEqual([secret.id]);
  expect(UploadInfo.parse((await alice("/api/uploads")).json()).usedBytes).toBeGreaterThan(0);
});

test("nobody else sees it, anywhere", async () => {
  expect(await titles(bob)).toEqual(["Song"]);
  const artists = ArtistPage.parse((await bob("/api/artists")).json());
  expect(artists.items.map((a) => a.name)).toEqual(["Band"]);
  expect(artists.total).toBe(1);
  const albums = AlbumPage.parse((await bob("/api/albums")).json());
  expect(albums.items.map((a) => a.title)).toEqual(["Album"]);
  expect(albums.total).toBe(1);
  for (const url of [
    `/api/albums/${secret.albumId}`,
    `/api/artists/${secret.artistId}`,
    `/api/tracks/${secret.id}/waveform`,
    `/api/tracks/${secret.id}/now-playing`,
    `/api/stream/${secret.id}`,
  ]) {
    expect((await bob(url)).statusCode, url).toBe(404);
  }
  const found = SearchResults.parse((await bob("/api/search?q=secret")).json());
  expect(found.tracks).toHaveLength(0);
  expect(SearchResults.parse((await bob("/api/search?q=alice")).json()).artists).toHaveLength(0);
  expect(TrackPage.parse((await bob("/api/uploads/tracks")).json()).items).toHaveLength(0);
  const sync = SyncPage.parse((await bob("/api/sync")).json());
  expect(sync.tracks.map((t) => t.title)).toEqual(["Song"]);
  // Playing it by id, or deleting it, doesn't work either.
  const queue = await bob({
    method: "PUT",
    url: "/api/queue",
    payload: { source: { kind: "tracks", trackIds: [secret.id] } },
  });
  expect(queue.json()).not.toMatchObject({ entries: [{ track: { id: secret.id } }] });
  expect((await bob({ method: "DELETE", url: `/api/uploads/${secret.id}` })).statusCode).toBe(404);
});

test("an upload never hides the shared copy, and two people's uploads never hide each other", async () => {
  const shared = wav({ INAM: "Song", IART: "Band", IPRD: "Album", ITRK: "1" });
  expect((await put(alice, "song.wav", shared)).statusCode).toBe(200);
  // Bob still has the shared one; Alice sees one copy (the shared one, the same track).
  expect(await titles(bob)).toEqual(["Song"]);
  expect((await titles(alice)).filter((t) => t === "Song")).toHaveLength(1);

  const twin = wav({ INAM: "Twin", IART: "Duo", IPRD: "Pair", ITRK: "1" });
  expect((await put(alice, "twin.wav", twin)).statusCode).toBe(200);
  expect((await put(bob, "twin.wav", twin)).statusCode).toBe(200);
  expect(await titles(alice)).toContain("Twin");
  expect(await titles(bob)).toContain("Twin");
});

test("limits: audio files only, of a size, within the quota", async () => {
  expect((await put(bob, "notes.txt", Buffer.from("hello"))).statusCode).toBe(415);
  const big = wav({ INAM: "Big", IART: "Bob" }, 13); // ~208 kB > 200 kB
  const tooBig = await put(bob, "big.wav", big);
  expect(tooBig.statusCode).toBe(413);
  expect(tooBig.json()).toMatchObject({ error: "too_large" });
  // 160 kB each: the second would go over the 300 kB quota.
  const used = UploadInfo.parse((await bob("/api/uploads")).json()).usedBytes;
  expect((await put(bob, "a.wav", wav({ INAM: "A", IART: "Bob" }, 10))).statusCode).toBe(200);
  const over = await put(bob, "b.wav", wav({ INAM: "B", IART: "Bob" }, 10));
  expect(over.statusCode).toBe(413);
  expect(over.json()).toMatchObject({ error: "quota_exceeded" });
  expect(UploadInfo.parse((await bob("/api/uploads")).json()).usedBytes).toBeGreaterThan(used);
  // Nothing half-written is left behind.
  expect(readdirSync(join(uploadDir, bobId, ".incoming"))).toEqual([]);
});

test("a file in the uploads folder outside a user's own folder never becomes shared music", async () => {
  writeFileSync(join(uploadDir, "stray.wav"), wav({ INAM: "Stray", IART: "Nobody" }));
  mkdirSync(join(uploadDir, "not-a-user"), { recursive: true });
  writeFileSync(join(uploadDir, "not-a-user", "x.wav"), wav({ INAM: "Orphan", IART: "Nobody" }));
  await ctx.startScan();
  for (const as of [alice, bob, admin]) {
    const all = await titles(as);
    expect(all).not.toContain("Stray");
    expect(all).not.toContain("Orphan");
  }
});

test("owners delete their uploads; deleting a user deletes theirs", async () => {
  const del = await alice({ method: "DELETE", url: `/api/uploads/${secret.id}` });
  expect(del.statusCode).toBe(200);
  expect(await titles(alice)).not.toContain("Secret Song");
  expect(existsSync(join(uploadDir, aliceId, "Alice Band"))).toBe(false);

  expect(existsSync(join(uploadDir, bobId))).toBe(true);
  expect((await admin({ method: "DELETE", url: `/api/users/${bobId}` })).statusCode).toBe(200);
  expect(existsSync(join(uploadDir, bobId))).toBe(false);
  // Alice's copy of the twin is hers alone, and still there.
  expect(await titles(alice)).toContain("Twin");
  // A rescan doesn't bring anything back.
  await ctx.startScan();
  expect(await titles(alice)).toContain("Twin");
  expect(await titles(admin)).not.toContain("Twin");
});
