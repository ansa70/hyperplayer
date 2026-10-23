import { z } from "zod";
import type { HttpClient } from "./http.ts";

const BASE = "https://musicbrainz.org/ws/2";

/*
 * Only the parts of MusicBrainz responses we use. Loose objects so new upstream
 * fields don't break parsing; anything we read is validated.
 */

const ArtistRef = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string().nullish(),
});

const ArtistCredit = z.array(z.looseObject({ name: z.string(), artist: ArtistRef }));

const LifeSpan = z.looseObject({
  begin: z.string().nullish(),
  end: z.string().nullish(),
  ended: z.boolean().nullish(),
});

/** A relationship from the entity being looked up to an artist. */
export const ArtistRelation = z.looseObject({
  type: z.string(),
  direction: z.enum(["forward", "backward"]).optional(),
  "target-type": z.literal("artist"),
  artist: ArtistRef,
  attributes: z.array(z.string()).default([]),
  "target-credit": z.string().nullish(),
  begin: z.string().nullish(),
  end: z.string().nullish(),
  ended: z.boolean().nullish(),
});
export type ArtistRelation = z.infer<typeof ArtistRelation>;

const UrlRelation = z.looseObject({
  type: z.string(),
  "target-type": z.literal("url"),
  url: z.looseObject({ resource: z.string() }),
});

const WorkRelation = z.looseObject({
  type: z.string(),
  "target-type": z.literal("work"),
  work: z.looseObject({
    id: z.string(),
    title: z.string(),
    relations: z.array(z.unknown()).default([]),
  }),
});

/** Keep only relations whose shape we understand; drop the rest (labels, places, …). */
const relations = <S extends z.ZodType>(schema: S) =>
  z
    .array(z.unknown())
    .default([])
    .transform((rels) =>
      rels.flatMap((r) => {
        const parsed = schema.safeParse(r);
        return parsed.success ? [parsed.data as z.output<S>] : [];
      }),
    );

export const Recording = z.looseObject({
  id: z.string(),
  title: z.string(),
  length: z.number().nullish(),
  relations: z.array(z.unknown()).default([]),
});

export const Release = z.looseObject({
  id: z.string(),
  title: z.string(),
  "artist-credit": ArtistCredit.default([]),
  "release-group": z.looseObject({ id: z.string() }).nullish(),
  "cover-art-archive": z.looseObject({ front: z.boolean() }).nullish(),
  relations: relations(ArtistRelation),
  media: z
    .array(
      z.looseObject({
        position: z.number(),
        tracks: z
          .array(
            z.looseObject({
              position: z.number(),
              title: z.string(),
              recording: Recording,
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
export type Release = z.infer<typeof Release>;

export const recordingArtistRelations = relations(ArtistRelation);
export const recordingWorkRelations = relations(WorkRelation);
export const workArtistRelations = relations(ArtistRelation);

const ReleaseGroupReleases = z.looseObject({
  releases: z
    .array(
      z.looseObject({
        id: z.string(),
        date: z.string().nullish(),
        status: z.string().nullish(),
        media: z.array(z.looseObject({ "track-count": z.number() })).default([]),
      }),
    )
    .default([]),
});
export type ReleaseGroupRelease = z.infer<typeof ReleaseGroupReleases>["releases"][number];

const ReleaseSearch = z.looseObject({
  releases: z
    .array(
      z.looseObject({
        id: z.string(),
        score: z.number(),
        title: z.string(),
        status: z.string().nullish(),
        "track-count": z.number().nullish(),
        "artist-credit": ArtistCredit.default([]),
      }),
    )
    .default([]),
});

export const Artist = z.looseObject({
  id: z.string(),
  name: z.string(),
  "sort-name": z.string().nullish(),
  type: z.string().nullish(),
  disambiguation: z.string().nullish(),
  country: z.string().nullish(),
  area: z.looseObject({ name: z.string() }).nullish(),
  "begin-area": z.looseObject({ name: z.string() }).nullish(),
  "life-span": LifeSpan.nullish(),
  genres: z.array(z.looseObject({ name: z.string(), count: z.number() })).default([]),
  relations: z.array(z.unknown()).default([]),
});
export type Artist = z.infer<typeof Artist>;

export const artistArtistRelations = relations(ArtistRelation);
export const artistUrlRelations = relations(UrlRelation);

const ArtistSearch = z.looseObject({
  artists: z.array(z.looseObject({ id: z.string(), name: z.string(), score: z.number() })).default([]),
});

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Lucene-escape a phrase for MusicBrainz search. */
const phrase = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

export class MusicBrainz {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Release with every recording's performers and every work's writers, in one request. */
  release(mbid: string): Promise<Release> {
    const inc =
      "recordings+artist-credits+release-groups+artist-rels+recording-level-rels+work-rels+work-level-rels";
    return this.#http.json(`${BASE}/release/${mbid}?inc=${inc}&fmt=json`, Release);
  }

  /** Other editions of the same album (first 100), without relationships. */
  async releaseGroupReleases(releaseGroupId: string): Promise<ReleaseGroupRelease[]> {
    const res = await this.#http.json(
      `${BASE}/release?release-group=${releaseGroupId}&inc=media&limit=100&fmt=json`,
      ReleaseGroupReleases,
    );
    return res.releases;
  }

  artist(mbid: string): Promise<Artist> {
    return this.#http.json(`${BASE}/artist/${mbid}?inc=url-rels+artist-rels+genres&fmt=json`, Artist);
  }

  /** Best-matching release for an untagged album, or null when nothing is a confident match. */
  async findRelease(artist: string, title: string, trackCount: number): Promise<string | null> {
    const query = `release:${phrase(title)} AND artist:${phrase(artist)}`;
    const { releases } = await this.#http.json(
      `${BASE}/release?query=${encodeURIComponent(query)}&limit=10&fmt=json`,
      ReleaseSearch,
    );
    const candidates = releases.filter(
      (r) =>
        r.score >= 90 &&
        normalize(r.title) === normalize(title) &&
        r["artist-credit"].some((c) => normalize(c.artist.name) === normalize(artist)),
    );
    // Prefer an official release with the same number of tracks we have.
    const rank = (r: (typeof candidates)[number]) =>
      (r["track-count"] === trackCount ? 2 : 0) + (r.status === "Official" ? 1 : 0);
    candidates.sort((a, b) => rank(b) - rank(a) || b.score - a.score);
    return candidates[0]?.id ?? null;
  }

  async findArtist(name: string): Promise<string | null> {
    const { artists } = await this.#http.json(
      `${BASE}/artist?query=${encodeURIComponent(`artist:${phrase(name)}`)}&limit=5&fmt=json`,
      ArtistSearch,
    );
    return artists.find((a) => a.score >= 95 && normalize(a.name) === normalize(name))?.id ?? null;
  }
}
