import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { LyricLine, Lyrics } from "@hyperplayer/schemas";
import { parseFile } from "music-metadata";
import { z } from "zod";
import type { Db } from "../db.ts";
import { NotFound, type HttpClient } from "../enrich/http.ts";

type Row = Record<string, unknown>;
type Found = Omit<Lyrics, "trackId">;

const NONE: Found = { source: "none", synced: false, instrumental: false, lines: [] };
/** A track nobody had lyrics for is looked up again after this long. */
const RETRY_NONE_MS = 14 * 24 * 3600 * 1000;
/** LRCLIB search hits of another length are only trusted for their timings this close. */
const SYNC_TOLERANCE_S = 3;

const TIMESTAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;

/**
 * Parses LRC (`[mm:ss.xx]line`, several stamps per line allowed, `[offset:±ms]`
 * honoured, other `[tag:value]` headers skipped). Text without any timestamps is
 * returned as plain lines.
 */
export function parseLrc(text: string): { synced: boolean; lines: LyricLine[] } {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  let offset = 0;
  const timed: { timeMs: number; text: string }[] = [];
  for (const line of raw) {
    const header = /^\[([a-z#]+):(.*)\]\s*$/i.exec(line.trim());
    if (header) {
      if (header[1]!.toLowerCase() === "offset") offset = Number.parseInt(header[2]!, 10) || 0;
      continue;
    }
    const stamps = [...line.matchAll(TIMESTAMP)];
    if (!stamps.length) continue;
    const words = line.replace(TIMESTAMP, "").trim();
    for (const [, min, sec] of stamps) {
      const ms = Math.round((Number(min) * 60 + Number(sec!.replace(":", "."))) * 1000);
      // A positive offset means the lyrics come earlier.
      timed.push({ timeMs: Math.max(0, ms - offset), text: words });
    }
  }
  if (timed.length) {
    timed.sort((a, b) => a.timeMs - b.timeMs);
    return { synced: true, lines: timed };
  }
  const lines = raw.map((l) => ({ timeMs: null, text: l.trim() }));
  // Trim blank lines at either end; keep single blanks between stanzas.
  while (lines.length && !lines[0]!.text) lines.shift();
  while (lines.length && !lines.at(-1)!.text) lines.pop();
  return { synced: false, lines: lines.filter((l, i) => l.text || lines[i - 1]?.text) };
}

const LrcLib = z.object({
  duration: z.number().nullable().optional(),
  instrumental: z.boolean(),
  plainLyrics: z.string().nullable(),
  syncedLyrics: z.string().nullable(),
});
type LrcLibHit = z.infer<typeof LrcLib>;

interface TrackInfo {
  path: string;
  mtime: number;
  title: string;
  artist: string;
  album: string;
  durationS: number;
}

/**
 * Finds lyrics for tracks, in order of trust: a `.lrc` file beside the audio file,
 * lyrics in its tags, then LRCLIB (when online lookups are allowed). Results,
 * including "none", are cached per track until the file changes.
 */
export class LyricsService {
  readonly #db: Db;
  readonly #http: HttpClient | null;
  readonly #inFlight = new Map<string, Promise<Lyrics>>();

  constructor(db: Db, http: HttpClient | null) {
    this.#db = db;
    this.#http = http;
  }

  /** Null when the track doesn't exist. */
  get(trackId: string): Promise<Lyrics> | null {
    const track = this.#track(trackId);
    if (!track) return null;
    let pending = this.#inFlight.get(trackId);
    if (!pending) {
      pending = this.#lookup(trackId, track).finally(() => this.#inFlight.delete(trackId));
      this.#inFlight.set(trackId, pending);
    }
    return pending;
  }

  async #lookup(trackId: string, track: TrackInfo): Promise<Lyrics> {
    const cached = this.#db.prepare("SELECT * FROM lyrics WHERE track_id = ?").get(trackId) as
      | Row
      | undefined;
    if (
      cached &&
      Number(cached.track_mtime) === track.mtime &&
      (cached.source !== "none" || Date.now() - Date.parse(String(cached.fetched_at)) < RETRY_NONE_MS)
    ) {
      return {
        trackId,
        source: cached.source as Lyrics["source"],
        synced: Boolean(cached.synced),
        instrumental: Boolean(cached.instrumental),
        lines: JSON.parse(String(cached.lines)) as LyricLine[],
      };
    }

    let found: Found;
    try {
      found =
        (await fromFile(track.path)) ??
        (await fromTags(track.path)) ??
        (await this.#fromLrcLib(track)) ??
        NONE;
    } catch (err) {
      // Network trouble: answer "none" for now without remembering it.
      console.warn(`lyrics: ${track.artist} – ${track.title}: ${(err as Error).message}`);
      return { trackId, ...NONE };
    }
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO lyrics (track_id, track_mtime, source, synced, instrumental, lines, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trackId,
        track.mtime,
        found.source,
        found.synced ? 1 : 0,
        found.instrumental ? 1 : 0,
        JSON.stringify(found.lines),
        new Date().toISOString(),
      );
    return { trackId, ...found };
  }

  #track(id: string): TrackInfo | null {
    const r = this.#db
      .prepare(
        `SELECT t.path, t.mtime_ms, t.title, t.duration_ms, COALESCE(t.artist_credit, ar.name) AS artist, al.title AS album
         FROM tracks t JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id
         WHERE t.id = ?`,
      )
      .get(id) as Row | undefined;
    return r
      ? {
          path: String(r.path),
          mtime: Number(r.mtime_ms),
          title: String(r.title),
          artist: String(r.artist),
          album: String(r.album),
          durationS: Number(r.duration_ms) / 1000,
        }
      : null;
  }

  async #fromLrcLib(t: TrackInfo): Promise<Found | null> {
    if (!this.#http) return null;
    const params = new URLSearchParams({ artist_name: t.artist, track_name: t.title });
    // Exact lookup: LRCLIB matches the duration within a couple of seconds.
    try {
      const exact = new URLSearchParams(params);
      exact.set("album_name", t.album);
      exact.set("duration", String(Math.round(t.durationS)));
      const hit = await this.#http.json(`https://lrclib.net/api/get?${exact.toString()}`, LrcLib);
      const found = fromLrcLib(hit, true);
      if (found) return found;
    } catch (err) {
      if (!(err instanceof NotFound)) throw err;
    }
    // Otherwise another release of the song: its words fit, its timings only if the length does.
    const hits = await this.#http.json(`https://lrclib.net/api/search?${params.toString()}`, z.array(LrcLib));
    const close = (h: LrcLibHit) =>
      h.duration != null && Math.abs(h.duration - t.durationS) <= SYNC_TOLERANCE_S;
    const best =
      hits.find((h) => close(h) && h.syncedLyrics) ??
      hits.find((h) => close(h) && h.instrumental) ??
      hits.find((h) => h.plainLyrics);
    return best ? fromLrcLib(best, close(best)) : null;
  }
}

function fromLrcLib(hit: LrcLibHit, timingsFit: boolean): Found | null {
  if (hit.instrumental) return { source: "lrclib", synced: false, instrumental: true, lines: [] };
  const text = (timingsFit && hit.syncedLyrics) || hit.plainLyrics;
  if (!text?.trim()) return null;
  const parsed = parseLrc(text);
  return { source: "lrclib", instrumental: false, ...parsed };
}

async function fromFile(path: string): Promise<Found | null> {
  const lrc = join(dirname(path), `${basename(path, extname(path))}.lrc`);
  try {
    await stat(lrc);
  } catch {
    return null;
  }
  const parsed = parseLrc(await readFile(lrc, "utf8"));
  return parsed.lines.length ? { source: "file", instrumental: false, ...parsed } : null;
}

async function fromTags(path: string): Promise<Found | null> {
  const { common } = await parseFile(path, { skipCovers: true, duration: false });
  const tags = common.lyrics ?? [];
  // ID3 SYLT frames: already timed.
  const timed = tags.find((t) => t.syncText.length && t.syncText.some((s) => s.timestamp !== undefined));
  if (timed) {
    const lines = timed.syncText
      .map((s) => ({ timeMs: Math.max(0, Math.round(s.timestamp ?? 0)), text: s.text.trim() }))
      .sort((a, b) => a.timeMs - b.timeMs);
    return { source: "tags", synced: true, instrumental: false, lines };
  }
  // Plain text, which taggers often fill with LRC.
  const text = tags.map((t) => t.text).find((t) => t?.trim());
  if (!text) return null;
  const parsed = parseLrc(text);
  return parsed.lines.length ? { source: "tags", instrumental: false, ...parsed } : null;
}
