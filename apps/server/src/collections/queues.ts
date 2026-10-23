import type { QueueOrigin, QueueState, RepeatMode, TrackSource } from "@hyperplayer/schemas";
import type { Catalog } from "../catalog/catalog.ts";
import type { Db } from "../db.ts";
import { HttpError, notFound } from "../http/contract.ts";
import { newId, resolveSource } from "./sources.ts";

type Row = Record<string, unknown>;

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

/** A queue loaded into memory; mutated by the operations below, then saved. */
interface Loaded {
  /** In play order. */
  entries: Entry[];
  /** Index into `entries`, or null when nothing is current (empty or finished). */
  index: number | null;
  shuffle: boolean;
  repeat: RepeatMode;
  positionMs: number;
  origin: QueueOrigin | null;
}

/** Fisher–Yates. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Per-device play queues with shuffle and repeat. Clients never reorder
 * locally: every navigation goes through here, so any client behaves alike.
 */
export class Queues {
  readonly #db: Db;
  readonly #catalog: Catalog;

  constructor(db: Db, catalog: Catalog) {
    this.#db = db;
    this.#catalog = catalog;
  }

  get(who: Who): QueueState {
    return this.#state(this.#load(who.deviceId));
  }

  /** Replaces the queue with `source`, current at `start` (an index in source order). */
  set(who: Who, source: TrackSource, start: number, shuffle?: boolean): QueueState {
    const { trackIds, origin } = resolveSource(this.#db, source, who.userId);
    if (!trackIds.length) throw new HttpError(400, "empty_source", "Nothing to play");
    const q = this.#load(who.deviceId);
    q.entries = trackIds.map((trackId, i) => ({ entryId: newId(), trackId, sourceIndex: i }));
    q.index = Math.min(start, q.entries.length - 1);
    q.origin = origin;
    q.positionMs = 0;
    q.shuffle = shuffle ?? q.shuffle;
    if (q.shuffle) this.#shuffleAroundCurrent(q);
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
    if (changes.shuffle !== undefined && changes.shuffle !== q.shuffle) {
      q.shuffle = changes.shuffle;
      if (q.shuffle) {
        this.#shuffleAroundCurrent(q);
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
    return this.#save(who, q);
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
    const device = who.deviceId;
    const db = this.#db;
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO queues (device_id, user_id, shuffle, repeat, current_entry, position_ms, origin_kind, origin_id, origin_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           user_id = excluded.user_id, shuffle = excluded.shuffle, repeat = excluded.repeat, current_entry = excluded.current_entry,
           position_ms = excluded.position_ms, origin_kind = excluded.origin_kind, origin_id = excluded.origin_id,
           origin_name = excluded.origin_name, updated_at = excluded.updated_at`,
      ).run(
        device,
        who.userId,
        q.shuffle ? 1 : 0,
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
      shuffle: q.shuffle,
      repeat: q.repeat,
      positionMs: q.positionMs,
      origin: q.origin,
      updatedAt: new Date().toISOString(),
    };
  }
}
