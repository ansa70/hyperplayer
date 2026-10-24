import type { QueueOrigin, QueueState, RepeatMode, ShuffleScope, TrackSource } from "@hyperplayer/schemas";
import type { Catalog } from "../catalog/catalog.ts";
import type { Db } from "../db.ts";
import { IN_GENRE } from "../catalog/genres.ts";
import { HttpError, notFound } from "../http/contract.ts";
import { newId, resolveSource } from "./sources.ts";

type Row = Record<string, unknown>;

/** Tracks the shuffle button keeps drawn ahead of the current one, and played ones kept behind it. */
const SHUFFLE_AHEAD = 25;
const SHUFFLE_BEHIND = 50;

/** The device whose queue this is, and its user (who may play their own playlists into it). */
export interface Who {
  deviceId: string;
  userId: string;
}

interface Entry {
  entryId: string;
  trackId: string;
  /** Position in the order the tracks were queued (restored when shuffle goes off). */
  sourceIndex: number;
}

/**
 * The shuffle button's draw: laps through a scope's tracks in an order fixed by `seed`.
 * The order is recomputed when needed rather than stored, so a library-wide lap costs a
 * few numbers, and the queue only holds a window of it.
 */
interface ShuffleContext {
  /** As chosen; drawn from the library instead when the track has no genre. */
  scope: ShuffleScope;
  /** The album or artist id, or the genre, drawn from; null for the library. */
  key: string | null;
  seed: number;
  /** How far into this lap's order the draw has got. */
  cursor: number;
  /** Left out of the lap: the track that was playing when shuffle started opens it instead. */
  exclude: string | null;
  /** Not to open the lap: the track that ended the previous one. */
  avoidFirst: string | null;
  /** This lap is drawn out; the next one starts only when reached (and repeat allows). */
  done: boolean;
  /**
   * A smart playlist's tracks, as the queue had them when shuffle started: its rules may
   * pick differently each time (random order), which would break the laps. At most 500.
   */
  tracks?: string[];
}

/** The queue as it was when the shuffle button went on, to return to when it goes off. */
interface ShuffleBase {
  entries: Entry[];
  origin: QueueOrigin | null;
}

/** A queue loaded into memory; mutated by the operations below, then saved. */
interface Loaded {
  /** In play order. */
  entries: Entry[];
  /** Index into `entries`, or null when nothing is current (empty or finished). */
  index: number | null;
  shuffle: boolean;
  /** Set while the shuffle button draws from a scope; null for a shuffled source (or no shuffle). */
  context: ShuffleContext | null;
  base: ShuffleBase | null;
  repeat: RepeatMode;
  positionMs: number;
  origin: QueueOrigin | null;
}

