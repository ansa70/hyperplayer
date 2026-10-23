import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, type Endpoint } from "@hyperplayer/schemas";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-auth-"));
  const lib = join(dir, "music");
  mkdirSync(join(lib, "Band", "Album"), { recursive: true });
  writeFileSync(
    join(lib, "Band", "Album", "1.wav"),
    wav({ INAM: "One", IART: "Band", IPRD: "Album", ITRK: "1" }),
  );
  ctx = await buildApp(testConfig(lib, join(dir, "data")), { logger: false });
  await ctx.startScan();
});

afterEach(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: "POST", url, payload, headers });

const login = (username: string, password: string, extra: object = {}) =>
  post("/api/auth/login", { username, password, deviceName: "test", ...extra });

test("every non-public endpoint rejects anonymous callers", async () => {
  await setupAdmin(ctx.app);
  for (const [name, e] of Object.entries(api) as [string, Endpoint][]) {
    if (e.access === "public") continue;
    const url = e.path.replace(/\{\w+\}/g, "x0000000000000000");
    const res = await ctx.app.inject({ method: e.method, url, payload: e.method === "GET" ? undefined : {} });
    expect(res.statusCode, `${name} ${e.method} ${url}`).toBe(401);
  }
});

test("the default admin can only replace its password until it does", async () => {
  expect((await ctx.app.inject("/api/auth/status")).json()).toMatchObject({ defaultAdmin: true });
  const res = await login("admin", "hyperplayer");
  expect(res.statusCode, res.body).toBe(200);
  const session = res.json() as { token: string; user: { admin: boolean; mustChangePassword: boolean } };
  expect(session.user).toMatchObject({ admin: true, mustChangePassword: true });
  const inject = authed(ctx.app, session.token);

  // Nothing but the session endpoints is reachable yet.
  for (const url of ["/api/search?q=one", "/api/playlists", "/api/queue", "/api/users"]) {
    const r = await inject(url);
    expect(r.statusCode, url).toBe(403);
    expect(r.json()).toMatchObject({ error: "password_change_required" });
  }
  expect((await inject("/api/me")).statusCode).toBe(200);

  const change = (newPassword: string) =>
    inject({
      method: "POST",
      url: "/api/me/password",
      payload: { currentPassword: "hyperplayer", newPassword },
    });
  expect((await change("hyperplayer")).statusCode).toBe(400); // must actually change
  expect((await change("my own password")).statusCode).toBe(200);

  expect((await inject("/api/search?q=one")).statusCode).toBe(200);
  expect((await inject("/api/me")).json()).toMatchObject({ user: { mustChangePassword: false } });
  expect((await ctx.app.inject("/api/auth/status")).json()).toMatchObject({ defaultAdmin: false });
  expect((await login("admin", "hyperplayer")).statusCode).toBe(401);
  expect((await login("admin", "my own password")).statusCode).toBe(200);
});

test("tokens are stored only as hashes", async () => {
  const token = await setupAdmin(ctx.app);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "data", "library.db"), { readOnly: true });
  const rows = JSON.stringify(db.prepare("SELECT * FROM devices").all());
  db.close();
  expect(rows).not.toContain(token);
  expect(rows).not.toContain(token.slice(3));
});

test("sign in, use the token, sign out", async () => {
  await setupAdmin(ctx.app);
  expect((await login("admin", "wrong password")).statusCode).toBe(401);
  expect((await login("nobody", "whatever1")).statusCode).toBe(401);

  const res = await login("ADMIN", "correct horse"); // usernames are case-insensitive
  expect(res.statusCode).toBe(200);
  const inject = authed(ctx.app, (res.json() as { token: string }).token);
  expect((await inject("/api/me")).json()).toMatchObject({
    user: { username: "admin" },
    device: { current: true },
  });
  expect((await inject("/api/me/devices")).json()).toHaveLength(2);

  expect((await inject({ method: "POST", url: "/api/auth/logout" })).statusCode).toBe(200);
  expect((await inject("/api/me")).statusCode).toBe(401);
});

test("repeated failed sign-ins are throttled", async () => {
  await setupAdmin(ctx.app);
  for (let i = 0; i < 5; i++) expect((await login("admin", `wrong ${i}`)).statusCode).toBe(401);
  // Even the right password is refused while locked out.
  const res = await login("admin", "correct horse");
  expect(res.statusCode).toBe(429);
  expect(res.json()).toMatchObject({ error: "too_many_attempts" });
});

test("users only see their own playlists and devices; admin endpoints need an admin", async () => {
  const admin = authed(ctx.app, await setupAdmin(ctx.app));
  const created = await admin({
    method: "POST",
    url: "/api/users",
    payload: { username: "guest", password: "guest password" },
  });
  expect(created.statusCode, created.body).toBe(200);
  const playlist = (
    await admin({ method: "POST", url: "/api/playlists", payload: { name: "Mine" } })
  ).json() as {
    id: string;
  };

  const guestSession = (await login("guest", "guest password", { deviceId: "test-device-1" })).json() as {
    token: string;
    device: { id: string };
  };
  // The admin's device id is taken: the guest gets its own, and with it its own queue.
  expect(guestSession.device.id).not.toBe("test-device-1");
  const guest = authed(ctx.app, guestSession.token);

  expect((await guest("/api/playlists")).json()).toEqual([]);
  expect((await guest(`/api/playlists/${playlist.id}`)).statusCode).toBe(404);
  const play = await guest({
    method: "PUT",
    url: "/api/queue",
    payload: { source: { kind: "playlist", id: playlist.id } },
  });
  expect(play.statusCode).toBe(404);
  expect((await guest("/api/users")).statusCode).toBe(403);
  expect((await guest({ method: "POST", url: "/api/library/scan" })).statusCode).toBe(403);
  expect((await guest({ method: "DELETE", url: "/api/me/devices/test-device-1" })).statusCode).toBe(404);
});

