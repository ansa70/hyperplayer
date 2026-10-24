import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrackPage } from "@hyperplayer/schemas";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { ArtworkStore } from "../src/library/artwork.ts";
import { Scanner } from "../src/library/scanner.ts";
import { ADMIN_PASSWORD, authed, setupAdmin, testConfig, wav } from "./helpers.ts";

let dir: string;
let apps: Awaited<ReturnType<typeof buildApp>>[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-library-"));
});

afterEach(async () => {
  for (const a of apps) await a.app.close();
  apps = [];
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `title` as a track by `artist` under `root`. */
function add(root: string, artist: string, title: string) {
  mkdirSync(join(root, artist), { recursive: true });
  writeFileSync(
    join(root, artist, `${title}.wav`),
    wav({ INAM: title, IART: artist, IPRD: `${artist} Album` }),
  );
}

async function start(roots: string[], overrides: Partial<Config> = {}, { claimed = false } = {}) {
  const ctx = await buildApp(
    { ...testConfig(roots[0]!, join(dir, "data"), overrides), libraryPaths: roots },
    { logger: false },
  );
  apps.push(ctx);
  // A restart on the same data: the admin account was claimed the first time.
  const token = claimed
    ? (
        (
          await ctx.app.inject({
            method: "POST",
            url: "/api/auth/login",
            payload: { username: "admin", password: ADMIN_PASSWORD, deviceName: "tests" },
          })
        ).json() as { token: string }
      ).token
    : await setupAdmin(ctx.app);
  const inject = authed(ctx.app, token);
  const titles = async () =>
    TrackPage.parse((await inject("/api/tracks")).json())
      .items.map((t) => t.title)
      .sort();
  return { ...ctx, titles };
}

test("several folders make one library; a folder that goes missing keeps its tracks", async () => {
  const [local, share] = [join(dir, "local"), join(dir, "share")];
  add(local, "Band", "Local One");
  add(share, "Other", "Shared One");
  add(share, "Other", "Shared Two");
  const ctx = await start([local, share]);
  await ctx.startScan();
  expect(await ctx.titles()).toEqual(["Local One", "Shared One", "Shared Two"]);

  // The share is unmounted while the local folder changes: local changes apply, shared tracks stay.
  renameSync(share, `${share}-away`);
  add(local, "Band", "Local Two");
  await ctx.startScan();
  expect(await ctx.titles()).toEqual(["Local One", "Local Two", "Shared One", "Shared Two"]);
  // A mount point without its share reads as empty: the same.
  mkdirSync(share);
  await ctx.startScan();
  expect(await ctx.titles()).toEqual(["Local One", "Local Two", "Shared One", "Shared Two"]);

  // Back again, minus a track deleted meanwhile.
  rmSync(share, { recursive: true });
  renameSync(`${share}-away`, share);
  rmSync(join(share, "Other", "Shared Two.wav"));
  await ctx.startScan();
  expect(await ctx.titles()).toEqual(["Local One", "Local Two", "Shared One"]);
});

test("a folder dropped from the configuration takes its tracks with it", async () => {
  const [a, b] = [join(dir, "a"), join(dir, "b")];
  add(a, "Band", "From A");
  add(b, "Band", "From B");
  const first = await start([a, b]);
  await first.startScan();
  await first.app.close();
  apps = [];

  const second = await start([a], {}, { claimed: true });
  await second.startScan();
  expect(await second.titles()).toEqual(["From A"]);
});

test("a scan reports its progress: listing the files, then reading them", async () => {
  const root = join(dir, "music");
  for (const title of ["A", "B", "C", "D", "E"]) add(root, "Band", title);
  const db = openDb(join(dir, "library.db"));
  const scanner = new Scanner(db, new ArtworkStore(db, dir), { settleMs: 0 });
  expect(scanner.progress).toBeNull();
  const scan = scanner.scan([root]);
  let finished = false;
  void scan.then(() => (finished = true));
  const seen = [scanner.progress!];
  while (!finished) {
    await new Promise((r) => setImmediate(r));
    if (scanner.progress) seen.push(scanner.progress);
  }
  await scan;
  expect(seen[0]).toEqual({ phase: "listing", done: 0, total: 0 });
  const reading = seen.filter((p) => p.phase === "reading");
  expect(reading.length).toBeGreaterThan(0);
  expect(reading.every((p) => p.total === 5 && p.done <= 5)).toBe(true);
  expect(reading.map((p) => p.done)).toEqual(reading.map((p) => p.done).sort((a, b) => a - b));
  expect(scanner.progress).toBeNull();
});

test("a cancelled scan keeps what it read and removes nothing", async () => {
  const root = join(dir, "music");
  for (const title of ["A", "B", "C", "D", "E"]) add(root, "Band", title);
  const db = openDb(join(dir, "library.db"));
  const scanner = new Scanner(db, new ArtworkStore(db, dir), { settleMs: 0 });
  const tracks = () => (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n;

  // Stopped partway through a first scan: the tracks read so far are in.
  const scan = scanner.scan([root]);
  while ((scanner.progress?.done ?? 5) < 2) await new Promise((r) => setImmediate(r));
  scanner.cancel();
  const stopped = await scan;
  expect(stopped).toMatchObject({ cancelled: true, removed: 0 });
  expect(stopped.updated).toBeLessThan(5);
  expect(tracks()).toBe(stopped.updated);

  // The next scan finishes the job.
  expect(await scanner.scan([root])).toMatchObject({ cancelled: false });
  expect(tracks()).toBe(5);

  // Stopped before it saw anything: nothing goes, although nothing was seen.
  const again = scanner.scan([root]);
  scanner.cancel();
  expect(await again).toMatchObject({ cancelled: true, removed: 0 });
  expect(tracks()).toBe(5);
  scanner.cancel(); // with no scan running: nothing to stop, and the next scan isn't affected
  expect(await scanner.scan([root])).toMatchObject({ cancelled: false, removed: 0 });
});

test("files still being written are left for the next scan", async () => {
  const root = join(dir, "music");
  add(root, "Band", "Old");
  const db = openDb(join(dir, "library.db"));
  const scanner = new Scanner(db, new ArtworkStore(db, dir), { settleMs: 60_000 });
  // Just written: not read yet, and nothing breaks.
  expect(await scanner.scan([root])).toMatchObject({ updated: 0, unsettled: 1 });
  // Once it's been left alone for a while, it's read.
  const minuteAgo = new Date(Date.now() - 60_000);
  utimesSync(join(root, "Band", "Old.wav"), minuteAgo, minuteAgo);
  expect(await scanner.scan([root])).toMatchObject({ updated: 1, unsettled: 0 });
  // Rewritten (e.g. retagged): the old version stays until the new one settles.
  add(root, "Band", "Old");
  expect(await scanner.scan([root])).toMatchObject({ removed: 0, unsettled: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM tracks").get()).toMatchObject({ n: 1 });
  // From a share whose clock is well ahead of ours: read now rather than in ten minutes.
  add(root, "Band", "Ahead");
  const later = new Date(Date.now() + 10 * 60_000);
  utimesSync(join(root, "Band", "Ahead.wav"), later, later);
  expect(await scanner.scan([root])).toMatchObject({ updated: 1, unsettled: 1 });
  db.close();
});

test("changes on a watched folder show up without a rescan request", async () => {
  const root = join(dir, "music");
  add(root, "Band", "First");
  const ctx = await start([root], { watch: true, watchDebounceMs: 100 });
  await ctx.startScan();
  const poll = (titles: string[]) =>
    expect.poll(() => ctx.titles(), { timeout: 5000, interval: 100 }).toEqual(titles);
  add(root, "Band", "Second");
  await poll(["First", "Second"]);
  // A new folder is noticed, and then watched itself.
  add(root, "New Band", "Third");
  await poll(["First", "Second", "Third"]);
  add(root, "New Band", "Fourth");
  await poll(["First", "Fourth", "Second", "Third"]);
  rmSync(join(root, "Band"), { recursive: true });
  await poll(["Fourth", "Third"]);
});

test("a scan requested during a scan runs again afterwards", async () => {
  const root = join(dir, "music");
  add(root, "Band", "First");
  const ctx = await start([root]);
  const running = ctx.startScan();
  // Too late for the running scan, which may already have listed the folder.
  add(root, "Band", "Second");
  const queued = ctx.startScan();
  expect(ctx.startScan()).toBe(queued); // further requests join the queued one
  await running;
  await queued;
  expect(await ctx.titles()).toEqual(["First", "Second"]);
});
