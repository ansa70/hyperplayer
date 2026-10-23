import type { BandMember, ExternalLink } from "@hyperplayer/schemas";
import type { FastifyBaseLogger } from "fastify";
import { rebuildSearchIndex } from "../catalog/searchIndex.ts";
import type { Db } from "../db.ts";
import type { ArtworkStore } from "../library/artwork.ts";
import type { CreditRow } from "../library/tagCredits.ts";
import { matchTracks, releaseCredits, type LocalTrack, type ReleaseTrackCredits } from "./credits.ts";
import { httpClient, NotFound, type HttpClient } from "./http.ts";
import {
  artistArtistRelations,
  artistUrlRelations,
  MusicBrainz,
  type Artist as MbArtist,
  type Release,
  type ReleaseGroupRelease,
} from "./musicbrainz.ts";
import { Fanart, Wikipedia } from "./wikipedia.ts";

export interface EnrichConfig {
  enabled: boolean;
  contact: string;
  wikiLang: string;
  fanartKey: string | null;
}

type Job = `album:${string}` | `artist:${string}`;
type Row = Record<string, unknown>;

/** MusicBrainz's "Various Artists" and "[unknown]" special-purpose artists. */
const SPECIAL_ARTISTS = new Set([
  "89ad4ac3-39f7-470e-963a-56509c546377",
  "125ec42a-7229-4250-afc5-e057484327fe",
]);
/** Share of tracks that must carry performer/writer credits before a release is considered credited. */
const CREDITED_THRESHOLD = 0.5;
/** How many sibling releases to try when the library's own release has no credits. */
const MAX_SIBLING_RELEASES = 4;

const URL_KINDS: Record<string, ExternalLink["kind"]> = {
  "official homepage": "homepage",
  wikipedia: "wikipedia",
  wikidata: "wikidata",
  discogs: "discogs",
  allmusic: "allmusic",
  "last.fm": "lastfm",
  bandcamp: "bandcamp",
};

const year = (date: string | null | undefined) => date?.slice(0, 4) ?? null;

function lifeSpan(a: MbArtist): string | null {
  const span = a["life-span"];
  const begin = year(span?.begin);
  const end = year(span?.end);
  if (!begin && !end) return null;
  if (a.type === "Person") return end ? `${begin ?? "?"}–${end}` : `b. ${begin}`;
  return `${begin ?? "?"}–${end ?? (span?.ended ? "?" : "present")}`;
}

function members(a: MbArtist): Omit<BandMember, "artistId">[] {
  const byMember = new Map<string, Omit<BandMember, "artistId"> & { spans: string[] }>();
  for (const rel of artistArtistRelations.parse(a.relations)) {
    // "backward" member-of-band relations point from members to this group.
    if (rel.type !== "member of band" || rel.direction !== "backward") continue;
    const m = byMember.get(rel.artist.id) ?? {
      name: rel.artist.name,
      musicbrainzId: rel.artist.id,
      roles: [],
      years: null,
      current: false,
      spans: [],
    };
    for (const role of rel.attributes) {
      // "eponymous" marks the member the band is named after; it isn't a role.
      if (!["original", "founder", "eponymous"].includes(role) && !m.roles.includes(role)) m.roles.push(role);
    }
    const [b, e] = [year(rel.begin), year(rel.end)];
    if (b || e) m.spans.push(b === e ? `${b}` : `${b ?? "?"}–${e ?? (rel.ended ? "?" : "present")}`);
    m.current ||= !rel.ended;
    byMember.set(rel.artist.id, m);
  }
  return [...byMember.values()]
    .map(({ spans, ...m }) => ({ ...m, years: spans.length ? spans.join(", ") : null }))
    .sort((x, y) => Number(y.current) - Number(x.current));
}

function links(a: MbArtist): ExternalLink[] {
  const out: ExternalLink[] = [{ kind: "musicbrainz", url: `https://musicbrainz.org/artist/${a.id}` }];
  for (const rel of artistUrlRelations.parse(a.relations)) {
    const kind = URL_KINDS[rel.type];
    if (kind && !out.some((l) => l.kind === kind)) out.push({ kind, url: rel.url.resource });
  }
  return out;
}

const KINDS: Record<string, string> = {
  Person: "person",
  Group: "group",
  Orchestra: "orchestra",
  Choir: "choir",
  Character: "character",
};

