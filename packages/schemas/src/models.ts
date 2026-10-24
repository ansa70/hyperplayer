import { z } from "zod";

/**
 * Domain models shared by the server (validation, serialization) and the
 * client (generated Rust types). Every schema that crosses the wire is
 * registered in `registry` under a stable name, which becomes the type name
 * in the generated JSON Schema / OpenAPI documents.
 */
export const registry = z.registry<{ id: string; description?: string }>();

export const named = <T extends z.ZodType>(id: string, schema: T, description?: string): T => {
  registry.add(schema, { id, description });
  return schema;
};

/** Opaque, stable identifier (hex digest derived from the library content). */
export const Id = named("Id", z.string().min(1));

const Count = z.int().nonnegative();
const DurationMs = z.int().nonnegative();
const Year = z.int().min(0).max(9999);

export const Artwork = named(
  "Artwork",
  z.object({
    id: Id,
    mime: z.string(),
    width: z.int().positive().nullable(),
    height: z.int().positive().nullable(),
    /** Dominant colour as `#rrggbb`, used by clients to theme the UI around the cover. */
    dominantColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/)
      .nullable(),
  }),
  "An image stored by the server (cover, artist photo, banner).",
);

export const ExternalLink = named(
  "ExternalLink",
  z.object({
    kind: z.enum([
      "homepage",
      "wikipedia",
      "wikidata",
      "musicbrainz",
      "discogs",
      "allmusic",
      "lastfm",
      "bandcamp",
    ]),
    url: z.url(),
  }),
);

export const EnrichmentState = named(
  "EnrichmentState",
  z.enum(["pending", "done", "not_found", "disabled"]),
  "Progress of fetching external metadata (MusicBrainz, Wikipedia, …) for an entity.",
);

export const BandMember = named(
  "BandMember",
  z.object({
    name: z.string(),
    /** Set when the member is also an artist in the local library. */
    artistId: Id.nullable(),
    musicbrainzId: z.string().nullable(),
    /** Instruments / roles within the band, e.g. `guitar`, `lead vocals`. */
    roles: z.array(z.string()),
    /** Human-readable tenure, e.g. `1965–1985`. */
    years: z.string().nullable(),
    current: z.boolean(),
  }),
);

export const ArtistSummary = named(
  "ArtistSummary",
  z.object({
    id: Id,
    name: z.string(),
    sortName: z.string(),
    albumCount: Count,
    trackCount: Count,
    image: Artwork.nullable(),
  }),
);

export const Artist = named(
  "Artist",
  ArtistSummary.extend({
    musicbrainzId: z.string().nullable(),
    disambiguation: z.string().nullable(),
    kind: z.enum(["person", "group", "orchestra", "choir", "character", "other"]).nullable(),
    /** Country or city the artist is from. */
    area: z.string().nullable(),
    /** Lifespan for people, active years for groups, e.g. `1926–1991`. */
    activeYears: z.string().nullable(),
    biography: z.string().nullable(),
    biographySource: ExternalLink.nullable(),
    genres: z.array(z.string()),
    /** Wide image for "now playing" backdrops. */
    banner: Artwork.nullable(),
    links: z.array(ExternalLink),
    members: z.array(BandMember),
    enrichment: EnrichmentState,
  }),
  "Full artist profile, including enrichment data when available.",
);

export const AlbumSummary = named(
  "AlbumSummary",
  z.object({
    id: Id,
    title: z.string(),
    artistId: Id,
    artistName: z.string(),
    year: Year.nullable(),
    trackCount: Count,
    durationMs: DurationMs,
    cover: Artwork.nullable(),
  }),
);

export const AudioFormat = named(
  "AudioFormat",
  z.object({
    codec: z.string(),
    container: z.string(),
    lossless: z.boolean(),
    bitrate: z.int().positive().nullable(),
    sampleRate: z.int().positive().nullable(),
    bitDepth: z.int().positive().nullable(),
    channels: z.int().positive().nullable(),
  }),
  "Technical properties of the source file.",
);

