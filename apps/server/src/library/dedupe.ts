import { rebuildSearchIndex } from "../catalog/searchIndex.ts";
import { type Db, sortKey } from "../db.ts";

/** Copies whose lengths differ by more than this are different recordings (an edit, a live take). */
const DURATION_TOLERANCE_MS = 3_000;

interface Copy {
  id: string;
  album: string;
  disc: number;
  track: number | null;
  title: string;
  recording: string | null;
  durationMs: number;
  /** Lower is preferred: this computer's files, then servers in the order they were added. */
  place: number;
  lossless: boolean;
  bitrate: number;
  shownAs: string | null;
  /** An upload's owner; null for the shared library. */
  owner: string | null;
}

/** Shared copies first (an upload is seen by its owner only), then this computer's, then the better file. */
const better = (a: Copy, b: Copy) =>
  Number(a.owner !== null) - Number(b.owner !== null) ||
  a.place - b.place ||
  Number(b.lossless) - Number(a.lossless) ||
  b.bitrate - a.bitrate ||
  (a.id < b.id ? -1 : 1);

/**
 * Finds the tracks that are in the library more than once (on this computer and on a
 * server, or in two folders) and shows one copy of each: this computer's over a server's
 * (it plays without the network), then the better file. A copy is the same track when it's
 * on the same album at the same disc and track number, with the same title (or the same
 * MusicBrainz recording) and nearly the same length. Returns how many copies changed.
 */
export function dedupe(db: Db): number {
  const rows = db
    .prepare(
      `SELECT t.id, t.album_id, t.disc_number, t.track_number, t.title, t.musicbrainz_recording_id,
              t.duration_ms, t.lossless, t.bitrate, t.duplicate_of, t.owner_id,
              CASE WHEN t.source_id IS NULL THEN 0
                   ELSE 1 + (SELECT COUNT(*) FROM sources o WHERE o.added_at < s.added_at) END AS place
       FROM all_tracks t LEFT JOIN sources s ON s.id = t.source_id`,
    )
    .all() as Record<string, unknown>[];
  const copies: Copy[] = rows.map((r) => ({
    id: String(r.id),
    album: String(r.album_id),
    disc: Number(r.disc_number ?? 1),
    track: r.track_number == null ? null : Number(r.track_number),
    title: sortKey(String(r.title)),
    recording: (r.musicbrainz_recording_id as string | null) ?? null,
    durationMs: Number(r.duration_ms),
    place: Number(r.place),
    lossless: Boolean(r.lossless),
    bitrate: Number(r.bitrate ?? 0),
    shownAs: (r.duplicate_of as string | null) ?? null,
    owner: (r.owner_id as string | null) ?? null,
  }));

  // Copies grouped by position on the album, then joined by title or recording.
  const parent = new Map(copies.map((c) => [c.id, c.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const byPosition = new Map<string, Copy[]>();
  for (const c of copies) {
    const key = `${c.album}\u0000${c.disc}\u0000${c.track ?? ""}`;
    let list = byPosition.get(key);
    if (!list) byPosition.set(key, (list = []));
    list.push(c);
  }
  for (const list of byPosition.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const sameName = a.title === b.title || (a.recording !== null && a.recording === b.recording);
        // Two people's uploads are never copies of each other: either would hide the
        // other's from its owner. (Through a shared copy they may meet: then it's shown.)
        const sameOwner = a.owner === null || b.owner === null || a.owner === b.owner;
        if (sameOwner && sameName && Math.abs(a.durationMs - b.durationMs) <= DURATION_TOLERANCE_MS) {
          parent.set(find(a.id), find(b.id));
        }
      }
    }
  }
  const groups = new Map<string, Copy[]>();
  for (const c of copies) {
    const root = find(c.id);
    let group = groups.get(root);
    if (!group) groups.set(root, (group = []));
    group.push(c);
  }

  // The copy to show first (so the triggers move references onto it), then the others.
  const show = db.prepare("UPDATE all_tracks SET duplicate_of = NULL WHERE id = ?");
  const hide = db.prepare("UPDATE all_tracks SET duplicate_of = ? WHERE id = ?");
  let changed = 0;
  db.exec("BEGIN");
  try {
    for (const group of groups.values()) {
      group.sort(better);
      const [shown, ...others] = group;
      if (shown!.shownAs !== null) {
        show.run(shown!.id);
        changed++;
      }
      for (const c of others) {
        if (c.shownAs !== shown!.id) {
          hide.run(shown!.id, c.id);
          changed++;
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return changed;
}

/** After tracks were added, changed or removed: which copies are shown, then the search index. */
export function tracksChanged(db: Db) {
  dedupe(db);
  rebuildSearchIndex(db);
}
