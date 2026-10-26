import { z } from "zod";
import { Artwork, Id, named, Track } from "./models.ts";
import { ShuffleScope } from "./auth.ts";

/*
 * User collections: playlists and per-device play queues. Both live on the
 * server; clients render them and send edits.
 */

const Count = z.int().nonnegative();
const Timestamp = z.iso.datetime();

/** What an entry was, kept so it can be shown (and relinked) even if the file disappears. */
export const TrackSnapshot = named(
  "TrackSnapshot",
  z.object({
    title: z.string(),
    artistName: z.string(),
    albumTitle: z.string(),
    durationMs: z.int().nonnegative(),
  }),
);

export const PlaylistEntry = named(
  "PlaylistEntry",
  z.object({
    /** Identifies this occurrence: the same track may appear more than once. */
    entryId: Id,
    /** Null while the track is missing from the library (moved or unmounted). */
    track: Track.nullable(),
    snapshot: TrackSnapshot,
    addedAt: Timestamp,
  }),
);

// ---------------------------------------------------------- smart playlists

export const SmartField = named(
  "SmartField",
  z.enum([
    "title",
    "artist",
    "album",
    "genre",
    "format",
    "year",
    "duration",
    "sampleRate",
    "plays",
    "lossless",
    "lastPlayed",
    "added",
  ]),
  "What a smart playlist rule looks at. `artist` matches the track's or the album's artist.",
);

export const SmartOperator = named(
  "SmartOperator",
  z.enum([
    "contains",
    "notContains",
    "is",
    "isNot",
    "startsWith",
    "lessThan",
    "greaterThan",
    "between",
    "inLast",
    "notInLast",
    "never",
  ]),
  `How a rule compares. Text fields (title, artist, album, genre, format): contains, notContains,
is, isNot, startsWith. Numbers (year; duration in seconds or m:ss; sampleRate in kHz; plays):
is, isNot, lessThan, greaterThan, between. lossless: is (yes or no). Dates (lastPlayed, added):
inLast and notInLast a number of days; lastPlayed also never.`,
);

export const SmartRule = named(
  "SmartRule",
  z.object({
    field: SmartField,
    op: SmartOperator,
    /** Left empty, the rule is skipped (still being written). */
    value: z.string().max(200).default(""),
    /** The upper end for `between`. */
    value2: z.string().max(200).default(""),
  }),
);

export const SmartRules = named(
  "SmartRules",
  z.object({
    /** Tracks must match every rule, or any of them. */
    match: z.enum(["all", "any"]).default("all"),
    rules: z.array(SmartRule).max(20).default([]),
    order: z
      .enum(["random", "title", "artist", "album", "year", "added", "plays", "lastPlayed"])
      .default("random"),
    descending: z.boolean().default(false),
    limit: z.int().min(1).max(500).default(100),
  }),
  "A smart playlist's rules: its tracks are whatever matches, worked out whenever it's read.",
);

export const PlaylistSummary = named(
  "PlaylistSummary",
  z.object({
    id: Id,
    name: z.string(),
    description: z.string().nullable(),
    trackCount: Count,
    durationMs: z.int().nonnegative(),
    /** Up to four distinct album covers, for a mosaic. */
    covers: z.array(Artwork),
    /** Set for a smart playlist, whose tracks follow from these rules (they can't be edited by hand). */
    rules: SmartRules.nullable().default(null),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  }),
);

export const Playlist = named(
  "Playlist",
  PlaylistSummary.extend({
    entries: z.array(PlaylistEntry),
    /** For a smart playlist: how many tracks match, before its limit. */
    matching: z.int().nonnegative().nullable().default(null),
  }),
);

export const PlaylistList = named("PlaylistList", z.array(PlaylistSummary));

const Name = z.string().trim().min(1).max(200);

export const CreatePlaylist = named(
  "CreatePlaylist",
  z.object({
    name: Name,
    description: z.string().max(2000).nullable().optional(),
    /** Optional initial content. */
    trackIds: z.array(Id).max(10_000).optional(),
    /** Makes it a smart playlist (then `trackIds` is ignored). */
    rules: SmartRules.optional(),
  }),
);

export const UpdatePlaylist = named(
  "UpdatePlaylist",
  z.object({
    name: Name.optional(),
    description: z.string().max(2000).nullable().optional(),
    /** New rules for a smart playlist. */
    rules: SmartRules.optional(),
  }),
);

/** Where tracks come from when adding to a playlist or a queue. */
export const TrackSource = named(
  "TrackSource",
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tracks"), trackIds: z.array(Id).min(1).max(10_000) }),
    z.object({ kind: z.literal("album"), id: Id }),
    z.object({
      kind: z.literal("playlist"),
      id: Id,
      /**
       * A smart playlist's tracks as the client shows them: its rules may pick differently
       * each time (random order), so this plays what was on screen. Ignored for other playlists.
       */
      trackIds: z.array(Id).max(10_000).optional(),
    }),
    z.object({ kind: z.literal("artist"), id: Id }),
    /** Every track in the genre (matched regardless of case). */
    z.object({ kind: z.literal("genre"), name: z.string().trim().min(1) }),
  ]),
  "A set of tracks: explicit ids, or every track of an album, playlist, artist or genre.",
);

