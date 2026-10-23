import { z } from "zod";
import {
  Album,
  AlbumList,
  AlbumPage,
  Artist,
  ArtistPage,
  Id,
  LibraryStatus,
  NowPlaying,
  SearchResults,
  TrackCredits,
  StreamFormat,
  TrackPage,
} from "./models.ts";

type Method = "GET" | "POST";

/** A JSON endpoint: the response body is described by a Zod schema. */
export interface JsonEndpoint<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  kind: "json";
  method: Method;
  path: string;
  summary: string;
  params: P;
  query: Q;
  response: R;
}

/** A binary endpoint (audio, images): the response is a raw byte stream. */
export interface BinaryEndpoint<P extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType> {
  kind: "binary";
  method: Method;
  path: string;
  summary: string;
  params: P;
  query: Q;
  contentTypes: string[];
}

export type Endpoint = JsonEndpoint | BinaryEndpoint;

const NoParams = z.object({});
const NoQuery = z.object({});
const IdParams = z.object({ id: Id });

export const Pagination = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const json = <P extends z.ZodType, Q extends z.ZodType, R extends z.ZodType>(
  e: Omit<JsonEndpoint<P, Q, R>, "kind">,
): JsonEndpoint<P, Q, R> => ({ kind: "json", ...e });

const binary = <P extends z.ZodType, Q extends z.ZodType>(
  e: Omit<BinaryEndpoint<P, Q>, "kind">,
): BinaryEndpoint<P, Q> => ({ kind: "binary", ...e });

/**
 * The HTTP API contract. Paths use `{param}` placeholders (OpenAPI style);
 * the server converts them to its router's syntax.
 */
export const api = {
  libraryStatus: json({
    method: "GET",
    path: "/api/library/status",
    summary: "Library statistics and scan state",
    params: NoParams,
    query: NoQuery,
    response: LibraryStatus,
  }),
  libraryScan: json({
    method: "POST",
    path: "/api/library/scan",
    summary: "Start a library rescan (returns immediately)",
    params: NoParams,
    query: NoQuery,
    response: LibraryStatus,
  }),
  listArtists: json({
    method: "GET",
    path: "/api/artists",
    summary: "List artists alphabetically",
    params: NoParams,
    query: Pagination,
    response: ArtistPage,
  }),
  getArtist: json({
    method: "GET",
    path: "/api/artists/{id}",
    summary: "Full artist profile",
    params: IdParams,
    query: NoQuery,
    response: Artist,
  }),
  getArtistAlbums: json({
    method: "GET",
    path: "/api/artists/{id}/albums",
    summary: "Albums by an artist, newest first",
    params: IdParams,
    query: NoQuery,
    response: AlbumList,
  }),
  listAlbums: json({
    method: "GET",
    path: "/api/albums",
    summary: "List albums",
    params: NoParams,
    query: Pagination.extend({
      sort: z.enum(["title", "artist", "year", "added"]).default("artist"),
    }),
    response: AlbumPage,
  }),
  getAlbum: json({
    method: "GET",
    path: "/api/albums/{id}",
    summary: "Album with its tracks",
    params: IdParams,
    query: NoQuery,
    response: Album,
  }),
  listTracks: json({
    method: "GET",
    path: "/api/tracks",
    summary: "List tracks",
    params: NoParams,
    query: Pagination,
    response: TrackPage,
  }),
  nowPlaying: json({
    method: "GET",
    path: "/api/tracks/{id}/now-playing",
    summary: "Track, album, artist and related albums for the now-playing screen",
    params: IdParams,
    query: NoQuery,
    response: NowPlaying,
  }),
  trackCredits: json({
    method: "GET",
    path: "/api/tracks/{id}/credits",
    summary: "Musicians and other contributors on a track",
    params: IdParams,
    query: NoQuery,
    response: TrackCredits,
  }),
  enrichArtist: json({
    method: "POST",
    path: "/api/artists/{id}/enrich",
    summary: "Re-fetch external metadata for an artist (returns immediately)",
    params: IdParams,
    query: NoQuery,
    response: LibraryStatus,
  }),
  search: json({
    method: "GET",
    path: "/api/search",
    summary: "Search artists, albums and tracks",
    params: NoParams,
    query: z.object({
      q: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
    response: SearchResults,
  }),
  stream: binary({
    method: "GET",
    path: "/api/stream/{id}",
    summary: "Audio stream of a track, original or transcoded",
    params: IdParams,
    query: z.object({
      format: StreamFormat.default("original"),
      /** Target bitrate in kbit/s for lossy transcodes. */
      bitrate: z.coerce.number().int().min(32).max(512).optional(),
    }),
    contentTypes: ["audio/*"],
  }),
  artwork: binary({
    method: "GET",
    path: "/api/artwork/{id}",
    summary: "Artwork image, optionally resized",
    params: IdParams,
    query: z.object({
      size: z.coerce.number().int().min(16).max(4096).optional(),
    }),
    contentTypes: ["image/*"],
  }),
} as const satisfies Record<string, Endpoint>;

export type Api = typeof api;
