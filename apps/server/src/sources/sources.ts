import { randomBytes } from "node:crypto";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import type { AddSource, Lyrics, Source, SyncPage, Waveform } from "@hyperplayer/schemas";
import type { Db } from "../db.ts";
import { HttpError } from "../http/contract.ts";
import type { ArtworkStore } from "../library/artwork.ts";
import { deleteOrphans, remotePath, writeTrack } from "../library/tracks.ts";
import { tracksChanged } from "../library/dedupe.ts";
import { offeredCertificate, SourceClient, SourceError, type Pin } from "./client.ts";

type Row = Record<string, unknown>;

const PAGE = 500;

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** A track that lives on a server: where to ask for it. */
export interface RemoteTrack {
  client: SourceClient;
  sourceId: string;
  remoteId: string;
}

/** A source's error in words for the user. */
function describe(err: unknown, host: string): string {
  if (err instanceof SourceError) {
    if (err.status === 401) {
      return `${host} no longer accepts this player's sign-in (signed out, or the account was removed). Remove the server and add it again.`;
    }
    if (err.status === 404) {
      return `${host} runs an older HyperPlayer, which can't share its music yet: update it to 0.3.0 or later.`;
    }
    return err.message;
  }
  return `syncing with ${host} failed: ${(err as Error).message}`;
}

/**
 * Servers whose music is part of this library (a standalone player's engine). Their
 * catalogs are copied into this one, so their artists and albums merge with the ones on
 * this computer; streams, covers, waveforms and lyrics are fetched from them when needed.
 */
export class Sources {
  readonly #db: Db;
  readonly #artwork: ArtworkStore;
  readonly #log: Log;
  readonly #userAgent: string;
  readonly #syncing = new Map<string, Promise<boolean>>();
  readonly #fetchingArt = new Map<string, Promise<{ path: string; mime: string } | null>>();

  constructor(db: Db, artwork: ArtworkStore, log: Log, opts: { userAgent: string }) {
    this.#db = db;
    this.#artwork = artwork;
    this.#log = log;
    this.#userAgent = opts.userAgent;
  }

