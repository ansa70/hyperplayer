import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LastfmAuthorization, ScrobbleSettings, TrackPage } from "@hyperplayer/schemas";
import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

const API_KEY = "test-key";
const SECRET = "test-secret";

/** A stand-in for ws.audioscrobbler.com, which checks signatures as Last.fm does. */
const fm = {
  mode: "ok" as "ok" | "down" | "revoked",
  /** Tokens the user has allowed on last.fm. */
  allowed: new Set<string>(),
  issued: 0,
  scrobbled: [] as Record<string, string>[],
  nowPlaying: [] as Record<string, string>[],
  async fetch(url: string, init: RequestInit): Promise<Response> {
    const params = new URLSearchParams(init.method === "POST" ? (init.body as string) : new URL(url).search);
    const p = Object.fromEntries(params);
    const signed = Object.keys(p)
      .filter((k) => k !== "api_sig" && k !== "format")
      .sort()
      .map((k) => k + p[k])
      .join("");
    const error = (code: number, message: string) => Response.json({ error: code, message }, { status: 400 });
    if (p.api_key !== API_KEY) return error(10, "Invalid API key");
    if (
      p.api_sig !==
      createHash("md5")
        .update(signed + SECRET)
        .digest("hex")
    )
      return error(13, "Invalid signature");
    switch (p.method) {
      case "auth.getToken":
        return Response.json({ token: `tok${++fm.issued}` });
      case "auth.getSession":
        if (!p.token?.startsWith("tok")) return error(4, "Invalid authentication token");
        if (!fm.allowed.has(p.token)) return error(14, "Unauthorized Token");
        return Response.json({ session: { name: "fmuser", key: "session-key", subscriber: 0 } });
      case "track.updateNowPlaying":
        if (p.sk !== "session-key") return error(9, "Invalid session key");
        fm.nowPlaying.push(p);
        return Response.json({ nowplaying: {} });
      case "track.scrobble": {
        if (fm.mode === "down") return error(16, "Temporarily unavailable");
        if (fm.mode === "revoked" || p.sk !== "session-key") return error(9, "Invalid session key");
        fm.scrobbled.push(p);
        const n = Object.keys(p).filter((k) => k.startsWith("track[")).length;
        return Response.json({ scrobbles: { "@attr": { accepted: n, ignored: 0 }, scrobble: [] } });
      }
    }
    return error(3, "Invalid method");
  },
};

let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let inject: ReturnType<typeof authed>;
let trackId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-lastfm-"));
  const lib = join(dir, "music", "Band");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "1.wav"), wav({ INAM: "Song", IART: "Band", IPRD: "Record", ITRK: "3" }, 60, 1000));
  ctx = await buildApp(
    testConfig(join(dir, "music"), join(dir, "data"), { lastfm: { apiKey: API_KEY, secret: SECRET } }),
    { logger: false, fetch: (url, init) => fm.fetch(url, init) },
  );
  await ctx.startScan();
  inject = authed(ctx.app, await setupAdmin(ctx.app));
  trackId = TrackPage.parse((await inject("/api/tracks")).json()).items[0]!.id;
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fm.mode = "ok";
  fm.scrobbled = [];
  fm.nowPlaying = [];
});

let minute = 0;
async function listen() {
  const startedAt = new Date(Date.UTC(2026, 9, 1, 12, minute++)).toISOString();
  const res = await inject({
    method: "POST",
    url: "/api/history",
    payload: { trackId, startedAt, playedMs: 40_000 },
  });
  expect(res.statusCode).toBe(200);
  await ctx.scrobbler.idle();
  return startedAt;
}
const status = async () => ScrobbleSettings.parse((await inject("/api/me/scrobbling")).json()).lastfm;
const authorize = async () =>
  LastfmAuthorization.parse(
    (await inject({ method: "POST", url: "/api/me/scrobbling/lastfm/authorize" })).json(),
  );
const connect = (token: string) =>
  inject({ method: "PUT", url: "/api/me/scrobbling/lastfm", payload: { token } });

