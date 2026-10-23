import type { HistoryStats, ListenPage, RecordListen } from "@hyperplayer/schemas";
import type { Catalog } from "../catalog/catalog.ts";
import type { Db } from "../db.ts";
import { HttpError, notFound } from "../http/contract.ts";
import type { Scrobbler } from "./scrobbler.ts";

type Row = Record<string, unknown>;

/** Tracks shorter than this never count (Last.fm's rule; ListenBrainz follows it). */
const MIN_TRACK_MS = 30_000;
/** Playing this much always counts, however long the track. */
const ENOUGH_MS = 4 * 60_000;
/** Clock skew tolerated between a client's `startedAt` and ours. */
const FUTURE_SLACK_MS = 5 * 60_000;

/** Whether `playedMs` of a track lasting `durationMs` is a listen. */
export function isListen(durationMs: number, playedMs: number): boolean {
  return durationMs >= MIN_TRACK_MS && playedMs >= Math.min(durationMs / 2, ENOUGH_MS);
}

/** Per-user listening history and the statistics built from it. */
export class History {
  readonly #db: Db;
  readonly #catalog: Catalog;
  readonly #scrobbler: Scrobbler | null;

  constructor(db: Db, catalog: Catalog, scrobbler: Scrobbler | null = null) {
    this.#db = db;
    this.#catalog = catalog;
    this.#scrobbler = scrobbler;
  }

  record(userId: string, listen: RecordListen) {
    const track = this.#catalog.getTrack(listen.trackId);
    if (!track) throw notFound("Track");
    if (!isListen(track.durationMs, listen.playedMs)) {
      throw new HttpError(400, "not_a_listen", "Too little of the track was played to count as a listen");
    }
    if (Date.parse(listen.startedAt) > Date.now() + FUTURE_SLACK_MS) {
      throw new HttpError(400, "bad_request", "startedAt is in the future");
    }
    const startedAt = new Date(listen.startedAt).toISOString();
    const known = this.#db
      .prepare("SELECT 1 FROM listens WHERE user_id = ? AND track_id = ? AND started_at = ?")
      .get(userId, track.id, startedAt);
    // Reporting the same listen again (a retry, or more of it played) only updates its length.
    this.#db
      .prepare(
        `INSERT INTO listens (user_id, track_id, started_at, played_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET played_ms = max(played_ms, excluded.played_ms)`,
      )
      .run(userId, track.id, startedAt, listen.playedMs);
    // ...and is sent to scrobbling services only the first time.
    if (!known) this.#scrobbler?.enqueue(userId, track.id, startedAt);
    return { ok: true as const };
  }

  list(userId: string, offset: number, limit: number): ListenPage {
    const rows = this.#db
      .prepare(
        "SELECT track_id, started_at, played_ms FROM listens WHERE user_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?",
      )
      .all(userId, limit, offset) as Row[];
    const tracks = this.#catalog.tracksByIds(rows.map((r) => String(r.track_id)));
    const total = Number(
      (this.#db.prepare("SELECT COUNT(*) AS n FROM listens WHERE user_id = ?").get(userId) as Row).n,
    );
    return {
      items: rows.flatMap((r) => {
        const track = tracks.get(String(r.track_id));
        return track ? [{ track, startedAt: String(r.started_at), playedMs: Number(r.played_ms) }] : [];
      }),
      total,
      offset,
      limit,
    };
  }

  stats(userId: string, days: number, limit: number): HistoryStats {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const totals = this.#db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(played_ms), 0) AS ms FROM listens WHERE user_id = ? AND started_at >= ?",
      )
      .get(userId, since) as Row;
    // Ties go to whatever was played most recently.
    const topTracks = this.#db
      .prepare(
        `SELECT track_id AS id, COUNT(*) AS plays FROM listens WHERE user_id = ? AND started_at >= ?
         GROUP BY track_id ORDER BY plays DESC, MAX(started_at) DESC LIMIT ?`,
      )
      .all(userId, since, limit) as Row[];
    const topArtists = this.#db
      .prepare(
        `SELECT t.artist_id AS id, COUNT(*) AS plays FROM listens l JOIN tracks t ON t.id = l.track_id
         WHERE l.user_id = ? AND l.started_at >= ?
         GROUP BY t.artist_id ORDER BY plays DESC, MAX(l.started_at) DESC LIMIT ?`,
      )
      .all(userId, since, limit) as Row[];
    const tracks = this.#catalog.tracksByIds(topTracks.map((r) => String(r.id)));
    const artists = this.#catalog.artistSummaries(topArtists.map((r) => String(r.id)));
    return {
      days,
      listens: Number(totals.n),
      listenedMs: Number(totals.ms),
      topTracks: topTracks.flatMap((r) => {
        const track = tracks.get(String(r.id));
        return track ? [{ track, plays: Number(r.plays) }] : [];
      }),
      topArtists: topArtists.flatMap((r) => {
        const artist = artists.get(String(r.id));
        return artist ? [{ artist, plays: Number(r.plays) }] : [];
      }),
    };
  }
}