  #row(id: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as Row | undefined;
  }

  #client(row: Row): SourceClient {
    const pin: Pin | null =
      row.fingerprint && row.certificate
        ? { fingerprint: row.fingerprint as string, certificate: row.certificate as string }
        : null;
    return new SourceClient(String(row.url), String(row.token), pin, this.#userAgent);
  }

  get count(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM sources").get() as Row).n);
  }

  list(): Source[] {
    const rows = this.#db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM all_tracks WHERE source_id = s.id) AS track_count,
                (SELECT COUNT(*) FROM all_tracks WHERE source_id = s.id AND duplicate_of IS NOT NULL) AS duplicates
         FROM sources s ORDER BY s.added_at`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      url: String(r.url),
      username: String(r.username),
      tracks: Number(r.track_count),
      duplicates: Number(r.duplicates),
      syncing: this.#syncing.has(String(r.id)),
      lastSyncAt: (r.last_sync_at as string | null) ?? null,
      error: (r.last_error as string | null) ?? null,
    }));
  }

  /**
   * Adds a server (or, already added, signs in to it anew) after checking that it answers
   * and can share its music. Returns its id; syncing is up to the caller.
   */
  async add(input: AddSource): Promise<string> {
    const url = input.url.replace(/\/+$/, "");
    const host = new URL(url).host;
    let pin: Pin | null = null;
    if (input.fingerprint) {
      if (!url.startsWith("https:")) {
        throw new HttpError(400, "bad_request", "A certificate can only be trusted for an https:// address");
      }
      const offered = await offeredCertificate(url).catch((err: unknown) => {
        throw new HttpError(502, "source_unreachable", (err as Error).message);
      });
      if (offered.fingerprint !== input.fingerprint) {
        throw new HttpError(
          400,
          "certificate_changed",
          `${host} now offers a different certificate (SHA-256 ${offered.fingerprint}) than the one trusted`,
        );
      }
      pin = offered;
    }
    const client = new SourceClient(url, input.token, pin, this.#userAgent);
    try {
      await client.json<SyncPage>("/api/sync?limit=1");
    } catch (err) {
      const status = err instanceof SourceError && err.status === 404 ? 400 : 502;
      throw new HttpError(status, "source_failed", describe(err, host));
    }
    const existing = this.#db.prepare("SELECT id FROM sources WHERE url = ?").get(url) as Row | undefined;
    const id = existing ? String(existing.id) : randomBytes(8).toString("hex");
    this.#db
      .prepare(
        `INSERT INTO sources (id, url, username, token, fingerprint, certificate, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET username = excluded.username, token = excluded.token,
           fingerprint = excluded.fingerprint, certificate = excluded.certificate, last_error = NULL`,
      )
      .run(
        id,
        url,
        input.username,
        input.token,
        pin?.fingerprint ?? null,
        pin?.certificate ?? null,
        new Date().toISOString(),
      );
    return id;
  }

  /** Takes a server's tracks out of the library and forgets it (signing out of it, if it answers). */
  remove(id: string) {
    const row = this.#row(id);
    if (!row) throw new HttpError(404, "not_found", "No such server in this library");
    this.#client(row)
      .request("POST", "/api/auth/logout")
      .then((res) => res.resume())
      .catch(() => undefined);
    const db = this.#db;
    db.exec("BEGIN");
    try {
      // Its tracks go with it (ON DELETE CASCADE); its covers not fetched yet can't be anymore.
      db.prepare("DELETE FROM sources WHERE id = ?").run(id);
      db.prepare("UPDATE artwork SET source_id = NULL WHERE source_id = ?").run(id);
      deleteOrphans(db);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    tracksChanged(db);
  }

  /** Syncs every server; true when the catalog changed. A failing one doesn't stop the others. */
  async syncAll(): Promise<boolean> {
    const ids = (this.#db.prepare("SELECT id FROM sources").all() as Row[]).map((r) => String(r.id));
    let changed = false;
    for (const id of ids) if (await this.sync(id)) changed = true;
    return changed;
  }

  /** Brings a server's tracks up to date; true when the catalog changed. Never throws. */
  sync(id: string): Promise<boolean> {
    let running = this.#syncing.get(id);
    if (!running) {
      running = this.#sync(id).finally(() => this.#syncing.delete(id));
      this.#syncing.set(id, running);
    }
    return running;
  }

  async #sync(id: string): Promise<boolean> {
    const row = this.#row(id);
    if (!row) return false;
    const host = new URL(String(row.url)).host;
    const client = this.#client(row);
    const db = this.#db;
    let written = 0;
    let removed = 0;
    try {
      let since = row.library_id ? Number(row.revision) : 0;
      let page = await client.json<SyncPage>(`/api/sync?since=${since}&limit=${PAGE}`);
      if (since > 0 && page.libraryId !== row.library_id) {
        // The server's library was started afresh: its old ids mean nothing anymore.
        since = 0;
        page = await client.json<SyncPage>(`/api/sync?since=0&limit=${PAGE}`);
      }
      const { libraryId, revision, full } = page;
      // A full listing: whatever this library has from the server and isn't listed is gone.
      const unlisted = full
        ? new Set(
            (db.prepare("SELECT remote_id FROM all_tracks WHERE source_id = ?").all(id) as Row[]).map((r) =>
              String(r.remote_id),
            ),
          )
        : null;
      const removeTrack = db.prepare("DELETE FROM all_tracks WHERE source_id = ? AND remote_id = ?");
      const putCover = db.prepare(
        `INSERT INTO artwork (id, path, mime, width, height, dominant_color, source_id) VALUES (?, '', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id WHERE artwork.path = ''`,
      );
      for (;;) {
        db.exec("BEGIN");
        try {
          for (const remoteId of page.removed) removed += Number(removeTrack.run(id, remoteId).changes);
          for (const t of page.tracks) {
            unlisted?.delete(t.id);
            if (t.cover) {
              putCover.run(
                t.cover.id,
                t.cover.mime,
                t.cover.width,
                t.cover.height,
                t.cover.dominantColor,
                id,
              );
            }
            writeTrack(db, {
              path: remotePath(id, t.id),
              mtimeMs: t.modifiedMs,
              size: t.fileSize,
              title: t.title,
              artistCredit: t.artistCredit,
              artist: t.artist,
              albumArtist: t.albumArtist,
              album: t.album,
              trackNumber: t.trackNumber,
              discNumber: t.discNumber,
              year: t.year,
              durationMs: t.durationMs,
              genres: t.genres,
              ...t.format,
              coverId: t.cover?.id ?? null,
              recordingId: t.musicbrainzRecordingId,
              rgTrackGain: t.replayGain.trackGain,
              rgTrackPeak: t.replayGain.trackPeak,
              rgAlbumGain: t.replayGain.albumGain,
              rgAlbumPeak: t.replayGain.albumPeak,
              credits: t.credits,
              rev: null,
              seenScan: 0,
              source: { id, remoteId: t.id },
            });
            written++;
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        if (!page.next) break;
        page = await client.json<SyncPage>(
          `/api/sync?since=${since}&after=${encodeURIComponent(page.next)}&limit=${PAGE}`,
        );
      }
      db.exec("BEGIN");
      try {
        for (const remoteId of unlisted ?? []) removed += Number(removeTrack.run(id, remoteId).changes);
        if (removed) deleteOrphans(db);
        db.prepare(
          "UPDATE sources SET library_id = ?, revision = ?, last_sync_at = ?, last_error = NULL WHERE id = ?",
        ).run(libraryId, revision, new Date().toISOString(), id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      if (written || removed) this.#log.info({ server: host, written, removed }, "server synced");
    } catch (err) {
      const message = describe(err, host);
      this.#log.warn({ server: host, err: message }, "syncing a server failed");
      db.prepare("UPDATE sources SET last_error = ? WHERE id = ?").run(message, id);
    }
    if (written || removed) tracksChanged(db);
    return written > 0 || removed > 0;
  }

  /** Where a server's track is played from; null for this computer's tracks. */
  remote(trackId: string): RemoteTrack | null {
    const r = this.#db
      .prepare(
        `SELECT s.*, t.remote_id FROM all_tracks t JOIN sources s ON s.id = t.source_id WHERE t.id = ?`,
      )
      .get(trackId) as Row | undefined;
    return r ? { client: this.#client(r), sourceId: String(r.id), remoteId: String(r.remote_id) } : null;
  }

  /**
   * A server's copy of a track on this computer (hidden by `dedupe`): played instead when
   * the file can't be read, e.g. a network share that isn't mounted.
   */
  copyOf(trackId: string): RemoteTrack | null {
    const r = this.#db
      .prepare(
        `SELECT s.*, t.remote_id FROM all_tracks t JOIN sources s ON s.id = t.source_id
         WHERE t.duplicate_of = ? ORDER BY s.added_at LIMIT 1`,
      )
      .get(trackId) as Row | undefined;
    return r ? { client: this.#client(r), sourceId: String(r.id), remoteId: String(r.remote_id) } : null;
  }

  /** Starts a track's stream from its server, passing the request's range and format on. */
  stream(
    remote: RemoteTrack,
    query: Record<string, string | number | undefined>,
    headers: OutgoingHttpHeaders,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    return remote.client.get(
      `/api/stream/${encodeURIComponent(remote.remoteId)}?${params.toString()}`,
      headers,
      signal,
    );
  }

  /** A server's track's waveform (cached by `Waveforms` like any other). */
  async waveform(remote: RemoteTrack): Promise<number[]> {
    const w = await remote.client.json<Waveform>(
      `/api/tracks/${encodeURIComponent(remote.remoteId)}/waveform`,
    );
    return w.points;
  }

  /** A server's track's lyrics, as the server finds them. */
  async lyrics(remote: RemoteTrack, trackId: string): Promise<Lyrics> {
    try {
      const l = await remote.client.json<Lyrics>(`/api/tracks/${encodeURIComponent(remote.remoteId)}/lyrics`);
      return { ...l, trackId };
    } catch {
      return { trackId, source: "none", synced: false, instrumental: false, lines: [] };
    }
  }

  /**
   * The file of a cover that came from a server, fetched the first time it's wanted.
   * Null when it can't be (the server is gone or doesn't answer).
   */
  artwork(id: string): Promise<{ path: string; mime: string } | null> {
    let pending = this.#fetchingArt.get(id);
    if (!pending) {
      pending = this.#fetchArtwork(id).finally(() => this.#fetchingArt.delete(id));
      this.#fetchingArt.set(id, pending);
    }
    return pending;
  }

  async #fetchArtwork(id: string): Promise<{ path: string; mime: string } | null> {
    const art = this.#db.prepare("SELECT path, mime, source_id FROM artwork WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!art) return null;
    if (art.path) return { path: art.path as string, mime: String(art.mime) };
    const source = art.source_id ? this.#row(art.source_id as string) : undefined;
    if (!source) return null;
    try {
      const { data } = await this.#client(source).bytes(`/api/artwork/${encodeURIComponent(id)}`);
      const path = await this.#artwork.fill(id, data, String(art.mime));
      return { path, mime: String(art.mime) };
    } catch (err) {
      this.#log.warn({ artwork: id, err: (err as Error).message }, "fetching a cover from a server failed");
      return null;
    }
  }
}
