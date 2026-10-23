import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { EnrichConfig } from "./enrich/enricher.ts";

const Env = z.object({
  HP_LIBRARY: z.string().default(resolve(homedir(), "Music")),
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
  /** Development only: cap every audio stream at this many kbit/s. */
  HP_DEBUG_THROTTLE_KBPS: z.coerce.number().int().positive().optional(),
});

export type Config = {
  libraryPath: string;
  dataDir: string;
  host: string;
  port: number;
  ffmpeg: string;
  validateResponses: boolean;
  enrich: EnrichConfig;
  debugThrottleKbps: number | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return {
    libraryPath: resolve(e.HP_LIBRARY),
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
    debugThrottleKbps: e.HP_DEBUG_THROTTLE_KBPS ?? null,
  };
}
