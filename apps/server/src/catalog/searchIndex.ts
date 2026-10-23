import type { Db } from "../db.ts";

/**
 * Full-text index over artists, albums and tracks (SQLite FTS5). `name` is
 * what the entity is called; `context` is what it belongs to (artist, album),
 * so "miles so what" matches the track So What by Miles Davis; `people` holds
 * credited musicians and writers, so "coltrane" finds every track he plays on.
 * The unicode61 tokenizer folds case and diacritics: "beyonce" finds "Beyoncé".
 */
const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  kind UNINDEXED, ref UNINDEXED, name, context, people,
  tokenize = 'unicode61 remove_diacritics 2'
);`;

/** Column weights for bm25(), in table order: own name ≫ belongs-to ≫ credits. */
export const SEARCH_WEIGHTS = "0, 0, 10, 2, 1";

/** Creates the index, recreating it if an older version lacks columns, and fills it when empty. */
export function ensureSearchIndex(db: Db) {
  const columns = (db.prepare("PRAGMA table_info(search_index)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (columns.length && !columns.includes("people")) db.exec("DROP TABLE search_index");
  db.exec(SEARCH_SCHEMA);
  const indexed = db.prepare("SELECT 1 FROM search_index LIMIT 1").get();
  if (!indexed && db.prepare("SELECT 1 FROM tracks LIMIT 1").get()) rebuildSearchIndex(db);
}

/** Rebuilds the whole index; cheap enough to run after every scan or enrichment batch. */
export function rebuildSearchIndex(db: Db) {
  db.exec("BEGIN");
  try {
    db.exec(`
      DELETE FROM search_index;
      INSERT INTO search_index (kind, ref, name, context, people)
        SELECT 'artist', id, name, COALESCE(disambiguation, ''), '' FROM artists;
      INSERT INTO search_index (kind, ref, name, context, people)
        SELECT 'album', al.id, al.title, ar.name, '' FROM albums al JOIN artists ar ON ar.id = al.artist_id;
      INSERT INTO search_index (kind, ref, name, context, people)
        SELECT 'track', t.id, t.title, COALESCE(t.artist_credit, ar.name) || ' ' || ar.name || ' ' || al.title,
               COALESCE((SELECT group_concat(DISTINCT c.name) FROM credits c WHERE c.track_id = t.id AND c.scope = 'track'), '')
        FROM tracks t JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id;
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Turns user input into an FTS5 query: every word must match, each as a
 * prefix ("kin blu" finds Kind of Blue). Returns null when nothing searchable remains.
 */
export function toFtsQuery(input: string): string | null {
  const terms = input
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return terms.length ? terms.map((t) => `"${t}"*`).join(" ") : null;
}
