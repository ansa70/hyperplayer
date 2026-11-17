import { DatabaseSync } from "node:sqlite";
import { ensureSearchIndex } from "./catalog/searchIndex.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artwork (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  mime           TEXT NOT NULL,
  width          INTEGER,
  height         INTEGER,
  dominant_color TEXT
);

CREATE TABLE IF NOT EXISTS artists (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  sort_name      TEXT NOT NULL,
  musicbrainz_id TEXT,
  biography      TEXT,
  image_id       TEXT REFERENCES artwork(id),
  banner_id      TEXT REFERENCES artwork(id)
);

CREATE TABLE IF NOT EXISTS albums (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  year      INTEGER,
  cover_id  TEXT REFERENCES artwork(id),
  added_at  TEXT NOT NULL
);

-- Servers whose music is part of this library (a standalone player's engine): their
-- tracks are copied into the catalog and played from the server.
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL UNIQUE,
  username     TEXT NOT NULL,
  token        TEXT NOT NULL,
  -- A self-signed certificate the user trusted: its SHA-256 and PEM, the only one accepted.
  fingerprint  TEXT,
  certificate  TEXT,
  library_id   TEXT,
  revision     INTEGER NOT NULL DEFAULT 0,
  added_at     TEXT NOT NULL,
  last_sync_at TEXT,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS tracks (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  mtime_ms     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  artist_id    TEXT NOT NULL REFERENCES artists(id),
  album_id     TEXT NOT NULL REFERENCES albums(id),
  track_number INTEGER,
  disc_number  INTEGER,
  year         INTEGER,
  duration_ms  INTEGER NOT NULL,
  genres       TEXT NOT NULL DEFAULT '[]',
  codec        TEXT NOT NULL,
  container    TEXT NOT NULL,
  lossless     INTEGER NOT NULL,
  bitrate      INTEGER,
  sample_rate  INTEGER,
  bit_depth    INTEGER,
  channels     INTEGER,
  file_size    INTEGER NOT NULL,
  cover_id     TEXT REFERENCES artwork(id),
  seen_scan    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS albums_artist ON albums(artist_id);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Tracks removed from the library, by the scan that removed them, for /api/sync.
CREATE TABLE IF NOT EXISTS removed_tracks (
  id  TEXT PRIMARY KEY,
  rev INTEGER NOT NULL
);

-- One row per (person, role) on a track; the catalog merges roles per person.
CREATE TABLE IF NOT EXISTS credits (
  track_id       TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,             -- 'musicbrainz' | 'tags'
  scope          TEXT NOT NULL,             -- 'track' | 'album'
  category       TEXT NOT NULL,
  name           TEXT NOT NULL,
  musicbrainz_id TEXT,
  role           TEXT NOT NULL,
  position       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credits_track ON credits(track_id, source);

CREATE TABLE IF NOT EXISTS waveforms (
  track_id    TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  track_mtime INTEGER NOT NULL,            -- the file's mtime when computed: a new file is recomputed
  points      TEXT NOT NULL                -- JSON array of 0..100
);

CREATE TABLE IF NOT EXISTS lyrics (
  track_id      TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  track_mtime   INTEGER NOT NULL,          -- the file's mtime when looked up: a retag invalidates
  source        TEXT NOT NULL,             -- 'file' | 'tags' | 'lrclib' | 'none'
  synced        INTEGER NOT NULL,
  instrumental  INTEGER NOT NULL,
  lines         TEXT NOT NULL,             -- JSON [{timeMs, text}]
  fetched_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Entries keep a snapshot of the track, not a foreign key: a file that moves or
-- a library that is briefly unmounted must not silently empty playlists.
CREATE TABLE IF NOT EXISTS playlist_entries (
  entry_id     TEXT PRIMARY KEY,
  playlist_id  TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  track_id     TEXT,
  recording_id TEXT,
  title        TEXT NOT NULL,
  artist_name  TEXT NOT NULL,
  album_title  TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL,
  added_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS playlist_entries_order ON playlist_entries(playlist_id, position);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  admin         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

-- One row per signed-in client. Only a SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queues (
  device_id     TEXT PRIMARY KEY,
  shuffle       INTEGER NOT NULL DEFAULT 0,
  repeat        TEXT NOT NULL DEFAULT 'off',
  current_entry TEXT,
  position_ms   INTEGER NOT NULL DEFAULT 0,
  origin_kind   TEXT,
  origin_id     TEXT,
  origin_name   TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_entries (
  device_id    TEXT NOT NULL REFERENCES queues(device_id) ON DELETE CASCADE,
  entry_id     TEXT NOT NULL,
  track_id     TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  -- Order the tracks were queued in (restored when shuffle is turned off) and play order.
  source_index INTEGER NOT NULL,
  play_index   INTEGER NOT NULL,
  PRIMARY KEY (device_id, entry_id)
);

-- One row per listen. Keyed by start time so a client retrying a report can't double count.
CREATE TABLE IF NOT EXISTS listens (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  played_ms   INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id, started_at)
);
CREATE INDEX IF NOT EXISTS listens_recent ON listens(user_id, started_at);

-- Services a user's listens are sent to. The token (a Last.fm session key) is needed to submit, so it's stored as is.
CREATE TABLE IF NOT EXISTS scrobble_accounts (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service           TEXT NOT NULL,             -- 'listenbrainz' or 'lastfm'
  token             TEXT NOT NULL,
  username          TEXT NOT NULL,
  connected_at      TEXT NOT NULL,
  last_error        TEXT,
  last_submitted_at TEXT,
  PRIMARY KEY (user_id, service)
);

-- Listens waiting to be sent; a row is deleted once the service has it.
CREATE TABLE IF NOT EXISTS scrobbles (
  user_id         TEXT NOT NULL,
  service         TEXT NOT NULL,
  track_id        TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  started_at      TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  PRIMARY KEY (user_id, service, track_id, started_at),
  FOREIGN KEY (user_id, service) REFERENCES scrobble_accounts(user_id, service) ON DELETE CASCADE
);
`;

/** Columns added after the first schema version, applied to existing databases. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["artists", "disambiguation", "TEXT"],
  ["artists", "kind", "TEXT"],
  ["artists", "area", "TEXT"],
  ["artists", "active_years", "TEXT"],
  ["artists", "biography_url", "TEXT"],
  ["artists", "mb_genres", "TEXT"],
  ["artists", "links", "TEXT"],
  ["artists", "members", "TEXT"],
  ["artists", "enrich_status", "TEXT"],
  ["artists", "enriched_at", "TEXT"],
  ["albums", "musicbrainz_id", "TEXT"],
  ["albums", "enrich_status", "TEXT"],
  ["albums", "enriched_at", "TEXT"],
  ["tracks", "musicbrainz_recording_id", "TEXT"],
  ["tracks", "artist_credit", "TEXT"],
  ["playlists", "owner_id", "TEXT REFERENCES users(id) ON DELETE CASCADE"],
  ["queues", "user_id", "TEXT REFERENCES users(id) ON DELETE CASCADE"],
  // A smart playlist's rules (JSON); null for an ordinary one.
  ["playlists", "rules", "TEXT"],
  // The shuffle button's draw (JSON) and the queue it returns to.
  ["queues", "shuffle_context", "TEXT"],
  ["queues", "shuffle_base", "TEXT"],
  ["users", "must_change_password", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "full_name", "TEXT"],
  ["tracks", "rg_track_gain", "REAL"],
  ["tracks", "rg_track_peak", "REAL"],
  ["tracks", "rg_album_gain", "REAL"],
  ["tracks", "rg_album_peak", "REAL"],
  // The scan generation that last wrote the track (for /api/sync); null before it existed.
  ["tracks", "rev", "INTEGER"],
  // A track from a server (see `sources`), and its id there; null for this library's files.
  ["tracks", "source_id", "TEXT REFERENCES sources(id) ON DELETE CASCADE"],
  ["tracks", "remote_id", "TEXT"],
  // A server's cover not fetched yet has an empty path.
  ["artwork", "source_id", "TEXT"],
  // Another copy of the track is the one shown (see `separateCopies`).
  ["tracks", "duplicate_of", "TEXT"],
  // A playlist copied from a server, and its id there. It stays when the server is removed.
  ["playlists", "source_id", "TEXT REFERENCES sources(id) ON DELETE SET NULL"],
  ["playlists", "remote_id", "TEXT"],
  // The part of the track to play (see `TrackTrim`); `trim_set` once someone decided.
  ["tracks", "trim_start_ms", "INTEGER"],
  ["tracks", "trim_end_ms", "INTEGER"],
  ["tracks", "trim_set", "INTEGER NOT NULL DEFAULT 0"],
  // Silence at the ends of the audio, found with the waveform; null before it was looked for.
  ["waveforms", "leading_silence_ms", "INTEGER"],
  ["waveforms", "trailing_silence_ms", "INTEGER"],
];

/** The table tracks are stored in: `all_tracks` once `separateCopies` has run. */
function tracksTable(db: DatabaseSync): string {
  const r = db.prepare("SELECT type FROM sqlite_master WHERE name = 'tracks'").get() as
    | { type: string }
    | undefined;
  return r?.type === "view" ? "all_tracks" : "tracks";
}

function migrate(db: DatabaseSync) {
  const tracks = tracksTable(db);
  for (const [name, column, definition] of ADDED_COLUMNS) {
    const table = name === "tracks" ? tracks : name;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  // Here rather than in SCHEMA: `tracks` becomes a view, which can't be indexed.
  db.exec(`CREATE INDEX IF NOT EXISTS tracks_album ON ${tracks}(album_id, disc_number, track_number)`);
  db.exec(`CREATE INDEX IF NOT EXISTS tracks_artist ON ${tracks}(artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS tracks_rev ON ${tracks}(rev, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS tracks_source ON ${tracks}(source_id, remote_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS tracks_duplicate ON ${tracks}(duplicate_of)`);
}

/** References to a track that follow it to the copy shown instead (`$from` → `$to`). */
const MOVE_REFERENCES = `
    UPDATE queue_entries SET track_id = $to WHERE track_id = $from;
    UPDATE playlist_entries SET track_id = $to WHERE track_id = $from;
    UPDATE OR IGNORE listens SET track_id = $to WHERE track_id = $from;
    UPDATE OR IGNORE scrobbles SET track_id = $to WHERE track_id = $from;`;

/** Which of a deleted track's hidden copies is shown in its place: as in `dedupe`, local first. */
const SUCCESSOR = `(SELECT c.id FROM all_tracks c WHERE c.duplicate_of = OLD.id
                    ORDER BY c.source_id IS NOT NULL, c.lossless DESC, c.bitrate DESC, c.id LIMIT 1)`;

/**
 * The same track can be in the library more than once: on this computer and on a server
 * (a standalone player's source), or in two folders. Every copy is kept in `all_tracks`,
 * but only one is shown: the others have `duplicate_of` set, and `tracks`, which every
 * query reads, leaves them out. Writes go to `all_tracks`.
 *
 * Triggers keep queues, playlists and history on the copy shown: when a copy is hidden
 * they move to the one shown instead, and when the one shown is deleted (its file gone)
 * another copy takes its place, with them.
 */
function separateCopies(db: DatabaseSync) {
  if (tracksTable(db) === "tracks") {
    // Other tables' foreign keys follow the rename.
    db.exec("ALTER TABLE tracks RENAME TO all_tracks");
    db.exec("CREATE VIEW tracks AS SELECT * FROM all_tracks WHERE duplicate_of IS NULL");
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS all_tracks_hidden AFTER UPDATE OF duplicate_of ON all_tracks
    WHEN NEW.duplicate_of IS NOT NULL BEGIN
      ${MOVE_REFERENCES.replaceAll("$to", "NEW.duplicate_of").replaceAll("$from", "NEW.id")}
      UPDATE all_tracks SET duplicate_of = NEW.duplicate_of WHERE duplicate_of = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS all_tracks_succeeded BEFORE DELETE ON all_tracks
    WHEN EXISTS (SELECT 1 FROM all_tracks WHERE duplicate_of = OLD.id) BEGIN
      ${MOVE_REFERENCES.replaceAll("$to", SUCCESSOR).replaceAll("$from", "OLD.id")}
      UPDATE all_tracks SET duplicate_of = ${SUCCESSOR} WHERE duplicate_of = OLD.id AND id <> ${SUCCESSOR};
      UPDATE all_tracks SET duplicate_of = NULL WHERE duplicate_of = OLD.id;
    END;`);
}

export type Db = DatabaseSync;

/**
 * How a displayed name sorts: case- and accent-insensitive, ignoring a leading
 * article ("The Beatles" under B). Deliberately not MusicBrainz's sort names
 * ("Davis, Miles"), which would file artists under letters their shown name
 * doesn't start with.
 */
export function sortKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .trim();
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.function("sort_key", { deterministic: true }, (name) => sortKey(String(name ?? "")));
  db.exec(SCHEMA);
  migrate(db);
  separateCopies(db);
  ensureSearchIndex(db);
  return db;
}
