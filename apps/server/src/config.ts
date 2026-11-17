import { homedir, userInfo } from "node:os";
import { delimiter, resolve } from "node:path";
import { z } from "zod";
import type { EnrichConfig } from "./enrich/enricher.ts";

const Env = z.object({
  /** Music folders, separated like PATH (`:` on Linux and macOS, `;` on Windows). */
  HP_LIBRARY: z.string().default(resolve(homedir(), "Music")),
  /**
   * Minutes between rescans of the library. The safety net that works on every
   * filesystem: network shares don't report changes made on the server side. 0 disables.
   */
  HP_RESCAN_MINUTES: z.coerce.number().min(0).default(5),
  /** Also watch the folders for changes and rescan shortly after (where the filesystem reports them). */
  HP_WATCH: z.stringbool().default(true),
  HP_DATA_DIR: z.string().default(resolve(import.meta.dirname, "../.data")),
  HP_HOST: z.string().default("127.0.0.1"),
  /**
   * Run as a player's private library engine: only on 127.0.0.1, plain HTTP, one local
   * account signed in for the player (its token is printed on stdout with the port, never
   * logged), and stop when the player closes stdin. The player starts it this way.
   */
  HP_EMBEDDED: z.stringbool().default(false),
  /** Embedded: the player's device id, so its queue is the same from one start to the next. */
  HP_EMBEDDED_DEVICE: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
  HP_EMBEDDED_DEVICE_NAME: z.string().trim().min(1).max(100).default("HyperPlayer"),
  /**
   * HTTPS: `auto` serves it unless the server only listens on this machine (127.0.0.1),
   * `on` always, `off` never (e.g. behind a reverse proxy that does HTTPS).
   */
  HP_TLS: z.enum(["auto", "on", "off"]).default("auto"),
  /** A certificate and its key (PEM files); without them a self-signed one is made in the data folder. */
  HP_TLS_CERT: z.string().trim().min(1).optional(),
  HP_TLS_KEY: z.string().trim().min(1).optional(),
  /** More names (host names or IP addresses, comma-separated) for the self-signed certificate. */
  HP_TLS_NAMES: z.string().default(""),
  /** 0 picks a free port (embedded mode does by default). */
  HP_PORT: z.coerce.number().int().min(0).max(65535).optional(),
  HP_FFMPEG: z.string().default("ffmpeg"),
  HP_VALIDATE_RESPONSES: z.stringbool().default(true),
  /** Fetch credits and artist profiles from MusicBrainz / Wikipedia / fanart.tv. */
  HP_ENRICH: z.stringbool().default(true),
  /** Contact info sent in the User-Agent, as MusicBrainz asks of API clients (URL or email). */
  HP_CONTACT: z.string().default("https://github.com/ansa70/hyperplayer"),
  HP_WIKI_LANG: z
    .string()
    .regex(/^[a-z-]{2,12}$/)
    .default("en"),
  HP_FANART_KEY: z.string().optional(),
  /** A Last.fm API account (last.fm/api/account/create), so users can scrobble to Last.fm. */
  HP_LASTFM_API_KEY: z.string().trim().min(1).optional(),
  HP_LASTFM_SECRET: z.string().trim().min(1).optional(),
  /** Development only: cap every audio stream at this many kbit/s. */
  HP_DEBUG_THROTTLE_KBPS: z.coerce.number().int().positive().optional(),
  /** The web player's build (`index.html` and its assets); found beside the server when unset. */
  HP_WEB_DIR: z.string().trim().min(1).optional(),
  /** Browser origins allowed to call the API cross-origin (comma-separated); none by default. */
  HP_CORS_ORIGINS: z.string().default(""),
  /** Set when behind a reverse proxy, so client IPs (for sign-in rate limits) come from X-Forwarded-For. */
  HP_TRUST_PROXY: z.stringbool().default(false),
  /** Mark session cookies Secure (HTTPS only). Turn off only for plain-HTTP development. */
  HP_SECURE_COOKIES: z.stringbool().default(true),
  /** Initial password of the built-in `admin` account; it must be changed at first sign-in. */
  HP_DEFAULT_ADMIN_PASSWORD: z.string().min(8).default("hyperplayer"),
});

export type TlsConfig = { certFile: string | null; keyFile: string | null; names: string[] };

export type LastfmConfig = { apiKey: string; secret: string };

