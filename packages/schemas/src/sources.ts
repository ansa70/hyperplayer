import { z } from "zod";
import { Artwork, AudioFormat, CreditCategory, Id, named, ReplayGain } from "./models.ts";

/**
 * Servers as sources of a standalone player's library: the player's engine copies a
 * server's catalog (`/api/sync`) into its own, and plays those tracks from the server.
 */

const Count = z.int().nonnegative();

export const SyncArtist = named(
  "SyncArtist",
  z.object({
    name: z.string(),
    sortName: z.string(),
    musicbrainzId: z.string().nullable(),
  }),
);

export const SyncCredit = named(
  "SyncCredit",
  z.object({
    name: z.string(),
    role: z.string(),
    category: CreditCategory,
    musicbrainzId: z.string().nullable(),
  }),
  "A credit read from the file's tags (MusicBrainz credits are looked up by each library itself).",
);

export const SyncTrack = named(
  "SyncTrack",
  z.object({
    id: Id,
    title: z.string(),
    /** The track's artist credit as tagged ("A feat. B"). */
    artistCredit: z.string(),
    artist: SyncArtist,
    albumArtist: SyncArtist,
    album: z.object({
      title: z.string(),
      year: z.int().nullable(),
      musicbrainzId: z.string().nullable(),
      addedAt: z.iso.datetime(),
    }),
    trackNumber: z.int().nullable(),
    discNumber: z.int().nullable(),
    year: z.int().nullable(),
    durationMs: z.int().nonnegative(),
    genres: z.array(z.string()),
    format: AudioFormat,
    replayGain: ReplayGain,
    fileSize: z.int().nonnegative(),
    /** The file's modification time: a newer one means the file (so its waveform) changed. */
    modifiedMs: z.int(),
    musicbrainzRecordingId: z.string().nullable(),
    cover: Artwork.nullable(),
    credits: z.array(SyncCredit),
  }),
  "A track as a server hands it to another library.",
);

export const SyncQuery = z.object({
  /** The revision the caller has (from an earlier page's `revision`); 0 lists everything. */
  since: z.coerce.number().int().nonnegative().default(0),
  /** Paging: the `next` of the previous page. */
  after: Id.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const SyncPage = named(
  "SyncPage",
  z.object({
    /** Changes when the server's library is started afresh: a caller then syncs everything again. */
    libraryId: z.string(),
    /** The library's revision: pass it as `since` next time to get only what changed after. */
    revision: Count,
    /** Every track is listed (not only changes): tracks the caller has that aren't listed are gone. */
    full: z.boolean(),
    /** Tracks added or changed since `since`, ordered by id. */
    tracks: z.array(SyncTrack),
    /** Tracks removed since `since` (on the first page only). */
    removed: z.array(Id),
    /** The `after` for the next page; null on the last one. */
    next: Id.nullable(),
  }),
);

export const AddSource = named(
  "AddSource",
  z.object({
    url: z.url({ protocol: /^https?$/ }),
    /** A device token for the server (the player signs in to get one). */
    token: z.string().min(1).max(512),
    username: z.string().min(1).max(64),
    /**
     * SHA-256 of the server's certificate (`AB:CD:…`) when the user trusted a self-signed
     * one; only that certificate is accepted then. Null: checked against the usual authorities.
     */
    fingerprint: z
      .string()
      .regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
      .nullable(),
  }),
);

export type SyncArtist = z.infer<typeof SyncArtist>;
export type SyncCredit = z.infer<typeof SyncCredit>;
export type SyncTrack = z.infer<typeof SyncTrack>;
export type SyncPage = z.infer<typeof SyncPage>;
export type AddSource = z.infer<typeof AddSource>;
