import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { authed, testConfig, wav } from "./helpers.ts";

let dir: string;
let lib: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-embedded-"));
  lib = join(dir, "music");
  mkdirSync(join(lib, "Band", "Album"), { recursive: true });
  writeFileSync(
    join(lib, "Band", "Album", "1.wav"),
    wav({ INAM: "One", IART: "Band", IPRD: "Album", ITRK: "1" }),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const embedded = (deviceId = "dev-player-0001") => ({
  embedded: { deviceId, deviceName: "HyperPlayer on test", username: "alice" },
});

test("embedded mode listens only on loopback, without HTTPS, on a free port", () => {
  const c = loadConfig({ HP_EMBEDDED: "1", HP_HOST: "0.0.0.0", HP_TLS: "on", HP_CORS_ORIGINS: "https://x" });
  expect(c).toMatchObject({ host: "127.0.0.1", port: 0, tls: null, corsOrigins: [] });
  expect(c.embedded?.deviceName).toBe("HyperPlayer");
  expect(c.embedded?.username).not.toBe("");
  expect(loadConfig({ HP_EMBEDDED: "1", HP_PORT: "5000" }).port).toBe(5000);
  expect(loadConfig({}).port).toBe(4533);
  expect(loadConfig({}).embedded).toBeNull();
  expect(() => loadConfig({ HP_EMBEDDED: "1", HP_EMBEDDED_DEVICE: "bad id" })).toThrow();
});

test("the player is signed in as the local admin, with no default admin to claim", async () => {
  const ctx = await buildApp(testConfig(lib, join(dir, "data"), embedded()), { logger: false });
  try {
    const session = ctx.embeddedSession!;
    expect(session.user).toMatchObject({ username: "alice", admin: true, mustChangePassword: false });
    expect(session.device.id).toBe("dev-player-0001");
    expect((await ctx.app.inject("/api/auth/status")).json()).toMatchObject({ defaultAdmin: false });
    await ctx.startScan();
    const inject = authed(ctx.app, session.token);
    expect((await inject("/api/search?q=one")).json()).toMatchObject({ tracks: [{ title: "One" }] });
    expect((await inject("/api/library/status")).statusCode).toBe(200);
  } finally {
    await ctx.app.close();
  }
});

test("each start re-keys the same device and account, keeping its queue", async () => {
  const data = join(dir, "data");
  const first = await buildApp(testConfig(lib, data, embedded()), { logger: false });
  await first.startScan();
  const firstToken = first.embeddedSession!.token;
  const album = (
    (await authed(first.app, firstToken)("/api/search?q=album")).json() as { albums: { id: string }[] }
  ).albums[0]!.id;
  const set = await authed(
    first.app,
    firstToken,
  )({ method: "PUT", url: "/api/queue", payload: { source: { kind: "album", id: album }, start: 0 } });
  expect(set.statusCode, set.body).toBe(200);
  await first.app.close();

  const second = await buildApp(testConfig(lib, data, embedded()), { logger: false });
  try {
    const s = second.embeddedSession!;
    expect(s.token).not.toBe(firstToken);
    expect(s.user.id).toBe(first.embeddedSession!.user.id);
    // The old token no longer works; the new one finds the queue.
    expect((await authed(second.app, firstToken)("/api/queue")).statusCode).toBe(401);
    expect((await authed(second.app, s.token)("/api/queue")).json()).toMatchObject({
      entries: [{ track: { title: "One" } }],
    });
  } finally {
    await second.app.close();
  }
});

test("the process announces its port and token, and stops when stdin closes", async () => {
  // As the player starts a development engine (a release one runs the bundled dist/main.mjs).
  const child = spawn("vpx", ["src/main.ts"], {
    cwd: join(import.meta.dirname, ".."),
    shell: process.platform === "win32",
    env: {
      ...process.env,
      HP_EMBEDDED: "1",
      HP_EMBEDDED_DEVICE: "dev-player-0002",
      HP_LIBRARY: lib,
      HP_DATA_DIR: join(dir, "proc-data"),
      HP_ENRICH: "0",
      HP_WATCH: "0",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    const ready = await new Promise<{ port: number; token: string }>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        if (line.startsWith("HYPERPLAYER-READY ")) resolve(JSON.parse(line.slice(18)));
        // The token appears only on the ready line, never in the log.
        else if (line.includes("hp_")) reject(new Error(`token in log: ${line}`));
      });
      child.on("exit", () => reject(new Error("exited before it was ready")));
    });
    expect(ready.port).toBeGreaterThan(0);
    const me = await fetch(`http://127.0.0.1:${ready.port}/api/me`, {
      headers: { authorization: `Bearer ${ready.token}` },
    });
    expect(me.status).toBe(200);
    child.stdin!.end();
    expect(await exited).toBe(0);
  } finally {
    child.kill();
  }
}, 30_000);
