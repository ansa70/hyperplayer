import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScrobbleSettings, TrackPage } from "@hyperplayer/schemas";
import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

/** A stand-in for api.listenbrainz.org. */
const lb = {
  mode: "ok" as "ok" | "down" | "rejecting",
  submitted: [] as { auth: string; body: { listen_type: string; payload: Record<string, unknown>[] } }[],
  async fetch(url: string, init: RequestInit): Promise<Response> {
    const auth = new Headers(init.headers).get("Authorization") ?? "";
    if (url.endsWith("/1/validate-token")) {
      const valid = auth === "Token good-token";
      return Response.json(valid ? { valid, user_name: "listener" } : { valid }, {
        status: valid ? 200 : 400,
      });
    }
    if (url.endsWith("/1/submit-listens")) {
      if (lb.mode === "down") return Response.json({ error: "maintenance" }, { status: 503 });
      if (lb.mode === "rejecting") return Response.json({ error: "invalid token" }, { status: 401 });
      lb.submitted.push({ auth, body: JSON.parse(init.body as string) as never });
      return Response.json({ status: "ok" });
    }
    return new Response(null, { status: 404 });
  },
};

let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let inject: ReturnType<typeof authed>;
let trackId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-scrobbling-"));
  const lib = join(dir, "music", "Band");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "1.wav"), wav({ INAM: "Song", IART: "Band", IPRD: "Record", ITRK: "3" }, 60, 1000));
  ctx = await buildApp(testConfig(join(dir, "music"), join(dir, "data")), {
    logger: false,
    fetch: (url, init) => lb.fetch(url, init),
  });
  await ctx.startScan();
  inject = authed(ctx.app, await setupAdmin(ctx.app));
  trackId = TrackPage.parse((await inject("/api/tracks")).json()).items[0]!.id;
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  lb.mode = "ok";
  lb.submitted = [];
});

let minute = 0;
/** Records a new listen (each a minute after the previous one). */
async function listen(startedAt = new Date(Date.UTC(2026, 9, 1, 12, minute++)).toISOString()) {
  const res = await inject({
    method: "POST",
    url: "/api/history",
    payload: { trackId, startedAt, playedMs: 40_000 },
  });
  expect(res.statusCode).toBe(200);
  await ctx.scrobbler.idle();
  return startedAt;
}
const status = async () => ScrobbleSettings.parse((await inject("/api/me/scrobbling")).json()).listenbrainz;
const connect = (token: string) =>
  inject({ method: "PUT", url: "/api/me/scrobbling/listenbrainz", payload: { token } });

test("only a token ListenBrainz accepts connects, and it's never given back", async () => {
  await listen(); // before connecting: never sent
  expect((await connect("bad-token")).statusCode).toBe(400);
  expect(await status()).toMatchObject({ connected: false });
  const res = await connect("good-token");
  expect(res.statusCode).toBe(200);
  expect(res.body).not.toContain("good-token");
  expect(await status()).toEqual({
    available: true,
    connected: true,
    username: "listener",
    pending: 0,
    lastError: null,
    lastSubmittedAt: null,
  });
  await ctx.scrobbler.idle();
  expect(lb.submitted).toEqual([]);
});

test("new listens are sent once, with their metadata", async () => {
  const startedAt = await listen();
  expect(lb.submitted).toHaveLength(1);
  const { auth, body } = lb.submitted[0]!;
  expect(auth).toBe("Token good-token");
  expect(body).toEqual({
    listen_type: "single",
    payload: [
      {
        listened_at: Date.parse(startedAt) / 1000,
        track_metadata: {
          artist_name: "Band",
          track_name: "Song",
          release_name: "Record",
          additional_info: {
            duration_ms: 60_000,
            tracknumber: 3,
            media_player: "HyperPlayer",
            submission_client: "HyperPlayer",
            submission_client_version: expect.any(String),
          },
        },
      },
    ],
  });
  // The client reporting the same listen again doesn't scrobble it twice.
  await listen(startedAt);
  expect(lb.submitted).toHaveLength(1);
  expect((await status()).lastSubmittedAt).not.toBeNull();
});

test("listens wait while ListenBrainz is down, then go together", async () => {
  lb.mode = "down";
  await listen();
  await listen();
  expect(await status()).toMatchObject({ pending: 2, lastError: "ListenBrainz answered 503: maintenance" });
  lb.mode = "ok";
  ctx.scrobbler.retryNow();
  await ctx.scrobbler.idle();
  expect(lb.submitted.map((s) => [s.body.listen_type, s.body.payload.length])).toEqual([["import", 2]]);
  expect(await status()).toMatchObject({ pending: 0, lastError: null });
});

test("a rejected token pauses the queue until reconnecting", async () => {
  lb.mode = "rejecting";
  await listen();
  expect(await status()).toMatchObject({
    pending: 1,
    lastError: expect.stringContaining("rejected the token"),
  });
  lb.mode = "ok";
  ctx.scrobbler.retryNow(); // not retried: the token is known bad
  await ctx.scrobbler.idle();
  expect(lb.submitted).toEqual([]);
  expect((await connect("good-token")).statusCode).toBe(200);
  await ctx.scrobbler.idle();
  expect(lb.submitted).toHaveLength(1);
  expect(await status()).toMatchObject({ pending: 0, lastError: null });
});

test("disconnecting forgets the token and drops unsent listens", async () => {
  lb.mode = "down";
  await listen();
  const res = await inject({ method: "DELETE", url: "/api/me/scrobbling/listenbrainz" });
  expect(ScrobbleSettings.parse(res.json()).listenbrainz).toMatchObject({ connected: false, pending: 0 });
  lb.mode = "ok";
  await listen();
  ctx.scrobbler.retryNow();
  await ctx.scrobbler.idle();
  expect(lb.submitted).toEqual([]);
});
