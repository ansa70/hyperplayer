import type {
  Album,
  AlbumPage,
  AlbumSummary,
  Artist,
  ArtistPage,
  ArtistSummary,
  Artwork,
  BandMember,
  Credit,
  CreditCategory,
  EnrichmentState,
  ExternalLink,
  NowPlaying,
  SearchResults,
  Track,
  TrackCredits,
  TrackPage,
} from "@hyperplayer/schemas";
import type { Db } from "../db.ts";

type Row = Record<string, unknown>;

/** What the catalog needs to know about the background enrichment worker. */
export interface EnrichmentStatus {
  enabled: boolean;
  isPending(kind: "album" | "artist", id: string): boolean;
}

const CATEGORY_ORDER: CreditCategory[] = ["performance", "composition", "production", "engineering", "other"];

const json = <T>(v: unknown, fallback: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : fallback);
type AlbumSort = "title" | "artist" | "year" | "added";

const num = (v: unknown) => (v == null ? null : Number(v));

/** Artwork columns are selected with a prefix (`c_` for covers, `i_`/`b_` for artist images). */
const ARTWORK = (alias: string, p: string) =>
  `${alias}.id AS ${p}id, ${alias}.mime AS ${p}mime, ${alias}.width AS ${p}width, ${alias}.height AS ${p}height, ${alias}.dominant_color AS ${p}color`;

function artwork(r: Row, p: string): Artwork | null {
  if (r[`${p}id`] == null) return null;
  return {
    id: String(r[`${p}id`]),
    mime: String(r[`${p}mime`]),
    width: num(r[`${p}width`]),
    height: num(r[`${p}height`]),
    dominantColor: (r[`${p}color`] as string | null) ?? null,
  };
}

const ARTIST_SELECT = `
  SELECT ar.*, ${ARTWORK("i", "i_")}, ${ARTWORK("b", "b_")},
         (SELECT COUNT(*) FROM albums WHERE artist_id = ar.id) AS album_count,
         (SELECT COUNT(*) FROM tracks WHERE artist_id = ar.id) AS track_count,
         -- No photo: use the newest cover of an album by, or featuring, the artist.
         (SELECT al.cover_id FROM albums al
           WHERE al.cover_id IS NOT NULL
             AND (al.artist_id = ar.id OR al.id IN (SELECT album_id FROM tracks WHERE artist_id = ar.id))
           ORDER BY al.artist_id = ar.id DESC, al.year DESC LIMIT 1) AS fallback_image_id
  FROM artists ar
  LEFT JOIN artwork i ON i.id = ar.image_id
  LEFT JOIN artwork b ON b.id = ar.banner_id`;

const ALBUM_SELECT = `
  SELECT al.*, ar.name AS artist_name, ${ARTWORK("c", "c_")},
         (SELECT COUNT(*) FROM tracks WHERE album_id = al.id) AS track_count,
         (SELECT COALESCE(SUM(duration_ms), 0) FROM tracks WHERE album_id = al.id) AS duration_ms
  FROM albums al
  JOIN artists ar ON ar.id = al.artist_id
  LEFT JOIN artwork c ON c.id = al.cover_id`;

const TRACK_SELECT = `
  SELECT t.*, COALESCE(t.artist_credit, ar.name) AS artist_name, al.title AS album_title, ${ARTWORK("c", "c_")}
  FROM tracks t
  JOIN artists ar ON ar.id = t.artist_id
  JOIN albums al ON al.id = t.album_id
  LEFT JOIN artwork c ON c.id = COALESCE(t.cover_id, al.cover_id)`;

const ALBUM_ORDER: Record<AlbumSort, string> = {
  title: "al.title COLLATE NOCASE",
  artist: "ar.sort_name COLLATE NOCASE, al.year, al.title COLLATE NOCASE",
  year: "al.year DESC, al.title COLLATE NOCASE",
  added: "al.added_at DESC",
};

export class Catalog {
  readonly #db: Db;
  readonly #enrichment: EnrichmentStatus;

  constructor(db: Db, enrichment: EnrichmentStatus = { enabled: false, isPending: () => false }) {
    this.#db = db;
    this.#enrichment = enrichment;
  }

  #state(kind: "album" | "artist", id: string, status: unknown): EnrichmentState {
    if (status === "done" || status === "not_found") return status;
    if (!this.#enrichment.enabled) return "disabled";
    // Not yet processed: pending while queued; otherwise it failed and will be retried on restart.
    return this.#enrichment.isPending(kind, id) ? "pending" : "not_found";
  }

