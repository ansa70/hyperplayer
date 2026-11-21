import type { TagField, TrackTags } from "@hyperplayer/schemas";
import type { Db } from "../db.ts";

type Row = Record<string, unknown>;

/**
 * Tags edited in HyperPlayer. The files are never changed: an edit is kept in `track_edits`
 * with the file's own value, and written over the file's in `all_tracks`, so every query
 * (search, sorting, smart playlists) sees it. A scan that reads the file again writes the
 * file's values, then `reapplyEdits` puts the edits back over them.
 */

/** Each tag and the `all_tracks` column it's kept in. */
const COLUMNS: Record<TagField, string> = {
  title: "title",
  artist: "artist_credit",
  trackNumber: "track_number",
  discNumber: "disc_number",
  year: "year",
  genres: "genres",
};
const FIELDS = Object.keys(COLUMNS) as TagField[];

/** A tag as stored: genres as JSON, as `all_tracks` keeps them. */
const stored = (field: TagField, value: TrackTags[TagField]) =>
  field === "genres" ? JSON.stringify(value) : (value as string | number | null);

const fieldsOf = (row: Row): TagField[] => JSON.parse(String(row.fields)) as TagField[];

/** The file has just been read into `all_tracks` (a scan, a sync): its edits go back over it. */
export function reapplyEdits(db: Db, trackId: string) {
  const edit = db.prepare("SELECT * FROM track_edits WHERE track_id = ?").get(trackId) as Row | undefined;
  if (!edit) return;
  const file = db.prepare("SELECT * FROM all_tracks WHERE id = ?").get(trackId) as Row;
  // The file's own values may have changed (it was retagged): keep them as they are now.
  db.prepare(
    `UPDATE track_edits SET ${FIELDS.map((f) => `file_${COLUMNS[f]} = ?`).join(", ")} WHERE track_id = ?`,
  ).run(...FIELDS.map((f) => file[COLUMNS[f]] as string | number | null), trackId);
  write(db, trackId, fieldsOf(edit), edit);
}

/** Writes the edited tags (`fields`, from `edit`) over the file's in `all_tracks`. */
function write(db: Db, trackId: string, fields: TagField[], edit: Row) {
  if (!fields.length) return;
  db.prepare(`UPDATE all_tracks SET ${fields.map((f) => `${COLUMNS[f]} = ?`).join(", ")} WHERE id = ?`).run(
    ...fields.map((f) => edit[COLUMNS[f]] as string | number | null),
    trackId,
  );
}

/**
 * Edits a track's tags: `tags` to change, `reset` to take back to the file's own. Returns
 * false when there's no such track.
 */
export function editTags(db: Db, trackId: string, tags: Partial<TrackTags>, reset: TagField[]): boolean {
  const current = db.prepare("SELECT * FROM all_tracks WHERE id = ?").get(trackId) as Row | undefined;
  if (!current) return false;
  db.exec("BEGIN");
  try {
    let edit = db.prepare("SELECT * FROM track_edits WHERE track_id = ?").get(trackId) as Row | undefined;
    if (!edit) {
      // No edits yet: what `all_tracks` holds is the file's own.
      db.prepare(
        `INSERT INTO track_edits (track_id, ${FIELDS.map((f) => `file_${COLUMNS[f]}`).join(", ")}, edited_at)
         VALUES (?, ${FIELDS.map(() => "?").join(", ")}, ?)`,
      ).run(
        trackId,
        ...FIELDS.map((f) => current[COLUMNS[f]] as string | number | null),
        new Date().toISOString(),
      );
      edit = db.prepare("SELECT * FROM track_edits WHERE track_id = ?").get(trackId) as Row;
    }
    const fields = new Set(fieldsOf(edit));
    for (const field of FIELDS) {
      if (tags[field] === undefined) continue;
      const value = stored(field, tags[field]);
      // Edited to what the file says: not an edit.
      const same =
        field === "genres"
          ? value === String((edit[`file_${COLUMNS[field]}`] as string | null) ?? "[]")
          : value === (edit[`file_${COLUMNS[field]}`] ?? null);
      if (same) fields.delete(field);
      else fields.add(field);
      edit[COLUMNS[field]] = value;
    }
    for (const field of reset) fields.delete(field);

    // Every tag back to the file's, then the edits over them.
    const restored = FIELDS.filter((f) => !fields.has(f));
    if (restored.length)
      db.prepare(
        `UPDATE all_tracks SET ${restored.map((f) => `${COLUMNS[f]} = ?`).join(", ")} WHERE id = ?`,
      ).run(...restored.map((f) => edit[`file_${COLUMNS[f]}`] as string | number | null), trackId);
    if (fields.size) {
      db.prepare(
        `UPDATE track_edits SET ${FIELDS.map((f) => `${COLUMNS[f]} = ?`).join(", ")}, fields = ?, edited_at = ?
         WHERE track_id = ?`,
      ).run(
        ...FIELDS.map((f) => (fields.has(f) ? (edit[COLUMNS[f]] as string | number | null) : null)),
        JSON.stringify(FIELDS.filter((f) => fields.has(f))),
        new Date().toISOString(),
        trackId,
      );
      write(db, trackId, [...fields], edit);
    } else {
      db.prepare("DELETE FROM track_edits WHERE track_id = ?").run(trackId);
    }
    // Libraries copying this one (standalone players) take the change at their next sync.
    db.prepare(
      `UPDATE all_tracks SET rev = COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'scan_generation'), 0) + 1
       WHERE id = ?`,
    ).run(trackId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  // The search finds it by its new title and artist.
  db.prepare(
    `UPDATE search_index SET name = (SELECT title FROM all_tracks WHERE id = ?1),
       context = (SELECT COALESCE(t.artist_credit, ar.name) || ' ' || ar.name || ' ' || al.title
                  FROM all_tracks t JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id
                  WHERE t.id = ?1)
     WHERE kind = 'track' AND ref = ?1`,
  ).run(trackId);
  return true;
}

/** A track's tags as shown, the file's own, and which are edited; null when there's no such track. */
export function trackTags(
  db: Db,
  trackId: string,
): { tags: TrackTags; original: TrackTags; edited: TagField[] } | null {
  const t = db
    .prepare(
      `SELECT t.*, ar.name AS artist_name FROM all_tracks t JOIN artists ar ON ar.id = t.artist_id WHERE t.id = ?`,
    )
    .get(trackId) as Row | undefined;
  if (!t) return null;
  const edit = db.prepare("SELECT * FROM track_edits WHERE track_id = ?").get(trackId) as Row | undefined;
  const tags = (r: Row, prefix: string): TrackTags => ({
    title: String(r[`${prefix}title`] ?? t.title),
    artist: String(r[`${prefix}artist_credit`] ?? t.artist_name),
    trackNumber: (r[`${prefix}track_number`] as number | null) ?? null,
    discNumber: (r[`${prefix}disc_number`] as number | null) ?? null,
    year: (r[`${prefix}year`] as number | null) ?? null,
    genres: JSON.parse((r[`${prefix}genres`] as string | null) ?? "[]") as string[],
  });
  return {
    tags: tags(t, ""),
    original: edit ? tags(edit, "file_") : tags(t, ""),
    edited: edit ? fieldsOf(edit) : [],
  };
}