/**
 * Background worker that fetches credits and artist profiles. Jobs run one at
 * a time (MusicBrainz allows one request per second); `prioritize` moves the
 * currently playing album and artist to the front of the queue.
 */
export class Enricher {
  readonly #db: Db;
  readonly #artwork: ArtworkStore;
  readonly #log: FastifyBaseLogger;
  readonly #config: EnrichConfig;
  readonly #http: HttpClient;
  readonly #mb: MusicBrainz;
  readonly #wiki: Wikipedia;
  readonly #fanart: Fanart | null;
  #queue: Job[] = [];
  /** Jobs that failed with a transient error; retried on the next server start. */
  readonly #failed = new Set<Job>();
  #running = false;
  #stopped = false;

  constructor(
    db: Db,
    artwork: ArtworkStore,
    log: FastifyBaseLogger,
    config: EnrichConfig,
    http?: HttpClient,
  ) {
    this.#db = db;
    this.#artwork = artwork;
    this.#log = log;
    this.#config = config;
    this.#http =
      http ??
      httpClient({
        userAgent: `HyperPlayer/0.1.0 ( ${config.contact} )`,
        minIntervalMs: { "musicbrainz.org": 1100 },
      });
    this.#mb = new MusicBrainz(this.#http);
    this.#wiki = new Wikipedia(this.#http, config.wikiLang);
    this.#fanart = config.fanartKey ? new Fanart(this.#http, config.fanartKey) : null;
  }

  get enabled() {
    return this.#config.enabled;
  }

  get queueSize() {
    return this.#queue.length;
  }

  /** Queues every album and artist that has never been enriched. */
  enqueuePending() {
    if (!this.enabled) return;
    const albums = this.#db.prepare("SELECT id FROM albums WHERE enrich_status IS NULL").all() as Row[];
    const artists = this.#db.prepare("SELECT id FROM artists WHERE enrich_status IS NULL").all() as Row[];
    for (const r of albums) this.#push(`album:${String(r.id)}`);
    for (const r of artists) this.#push(`artist:${String(r.id)}`);
    void this.#run();
  }