test("connecting waits for the user to allow the token on last.fm", async () => {
  expect(await status()).toMatchObject({ available: true, connected: false });
  const { token, url } = await authorize();
  expect(url).toBe(`https://www.last.fm/api/auth/?api_key=${API_KEY}&token=${token}`);
  const waiting = await connect(token);
  expect(waiting.statusCode).toBe(409);
  expect(waiting.json()).toMatchObject({ error: "not_authorized" });
  expect((await connect("forged")).statusCode).toBe(400);
  fm.allowed.add(token);
  const res = await connect(token);
  expect(res.statusCode).toBe(200);
  expect(res.body).not.toContain("session-key");
  expect(await status()).toEqual({
    available: true,
    connected: true,
    username: "fmuser",
    pending: 0,
    lastError: null,
    lastSubmittedAt: null,
  });
});

test("new listens are scrobbled, signed, with their metadata", async () => {
  const startedAt = await listen();
  expect(fm.scrobbled).toEqual([
    expect.objectContaining({
      method: "track.scrobble",
      sk: "session-key",
      "artist[0]": "Band",
      "track[0]": "Song",
      "album[0]": "Record",
      "albumArtist[0]": "Band",
      "trackNumber[0]": "3",
      "duration[0]": "60",
      "timestamp[0]": String(Date.parse(startedAt) / 1000),
    }),
  ]);
  expect((await status()).lastSubmittedAt).not.toBeNull();
});

test("now playing goes to Last.fm, signed", async () => {
  const res = await inject({ method: "POST", url: "/api/me/now-playing", payload: { trackId } });
  expect(res.statusCode).toBe(200);
  await ctx.scrobbler.idle();
  expect(fm.nowPlaying).toEqual([
    expect.objectContaining({
      sk: "session-key",
      artist: "Band",
      track: "Song",
      album: "Record",
      duration: "60",
    }),
  ]);
  expect(fm.scrobbled).toEqual([]);
});

test("listens wait while Last.fm is down, then go together", async () => {
  fm.mode = "down";
  await listen();
  await listen();
  expect(await status()).toMatchObject({ pending: 2, lastError: expect.stringContaining("error 16") });
  fm.mode = "ok";
  ctx.scrobbler.retryNow();
  await ctx.scrobbler.idle();
  expect(fm.scrobbled).toHaveLength(1);
  expect(fm.scrobbled[0]).toHaveProperty("track[1]");
  expect(await status()).toMatchObject({ pending: 0, lastError: null });
});

test("a revoked session pauses the queue until reconnecting", async () => {
  fm.mode = "revoked";
  await listen();
  expect(await status()).toMatchObject({ pending: 1, lastError: expect.stringContaining("reconnect") });
  fm.mode = "ok";
  ctx.scrobbler.retryNow();
  await ctx.scrobbler.idle();
  expect(fm.scrobbled).toEqual([]);
  const { token } = await authorize();
  fm.allowed.add(token);
  expect((await connect(token)).statusCode).toBe(200);
  await ctx.scrobbler.idle();
  expect(fm.scrobbled).toHaveLength(1);
});

test("disconnecting Last.fm leaves ListenBrainz alone", async () => {
  const res = await inject({ method: "DELETE", url: "/api/me/scrobbling/lastfm" });
  expect(ScrobbleSettings.parse(res.json()).lastfm).toMatchObject({ connected: false });
  await listen();
  expect(fm.scrobbled).toEqual([]);
});

test("without an API account, Last.fm is unavailable", async () => {
  const other = await buildApp(testConfig(join(dir, "music"), join(dir, "data2")), { logger: false });
  try {
    const admin = authed(other.app, await setupAdmin(other.app));
    const settings = ScrobbleSettings.parse((await admin("/api/me/scrobbling")).json());
    expect(settings.lastfm).toMatchObject({ available: false, connected: false });
    const res = await admin({ method: "POST", url: "/api/me/scrobbling/lastfm/authorize" });
    expect(res.statusCode).toBe(503);
  } finally {
    await other.app.close();
  }
});