test("changing the password signs out every other device", async () => {
  const first = authed(ctx.app, await setupAdmin(ctx.app));
  const second = authed(ctx.app, ((await login("admin", "correct horse")).json() as { token: string }).token);
  const res = await second({
    method: "POST",
    url: "/api/me/password",
    payload: { currentPassword: "correct horse", newPassword: "battery staple" },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect((await first("/api/me")).statusCode).toBe(401);
  expect((await second("/api/me")).statusCode).toBe(200);
  expect((await login("admin", "battery staple")).statusCode).toBe(200);
});

test("browser sessions: HttpOnly cookie, and cross-origin writes are refused", async () => {
  await setupAdmin(ctx.app);
  const res = await login("admin", "correct horse", { cookie: true });
  const setCookie = String(res.headers["set-cookie"]);
  expect(setCookie).toMatch(/^hp_session=hp_[\w-]+; Path=\/; HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(";")[0]!;
  const host = "player.example";

  // Reads work with the cookie alone.
  expect((await ctx.app.inject({ url: "/api/me", headers: { cookie, host } })).statusCode).toBe(200);
  // Writes need a same-origin Origin header.
  const write = (origin?: string) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/playlists",
      payload: { name: "x" },
      headers: { cookie, host, ...(origin ? { origin } : {}) },
    });
  expect((await write()).statusCode).toBe(403);
  expect((await write("https://evil.example")).statusCode).toBe(403);
  expect((await write(`https://${host}`)).statusCode).toBe(200);
});

test("playlists made before accounts existed are adopted by the first admin", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "data", "library.db"));
  db.prepare(
    "INSERT INTO playlists (id, name, created_at, updated_at) VALUES ('old', 'From before', ?, ?)",
  ).run(new Date().toISOString(), new Date().toISOString());
  db.close();
  // Adoption happens at startup.
  await ctx.app.close();
  ctx = await buildApp(testConfig(join(dir, "music"), join(dir, "data")), { logger: false });
  const admin = authed(ctx.app, await setupAdmin(ctx.app));
  expect(((await admin("/api/playlists")).json() as { name: string }[]).map((p) => p.name)).toEqual([
    "From before",
  ]);
});

test("first-run onboarding hands the device, its queue and the playlists to the new user", async () => {
  const adminToken = await setupAdmin(ctx.app);
  const admin = authed(ctx.app, adminToken);
  // Things done while signed in as admin, before the everyday user exists.
  await admin({ method: "POST", url: "/api/playlists", payload: { name: "Early favourites" } });
  const album = ((await admin("/api/albums")).json() as { items: { id: string }[] }).items[0]!.id;
  await admin({ method: "PUT", url: "/api/queue", payload: { source: { kind: "album", id: album } } });

  const res = await admin({
    method: "POST",
    url: "/api/auth/onboard",
    payload: { fullName: "Enrico", username: "enrico", password: "listening!" },
  });
  expect(res.statusCode, res.body).toBe(200);
  const session = res.json() as { token: string; user: object; device: { id: string } };
  expect(session.user).toMatchObject({ username: "enrico", fullName: "Enrico", admin: false });
  expect(session.device.id).toBe("test-device-1"); // same device, so its queue carries over

  const me = authed(ctx.app, session.token);
  expect(((await me("/api/playlists")).json() as { name: string }[]).map((p) => p.name)).toEqual([
    "Early favourites",
  ]);
  expect(((await me("/api/queue")).json() as { entries: unknown[] }).entries).toHaveLength(1);
  // The admin's token on this device is gone; the admin account itself remains.
  expect((await admin("/api/me")).statusCode).toBe(401);
  expect((await login("admin", "correct horse")).statusCode).toBe(200);

  // Only once.
  const again = await authed(
    ctx.app,
    ((await login("admin", "correct horse")).json() as { token: string }).token,
  )({
    method: "POST",
    url: "/api/auth/onboard",
    payload: { username: "someone", password: "password!" },
  });
  expect(again.statusCode).toBe(409);
});

test("preferences are per user and fill in defaults", async () => {
  const admin = authed(ctx.app, await setupAdmin(ctx.app));
  expect((await admin("/api/me/preferences")).json()).toEqual({ quality: "auto" });
  const res = await admin({
    method: "PATCH",
    url: "/api/me/preferences",
    payload: { quality: "data-saver" },
  });
  expect(res.json()).toEqual({ quality: "data-saver" });
  expect((await admin("/api/me/preferences")).json()).toEqual({ quality: "data-saver" });

  await admin({
    method: "POST",
    url: "/api/users",
    payload: { username: "guest", password: "guest password" },
  });
  const guest = authed(ctx.app, ((await login("guest", "guest password")).json() as { token: string }).token);
  expect((await guest("/api/me/preferences")).json()).toEqual({ quality: "auto" });
  expect(
    (await guest({ method: "PATCH", url: "/api/me/preferences", payload: { quality: "loud" } })).statusCode,
  ).toBe(400);
});
