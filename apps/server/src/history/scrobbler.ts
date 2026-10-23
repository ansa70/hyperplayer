import type { ScrobbleAccount, ScrobbleSettings } from "@hyperplayer/schemas";
import type { Db } from "../db.ts";
import { HttpError } from "../http/contract.ts";

type Row = Record<string, unknown>;
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ScrobbleLog {
  warn(obj: object, msg: string): void;
}

const LISTENBRAINZ = "https://api.listenbrainz.org";
/** ListenBrainz accepts up to 1000 listens per request; smaller batches fail more cheaply. */
const BATCH = 100;
const MAX_BACKOFF_MS = 6 * 3600_000;
/** Pending listens of a rejected token wait for the user to reconnect. */
const NEVER = "9999-12-31T00:00:00.000Z";

/** The service rejected the token. */
class Rejected extends Error {}
/** The service will never accept these listens (malformed): retrying is pointless. */
class Refused extends Error {}

/**
 * Sends listens to the services users have connected (ListenBrainz for now).
 * Listens are queued in the database and submitted in the background, so an
 * unreachable service only delays them; failures back off exponentially, and a
 * token the service rejects pauses that user's queue until they reconnect.
 */
export class Scrobbler {
  readonly #db: Db;
  readonly #fetch: Fetch;
  readonly #log: ScrobbleLog;
  readonly #client: { name: string; version: string };
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  #closed = false;

  constructor(db: Db, log: ScrobbleLog, opts: { version: string; fetch?: Fetch }) {
    this.#db = db;
    this.#log = log;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }));
    this.#client = { name: "HyperPlayer", version: opts.version };
    // Whatever was left from before a restart.
    this.kick();
  }

  status(userId: string): ScrobbleSettings {
    const r = this.#db
      .prepare("SELECT * FROM scrobble_accounts WHERE user_id = ? AND service = 'listenbrainz'")
      .get(userId) as Row | undefined;
    const pending = Number(
      (
        this.#db
          .prepare("SELECT COUNT(*) AS n FROM scrobbles WHERE user_id = ? AND service = 'listenbrainz'")
          .get(userId) as Row
      ).n,
    );
    const listenbrainz: ScrobbleAccount = r
      ? {
          connected: true,
          username: String(r.username),
          pending,
          lastError: (r.last_error as string | null) ?? null,
          lastSubmittedAt: (r.last_submitted_at as string | null) ?? null,
        }
      : { connected: false, username: null, pending: 0, lastError: null, lastSubmittedAt: null };
    return { listenbrainz };
  }