export const AddToPlaylist = named(
  "AddToPlaylist",
  z.object({
    source: TrackSource,
    /** Insert before this index; appends when omitted. */
    position: z.int().nonnegative().optional(),
  }),
);

export const MoveEntry = named(
  "MoveEntry",
  z.object({
    /** Index the entry should end up at. */
    toIndex: z.int().nonnegative(),
  }),
);

export const Ok = named("Ok", z.object({ ok: z.literal(true) }));

// ------------------------------------------------------------------- queue

export const RepeatMode = named("RepeatMode", z.enum(["off", "all", "one"]));

export const QueueEntry = named(
  "QueueEntry",
  z.object({
    entryId: Id,
    track: Track,
  }),
);

export const QueueOrigin = named(
  "QueueOrigin",
  z.object({
    /** `shuffle`: tracks drawn at random from the library, or an album, artist or genre (`id`, `name`). */
    kind: z.enum(["tracks", "album", "playlist", "artist", "genre", "shuffle"]),
    id: Id.nullable(),
    /** Display name, e.g. the album or playlist title. */
    name: z.string().nullable(),
  }),
  "What the queue was started from.",
);

export const QueueState = named(
  "QueueState",
  z.object({
    /**
     * Entries in play order (shuffled order while shuffle is on). Shuffle from the shuffle
     * button is a rolling window: the tracks played lately, the current one and the next
     * few drawn from its scope, topped up as it advances.
     */
    entries: z.array(QueueEntry),
    /** Index of the current entry in `entries`; null when the queue is empty or finished. */
    index: z.int().nonnegative().nullable(),
    /**
     * Index of the entry the current track's end will advance to (honouring repeat), so
     * clients can preload it for gapless playback; null when nothing follows, or when
     * it isn't known yet (a shuffled repeat lap is reshuffled as it starts).
     */
    upNext: z.int().nonnegative().nullable(),
    shuffle: z.boolean(),
    /**
     * What the shuffle button is drawing from (`origin` names the album, artist or genre);
     * null when it's off or a source shuffles itself. `library` also when the track had no genre.
     */
    shuffleScope: ShuffleScope.nullable(),
    repeat: RepeatMode,
    /** Playback position in the current track, saved by the client for resuming. */
    positionMs: z.int().nonnegative(),
    origin: QueueOrigin.nullable(),
    updatedAt: Timestamp,
  }),
  "A device's play queue. All navigation (next, previous, shuffle, repeat) happens on the server.",
);

export const SetQueue = named(
  "SetQueue",
  z.object({
    source: TrackSource,
    /** Index in the source's order to start from. */
    start: z.int().nonnegative().default(0),
    /**
     * True shuffles just this source (e.g. a playlist's Shuffle button); false plays it in
     * order. Omitted keeps the current setting: while the shuffle button is on, tracks are
     * drawn from its scope around the chosen one.
     */
    shuffle: z.boolean().optional(),
    /** With `shuffle`, draw from this scope instead of the user's (a playlist's own Shuffle: `playlist`). */
    shuffleScope: ShuffleScope.optional(),
  }),
);

export const AddToQueue = named(
  "AddToQueue",
  z.object({
    source: TrackSource,
    /** `next`: right after the current track; `end`: after everything else. */
    placement: z.enum(["next", "end"]).default("end"),
  }),
);

export const Advance = named(
  "Advance",
  z.object({
    /** True when the current track ended by itself (repeat-one replays it); false for the next button. */
    auto: z.boolean().default(false),
  }),
);

export const Jump = named("Jump", z.object({ entryId: Id }));

export const UpdateQueue = named(
  "UpdateQueue",
  z.object({
    /**
     * The shuffle button: on draws tracks from the user's shuffle scope around the current
     * one (starting one when nothing plays; sent again after the scope changes, it redraws);
     * off returns to the queue as it was before.
     */
    shuffle: z.boolean().optional(),
    repeat: RepeatMode.optional(),
    positionMs: z.int().nonnegative().optional(),
  }),
);

export type TrackSnapshot = z.infer<typeof TrackSnapshot>;
export type PlaylistEntry = z.infer<typeof PlaylistEntry>;
export type PlaylistSummary = z.infer<typeof PlaylistSummary>;
export type Playlist = z.infer<typeof Playlist>;
export type TrackSource = z.infer<typeof TrackSource>;
export type RepeatMode = z.infer<typeof RepeatMode>;
export type SmartRules = z.infer<typeof SmartRules>;
export type SmartRule = z.infer<typeof SmartRule>;
export type QueueEntry = z.infer<typeof QueueEntry>;
export type QueueOrigin = z.infer<typeof QueueOrigin>;
export type QueueState = z.infer<typeof QueueState>;