export const ReplayGain = named(
  "ReplayGain",
  z.object({
    /** Gain in dB that brings the track to the ReplayGain reference loudness. */
    trackGain: z.number().nullable(),
    /** Highest sample amplitude, linear (1.0 = full scale); used to avoid clipping when boosting. */
    trackPeak: z.number().nonnegative().nullable(),
    /** The same for the whole album, preserving loudness differences between its tracks. */
    albumGain: z.number().nullable(),
    albumPeak: z.number().nonnegative().nullable(),
  }),
  "Loudness normalisation data from the file's tags; all null when untagged.",
);

export const Track = named(
  "Track",
  z.object({
    id: Id,
    title: z.string(),
    artistId: Id,
    artistName: z.string(),
    albumId: Id,
    albumTitle: z.string(),
    trackNumber: z.int().positive().nullable(),
    discNumber: z.int().positive().nullable(),
    year: Year.nullable(),
    durationMs: DurationMs,
    genres: z.array(z.string()),
    format: AudioFormat,
    replayGain: ReplayGain,
    fileSize: z.int().nonnegative(),
    cover: Artwork.nullable(),
  }),
);

export const Album = named(
  "Album",
  AlbumSummary.extend({
    genres: z.array(z.string()),
    tracks: z.array(Track),
  }),
);

export const CreditCategory = named(
  "CreditCategory",
  z.enum(["performance", "composition", "production", "engineering", "other"]),
);

export const Credit = named(
  "Credit",
  z.object({
    name: z.string(),
    /** Set when the credited person is also an artist in the local library. */
    artistId: Id.nullable(),
    musicbrainzId: z.string().nullable(),
    /** What they did, e.g. `piano`, `lead vocals`, `composer`, `producer`. */
    roles: z.array(z.string()),
    category: CreditCategory,
    /** `album` credits come from the release and apply to every track on it. */
    scope: z.enum(["track", "album"]),
    source: z.enum(["musicbrainz", "tags"]),
  }),
  "One person's contribution to a track, with all their roles merged.",
);

export const TrackCredits = named(
  "TrackCredits",
  z.object({
    trackId: Id,
    credits: z.array(Credit),
    enrichment: EnrichmentState,
  }),
);

export const Waveform = named(
  "Waveform",
  z.object({
    trackId: Id,
    /** The track's loudness envelope from start to end, as heights from 0 to 100. */
    points: z.array(z.int().min(0).max(100)),
  }),
);

export const LyricLine = named(
  "LyricLine",
  z.object({
    /** When the line starts, for synced lyrics; null in plain lyrics. */
    timeMs: z.int().nonnegative().nullable(),
    /** Empty for a stanza break. */
    text: z.string(),
  }),
);

export const Lyrics = named(
  "Lyrics",
  z.object({
    trackId: Id,
    /** Where they came from: a `.lrc` file beside the track, its tags, or LRCLIB. */
    source: z.enum(["file", "tags", "lrclib", "none"]),
    /** Every line has a time. */
    synced: z.boolean(),
    /** Known to have no vocals (no lines). */
    instrumental: z.boolean(),
    lines: z.array(LyricLine),
  }),
  "A track's lyrics; `source` is `none` (and `lines` empty) when none were found.",
);

export const NowPlaying = named(
  "NowPlaying",
  z.object({
    track: Track,
    album: AlbumSummary,
    artist: Artist,
    /** Other albums by the same artist, for "more from" rails. */
    moreFromArtist: z.array(AlbumSummary),
    credits: z.array(Credit),
    /** While `pending`, clients may poll again to pick up credits and artist details. */
    enrichment: EnrichmentState,
  }),
  "Everything a client needs to render the now-playing screen in one request.",
);

const page = <T extends z.ZodType>(id: string, item: T) =>
  named(
    id,
    z.object({
      items: z.array(item),
      total: Count,
      offset: Count,
      limit: Count,
    }),
  );

