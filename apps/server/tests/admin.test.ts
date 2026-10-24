import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStatus, Me, PlaylistList, User, UserList } from "@hyperplayer/schemas";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

let dir: string;
let lib: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let admin: ReturnType<typeof authed>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-admin-"));
  lib = join(dir, "music");
  mkdirSync(join(lib, "Band"), { recursive: true });
  writeFileSync(join(lib, "Band", "1.wav"), wav({ INAM: "Song", IART: "Band", IPRD: "Album" }));
  ctx = await buildApp(
    { ...testConfig(lib, join(dir, "data")), libraryPaths: [lib, join(dir, "unmounted")] },
    { logger: false },
  );
  await ctx.startScan();
  admin = authed(ctx.app, await setupAdmin(ctx.app));
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function signIn(username: string, password: string) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password, deviceName: "tests" },
  });
  return { status: res.statusCode, as: authed(ctx.app, (res.json() as { token?: string }).token ?? "") };
}

async function createUser(username: string, extra: object = {}) {
  const res = await admin({
    method: "POST",
    url: "/api/users",
    payload: { username, password: "first password", ...extra },
  });
  expect(res.statusCode).toBe(200);
  return User.parse(res.json());
}

test("users edit their own name; only admins manage others", async () => {
  const bob = await createUser("bob");
  const { as: asBob } = await signIn("bob", "first password");
  const me = await asBob({ method: "PATCH", url: "/api/me", payload: { fullName: "  Bob Jones " } });
  expect(User.parse(me.json()).fullName).toBe("Bob Jones");
  expect(
    (await asBob({ method: "PATCH", url: `/api/users/${bob.id}`, payload: { admin: true } })).statusCode,
  ).toBe(403);
  expect((await asBob({ method: "DELETE", url: `/api/users/${bob.id}` })).statusCode).toBe(403);
  expect((await asBob("/api/users")).statusCode).toBe(403);
});

test("a temporary password signs the user out and must be replaced at sign-in", async () => {
  const carol = await createUser("carol");
  const { as: before } = await signIn("carol", "first password");
  const res = await admin({
    method: "PATCH",
    url: `/api/users/${carol.id}`,
    payload: { password: "temporary pass" },
  });
  expect(User.parse(res.json()).mustChangePassword).toBe(true);
  expect((await before("/api/me")).statusCode).toBe(401);

  expect((await signIn("carol", "first password")).status).toBe(401);
  const { as: temp } = await signIn("carol", "temporary pass");
  expect((await temp("/api/playlists")).statusCode).toBe(403); // only the password change is allowed
  const changed = await temp({
    method: "POST",
    url: "/api/me/password",
    payload: { currentPassword: "temporary pass", newPassword: "carol's own" },
  });
  expect(changed.statusCode).toBe(200);
  expect((await temp("/api/playlists")).statusCode).toBe(200);

  // Admins change their own password the usual way.
  const me = Me.parse((await admin("/api/me")).json()).user;
  const own = await admin({
    method: "PATCH",
    url: `/api/users/${me.id}`,
    payload: { password: "something new" },
  });
  expect(own.statusCode).toBe(400);
});

test("the server always keeps an admin, and nobody deletes themselves", async () => {
  const me = Me.parse((await admin("/api/me")).json()).user;
  expect(
    (await admin({ method: "PATCH", url: `/api/users/${me.id}`, payload: { admin: false } })).statusCode,
  ).toBe(409);
  expect((await admin({ method: "DELETE", url: `/api/users/${me.id}` })).statusCode).toBe(409);

  const dave = await createUser("dave", { admin: true });
  // With another admin around, stepping down is fine.
  expect(
    (await admin({ method: "PATCH", url: `/api/users/${me.id}`, payload: { admin: false } })).statusCode,
  ).toBe(200);
  const { as: asDave } = await signIn("dave", "first password");
  expect(
    (await asDave({ method: "PATCH", url: `/api/users/${me.id}`, payload: { admin: true } })).statusCode,
  ).toBe(200);
  expect(Me.parse((await admin("/api/me")).json()).user.admin).toBe(true);
  expect(dave.admin).toBe(true);
});

test("deleting a user removes their sessions and what they own", async () => {
  const erin = await createUser("erin");
  const { as: asErin } = await signIn("erin", "first password");
  await asErin({ method: "POST", url: "/api/playlists", payload: { name: "Erin's", trackIds: [] } });
  expect(PlaylistList.parse((await asErin("/api/playlists")).json())).toHaveLength(1);

  expect((await admin({ method: "DELETE", url: `/api/users/${erin.id}` })).statusCode).toBe(200);
  expect((await asErin("/api/me")).statusCode).toBe(401);
  expect((await signIn("erin", "first password")).status).toBe(401);
  expect(UserList.parse((await admin("/api/users")).json()).map((u) => u.username)).not.toContain("erin");
  expect((await admin({ method: "DELETE", url: `/api/users/${erin.id}` })).statusCode).toBe(404);
});

test("admins see the library's folders; others don't", async () => {
  const status = LibraryStatus.parse((await admin("/api/library/status")).json());
  expect(status.folders).toEqual([
    { path: lib, available: true, tracks: 1 },
    { path: join(dir, "unmounted"), available: false, tracks: 0 },
  ]);
  await createUser("frank");
  const { as: asFrank } = await signIn("frank", "first password");
  expect(LibraryStatus.parse((await asFrank("/api/library/status")).json()).folders).toEqual([]);
});