  /** Moves the album and artists of a track to the front of the queue. */
  prioritizeTrack(trackId: string) {
    const t = this.#db
      .prepare(
        "SELECT t.album_id, t.artist_id, al.artist_id AS album_artist_id, al.enrich_status FROM tracks t JOIN albums al ON al.id = t.album_id WHERE t.id = ?",
      )
      .get(trackId) as Row | undefined;
    if (!t || !this.enabled) return;
    for (const job of [
      `artist:${String(t.artist_id)}`,
      `artist:${String(t.album_artist_id)}`,
      `album:${String(t.album_id)}`,
    ] as Job[]) {
      if (this.#queue.includes(job)) this.#push(job, true);
    }
    void this.#run();
  }

  /** Forgets an artist's enrichment and fetches it again ahead of everything else. */
  refreshArtist(artistId: string) {
    if (!this.enabled) return;
    this.#db.prepare("UPDATE artists SET enrich_status = NULL WHERE id = ?").run(artistId);
    this.#failed.delete(`artist:${artistId}`);
    this.#push(`artist:${artistId}`, true);
    void this.#run();
  }

  /** `pending` while an entity is queued, so clients know to poll again. */
  isPending(kind: "album" | "artist", id: string): boolean {
    return this.enabled && this.#queue.includes(`${kind}:${id}`);
  }

  stop() {
    this.#stopped = true;
  }

  #push(job: Job, front = false) {
    if (this.#failed.has(job)) return;
    const i = this.#queue.indexOf(job);
    if (i >= 0) {
      if (!front) return;
      this.#queue.splice(i, 1);
    }
    if (front) this.#queue.unshift(job);
    else this.#queue.push(job);
  }

  async #run() {
    if (this.#running) return;
    this.#running = true;
    try {
      // Peek rather than shift: the job stays "pending" for clients until it has finished.
      for (let job = this.#queue[0]; job && !this.#stopped; job = this.#queue[0]) {
        const [kind, id] = job.split(/:(.*)/s) as ["album" | "artist", string];
        try {
          if (kind === "album") await this.#album(id);
          else await this.#artist(id);
        } catch (err) {
          this.#failed.add(job);
          this.#log.warn({ err: (err as Error).message, job }, "enrichment failed");
        }
        this.#queue.splice(this.#queue.indexOf(job), 1);
      }
      // Artists may have been renamed to their canonical names.
      if (!this.#stopped) rebuildSearchIndex(this.#db);
    } finally {
      this.#running = false;
    }
  }

  // ------------------------------------------------------------------ albums

  async #album(albumId: string) {
    const db = this.#db;
    const album = db
      .prepare(
        `SELECT al.id, al.title, al.musicbrainz_id, al.cover_id, ar.id AS artist_id, ar.name AS artist_name,
                ar.musicbrainz_id AS artist_mbid
         FROM albums al JOIN artists ar ON ar.id = al.artist_id WHERE al.id = ?`,
      )
      .get(albumId) as Row | undefined;
    if (!album) return;
    const local: LocalTrack[] = (
      db
        .prepare(
          "SELECT id, musicbrainz_recording_id, disc_number, track_number, title FROM tracks WHERE album_id = ?",
        )
        .all(albumId) as Row[]
    ).map((r) => ({
      id: String(r.id),
      recordingId: (r.musicbrainz_recording_id as string | null) ?? null,
      disc: (r.disc_number as number | null) ?? null,
      position: (r.track_number as number | null) ?? null,
      title: String(r.title),
    }));

    const releaseId =
      (album.musicbrainz_id as string | null) ??
      (await this.#mb.findRelease(String(album.artist_name), String(album.title), local.length));
    if (!releaseId) {
      db.prepare("UPDATE albums SET enrich_status = 'not_found', enriched_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        albumId,
      );
      return;
    }

    const release = await this.#mb.release(releaseId);
    let { tracks: remote, album: albumCredits } = releaseCredits(release);
    let matched = matchTracks(local, remote);
    if (creditedShare(matched) < CREDITED_THRESHOLD && release["release-group"]) {
      const sibling = await this.#creditedSibling(release, local);
      if (sibling) {
        matched = sibling.matched;
        // Release-wide credits (producer, mix) are kept from both editions.
        albumCredits = dedupeRows([...albumCredits, ...sibling.album]);
        remote = sibling.remote;
      }
    }

    db.exec("BEGIN");
    try {
      const del = db.prepare("DELETE FROM credits WHERE track_id = ? AND source = 'musicbrainz'");
      const ins = db.prepare(`
        INSERT INTO credits (track_id, source, scope, category, name, musicbrainz_id, role, position)
        VALUES (?, 'musicbrainz', ?, ?, ?, ?, ?, ?)`);
      for (const t of local) {
        del.run(t.id);
        const rows: [string, CreditRow][] = [
          ...(matched.get(t.id)?.credits ?? []).map((c) => ["track", c] as [string, CreditRow]),
          ...albumCredits.map((c) => ["album", c] as [string, CreditRow]),
        ];
        rows.forEach(([scope, c], i) => ins.run(t.id, scope, c.category, c.name, c.musicbrainzId, c.role, i));
      }
      db.prepare(
        "UPDATE albums SET musicbrainz_id = ?, enrich_status = 'done', enriched_at = ? WHERE id = ?",
      ).run(releaseId, new Date().toISOString(), albumId);
      const credit = release["artist-credit"];
      if (!album.artist_mbid && credit.length === 1) {
        db.prepare("UPDATE artists SET musicbrainz_id = ? WHERE id = ? AND musicbrainz_id IS NULL").run(
          credit[0]!.artist.id,
          String(album.artist_id),
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    this.#log.info({ album: album.title, release: releaseId, tracks: matched.size }, "album enriched");

    if (!album.cover_id && release["cover-art-archive"]?.front) {
      const coverId = await this.#download(`https://coverartarchive.org/release/${releaseId}/front-500`);
      if (coverId) db.prepare("UPDATE albums SET cover_id = ? WHERE id = ?").run(coverId, albumId);
    }
    this.#push(`artist:${String(album.artist_id)}`);
  }

  /** Looks for another edition of the album whose recordings carry credits. */
  async #creditedSibling(release: Release, local: LocalTrack[]) {
    const counts = release.media.map((m) => m.tracks.length).join("/");
    const siblings = (await this.#mb.releaseGroupReleases(release["release-group"]!.id))
      .filter((r) => r.id !== release.id)
      .sort(
        (a, b) =>
          siblingRank(b, counts) - siblingRank(a, counts) ||
          (a.date ?? "9999").localeCompare(b.date ?? "9999"),
      )
      .slice(0, MAX_SIBLING_RELEASES);
    // Recording ids differ between editions, so match on disc/position and title only.
    const byPosition = local.map((t) => ({ ...t, recordingId: null }));
    for (const s of siblings) {
      const { tracks, album } = releaseCredits(await this.#mb.release(s.id));
      const matched = matchTracks(byPosition, tracks);
      if (creditedShare(matched) >= CREDITED_THRESHOLD) {
        this.#log.info({ release: release.id, creditsFrom: s.id }, "using credits from another edition");
        return { matched, album, remote: tracks };
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- artists

  async #artist(artistId: string) {
    const db = this.#db;
    const row = db
      .prepare("SELECT id, name, musicbrainz_id, image_id FROM artists WHERE id = ?")
      .get(artistId) as Row | undefined;
    if (!row) return;
    const mbid = (row.musicbrainz_id as string | null) ?? (await this.#mb.findArtist(String(row.name)));
    if (!mbid || SPECIAL_ARTISTS.has(mbid)) {
      db.prepare("UPDATE artists SET enrich_status = 'not_found', enriched_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        artistId,
      );
      return;
    }

    let a: MbArtist;
    try {
      a = await this.#mb.artist(mbid);
    } catch (err) {
      if (!(err instanceof NotFound)) throw err;
      db.prepare("UPDATE artists SET enrich_status = 'not_found' WHERE id = ?").run(artistId);
      return;
    }
    const artistLinks = links(a);
    const wikidata = artistLinks.find((l) => l.kind === "wikidata");
    const wiki = wikidata ? await this.#wiki.profile(wikidata.url).catch(() => null) : null;
    if (wiki?.biographyUrl?.includes("wikipedia.org") && !artistLinks.some((l) => l.kind === "wikipedia")) {
      artistLinks.push({ kind: "wikipedia", url: wiki.biographyUrl });
    }

    const fanart = this.#fanart ? await this.#fanart.artist(mbid).catch(() => null) : null;
    const imageUrl = fanart?.thumb ?? wiki?.imageUrl ?? null;
    const imageId = imageUrl ? await this.#download(imageUrl) : null;
    const bannerId = fanart?.background ? await this.#download(fanart.background) : null;

    const area = [a["begin-area"]?.name, a.area?.name]
      .filter((v, i, all) => v && all.indexOf(v) === i)
      .join(", ");
    const genres = [...a.genres]
      .sort((x, y) => y.count - x.count)
      .slice(0, 5)
      .map((g) => g.name);

    db.prepare(
      `UPDATE artists SET
         name = ?, sort_name = ?, musicbrainz_id = ?, disambiguation = ?, kind = ?, area = ?, active_years = ?, biography = ?,
         biography_url = ?, mb_genres = ?, links = ?, members = ?,
         image_id = COALESCE(?, image_id), banner_id = COALESCE(?, banner_id),
         enrich_status = 'done', enriched_at = ?
       WHERE id = ?`,
    ).run(
      a.name,
      a["sort-name"] || a.name,
      mbid,
      a.disambiguation || null,
      a.type ? (KINDS[a.type] ?? "other") : null,
      area || null,
      lifeSpan(a),
      wiki?.biography ?? null,
      wiki?.biographyUrl ?? null,
      JSON.stringify(genres),
      JSON.stringify(artistLinks),
      JSON.stringify(members(a)),
      imageId,
      bannerId,
      new Date().toISOString(),
      artistId,
    );
    this.#log.info({ artist: row.name, mbid }, "artist enriched");
  }

  async #download(url: string): Promise<string | null> {
    try {
      const { data, mime } = await this.#http.bytes(url);
      return await this.#artwork.put(data, mime);
    } catch (err) {
      this.#log.warn({ err: (err as Error).message, url }, "image download failed");
      return null;
    }
  }
}

function creditedShare(matched: Map<string, ReleaseTrackCredits>): number {
  if (matched.size === 0) return 0;
  let credited = 0;
  for (const t of matched.values()) {
    if (t.credits.some((c) => c.category === "performance" || c.category === "composition")) credited++;
  }
  return credited / matched.size;
}

function siblingRank(r: ReleaseGroupRelease, trackCounts: string): number {
  return (
    (r.media.map((m) => m["track-count"]).join("/") === trackCounts ? 2 : 0) +
    (r.status === "Official" ? 1 : 0)
  );
}

function dedupeRows(rows: CreditRow[]): CreditRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.musicbrainzId ?? r.name}\u0000${r.role}`;
    return !seen.has(key) && (seen.add(key), true);
  });
}