  /** Checks `token` with ListenBrainz and, if it's valid, sends this user's listens from now on. */
  async connect(userId: string, token: string): Promise<ScrobbleSettings> {
    let res: Response;
    try {
      res = await this.#fetch(`${LISTENBRAINZ}/1/validate-token`, {
        headers: { Authorization: `Token ${token}` },
      });
    } catch (err) {
      throw new HttpError(
        502,
        "service_unreachable",
        `ListenBrainz is unreachable: ${(err as Error).message}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { valid?: boolean; user_name?: string };
    if (!res.ok && res.status !== 400 && res.status !== 401) {
      throw new HttpError(502, "service_error", `ListenBrainz answered ${res.status}`);
    }
    if (!body.valid || !body.user_name)
      throw new HttpError(400, "invalid_token", "ListenBrainz doesn't accept this token");
    this.#db
      .prepare(
        `INSERT INTO scrobble_accounts (user_id, service, token, username, connected_at) VALUES (?, 'listenbrainz', ?, ?, ?)
         ON CONFLICT DO UPDATE SET token = excluded.token, username = excluded.username, last_error = NULL`,
      )
      .run(userId, token, body.user_name, new Date().toISOString());
    // Listens paused by a previously rejected token can go now.
    this.#db
      .prepare("UPDATE scrobbles SET next_attempt_at = ? WHERE user_id = ? AND service = 'listenbrainz'")
      .run(new Date().toISOString(), userId);
    this.kick();
    return this.status(userId);
  }

  disconnect(userId: string): ScrobbleSettings {
    // Unsent listens go with the account (foreign key cascade).
    this.#db
      .prepare("DELETE FROM scrobble_accounts WHERE user_id = ? AND service = 'listenbrainz'")
      .run(userId);
    return this.status(userId);
  }

  /** Queues a newly recorded listen for every service the user has connected. */
  enqueue(userId: string, trackId: string, startedAt: string) {
    const queued = this.#db
      .prepare(
        `INSERT OR IGNORE INTO scrobbles (user_id, service, track_id, started_at, next_attempt_at)
         SELECT user_id, service, ?, ?, ? FROM scrobble_accounts WHERE user_id = ?`,
      )
      .run(trackId, startedAt, new Date().toISOString(), userId);
    if (queued.changes) this.kick();
  }

  /** Submits whatever is due, now (or right after a submission in progress). */
  kick() {
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#running = this.#drain()
      .catch((err: unknown) => this.#log.warn({ err }, "scrobbling failed"))
      .finally(() => {
        this.#running = null;
        if (this.#again) {
          this.#again = false;
          this.kick();
        } else this.#scheduleNext();
      });
  }

  /** Retries listens waiting out a backoff now (not those of a rejected token). */
  retryNow() {
    this.#db
      .prepare("UPDATE scrobbles SET next_attempt_at = ? WHERE next_attempt_at < ?")
      .run(new Date().toISOString(), NEVER);
    this.kick();
  }

  /** Resolves once nothing is being submitted (for tests). */
  async idle() {
    while (this.#running) await this.#running;
  }

  close() {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
  }

  #scheduleNext() {
    if (this.#closed) return;
    const next = this.#db
      .prepare("SELECT MIN(next_attempt_at) AS at FROM scrobbles WHERE next_attempt_at < ?")
      .get(NEVER) as { at: string | null };
    if (!next.at) return;
    const wait = Math.max(0, Date.parse(next.at) - Date.now());
    this.#timer = setTimeout(() => this.kick(), wait);
    this.#timer.unref();
  }

  async #drain() {
    for (;;) {
      const now = new Date().toISOString();
      // One user and service at a time: a batch shares a token.
      const head = this.#db
        .prepare(
          "SELECT user_id, service FROM scrobbles WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 1",
        )
        .get(now) as Row | undefined;
      if (!head || this.#closed) return;
      const [userId, service] = [String(head.user_id), String(head.service)];
      const account = this.#db
        .prepare("SELECT token FROM scrobble_accounts WHERE user_id = ? AND service = ?")
        .get(userId, service) as Row | undefined;
      // Disconnected meanwhile: its queue went with it.
      if (!account) continue;
      const rows = this.#db
        .prepare(
          `SELECT s.track_id, s.started_at, s.attempts, t.title, t.duration_ms, t.track_number,
                  t.musicbrainz_recording_id, COALESCE(t.artist_credit, ar.name) AS artist, al.title AS album,
                  al.musicbrainz_id AS release_mbid
           FROM scrobbles s JOIN tracks t ON t.id = s.track_id
           JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id
           WHERE s.user_id = ? AND s.service = ? AND s.next_attempt_at <= ?
           ORDER BY s.started_at LIMIT ?`,
        )
        .all(userId, service, now, BATCH) as Row[];
      try {
        await this.#submitListenBrainz(String(account.token), rows);
        const done = this.#db.prepare(
          "DELETE FROM scrobbles WHERE user_id = ? AND service = ? AND track_id = ? AND started_at = ?",
        );
        for (const r of rows) done.run(userId, service, r.track_id as string, r.started_at as string);
        this.#db
          .prepare(
            "UPDATE scrobble_accounts SET last_error = NULL, last_submitted_at = ? WHERE user_id = ? AND service = ?",
          )
          .run(new Date().toISOString(), userId, service);
      } catch (err) {
        if (err instanceof Refused) {
          this.#log.warn(
            { service, user: userId, listens: rows.length, error: err.message },
            "listens refused; dropped",
          );
          const drop = this.#db.prepare(
            "DELETE FROM scrobbles WHERE user_id = ? AND service = ? AND track_id = ? AND started_at = ?",
          );
          for (const r of rows) drop.run(userId, service, r.track_id as string, r.started_at as string);
          continue;
        }
        const rejected = err instanceof Rejected;
        const message = (err as Error).message;
        this.#log.warn({ service, user: userId, listens: rows.length, error: message }, "scrobbling failed");
        this.#db
          .prepare("UPDATE scrobble_accounts SET last_error = ? WHERE user_id = ? AND service = ?")
          .run(message, userId, service);
        const later = this.#db.prepare(
          `UPDATE scrobbles SET attempts = attempts + 1, next_attempt_at = ?
           WHERE user_id = ? AND service = ? AND track_id = ? AND started_at = ?`,
        );
        for (const r of rows) {
          const backoff = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Number(r.attempts));
          const at = rejected ? NEVER : new Date(Date.now() + backoff).toISOString();
          later.run(at, userId, service, r.track_id as string, r.started_at as string);
        }
      }
    }
  }

  async #submitListenBrainz(token: string, rows: Row[]) {
    const payload = rows.map((r) => ({
      listened_at: Math.floor(Date.parse(String(r.started_at)) / 1000),
      track_metadata: {
        artist_name: String(r.artist),
        track_name: String(r.title),
        release_name: String(r.album),
        additional_info: {
          duration_ms: Number(r.duration_ms),
          ...(r.track_number ? { tracknumber: Number(r.track_number) } : {}),
          ...(r.musicbrainz_recording_id ? { recording_mbid: r.musicbrainz_recording_id as string } : {}),
          ...(r.release_mbid ? { release_mbid: r.release_mbid as string } : {}),
          media_player: this.#client.name,
          submission_client: this.#client.name,
          submission_client_version: this.#client.version,
        },
      },
    }));
    const res = await this.#fetch(`${LISTENBRAINZ}/1/submit-listens`, {
      method: "POST",
      headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ listen_type: payload.length === 1 ? "single" : "import", payload }),
    });
    if (res.status === 401) throw new Rejected("ListenBrainz rejected the token; reconnect in Settings");
    if (!res.ok) {
      const detail = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      const message = `ListenBrainz answered ${res.status}${detail ? `: ${detail}` : ""}`;
      throw res.status === 400 ? new Refused(message) : new Error(message);
    }
  }
}
