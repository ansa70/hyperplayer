import type { Artwork, Playlist, PlaylistSummary, SmartRules, TrackSource } from "@hyperplayer/schemas";
import type { Catalog } from "../catalog/catalog.ts";
import type { Db } from "../db.ts";
import { HttpError, notFound } from "../http/contract.ts";
import { checkRules, smartTracks } from "./smart.ts";
import { newId, resolveSource } from "./sources.ts";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const rulesOf = (r: Row) => (r.rules ? (JSON.parse(r.rules as string) as SmartRules) : null);
const notByHand = () =>
  new HttpError(
    409,
    "smart_playlist",
    "A smart playlist's tracks follow from its rules: change those instead",
  );
const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "");

export class Playlists {
  readonly #db: Db;
  readonly #catalog: Catalog;

  constructor(db: Db, catalog: Catalog) {
    this.#db = db;
    this.#catalog = catalog;
  }

  list(owner: string): PlaylistSummary[] {
    const rows = this.#db
      .prepare("SELECT * FROM playlists WHERE owner_id = ? ORDER BY updated_at DESC")
      .all(owner) as Row[];
    return rows.map((r) => this.#summary(r, this.#smart(owner, r)?.trackIds));
  }

  get(owner: string, id: string): Playlist {
    const row = this.#row(owner, id);
    const smart = this.#smart(owner, row);
    if (smart) {
      // Worked out now: the entries are simply the matching tracks.
      const tracks = this.#catalog.tracksByIds(smart.trackIds);
      const at = now();
      return {
        ...this.#summary(row, smart.trackIds),
        matching: smart.matching,
        entries: smart.trackIds.flatMap((trackId) => {
          const t = tracks.get(trackId);
          if (!t) return [];
          return [
            {
              entryId: trackId,
              track: t,
              snapshot: {
                title: t.title,
                artistName: t.artistName,
                albumTitle: t.albumTitle,
                durationMs: t.durationMs,
              },
              addedAt: at,
            },
          ];
        }),
      };
    }
    const entries = this.#db
      .prepare("SELECT * FROM playlist_entries WHERE playlist_id = ? ORDER BY position")
      .all(id) as Row[];
    const tracks = this.#catalog.tracksByIds(
      entries.flatMap((e) => (e.track_id ? [e.track_id as string] : [])),
    );
    return {
      ...this.#summary(row),
      matching: null,
      entries: entries.map((e) => ({
        entryId: String(e.entry_id),
        track: (e.track_id ? tracks.get(e.track_id as string) : undefined) ?? null,
        snapshot: {
          title: String(e.title),
          artistName: String(e.artist_name),
          albumTitle: String(e.album_title),
          durationMs: Number(e.duration_ms),
        },
        addedAt: String(e.added_at),
      })),
    };
  }

