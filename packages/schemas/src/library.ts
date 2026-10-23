import { z } from "zod";
import { Artwork, Id, named, Track } from "./models.ts";

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
    createdAt: Timestamp,
    updatedAt: Timestamp,
  }),
);

export const Playlist = named(
  "Playlist",
  PlaylistSummary.extend({
    entries: z.array(PlaylistEntry),
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
  }),
);

export const UpdatePlaylist = named(
  "UpdatePlaylist",
  z.object({
    name: Name.optional(),
    description: z.string().max(2000).nullable().optional(),
  }),
);

/** Where tracks come from when adding to a playlist or a queue. */
export const TrackSource = named(
  "TrackSource",
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tracks"), trackIds: z.array(Id).min(1).max(10_000) }),
    z.object({ kind: z.literal("album"), id: Id }),
    z.object({ kind: z.literal("playlist"), id: Id }),
    z.object({ kind: z.literal("artist"), id: Id }),
  ]),
  "A set of tracks: explicit ids, or every track of an album, playlist or artist.",
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
    kind: z.enum(["tracks", "album", "playlist", "artist"]),
    id: Id.nullable(),
    /** Display name, e.g. the album or playlist title. */
    name: z.string().nullable(),
  }),
  "What the queue was started from.",
);

export const QueueState = named(
  "QueueState",
  z.object({
    /** Entries in play order (shuffled order while shuffle is on). */
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
    /** Turn shuffle on or off as part of starting; keeps the current setting when omitted. */
    shuffle: z.boolean().optional(),
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
export type QueueEntry = z.infer<typeof QueueEntry>;
export type QueueOrigin = z.infer<typeof QueueOrigin>;
export type QueueState = z.infer<typeof QueueState>;