/** Embedded mode: the player this engine belongs to (see HP_EMBEDDED). */
export type EmbeddedConfig = {
  deviceId: string | undefined;
  deviceName: string;
  /** The local account's username, made on first start (the system user's name). */
  username: string;
};

export type Config = {
  libraryPaths: string[];
  rescanMinutes: number;
  watch: boolean;
  /** How long a file must be unchanged before it's read (see `SETTLE_MS`); tests use 0. */
  scanSettleMs?: number;
  /** Quiet time after a reported change before rescanning (defaults to `SETTLE_MS`). */
  watchDebounceMs?: number;
  dataDir: string;
  host: string;
  port: number;
  /** HTTPS settings, or null for plain HTTP. */
  tls: TlsConfig | null;
  ffmpeg: string;
  validateResponses: boolean;
  enrich: EnrichConfig;
  lastfm: LastfmConfig | null;
  debugThrottleKbps: number | null;
  corsOrigins: string[];
  trustProxy: boolean;
  secureCookies: boolean;
  defaultAdminPassword: string;
  /** Running as a player's library engine, or null for a server. */
  embedded?: EmbeddedConfig | null;
  /** Where the web player's build is, if set (see `findWebDir`). */
  webDir?: string;
};

/** The system user's name, as a HyperPlayer username. */
function localUsername(): string {
  let name = "";
  try {
    name = userInfo().username;
  } catch {
    // No passwd entry (e.g. some containers).
  }
  return name.trim().slice(0, 64) || "me";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  if (e.HP_EMBEDDED) {
    // Only this machine's player talks to it: loopback, no HTTPS, a free port.
    e.HP_HOST = "127.0.0.1";
    e.HP_TLS = "off";
    e.HP_TLS_CERT = undefined;
    e.HP_TLS_KEY = undefined;
    e.HP_CORS_ORIGINS = "";
    e.HP_TRUST_PROXY = false;
  }
  if (!e.HP_TLS_CERT !== !e.HP_TLS_KEY) {
    throw new Error("HP_TLS_CERT and HP_TLS_KEY go together: set both or neither");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(e.HP_HOST);
  const tls = e.HP_TLS === "on" || (e.HP_TLS === "auto" && (!loopback || e.HP_TLS_CERT !== undefined));
  if (!e.HP_LASTFM_API_KEY !== !e.HP_LASTFM_SECRET) {
    throw new Error("HP_LASTFM_API_KEY and HP_LASTFM_SECRET go together: set both or neither");
  }
  return {
    libraryPaths: [
      ...new Set(
        e.HP_LIBRARY.split(delimiter)
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => resolve(p)),
      ),
    ],
    rescanMinutes: e.HP_RESCAN_MINUTES,
    watch: e.HP_WATCH,
    dataDir: resolve(e.HP_DATA_DIR),
    host: e.HP_HOST,
    port: e.HP_PORT ?? (e.HP_EMBEDDED ? 0 : 4533),
    tls: tls
      ? {
          certFile: e.HP_TLS_CERT ? resolve(e.HP_TLS_CERT) : null,
          keyFile: e.HP_TLS_KEY ? resolve(e.HP_TLS_KEY) : null,
          names: e.HP_TLS_NAMES.split(",")
            .map((n) => n.trim())
            .filter(Boolean),
        }
      : null,
    ffmpeg: e.HP_FFMPEG,
    validateResponses: e.HP_VALIDATE_RESPONSES,
    enrich: {
      enabled: e.HP_ENRICH,
      contact: e.HP_CONTACT,
      wikiLang: e.HP_WIKI_LANG,
      fanartKey: e.HP_FANART_KEY ?? null,
    },
    lastfm:
      e.HP_LASTFM_API_KEY && e.HP_LASTFM_SECRET
        ? { apiKey: e.HP_LASTFM_API_KEY, secret: e.HP_LASTFM_SECRET }
        : null,
    debugThrottleKbps: e.HP_DEBUG_THROTTLE_KBPS ?? null,
    webDir: e.HP_WEB_DIR ? resolve(e.HP_WEB_DIR) : undefined,
    corsOrigins: e.HP_CORS_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    trustProxy: e.HP_TRUST_PROXY,
    secureCookies: e.HP_SECURE_COOKIES,
    defaultAdminPassword: e.HP_DEFAULT_ADMIN_PASSWORD,
    embedded: e.HP_EMBEDDED
      ? { deviceId: e.HP_EMBEDDED_DEVICE, deviceName: e.HP_EMBEDDED_DEVICE_NAME, username: localUsername() }
      : null,
  };
}