  /** Local artist id for a credited person, by MusicBrainz id or exact name. */
  #localArtistId(mbid: string | null, name: string): string | null {
    const r = this.#db
      .prepare("SELECT id FROM artists WHERE musicbrainz_id = ? OR name = ? COLLATE NOCASE LIMIT 1")
      .get(mbid, name) as Row | undefined;
    return r ? String(r.id) : null;
  }

  #artistSummary = (r: Row): ArtistSummary => ({
    id: String(r.id),
    name: String(r.name),
    sortName: String(r.sort_name),
    albumCount: Number(r.album_count),
    trackCount: Number(r.track_count),
    image: artwork(r, "i_") ?? (r.fallback_image_id ? this.artwork(r.fallback_image_id as string) : null),
  });

  #artist = (r: Row): Artist => {
    const tagGenres = this.#artistGenres(String(r.id));
    const links = json<ExternalLink[]>(r.links, []);
    const biographyUrl = (r.biography_url as string | null) ?? null;
    return {
      ...this.#artistSummary(r),
      musicbrainzId: (r.musicbrainz_id as string | null) ?? null,
      disambiguation: (r.disambiguation as string | null) ?? null,
      kind: (r.kind as Artist["kind"]) ?? null,
      area: (r.area as string | null) ?? null,
      activeYears: (r.active_years as string | null) ?? null,
      biography: (r.biography as string | null) ?? null,
      biographySource: biographyUrl
        ? { kind: biographyUrl.includes("wikidata.org") ? "wikidata" : "wikipedia", url: biographyUrl }
        : null,
      // File tags describe this library best; MusicBrainz genres fill in when tags have none.
      genres: tagGenres.length ? tagGenres : json<string[]>(r.mb_genres, []),
      banner: artwork(r, "b_"),
      links,
      members: json<Omit<BandMember, "artistId">[]>(r.members, []).map((m) => ({
        ...m,
        artistId: this.#localArtistId(m.musicbrainzId, m.name),
      })),
      enrichment: this.#state("artist", String(r.id), r.enrich_status),
    };
  };

  #albumSummary = (r: Row): AlbumSummary => ({
    id: String(r.id),
    title: String(r.title),
    artistId: String(r.artist_id),
    artistName: String(r.artist_name),
    year: num(r.year),
    trackCount: Number(r.track_count),
    durationMs: Number(r.duration_ms),
    cover: artwork(r, "c_"),
  });

  #track = (r: Row): Track => ({
    id: String(r.id),
    title: String(r.title),
    artistId: String(r.artist_id),
    artistName: String(r.artist_name),
    albumId: String(r.album_id),
    albumTitle: String(r.album_title),
    trackNumber: num(r.track_number),
    discNumber: num(r.disc_number),
    year: num(r.year),
    durationMs: Number(r.duration_ms),
    genres: JSON.parse(String(r.genres)) as string[],
    format: {
      codec: String(r.codec),
      container: String(r.container),
      lossless: Boolean(r.lossless),
      bitrate: num(r.bitrate),
      sampleRate: num(r.sample_rate),
      bitDepth: num(r.bit_depth),
      channels: num(r.channels),
    },
    fileSize: Number(r.file_size),
    cover: artwork(r, "c_"),
  });

  #count(table: string): number {
    return Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
  }

  #artistGenres(artistId: string): string[] {
    const rows = this.#db.prepare("SELECT genres FROM tracks WHERE artist_id = ?").all(artistId) as Row[];
    const counts = new Map<string, number>();
    for (const r of rows)
      for (const g of JSON.parse(String(r.genres)) as string[]) counts.set(g, (counts.get(g) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([g]) => g);
  }

  counts() {
    return { artists: this.#count("artists"), albums: this.#count("albums"), tracks: this.#count("tracks") };
  }

  lastScanAt(): string | null {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'last_scan_at'").get() as
      | Row
      | undefined;
    return (row?.value as string | undefined) ?? null;
  }

  artwork(id: string): Artwork | null {
    const r = this.#db.prepare(`SELECT ${ARTWORK("a", "")} FROM artwork a WHERE a.id = ?`).get(id) as
      | Row
      | undefined;
    return r ? artwork(r, "") : null;
  }

  artworkPath(id: string): { path: string; mime: string } | null {
    const r = this.#db.prepare("SELECT path, mime FROM artwork WHERE id = ?").get(id) as Row | undefined;
    return r ? { path: String(r.path), mime: String(r.mime) } : null;
  }

  trackPath(id: string): { path: string; container: string; fileSize: number } | null {
    const r = this.#db.prepare("SELECT path, container, file_size FROM tracks WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r ? { path: String(r.path), container: String(r.container), fileSize: Number(r.file_size) } : null;
  }

  listArtists(offset: number, limit: number): ArtistPage {
    const rows = this.#db
      .prepare(`${ARTIST_SELECT} ORDER BY ar.sort_name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(limit, offset) as Row[];
    return { items: rows.map(this.#artistSummary), total: this.#count("artists"), offset, limit };
  }

  getArtist(id: string): Artist | null {
    const r = this.#db.prepare(`${ARTIST_SELECT} WHERE ar.id = ?`).get(id) as Row | undefined;
    return r ? this.#artist(r) : null;
  }

  artistAlbums(artistId: string): AlbumSummary[] {
    const rows = this.#db
      .prepare(
        `${ALBUM_SELECT} WHERE al.artist_id = ? OR al.id IN (SELECT album_id FROM tracks WHERE artist_id = ?)
         ORDER BY al.year DESC, al.title COLLATE NOCASE`,
      )
      .all(artistId, artistId) as Row[];
    return rows.map(this.#albumSummary);
  }

  listAlbums(offset: number, limit: number, sort: AlbumSort): AlbumPage {
    const rows = this.#db
      .prepare(`${ALBUM_SELECT} ORDER BY ${ALBUM_ORDER[sort]} LIMIT ? OFFSET ?`)
      .all(limit, offset) as Row[];
    return { items: rows.map(this.#albumSummary), total: this.#count("albums"), offset, limit };
  }

  #albumSummaryById(id: string): AlbumSummary | null {
    const r = this.#db.prepare(`${ALBUM_SELECT} WHERE al.id = ?`).get(id) as Row | undefined;
    return r ? this.#albumSummary(r) : null;
  }

  getAlbum(id: string): Album | null {
    const summary = this.#albumSummaryById(id);
    if (!summary) return null;
    const tracks = (
      this.#db
        .prepare(
          `${TRACK_SELECT} WHERE t.album_id = ? ORDER BY t.disc_number, t.track_number, t.title COLLATE NOCASE`,
        )
        .all(id) as Row[]
    ).map(this.#track);
    const genres = [...new Set(tracks.flatMap((t) => t.genres))];
    return { ...summary, genres, tracks };
  }

  listTracks(offset: number, limit: number): TrackPage {
    const rows = this.#db
      .prepare(
        `${TRACK_SELECT} ORDER BY ar.sort_name COLLATE NOCASE, al.title COLLATE NOCASE, t.disc_number, t.track_number LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Row[];
    return { items: rows.map(this.#track), total: this.#count("tracks"), offset, limit };
  }

  getTrack(id: string): Track | null {
    const r = this.#db.prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
    return r ? this.#track(r) : null;
  }

  /**
   * Credits for a track, one entry per person and scope with their roles merged.
   * MusicBrainz credits replace tag credits once the album has been enriched.
   */
  trackCredits(trackId: string): TrackCredits | null {
    const t = this.#db
      .prepare(
        "SELECT t.album_id, al.enrich_status FROM tracks t JOIN albums al ON al.id = t.album_id WHERE t.id = ?",
      )
      .get(trackId) as Row | undefined;
    if (!t) return null;
    const rows = this.#db
      .prepare(
        `SELECT * FROM credits WHERE track_id = ? AND source = (
           SELECT CASE WHEN EXISTS (SELECT 1 FROM credits WHERE track_id = ? AND source = 'musicbrainz')
                       THEN 'musicbrainz' ELSE 'tags' END)
         ORDER BY position`,
      )
      .all(trackId, trackId) as Row[];

    const merged = new Map<string, Credit>();
    for (const r of rows) {
      const name = String(r.name);
      const mbid = (r.musicbrainz_id as string | null) ?? null;
      const category = r.category as CreditCategory;
      const scope = r.scope as Credit["scope"];
      const key = `${scope}\u0000${category}\u0000${mbid ?? name.toLowerCase()}`;
      const existing = merged.get(key);
      if (existing) {
        if (!existing.roles.includes(String(r.role))) existing.roles.push(String(r.role));
        continue;
      }
      merged.set(key, {
        name,
        artistId: this.#localArtistId(mbid, name),
        musicbrainzId: mbid,
        roles: [String(r.role)],
        category,
        scope,
        source: r.source as Credit["source"],
      });
    }
    // Stable sort keeps MusicBrainz's ordering within each group.
    const credits = [...merged.values()].sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
        Number(a.scope === "album") - Number(b.scope === "album"),
    );
    return { trackId, credits, enrichment: this.#state("album", String(t.album_id), t.enrich_status) };
  }

  nowPlaying(trackId: string): NowPlaying | null {
    const track = this.getTrack(trackId);
    if (!track) return null;
    const album = this.#albumSummaryById(track.albumId)!;
    // Profile the album artist: the track artist may be a featured guest.
    const artist = this.getArtist(album.artistId)!;
    const moreFromArtist = this.artistAlbums(artist.id).filter((a) => a.id !== album.id);
    const { credits, enrichment } = this.trackCredits(trackId)!;
    const pending = enrichment === "pending" || artist.enrichment === "pending";
    return {
      track,
      album,
      artist,
      moreFromArtist,
      credits,
      enrichment: pending ? "pending" : enrichment,
    };
  }

  search(q: string, limit: number): SearchResults {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const artists = this.#db
      .prepare(
        `${ARTIST_SELECT} WHERE ar.name LIKE ? ESCAPE '\\' ORDER BY ar.sort_name COLLATE NOCASE LIMIT ?`,
      )
      .all(like, limit) as Row[];
    const albums = this.#db
      .prepare(`${ALBUM_SELECT} WHERE al.title LIKE ? ESCAPE '\\' ORDER BY al.title COLLATE NOCASE LIMIT ?`)
      .all(like, limit) as Row[];
    const tracks = this.#db
      .prepare(`${TRACK_SELECT} WHERE t.title LIKE ? ESCAPE '\\' ORDER BY t.title COLLATE NOCASE LIMIT ?`)
      .all(like, limit) as Row[];
    return {
      artists: artists.map(this.#artistSummary),
      albums: albums.map(this.#albumSummary),
      tracks: tracks.map(this.#track),
    };
  }
}