export const ArtistPage = page("ArtistPage", ArtistSummary);
export const AlbumPage = page("AlbumPage", AlbumSummary);
export const TrackPage = page("TrackPage", Track);
export const AlbumList = named("AlbumList", z.array(AlbumSummary));

export const SearchResults = named(
  "SearchResults",
  z.object({
    artists: z.array(ArtistSummary),
    albums: z.array(AlbumSummary),
    tracks: z.array(Track),
  }),
);

export const LibraryFolder = named(
  "LibraryFolder",
  z.object({
    path: z.string(),
    /** Present and readable now (an unmounted share isn't; its tracks are kept meanwhile). */
    available: z.boolean(),
    tracks: Count,
  }),
);

export const LibraryStatus = named(
  "LibraryStatus",
  z.object({
    scanning: z.boolean(),
    /** The music folders, for admins; empty for everyone else. */
    folders: z.array(LibraryFolder),
    /** How paths look on the server (`D:\Music` or `/mnt/music`), for entering a folder. */
    pathStyle: z.enum(["posix", "windows"]).default("posix"),
    lastScanAt: z.iso.datetime().nullable(),
    artists: Count,
    albums: Count,
    tracks: Count,
    /** Albums and artists still waiting for external metadata. */
    enrichmentQueue: Count,
    /** While scanning: listing the folders' files (`total` found so far), then reading them. */
    scanProgress: z
      .object({
        phase: z.enum(["listing", "reading"]),
        done: Count,
        total: Count,
      })
      .nullable(),
  }),
);

export const SetLibraryFolders = named(
  "SetLibraryFolders",
  z.object({
    /** Full paths on the server; each must be an existing folder. */
    paths: z.array(z.string().trim().min(1)).min(1).max(32),
  }),
  "The music folders, replacing HP_LIBRARY's until HP_LIBRARY itself changes.",
);

export const StreamFormat = named(
  "StreamFormat",
  z.enum(["original", "opus", "vorbis", "aac", "mp3", "flac"]),
  "`original` serves the file untouched (with HTTP range support); others are transcoded with ffmpeg.",
);

export const ApiError = named(
  "ApiError",
  z.object({
    error: z.string(),
    message: z.string(),
  }),
);

export type Artwork = z.infer<typeof Artwork>;
export type EnrichmentState = z.infer<typeof EnrichmentState>;
export type BandMember = z.infer<typeof BandMember>;
export type Credit = z.infer<typeof Credit>;
export type CreditCategory = z.infer<typeof CreditCategory>;
export type TrackCredits = z.infer<typeof TrackCredits>;
export type Waveform = z.infer<typeof Waveform>;
export type LyricLine = z.infer<typeof LyricLine>;
export type Lyrics = z.infer<typeof Lyrics>;
export type ExternalLink = z.infer<typeof ExternalLink>;
export type ArtistSummary = z.infer<typeof ArtistSummary>;
export type Artist = z.infer<typeof Artist>;
export type AlbumSummary = z.infer<typeof AlbumSummary>;
export type AudioFormat = z.infer<typeof AudioFormat>;
export type Track = z.infer<typeof Track>;
export type ReplayGain = z.infer<typeof ReplayGain>;
export type Album = z.infer<typeof Album>;
export type NowPlaying = z.infer<typeof NowPlaying>;
export type ArtistPage = z.infer<typeof ArtistPage>;
export type AlbumPage = z.infer<typeof AlbumPage>;
export type TrackPage = z.infer<typeof TrackPage>;
export type SearchResults = z.infer<typeof SearchResults>;
export type LibraryFolder = z.infer<typeof LibraryFolder>;
export type LibraryStatus = z.infer<typeof LibraryStatus>;
export type SetLibraryFolders = z.infer<typeof SetLibraryFolders>;
export type StreamFormat = z.infer<typeof StreamFormat>;
export type ApiError = z.infer<typeof ApiError>;
