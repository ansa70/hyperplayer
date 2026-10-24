import { homedir } from "node:os";
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
  HP_PORT: z.coerce.number().int().min(1).max(65535).default(4533),
  HP_FFMPEG: z.string().default("ffmpeg"),
  HP_VALIDATE_RESPONSES: z.stringbool().default(true),
  /** Fetch credits and artist profiles from MusicBrainz / Wikipedia / fanart.tv. */
  HP_ENRICH: z.stringbool().default(true),
  /** Contact info sent in the User-Agent, as MusicBrainz asks of API clients (URL or email). */
  HP_CONTACT: z.string().default("https://github.com/hyperplayer"),
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
  /** Browser origins allowed to call the API cross-origin (comma-separated); none by default. */
  HP_CORS_ORIGINS: z.string().default(""),
  /** Set when behind a reverse proxy, so client IPs (for sign-in rate limits) come from X-Forwarded-For. */
  HP_TRUST_PROXY: z.stringbool().default(false),
  /** Mark session cookies Secure (HTTPS only). Turn off only for plain-HTTP development. */
  HP_SECURE_COOKIES: z.stringbool().default(true),
  /** Initial password of the built-in `admin` account; it must be changed at first sign-in. */
  HP_DEFAULT_ADMIN_PASSWORD: z.string().min(8).default("hyperplayer"),
});

export type LastfmConfig = { apiKey: string; secret: string };

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
  ffmpeg: string;
  validateResponses: boolean;
  enrich: EnrichConfig;
  lastfm: LastfmConfig | null;
  debugThrottleKbps: number | null;
  corsOrigins: string[];
  trustProxy: boolean;
  secureCookies: boolean;
  defaultAdminPassword: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
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
    port: e.HP_PORT,
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
    corsOrigins: e.HP_CORS_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    trustProxy: e.HP_TRUST_PROXY,
    secureCookies: e.HP_SECURE_COOKIES,
    defaultAdminPassword: e.HP_DEFAULT_ADMIN_PASSWORD,
  };
}
