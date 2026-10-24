import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStatus } from "@hyperplayer/schemas";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

let dir: string;
let first: string;
let second: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let token: string;
let admin: ReturnType<typeof authed>;

/** A folder with one album of one track. */
function folder(name: string, album: string) {
  const path = join(dir, name);
  mkdirSync(join(path, "Band"), { recursive: true });
  writeFileSync(join(path, "Band", "1.wav"), wav({ INAM: "Song", IART: "Band", IPRD: album }));
  return path;
}

async function start(environment: string[]) {
  ctx = await buildApp(
    { ...testConfig(environment[0]!, join(dir, "data")), libraryPaths: environment },
    { logger: false },
  );
  await ctx.startScan();
  token ??= await setupAdmin(ctx.app);
  admin = authed(ctx.app, token);
}

const setFolders = (paths: string[]) =>
  admin({ method: "PUT", url: "/api/library/folders", payload: { paths } });
const folderPaths = async () =>
  LibraryStatus.parse((await admin("/api/library/status")).json()).folders.map((f) => f.path);
const albumTitles = async () =>
  ((await admin("/api/albums")).json() as { items: { title: string }[] }).items.map((a) => a.title);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-folders-"));
  first = folder("first", "First Album");
  second = folder("second", "Second Album");
  token = undefined as unknown as string;
  await start([first]);
});

afterEach(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("an admin replaces the music folders, and the library follows", async () => {
  expect(await albumTitles()).toEqual(["First Album"]);
  const res = await setFolders([second, ` ${first} `, second]);
  expect(res.statusCode).toBe(200);
  expect(LibraryStatus.parse(res.json()).folders.map((f) => f.path)).toEqual([second, first]);
  await ctx.startScan(); // joins the scan the change started
  expect((await albumTitles()).sort()).toEqual(["First Album", "Second Album"]);

  await setFolders([second]);
  await ctx.startScan();
  expect(await albumTitles()).toEqual(["Second Album"]);
});

test("folders that don't exist, or aren't full paths, are refused and change nothing", async () => {
  const missing = await setFolders([second, join(dir, "typo")]);
  expect(missing.statusCode).toBe(400);
  expect(missing.json()).toMatchObject({ error: "folder_not_found" });
  expect((await setFolders(["music"])).json()).toMatchObject({ error: "relative_folder" });
  expect((await setFolders([])).statusCode).toBe(400);
  expect(await folderPaths()).toEqual([first]);
  expect(await albumTitles()).toEqual(["First Album"]);
});

test("only admins change the folders or stop a scan", async () => {
  const created = await admin({
    method: "POST",
    url: "/api/users",
    payload: { username: "listener", password: "a password" },
  });
  expect(created.statusCode).toBe(200);
  const login = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "listener", password: "a password", deviceName: "tests" },
  });
  const listener = authed(ctx.app, (login.json() as { token: string }).token);
  const res = await listener({ method: "PUT", url: "/api/library/folders", payload: { paths: [second] } });
  expect(res.statusCode).toBe(403);
  expect((await listener({ method: "POST", url: "/api/library/scan/cancel" })).statusCode).toBe(403);
  // With nothing running, a cancel does nothing harmful.
  const cancel = await admin({ method: "POST", url: "/api/library/scan/cancel" });
  expect(cancel.statusCode).toBe(200);
  expect(LibraryStatus.parse(cancel.json()).scanProgress).toBeNull();
});

test("a change survives restarts, until HP_LIBRARY itself changes", async () => {
  await setFolders([second]);
  await ctx.app.close();
  await start([first]); // same HP_LIBRARY: the admin's choice stands
  expect(await folderPaths()).toEqual([second]);

  await ctx.app.close();
  const third = folder("third", "Third Album");
  await start([third]); // HP_LIBRARY changed (e.g. by the installer): it wins
  expect(await folderPaths()).toEqual([third]);
});
