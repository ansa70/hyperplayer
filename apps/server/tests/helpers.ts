import type { FastifyInstance, InjectOptions } from "fastify";
import type { Config } from "../src/config.ts";

/** Builds a 16-bit mono PCM WAV with a RIFF INFO tag chunk. */
export function wav(tags: Record<string, string>, seconds = 1, sampleRate = 8000): Buffer {
  const pcm = Buffer.alloc(seconds * sampleRate * 2);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(1, 2); // channels
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const chunk = (id: string, body: Buffer) => {
    const header = Buffer.alloc(8);
    header.write(id, 0, "ascii");
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const info = Buffer.concat([
    Buffer.from("INFO"),
    ...Object.entries(tags).map(([k, v]) => chunk(k, Buffer.from(`${v}\0`))),
  ]);
  const body = Buffer.concat([
    Buffer.from("WAVE"),
    chunk("fmt ", fmt),
    chunk("data", pcm),
    chunk("LIST", info),
  ]);
  return chunk("RIFF", body);
}

/** Server config for tests: no enrichment, no throttling. */
export function testConfig(libraryPath: string, dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    libraryPaths: [libraryPath],
    // Tests scan explicitly.
    rescanMinutes: 0,
    watch: false,
    scanSettleMs: 0,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    tls: null,
    ffmpeg: "ffmpeg",
    validateResponses: true,
    enrich: { enabled: false, contact: "test", wikiLang: "en", fanartKey: null },
    lastfm: null,
    debugThrottleKbps: null,
    corsOrigins: [],
    trustProxy: false,
    secureCookies: false,
    defaultAdminPassword: "hyperplayer",
    ...overrides,
  };
}

export const ADMIN_PASSWORD = "correct horse";

/**
 * Claims the default admin account (signs in with the default password and sets
 * `ADMIN_PASSWORD`) and returns that device's token.
 */
export async function setupAdmin(app: FastifyInstance, deviceId = "test-device-1"): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "hyperplayer", deviceName: "tests", deviceId },
  });
  if (login.statusCode !== 200) throw new Error(`default sign-in failed: ${login.body}`);
  const token = (login.json() as { token: string }).token;
  const change = await app.inject({
    method: "POST",
    url: "/api/me/password",
    headers: { authorization: `Bearer ${token}` },
    payload: { currentPassword: "hyperplayer", newPassword: ADMIN_PASSWORD },
  });
  if (change.statusCode !== 200) throw new Error(`password change failed: ${change.body}`);
  return token;
}

/** `app.inject` with a bearer token. */
export function authed(app: FastifyInstance, token: string) {
  return (opts: InjectOptions | string) => {
    const o = typeof opts === "string" ? { url: opts } : opts;
    return app.inject({ ...o, headers: { ...o.headers, authorization: `Bearer ${token}` } });
  };
}