/** Fisher–Yates; `rand` gives a repeatable order where one is needed. */
function shuffled<T>(items: T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Mulberry32: a small seeded generator, so a lap's order can be recomputed from its seed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const newSeed = () => Math.floor(Math.random() * 2 ** 32);

/** Where `advance(auto: true)` from `index` will go, if that's already decided. */
function upNext(index: number, length: number, q: Loaded): number | null {
  if (q.repeat === "one") return index;
  if (index + 1 < length) return index + 1;
  // Wrapping around: a shuffled lap gets its new order only when it starts.
  if (q.repeat === "all" && !q.shuffle) return 0;
  return null;
}

/**
 * Per-device play queues with shuffle and repeat. Clients never reorder
 * locally: every navigation goes through here, so any client behaves alike.
 */
export class Queues {
  readonly #db: Db;
  readonly #catalog: Catalog;
  /** The user's choice of what the shuffle button draws from. */
  readonly #shuffleScope: (userId: string) => ShuffleScope;

  constructor(db: Db, catalog: Catalog, shuffleScope: (userId: string) => ShuffleScope) {
    this.#db = db;
    this.#catalog = catalog;
    this.#shuffleScope = shuffleScope;
  }

  get(who: Who): QueueState {
    return this.#state(this.#load(who.deviceId));
  }

  /**
   * Replaces the queue with `source`, current at `start` (an index in source order). With
   * `shuffle` and a `scope`, it's drawn from that scope (the user's choice stays as it is).
   */
  set(who: Who, source: TrackSource, start: number, shuffle?: boolean, scope?: ShuffleScope): QueueState {
    const { trackIds, origin } = resolveSource(this.#db, source, who.userId);
    if (!trackIds.length) throw new HttpError(400, "empty_source", "Nothing to play");
    const q = this.#load(who.deviceId);
    q.entries = trackIds.map((trackId, i) => ({ entryId: newId(), trackId, sourceIndex: i }));
    q.index = Math.min(start, q.entries.length - 1);
    q.origin = origin;
    q.positionMs = 0;
    q.base = null;
    if (shuffle && scope) {
      this.#startShuffle(q, who.userId, scope);
    } else if (shuffle === undefined && q.shuffle && q.context) {
      // The shuffle button is on: draw around the chosen track; turning it off returns here.
      this.#startShuffle(q, who.userId);
    } else {
      q.context = null;
      q.shuffle = shuffle ?? q.shuffle;
      if (q.shuffle) this.#shuffleAroundCurrent(q);
    }
    return this.#save(who, q);
  }

  add(who: Who, source: TrackSource, placement: "next" | "end"): QueueState {
    const { trackIds } = resolveSource(this.#db, source, who.userId);
    if (!trackIds.length) throw new HttpError(400, "empty_source", "Nothing to queue");
    const q = this.#load(who.deviceId);
    const added = trackIds.map((trackId) => ({ entryId: newId(), trackId, sourceIndex: 0 }));
    // Source order: queued tracks go after the current one ("next") or last ("end").
    const bySource = [...q.entries].sort((a, b) => a.sourceIndex - b.sourceIndex);
    const current = q.index === null ? undefined : q.entries[q.index];
    const sourceAt = placement === "next" && current ? bySource.indexOf(current) + 1 : bySource.length;
    bySource.splice(sourceAt, 0, ...added);
    bySource.forEach((e, i) => (e.sourceIndex = i));
    // Play order: same rule.
    const playAt = placement === "next" && q.index !== null ? q.index + 1 : q.entries.length;
    q.entries.splice(playAt, 0, ...added);
    return this.#save(who, q);
  }

  remove(who: Who, entryId: string): QueueState {
    const q = this.#load(who.deviceId);
    const at = q.entries.findIndex((e) => e.entryId === entryId);
    if (at < 0) throw notFound("Queue entry");
    q.entries.splice(at, 1);
    if (q.index !== null) {
      if (at < q.index) q.index--;
      // Removing the current entry makes the following one current (the client starts it).
      else if (at === q.index) {
        q.positionMs = 0;
        if (q.index >= q.entries.length) q.index = null;
      }
    }
    return this.#save(who, q);
  }

  /** Next track; `auto` means the current one ended by itself (repeat-one replays it). */
  advance(who: Who, auto: boolean): QueueState {
    const q = this.#load(who.deviceId);
    q.positionMs = 0;
    if (!q.entries.length) return this.#state(q);
    if (q.index === null) {
      // Finished (or never started): play from the top.
      q.index = 0;
    } else if (auto && q.repeat === "one") {
      // Same track again.
    } else if (q.index + 1 < q.entries.length) {
      q.index++;
    } else if (q.repeat !== "off" && q.context) {
      this.#nextLap(q);
      if (q.index + 1 < q.entries.length) q.index++;
      else q.index = null;
    } else if (q.repeat !== "off") {
      if (q.shuffle) this.#reshuffleForNextLap(q);
      q.index = 0;
    } else {
      q.index = null;
    }
    return this.#save(who, q);
  }

  /** Previous track; wraps with repeat-all, otherwise stays on the first. */
  back(who: Who): QueueState {
    const q = this.#load(who.deviceId);
    q.positionMs = 0;
    if (!q.entries.length) return this.#state(q);
    if (q.index === null) q.index = q.entries.length - 1;
    else if (q.index > 0) q.index--;
    else if (q.repeat === "all") q.index = q.entries.length - 1;
    return this.#save(who, q);
  }

  jump(who: Who, entryId: string): QueueState {
    const q = this.#load(who.deviceId);
    const at = q.entries.findIndex((e) => e.entryId === entryId);
    if (at < 0) throw notFound("Queue entry");
    q.index = at;
    q.positionMs = 0;
    return this.#save(who, q);
  }

  update(who: Who, changes: { shuffle?: boolean; repeat?: RepeatMode; positionMs?: number }): QueueState {
    const q = this.#load(who.deviceId);
    if (changes.repeat) q.repeat = changes.repeat;
    if (changes.positionMs !== undefined) q.positionMs = changes.positionMs;
    if (changes.shuffle === true) {
      // Already drawing from the right scope with something to play: nothing to do.
      const drawing = q.shuffle && q.context?.scope === this.#shuffleScope(who.userId) && q.index !== null;
      if (!drawing) this.#startShuffle(q, who.userId);
    } else if (changes.shuffle === false && q.shuffle) {
      q.shuffle = false;
      if (q.context) {
        this.#endShuffle(q);
      } else {
        // Back to queued order, continuing from the current track.
        const current = q.index === null ? undefined : q.entries[q.index];
        q.entries.sort((a, b) => a.sourceIndex - b.sourceIndex);
        q.index = current ? q.entries.indexOf(current) : null;
      }
    }
    return this.#save(who, q);
  }

  clear(who: Who): QueueState {
    const q = this.#load(who.deviceId);
    q.entries = [];
    q.index = null;
    q.origin = null;
    q.positionMs = 0;
    q.base = null;
    // The shuffle button stays on: whatever plays next is drawn around.
    if (q.context) q.context.done = true;
    return this.#save(who, q);
  }

  /**
   * The shuffle button went on (or its scope changed): the current track, then tracks drawn
   * from the user's scope around it. With nothing playing, the first drawn track starts.
   */
  #startShuffle(q: Loaded, userId: string, scope = this.#shuffleScope(userId)) {
    const current = q.index === null ? undefined : q.entries[q.index];
    if (!q.base) {
      // A shuffled source goes back to its own order.
      const entries = q.shuffle ? [...q.entries].sort((a, b) => a.sourceIndex - b.sourceIndex) : q.entries;
      q.base = { entries, origin: q.origin };
    }
    const { key, origin } = this.#scopeOf(scope, current?.trackId, q.base.origin);
    q.context = {
      scope,
      key,
      seed: newSeed(),
      cursor: 0,
      exclude: current?.trackId ?? null,
      avoidFirst: null,
      done: false,
    };
    const playlist = scope === "playlist" && key ? this.#playlistRules(key) : null;
    if (playlist) {
      // The tracks the queue was just built from: asked again, its rules might pick others.
      q.context.tracks = [...new Set(q.base.entries.map((e) => e.trackId))];
    }
    q.shuffle = true;
    q.origin = origin;
    q.entries = current ? [current] : [];
    q.index = current ? 0 : null;
    this.#draw(q);
    if (!current && q.entries.length) {
      q.index = 0;
      q.positionMs = 0;
    }
  }

  /** A smart playlist's rules (as stored); null for an ordinary playlist. */
  #playlistRules(id: string): string | null {
    const row = this.#db.prepare("SELECT rules FROM playlists WHERE id = ?").get(id) as Row | undefined;
    return (row?.rules as string | null | undefined) ?? null;
  }

  /** The shuffle button went off: back to the queue from before, at the current track if it's there. */
  #endShuffle(q: Loaded) {
    const current = q.index === null ? undefined : q.entries[q.index];
    const base = q.base ?? { entries: current ? [current] : [], origin: q.origin };
    q.context = null;
    q.base = null;
    q.origin = base.origin;
    q.entries = base.entries;
    if (!current) {
      q.index = null;
      return;
    }
    let at = base.entries.findIndex((e) => e.entryId === current.entryId);
    if (at < 0) at = base.entries.findIndex((e) => e.trackId === current.trackId);
    if (at >= 0) {
      // The same entry as playing, so clients don't take it for a new one and restart it.
      q.entries = base.entries.map((e, i) => (i === at ? { ...e, entryId: current.entryId } : e));
    } else {
      // Drawn from elsewhere: it finishes playing, then the queue stops.
      q.entries = [...base.entries, { ...current, sourceIndex: base.entries.length }];
      at = q.entries.length - 1;
    }
    q.index = at;
  }

  /**
   * What `scope` means around `trackId`, in a queue started from `from`: the library when
   * there's nothing to go by (no track, no genre, not a playlist).
   */
  #scopeOf(
    scope: ShuffleScope,
    trackId: string | undefined,
    from: QueueOrigin | null,
  ): { key: string | null; origin: QueueOrigin } {
    const library = { key: null, origin: { kind: "shuffle" as const, id: null, name: "Library" } };
    if (scope === "playlist") {
      return from?.kind === "playlist" && from.id
        ? { key: from.id, origin: { kind: "shuffle", id: from.id, name: from.name } }
        : library;
    }
    if (scope === "library" || !trackId) return library;
    const row = this.#db
      .prepare(
        `SELECT t.album_id, al.title AS album_title, t.artist_id, ar.name AS artist_name, t.genres, ar.mb_genres
         FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.artist_id
         WHERE t.id = ?`,
      )
      .get(trackId) as Row | undefined;
    if (!row) return library;
    const shuffle = (id: string | null, name: string) => ({ kind: "shuffle" as const, id, name });
    switch (scope) {
      case "album":
        return { key: String(row.album_id), origin: shuffle(String(row.album_id), String(row.album_title)) };
      case "artist":
        return {
          key: String(row.artist_id),
          origin: shuffle(String(row.artist_id), String(row.artist_name)),
        };
      case "genre": {
        // As the catalog does: file tags first, the artist's MusicBrainz genres otherwise.
        const tags = JSON.parse(String(row.genres)) as string[];
        const genre = tags[0] ?? (JSON.parse((row.mb_genres as string | null) ?? "[]") as string[])[0];
        return genre ? { key: genre, origin: shuffle(null, genre) } : library;
      }
    }
  }

  /** Every track in the context, in a stable order for the lap's seed to shuffle. */
  #contextTracks(c: ShuffleContext): string[] {
    if (c.tracks) return [...c.tracks].sort();
    const ids = (sql: string, ...args: string[]) =>
      (this.#db.prepare(sql).all(...args) as Row[]).map((r) => String(r.id));
    if (c.key === null) return ids("SELECT id FROM tracks ORDER BY id");
    switch (c.scope) {
      case "album":
        return ids("SELECT id FROM tracks WHERE album_id = ? ORDER BY id", c.key);
      case "artist":
        return ids(
          `SELECT t.id FROM tracks t JOIN albums al ON al.id = t.album_id
           WHERE t.artist_id = ? OR al.artist_id = ? ORDER BY t.id`,
          c.key,
          c.key,
        );
      case "playlist":
        // Each track once, however often it's listed; entries whose file is missing are skipped.
        return ids(
          `SELECT DISTINCT e.track_id AS id FROM playlist_entries e JOIN tracks t ON t.id = e.track_id
           WHERE e.playlist_id = ? ORDER BY e.track_id`,
          c.key,
        );
      default:
        return ids(
          `SELECT t.id FROM tracks t JOIN artists ar ON ar.id = t.artist_id WHERE ${IN_GENRE} ORDER BY t.id`,
          c.key,
        );
    }
  }

  /** Tops the shuffle up to SHUFFLE_AHEAD tracks past the current one, and lets old ones go. */
  #draw(q: Loaded) {
    const c = q.context;
    if (!c) return;
    const ahead = () => q.entries.length - (q.index === null ? 0 : q.index + 1);
    if (!c.done && ahead() < SHUFFLE_AHEAD) {
      let order = shuffled(
        this.#contextTracks(c).filter((id) => id !== c.exclude),
        seeded(c.seed),
      );
      if (c.avoidFirst && order.length > 1 && order[0] === c.avoidFirst) {
        order = [order[1]!, order[0], ...order.slice(2)];
      }
      while (ahead() < SHUFFLE_AHEAD && c.cursor < order.length) {
        q.entries.push({ entryId: newId(), trackId: order[c.cursor++]!, sourceIndex: 0 });
      }
      if (c.cursor >= order.length) c.done = true;
    }
    if (q.index !== null && q.index > SHUFFLE_BEHIND) {
      q.entries.splice(0, q.index - SHUFFLE_BEHIND);
      q.index = SHUFFLE_BEHIND;
    }
  }

  /** Another lap of the shuffle's scope, not opening with the track that just played. */
  #nextLap(q: Loaded) {
    const c = q.context!;
    const last = q.index === null ? undefined : q.entries[q.index];
    Object.assign(c, {
      seed: newSeed(),
      cursor: 0,
      exclude: null,
      avoidFirst: last?.trackId ?? null,
      done: false,
    });
    this.#draw(q);
  }

  /** Current entry first, everything else in random order after it. */
  #shuffleAroundCurrent(q: Loaded) {
    const current = q.index === null ? undefined : q.entries[q.index];
    const rest = shuffled(q.entries.filter((e) => e !== current));
    q.entries = current ? [current, ...rest] : rest;
    q.index = current ? 0 : null;
  }

  /** New random order for another lap, never starting with the track that just played. */
  #reshuffleForNextLap(q: Loaded) {
    const last = q.index === null ? undefined : q.entries[q.index];
    q.entries = shuffled(q.entries);
    if (q.entries.length > 1 && q.entries[0] === last) {
      const swap = 1 + Math.floor(Math.random() * (q.entries.length - 1));
      [q.entries[0], q.entries[swap]] = [q.entries[swap]!, q.entries[0]!];
    }
  }

  #load(device: string): Loaded {
    const row = this.#db.prepare("SELECT * FROM queues WHERE device_id = ?").get(device) as Row | undefined;
    // Entries whose track left the library were removed by the foreign key; play_index may have gaps.
    const entries = (
      this.#db
        .prepare(
          "SELECT entry_id, track_id, source_index FROM queue_entries WHERE device_id = ? ORDER BY play_index",
        )
        .all(device) as Row[]
    ).map((r) => ({
      entryId: String(r.entry_id),
      trackId: String(r.track_id),
      sourceIndex: Number(r.source_index),
    }));
    const currentIndex = row?.current_entry ? entries.findIndex((e) => e.entryId === row.current_entry) : -1;
    return {
      entries,
      index: currentIndex >= 0 ? currentIndex : null,
      shuffle: Boolean(row?.shuffle),
      context: row?.shuffle_context ? (JSON.parse(row.shuffle_context as string) as ShuffleContext) : null,
      base: row?.shuffle_base ? (JSON.parse(row.shuffle_base as string) as ShuffleBase) : null,
      repeat: (row?.repeat as RepeatMode | undefined) ?? "off",
      positionMs: Number(row?.position_ms ?? 0),
      origin: row?.origin_kind
        ? {
            kind: row.origin_kind as QueueOrigin["kind"],
            id: (row.origin_id as string | null) ?? null,
            name: (row.origin_name as string | null) ?? null,
          }
        : null,
    };
  }

  #save(who: Who, q: Loaded): QueueState {
    this.#draw(q);
    const device = who.deviceId;
    const db = this.#db;
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO queues (device_id, user_id, shuffle, shuffle_context, shuffle_base, repeat, current_entry, position_ms,
           origin_kind, origin_id, origin_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           user_id = excluded.user_id, shuffle = excluded.shuffle, shuffle_context = excluded.shuffle_context,
           shuffle_base = excluded.shuffle_base, repeat = excluded.repeat, current_entry = excluded.current_entry,
           position_ms = excluded.position_ms, origin_kind = excluded.origin_kind, origin_id = excluded.origin_id,
           origin_name = excluded.origin_name, updated_at = excluded.updated_at`,
      ).run(
        device,
        who.userId,
        q.shuffle ? 1 : 0,
        q.context ? JSON.stringify(q.context) : null,
        q.base ? JSON.stringify(q.base) : null,
        q.repeat,
        q.index === null ? null : q.entries[q.index]!.entryId,
        q.positionMs,
        q.origin?.kind ?? null,
        q.origin?.id ?? null,
        q.origin?.name ?? null,
        new Date().toISOString(),
      );
      db.prepare("DELETE FROM queue_entries WHERE device_id = ?").run(device);
      const insert = db.prepare(
        "INSERT INTO queue_entries (device_id, entry_id, track_id, source_index, play_index) VALUES (?, ?, ?, ?, ?)",
      );
      q.entries.forEach((e, i) => insert.run(device, e.entryId, e.trackId, e.sourceIndex, i));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return this.#state(q);
  }

  #state(q: Loaded): QueueState {
    const tracks = this.#catalog.tracksByIds(q.entries.map((e) => e.trackId));
    const current = q.index === null ? undefined : q.entries[q.index];
    // Normally every entry has its track (the foreign key cascades); filter defensively
    // and point `index` into the filtered list.
    const visible = q.entries.filter((e) => tracks.has(e.trackId));
    const index = current ? visible.indexOf(current) : -1;
    return {
      entries: visible.map((e) => ({ entryId: e.entryId, track: tracks.get(e.trackId)! })),
      index: index >= 0 ? index : null,
      upNext: index >= 0 ? upNext(index, visible.length, q) : null,
      shuffle: q.shuffle,
      shuffleScope: q.context && (q.context.key === null ? "library" : q.context.scope),
      repeat: q.repeat,
      positionMs: q.positionMs,
      origin: q.origin,
      updatedAt: new Date().toISOString(),
    };
  }
}
