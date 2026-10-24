import { createHash } from "node:crypto";
import type { LastfmAuthorization, ScrobbleAccount, ScrobbleSettings } from "@hyperplayer/schemas";
import type { LastfmConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { HttpError } from "../http/contract.ts";

type Row = Record<string, unknown>;
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ScrobbleLog {
  warn(obj: object, msg: string): void;
}

const LISTENBRAINZ = "https://api.listenbrainz.org";
const LASTFM = "https://ws.audioscrobbler.com/2.0/";
type Service = "listenbrainz" | "lastfm";
const SERVICES: Service[] = ["listenbrainz", "lastfm"];
/**
 * Listens per request. ListenBrainz accepts up to 1000 (smaller batches fail more
 * cheaply), Last.fm 50.
 */
const BATCH: Record<Service, number> = { listenbrainz: 100, lastfm: 50 };
const MAX_BACKOFF_MS = 6 * 3600_000;
/** Pending listens of a rejected token wait for the user to reconnect. */
const NEVER = "9999-12-31T00:00:00.000Z";

/** What the services are told about a track (`t` tracks, `ar` its artist, `al` album, `aa` album artist). */
const TRACK_COLUMNS = `t.title, t.duration_ms, t.track_number, t.musicbrainz_recording_id,
  COALESCE(t.artist_credit, ar.name) AS artist, al.title AS album, al.musicbrainz_id AS release_mbid,
  aa.name AS album_artist`;
const TRACK_JOINS = `JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id
  JOIN artists aa ON aa.id = al.artist_id`;

/** The service rejected the token. */
class Rejected extends Error {}
/** The service will never accept these listens (malformed): retrying is pointless. */
class Refused extends Error {}

/** An error Last.fm reported (last.fm/api/errorcodes). */
class LastfmError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Sends listens to the services users have connected (ListenBrainz and Last.fm).
 * Listens are queued in the database and submitted in the background, so an
 * unreachable service only delays them; failures back off exponentially, and a
 * token the service rejects pauses that user's queue until they reconnect.
 */
export class Scrobbler {
  readonly #db: Db;
  readonly #fetch: Fetch;
  readonly #log: ScrobbleLog;
  readonly #client: { name: string; version: string };
  readonly #lastfm: LastfmConfig | null;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  /** "Now playing" announcements in flight. */
  readonly #announcing = new Set<Promise<unknown>>();
  #closed = false;

  constructor(
    db: Db,
    log: ScrobbleLog,
    opts: { version: string; fetch?: Fetch; lastfm?: LastfmConfig | null },
  ) {
    this.#db = db;
    this.#log = log;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }));
    this.#client = { name: "HyperPlayer", version: opts.version };
    this.#lastfm = opts.lastfm ?? null;
    // Whatever was left from before a restart.
    this.kick();
  }

  status(userId: string): ScrobbleSettings {
    const [listenbrainz, lastfm] = SERVICES.map((service) => this.#account(userId, service));
    return { listenbrainz: listenbrainz!, lastfm: lastfm! };
  }

  #account(userId: string, service: Service): ScrobbleAccount {
    const available = service !== "lastfm" || this.#lastfm !== null;
    const r = this.#db
      .prepare("SELECT * FROM scrobble_accounts WHERE user_id = ? AND service = ?")
      .get(userId, service) as Row | undefined;
    if (!r)
      return {
        available,
        connected: false,
        username: null,
        pending: 0,
        lastError: null,
        lastSubmittedAt: null,
      };
    const pending = Number(
      (
        this.#db
          .prepare("SELECT COUNT(*) AS n FROM scrobbles WHERE user_id = ? AND service = ?")
          .get(userId, service) as Row
      ).n,
    );
    return {
      available,
      connected: true,
      username: String(r.username),
      pending,
      lastError: (r.last_error as string | null) ?? null,
      lastSubmittedAt: (r.last_submitted_at as string | null) ?? null,
    };
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
    return this.#save(userId, "listenbrainz", token, body.user_name);
  }

  /** Starts connecting Last.fm: the user allows the returned token on last.fm, then it's passed to `connectLastfm`. */
  async authorizeLastfm(): Promise<LastfmAuthorization> {
    const lastfm = this.#lastfmConfig();
    const body = await this.#lastfmCall("auth.getToken", {}).catch((err: unknown) => {
      throw this.#lastfmHttpError(err);
    });
    const token = String(body.token);
    const url = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(lastfm.apiKey)}&token=${encodeURIComponent(token)}`;
    return { token, url };
  }

  /** Exchanges an allowed token for a session, and sends this user's listens to Last.fm from now on. */
  async connectLastfm(userId: string, token: string): Promise<ScrobbleSettings> {
    this.#lastfmConfig();
    let body: Row;
    try {
      body = await this.#lastfmCall("auth.getSession", { token });
    } catch (err) {
      if (err instanceof LastfmError && err.code === 14) {
        throw new HttpError(409, "not_authorized", "Waiting for you to allow HyperPlayer on Last.fm");
      }
      if (err instanceof LastfmError && (err.code === 4 || err.code === 15)) {
        throw new HttpError(400, "invalid_token", "This Last.fm authorization expired; connect again");
      }
      throw this.#lastfmHttpError(err);
    }
    const session = body.session as { name?: string; key?: string } | undefined;
    if (!session?.name || !session.key) throw new HttpError(502, "service_error", "Last.fm sent no session");
    return this.#save(userId, "lastfm", session.key, session.name);
  }

  #lastfmConfig(): LastfmConfig {
    if (!this.#lastfm) {
      throw new HttpError(
        503,
        "not_configured",
        "This server has no Last.fm API account (HP_LASTFM_API_KEY and HP_LASTFM_SECRET)",
      );
    }
    return this.#lastfm;
  }

  #lastfmHttpError(err: unknown): HttpError {
    if (err instanceof LastfmError)
      return new HttpError(502, "service_error", `Last.fm: ${err.message} (error ${err.code})`);
    return new HttpError(502, "service_unreachable", `Last.fm is unreachable: ${(err as Error).message}`);
  }

  #save(userId: string, service: Service, token: string, username: string): ScrobbleSettings {
    this.#db
      .prepare(
        `INSERT INTO scrobble_accounts (user_id, service, token, username, connected_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET token = excluded.token, username = excluded.username, last_error = NULL`,
      )
      .run(userId, service, token, username, new Date().toISOString());
    // Listens paused by a previously rejected token can go now.
    this.#db
      .prepare("UPDATE scrobbles SET next_attempt_at = ? WHERE user_id = ? AND service = ?")
      .run(new Date().toISOString(), userId, service);
    this.kick();
    return this.status(userId);
  }

  disconnect(userId: string, service: Service): ScrobbleSettings {
    // Unsent listens go with the account (foreign key cascade).
    this.#db.prepare("DELETE FROM scrobble_accounts WHERE user_id = ? AND service = ?").run(userId, service);
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

  /**
   * Tells the user's services that `trackId` started playing. Sent once and not
   * queued: a late "now playing" would be wrong, and the listen itself follows.
   */
  nowPlaying(userId: string, trackId: string) {
    const accounts = this.#db
      .prepare("SELECT service, token FROM scrobble_accounts WHERE user_id = ?")
      .all(userId) as Row[];
    if (accounts.length === 0) return;
    const track = this.#db
      .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks t ${TRACK_JOINS} WHERE t.id = ?`)
      .get(trackId) as Row | undefined;
    if (!track) return;
    for (const a of accounts) {
      const service = a.service as Service;
      const sent = this.#sendNowPlaying(service, String(a.token), track)
        .catch((err: unknown) =>
          this.#log.warn({ service, user: userId, error: (err as Error).message }, "now playing not sent"),
        )
        .finally(() => this.#announcing.delete(sent));
      this.#announcing.add(sent);
    }
  }

  async #sendNowPlaying(service: Service, token: string, track: Row) {
    if (service === "lastfm") {
      await this.#lastfmCall(
        "track.updateNowPlaying",
        { sk: token, ...this.#lastfmTrackParams(track) },
        "POST",
      );
      return;
    }
    const res = await this.#listenBrainzSubmit(token, "playing_now", [
      { track_metadata: this.#listenBrainzMetadata(track) },
    ]);
    if (!res.ok) throw new Error(`ListenBrainz answered ${res.status}`);
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
    while (this.#running || this.#announcing.size) {
      await Promise.all([this.#running, ...this.#announcing]);
    }
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
      const [userId, service] = [String(head.user_id), head.service as Service];
      const account = this.#db
        .prepare("SELECT token FROM scrobble_accounts WHERE user_id = ? AND service = ?")
        .get(userId, service) as Row | undefined;
      // Disconnected meanwhile: its queue went with it.
      if (!account) continue;
      const rows = this.#db
        .prepare(
          `SELECT s.track_id, s.started_at, s.attempts, ${TRACK_COLUMNS}
           FROM scrobbles s JOIN tracks t ON t.id = s.track_id ${TRACK_JOINS}
           WHERE s.user_id = ? AND s.service = ? AND s.next_attempt_at <= ?
           ORDER BY s.started_at LIMIT ?`,
        )
        .all(userId, service, now, BATCH[service]) as Row[];
      try {
        if (service === "lastfm") await this.#submitLastfm(String(account.token), rows);
        else await this.#submitListenBrainz(String(account.token), rows);
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
      track_metadata: this.#listenBrainzMetadata(r),
    }));
    const res = await this.#listenBrainzSubmit(token, payload.length === 1 ? "single" : "import", payload);
    if (res.status === 401) throw new Rejected("ListenBrainz rejected the token; reconnect in Settings");
    if (!res.ok) {
      const detail = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      const message = `ListenBrainz answered ${res.status}${detail ? `: ${detail}` : ""}`;
      throw res.status === 400 ? new Refused(message) : new Error(message);
    }
  }

  #listenBrainzMetadata(r: Row) {
    return {
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
    };
  }

  #listenBrainzSubmit(token: string, listenType: string, payload: object[]) {
    return this.#fetch(`${LISTENBRAINZ}/1/submit-listens`, {
      method: "POST",
      headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ listen_type: listenType, payload }),
    });
  }

  /** Last.fm's track parameters; `index` numbers them for a batch (`artist[0]`, ...). */
  #lastfmTrackParams(r: Row, index?: number): Record<string, string> {
    const at = (name: string) => (index === undefined ? name : `${name}[${index}]`);
    return {
      [at("artist")]: String(r.artist),
      [at("track")]: String(r.title),
      [at("album")]: String(r.album),
      [at("albumArtist")]: String(r.album_artist),
      [at("duration")]: String(Math.round(Number(r.duration_ms) / 1000)),
      ...(r.track_number ? { [at("trackNumber")]: String(Number(r.track_number)) } : {}),
      ...(r.musicbrainz_recording_id ? { [at("mbid")]: r.musicbrainz_recording_id as string } : {}),
    };
  }

  async #submitLastfm(sessionKey: string, rows: Row[]) {
    const params: Record<string, string> = { sk: sessionKey };
    rows.forEach((r, i) => {
      Object.assign(params, this.#lastfmTrackParams(r, i));
      params[`timestamp[${i}]`] = String(Math.floor(Date.parse(String(r.started_at)) / 1000));
    });
    let body: Row;
    try {
      body = await this.#lastfmCall("track.scrobble", params, "POST");
    } catch (err) {
      if (!(err instanceof LastfmError)) throw err;
      const message = `Last.fm: ${err.message} (error ${err.code})`;
      // 9: the session was revoked (or the user removed HyperPlayer's access).
      if (err.code === 9)
        throw new Rejected("Last.fm no longer accepts this connection; reconnect in Settings");
      if (err.code === 6) throw new Refused(message);
      throw new Error(message);
    }
    // Ignored listens (e.g. older than Last.fm accepts) are final, like accepted ones.
    const scrobbles = body.scrobbles as { "@attr"?: { ignored?: number }; scrobble?: unknown } | undefined;
    if (Number(scrobbles?.["@attr"]?.ignored ?? 0) > 0) {
      const list = [scrobbles?.scrobble].flat() as { ignoredMessage?: { code?: string; "#text"?: string } }[];
      const reasons = list
        .map((x) => x?.ignoredMessage)
        .filter((m) => m && m.code !== "0")
        .map((m) => m?.["#text"] || `code ${m?.code}`);
      this.#log.warn(
        { service: "lastfm", ignored: scrobbles?.["@attr"]?.ignored, reasons },
        "Last.fm ignored listens",
      );
    }
  }

  /** A signed Last.fm API call (last.fm/api/authspec); errors become `LastfmError`. */
  async #lastfmCall(
    method: string,
    params: Record<string, string>,
    http: "GET" | "POST" = "GET",
  ): Promise<Row> {
    const lastfm = this.#lastfmConfig();
    const all: Record<string, string> = { ...params, method, api_key: lastfm.apiKey };
    const signed = Object.keys(all)
      .sort()
      .map((k) => k + all[k])
      .join("");
    const query = new URLSearchParams({
      ...all,
      api_sig: createHash("md5")
        .update(signed + lastfm.secret, "utf8")
        .digest("hex"),
      format: "json",
    });
    const res =
      http === "GET"
        ? await this.#fetch(`${LASTFM}?${query.toString()}`, { headers: { "User-Agent": this.#userAgent() } })
        : await this.#fetch(LASTFM, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": this.#userAgent() },
            body: query.toString(),
          });
    const body = (await res.json().catch(() => null)) as Row | null;
    if (body && typeof body.error === "number")
      throw new LastfmError(body.error, (body.message as string | undefined) ?? "");
    if (!res.ok || !body) throw new Error(`Last.fm answered ${res.status}`);
    return body;
  }

  #userAgent() {
    return `${this.#client.name}/${this.#client.version}`;
  }
}
