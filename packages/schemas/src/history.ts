import { z } from "zod";
import { ArtistSummary, named, Track } from "./models.ts";

/*
 * Listening history: one record per listen, per user. What counts as a listen
 * follows Last.fm/ListenBrainz: a track of at least 30 s, played (really played,
 * not skipped through) for half its length or 4 minutes, whichever comes first.
 */

const Count = z.int().nonnegative();
const Timestamp = z.iso.datetime();

export const RecordListen = named(
  "RecordListen",
  z.object({
    trackId: z.string().min(1),
    /** When playback of this listen started; with the track it identifies the listen (retries are harmless). */
    startedAt: Timestamp,
    /** Time actually played so far. */
    playedMs: Count,
  }),
);

export const Listen = named(
  "Listen",
  z.object({
    track: Track,
    startedAt: Timestamp,
    playedMs: Count,
  }),
);

export const ListenPage = named(
  "ListenPage",
  z.object({ items: z.array(Listen), total: Count, offset: Count, limit: Count }),
  "Listens, most recent first.",
);

export const TopTrack = named("TopTrack", z.object({ track: Track, plays: Count }));
export const TopArtist = named("TopArtist", z.object({ artist: ArtistSummary, plays: Count }));

export const HistoryStats = named(
  "HistoryStats",
  z.object({
    days: Count,
    listens: Count,
    /** Total time listened, in milliseconds. */
    listenedMs: Count,
    topTracks: z.array(TopTrack),
    topArtists: z.array(TopArtist),
  }),
  "The user's most played tracks and artists over the last `days` days.",
);

export type RecordListen = z.infer<typeof RecordListen>;
export type Listen = z.infer<typeof Listen>;
export type ListenPage = z.infer<typeof ListenPage>;
export type TopTrack = z.infer<typeof TopTrack>;
export type TopArtist = z.infer<typeof TopArtist>;
export type HistoryStats = z.infer<typeof HistoryStats>;