  /** A playlist; with `rules`, a smart one (and `trackIds` is ignored). */
  create(
    owner: string,
    name: string,
    description: string | null,
    trackIds: string[] = [],
    rules?: SmartRules,
  ): Playlist {
    if (rules) checkRules(rules);
    const id = newId();
    const at = now();
    this.#db
      .prepare(
        "INSERT INTO playlists (id, owner_id, name, description, rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, owner, name, description, rules ? JSON.stringify(rules) : null, at, at);
    if (trackIds.length && !rules) this.add(owner, id, { kind: "tracks", trackIds });
    return this.get(owner, id);
  }

  update(
    owner: string,
    id: string,
    changes: { name?: string; description?: string | null; rules?: SmartRules },
  ): Playlist {
    const row = this.#row(owner, id);
    if (changes.rules) {
      if (!row.rules) throw new HttpError(409, "not_smart", "Only a smart playlist has rules");
      checkRules(changes.rules);
      this.#db.prepare("UPDATE playlists SET rules = ? WHERE id = ?").run(JSON.stringify(changes.rules), id);
    }
    if (changes.name !== undefined)
      this.#db.prepare("UPDATE playlists SET name = ? WHERE id = ?").run(changes.name, id);
    if (changes.description !== undefined) {
      this.#db.prepare("UPDATE playlists SET description = ? WHERE id = ?").run(changes.description, id);
    }
    this.#touch(id);
    return this.get(owner, id);
  }

  delete(owner: string, id: string) {
    this.#row(owner, id);
    this.#db.prepare("DELETE FROM playlists WHERE id = ?").run(id);
  }

  /** Inserts the source's tracks at `position` (default: the end). */
  add(owner: string, id: string, source: TrackSource, position?: number): Playlist {
    if (this.#row(owner, id).rules) throw notByHand();
    // Resolved up front, so adding a playlist to itself doubles it rather than looping.
    const { trackIds } = resolveSource(this.#db, source, owner);
    if (!trackIds.length) throw new HttpError(400, "empty_source", "Nothing to add");
    const tracks = this.#catalog.tracksByIds(trackIds);
    const order = this.#order(id);
    const at = Math.min(position ?? order.length, order.length);
    const insert = this.#db.prepare(`
      INSERT INTO playlist_entries
        (entry_id, playlist_id, position, track_id, recording_id, title, artist_name, album_title, duration_ms, added_at)
      VALUES (?, ?, 0, ?, (SELECT musicbrainz_recording_id FROM tracks WHERE id = ?), ?, ?, ?, ?, ?)`);
    const added: string[] = [];
    this.#transaction(() => {
      for (const trackId of trackIds) {
        const t = tracks.get(trackId)!;
        const entryId = newId();
        insert.run(entryId, id, trackId, trackId, t.title, t.artistName, t.albumTitle, t.durationMs, now());
        added.push(entryId);
      }
      this.#renumber([...order.slice(0, at), ...added, ...order.slice(at)]);
      this.#touch(id);
    });
    return this.get(owner, id);
  }

  remove(owner: string, id: string, entryId: string): Playlist {
    if (this.#row(owner, id).rules) throw notByHand();
    const order = this.#order(id);
    if (!order.includes(entryId)) throw notFound("Entry");
    this.#transaction(() => {
      this.#db.prepare("DELETE FROM playlist_entries WHERE entry_id = ?").run(entryId);
      this.#renumber(order.filter((e) => e !== entryId));
      this.#touch(id);
    });
    return this.get(owner, id);
  }

  move(owner: string, id: string, entryId: string, toIndex: number): Playlist {
    if (this.#row(owner, id).rules) throw notByHand();
    const order = this.#order(id).filter((e) => e !== entryId);
    if (order.length === this.#order(id).length) throw notFound("Entry");
    order.splice(Math.min(toIndex, order.length), 0, entryId);
    this.#transaction(() => {
      this.#renumber(order);
      this.#touch(id);
    });
    return this.get(owner, id);
  }

  /**
   * Re-attaches entries whose track id no longer exists (file moved, library
   * rescanned) by MusicBrainz recording id, else by title, artist and album.
   */
  relink(): number {
    const orphans = this.#db
      .prepare(
        `SELECT entry_id, recording_id, title, artist_name, album_title FROM playlist_entries
         WHERE track_id IS NULL OR track_id NOT IN (SELECT id FROM tracks)`,
      )
      .all() as Row[];
    if (!orphans.length) return 0;
    const candidates = this.#db
      .prepare(
        `SELECT t.id, t.musicbrainz_recording_id, t.title, COALESCE(t.artist_credit, ar.name) AS artist, al.title AS album
         FROM tracks t JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id`,
      )
      .all() as Row[];
    const byRecording = new Map<string, string>();
    const byText = new Map<string, string>();
    for (const c of candidates) {
      if (c.musicbrainz_recording_id) byRecording.set(c.musicbrainz_recording_id as string, String(c.id));
      byText.set(
        `${normalize(String(c.title))}|${normalize(String(c.artist))}|${normalize(String(c.album))}`,
        String(c.id),
      );
    }
    const update = this.#db.prepare("UPDATE playlist_entries SET track_id = ? WHERE entry_id = ?");
    let relinked = 0;
    for (const o of orphans) {
      const match =
        (o.recording_id ? byRecording.get(o.recording_id as string) : undefined) ??
        byText.get(
          `${normalize(String(o.title))}|${normalize(String(o.artist_name))}|${normalize(String(o.album_title))}`,
        );
      if (match) {
        update.run(match, String(o.entry_id));
        relinked++;
      }
    }
    return relinked;
  }

  #row(owner: string, id: string): Row {
    const row = this.#db.prepare("SELECT * FROM playlists WHERE id = ? AND owner_id = ?").get(id, owner) as
      | Row
      | undefined;
    if (!row) throw notFound("Playlist");
    return row;
  }

  /** A smart playlist's tracks as of now; null for an ordinary playlist. */
  #smart(owner: string, r: Row) {
    const rules = rulesOf(r);
    return rules ? smartTracks(this.#db, owner, rules) : null;
  }

  /** `smart`: a smart playlist's tracks, which the figures and covers are taken from. */
  #summary(r: Row, smart?: string[]): PlaylistSummary {
    const id = String(r.id);
    let trackCount: number;
    let durationMs: number;
    let coverIds: string[];
    if (smart) {
      const tracks = smart.length
        ? (this.#db
            .prepare(
              `SELECT t.id, t.duration_ms, al.cover_id FROM tracks t JOIN albums al ON al.id = t.album_id
               WHERE t.id IN (${smart.map(() => "?").join(",")})`,
            )
            .all(...smart) as Row[])
        : [];
      const byId = new Map(tracks.map((t) => [String(t.id), t]));
      trackCount = tracks.length;
      durationMs = tracks.reduce((ms, t) => ms + Number(t.duration_ms), 0);
      coverIds = [
        ...new Set(smart.flatMap((t) => (byId.get(t)?.cover_id ? [String(byId.get(t)!.cover_id)] : []))),
      ].slice(0, 4);
    } else {
      const stats = this.#db
        .prepare(
          "SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms FROM playlist_entries WHERE playlist_id = ?",
        )
        .get(id) as Row;
      trackCount = Number(stats.n);
      durationMs = Number(stats.ms);
      coverIds = (
        this.#db
          .prepare(
            `SELECT al.cover_id FROM playlist_entries e
             JOIN tracks t ON t.id = e.track_id JOIN albums al ON al.id = t.album_id
             WHERE e.playlist_id = ? AND al.cover_id IS NOT NULL
             GROUP BY al.cover_id ORDER BY MIN(e.position) LIMIT 4`,
          )
          .all(id) as Row[]
      ).map((c) => String(c.cover_id));
    }
    return {
      id,
      name: String(r.name),
      description: (r.description as string | null) ?? null,
      trackCount,
      durationMs,
      rules: rulesOf(r),
      covers: coverIds.flatMap((c): Artwork[] => {
        const art = this.#catalog.artwork(c);
        return art ? [art] : [];
      }),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  #order(id: string): string[] {
    return (
      this.#db
        .prepare("SELECT entry_id FROM playlist_entries WHERE playlist_id = ? ORDER BY position")
        .all(id) as Row[]
    ).map((r) => String(r.entry_id));
  }

  #renumber(entryIds: string[]) {
    const update = this.#db.prepare("UPDATE playlist_entries SET position = ? WHERE entry_id = ?");
    entryIds.forEach((e, i) => update.run(i, e));
  }

  #touch(id: string) {
    this.#db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  #transaction(fn: () => void) {
    this.#db.exec("BEGIN");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }
}
