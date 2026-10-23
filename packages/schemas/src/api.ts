import { z } from "zod";
import {
  Album,
  AlbumList,
  AlbumPage,
  Artist,
  ArtistPage,
  Id,
  LibraryStatus,
  Lyrics,
  NowPlaying,
  SearchResults,
  TrackCredits,
  StreamFormat,
  TrackPage,
} from "./models.ts";
import {
  AddToPlaylist,
  AddToQueue,
  Advance,
  CreatePlaylist,
  Jump,
  MoveEntry,
  Ok,
  Playlist,
  PlaylistList,
  QueueState,
  SetQueue,
  UpdatePlaylist,
  UpdateQueue,
} from "./library.ts";
import { HistoryStats, ListenPage, RecordListen } from "./history.ts";
import {
  AuthStatus,
  ChangePassword,
  CreateUser,
  DeviceId,
  DeviceList,
  Login,
  Me,
  Onboard,
  Preferences,
  Session,
  UpdatePreferences,
  User,
  UserList,
} from "./auth.ts";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Who may call an endpoint:
 * - `public`: anyone;
 * - `session`: any signed-in device, even one that must still replace a default password;
 * - `user`: signed-in devices with a real password (the default, so forgetting to
 *   declare it can never open an endpoint up);
 * - `admin`: admins only.
 */
export type Access = "public" | "session" | "user" | "admin";

/** A JSON endpoint: request and response bodies are described by Zod schemas. */
export interface JsonEndpoint<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType,
> {
  kind: "json";
  method: Method;
  path: string;
  summary: string;
  access: Access;
  params: P;
  query: Q;
  /** Request body; `NoBody` for endpoints without one. Bodies must be registered models. */
  body: B;
  response: R;
}

/** A binary endpoint (audio, images): the response is a raw byte stream. */
export interface BinaryEndpoint<P extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType> {
  kind: "binary";
  method: Method;
  path: string;
  summary: string;
  access: Access;
  params: P;
  query: Q;
  contentTypes: string[];
}

export type Endpoint = JsonEndpoint | BinaryEndpoint;

const NoParams = z.object({});
const NoQuery = z.object({});
export const NoBody = z.undefined();
const IdParams = z.object({ id: Id });
const EntryParams = z.object({ id: Id, entryId: Id });
const QueueEntryParams = z.object({ entryId: Id });
const DeviceParams = z.object({ id: DeviceId });

export const Pagination = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const json = <
  P extends z.ZodType,
  Q extends z.ZodType,
  R extends z.ZodType,
  B extends z.ZodType = typeof NoBody,
>(
  e: Omit<JsonEndpoint<P, Q, R, B>, "kind" | "body" | "access"> & { body?: B; access?: Access },
): JsonEndpoint<P, Q, R, B> => ({ kind: "json", access: "user", ...e, body: (e.body ?? NoBody) as B });

const binary = <P extends z.ZodType, Q extends z.ZodType>(
  e: Omit<BinaryEndpoint<P, Q>, "kind" | "access"> & { access?: Access },
): BinaryEndpoint<P, Q> => ({ kind: "binary", access: "user", ...e });

/**
 * The HTTP API contract. Paths use `{param}` placeholders (OpenAPI style);
 * the server converts them to its router's syntax.
 */
export const api = {
  // -------------------------------------------------------------------- auth
  authStatus: json({
    method: "GET",
    path: "/api/auth/status",
    summary: "Server version, and whether the default admin account is still unclaimed",
    access: "public",
    params: NoParams,
    query: NoQuery,
    response: AuthStatus,
  }),
  login: json({
    method: "POST",
    path: "/api/auth/login",
    summary: "Sign in a device; returns its bearer token",
    access: "public",
    params: NoParams,
    query: NoQuery,
    body: Login,
    response: Session,
  }),
  logout: json({
    method: "POST",
    path: "/api/auth/logout",
    summary: "Sign out this device (revokes its token)",
    access: "session",
    params: NoParams,
    query: NoQuery,
    response: Ok,
  }),
  me: json({
    method: "GET",
    path: "/api/me",
    summary: "The signed-in user and device",
    access: "session",
    params: NoParams,
    query: NoQuery,
    response: Me,
  }),
  changePassword: json({
    method: "POST",
    path: "/api/me/password",
    summary: "Change your password (signs out your other devices)",
    access: "session",
    params: NoParams,
    query: NoQuery,
    body: ChangePassword,
    response: Ok,
  }),
  listDevices: json({
    method: "GET",
    path: "/api/me/devices",
    summary: "Your signed-in devices",
    params: NoParams,
    query: NoQuery,
    response: DeviceList,
  }),
  revokeDevice: json({
    method: "DELETE",
    path: "/api/me/devices/{id}",
    summary: "Sign out one of your devices",
    params: DeviceParams,
    query: NoQuery,
    response: Ok,
  }),
  onboard: json({
    method: "POST",
    path: "/api/auth/onboard",
    summary:
      "First run: create the everyday user and hand it this device (with its queue) and the playlists made so far",
    access: "admin",
    params: NoParams,
    query: NoQuery,
    body: Onboard,
    response: Session,
  }),
  getPreferences: json({
    method: "GET",
    path: "/api/me/preferences",
    summary: "Your preferences",
    params: NoParams,
    query: NoQuery,
    response: Preferences,
  }),
  updatePreferences: json({
    method: "PATCH",
    path: "/api/me/preferences",
    summary: "Change some of your preferences",
    params: NoParams,
    query: NoQuery,
    body: UpdatePreferences,
    response: Preferences,
  }),
  listUsers: json({
    method: "GET",
    path: "/api/users",
    summary: "All accounts",
    access: "admin",
    params: NoParams,
    query: NoQuery,
    response: UserList,
  }),
  createUser: json({
    method: "POST",
    path: "/api/users",
    summary: "Create an account",
    access: "admin",
    params: NoParams,
    query: NoQuery,
    body: CreateUser,
    response: User,
  }),

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
    access: "admin",
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
  lyrics: json({
    method: "GET",
    path: "/api/tracks/{id}/lyrics",
    summary: "Lyrics for a track: from a .lrc file beside it, its tags, or LRCLIB (synced when available)",
    params: IdParams,
    query: NoQuery,
    response: Lyrics,
  }),
  enrichArtist: json({
    method: "POST",
    path: "/api/artists/{id}/enrich",
    summary: "Re-fetch external metadata for an artist (returns immediately)",
    access: "admin",
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
  // --------------------------------------------------------------- playlists
  listPlaylists: json({
    method: "GET",
    path: "/api/playlists",
    summary: "All playlists, most recently updated first",
    params: NoParams,
    query: NoQuery,
    response: PlaylistList,
  }),
  createPlaylist: json({
    method: "POST",
    path: "/api/playlists",
    summary: "Create a playlist, optionally with initial tracks",
    params: NoParams,
    query: NoQuery,
    body: CreatePlaylist,
    response: Playlist,
  }),
  getPlaylist: json({
    method: "GET",
    path: "/api/playlists/{id}",
    summary: "A playlist with its entries",
    params: IdParams,
    query: NoQuery,
    response: Playlist,
  }),
  updatePlaylist: json({
    method: "PATCH",
    path: "/api/playlists/{id}",
    summary: "Rename or re-describe a playlist",
    params: IdParams,
    query: NoQuery,
    body: UpdatePlaylist,
    response: Playlist,
  }),
  deletePlaylist: json({
    method: "DELETE",
    path: "/api/playlists/{id}",
    summary: "Delete a playlist",
    params: IdParams,
    query: NoQuery,
    response: Ok,
  }),
  addToPlaylist: json({
    method: "POST",
    path: "/api/playlists/{id}/entries",
    summary: "Add tracks, an album, an artist or another playlist",
    params: IdParams,
    query: NoQuery,
    body: AddToPlaylist,
    response: Playlist,
  }),
  removeFromPlaylist: json({
    method: "DELETE",
    path: "/api/playlists/{id}/entries/{entryId}",
    summary: "Remove one entry",
    params: EntryParams,
    query: NoQuery,
    response: Playlist,
  }),
  movePlaylistEntry: json({
    method: "POST",
    path: "/api/playlists/{id}/entries/{entryId}/move",
    summary: "Move an entry to another position",
    params: EntryParams,
    query: NoQuery,
    body: MoveEntry,
    response: Playlist,
  }),

  // ----------------------------------------------------------------- history
  recordListen: json({
    method: "POST",
    path: "/api/history",
    summary: "Record a listen (only plays meeting the listen rule count; repeats of one listen are ignored)",
    params: NoParams,
    query: NoQuery,
    body: RecordListen,
    response: Ok,
  }),
  listHistory: json({
    method: "GET",
    path: "/api/history",
    summary: "The caller's listens, most recent first",
    params: NoParams,
    query: Pagination,
    response: ListenPage,
  }),
  historyStats: json({
    method: "GET",
    path: "/api/history/stats",
    summary: "The caller's most played tracks and artists over recent days",
    params: NoParams,
    query: z.object({
      days: z.coerce.number().int().min(1).max(36500).default(30),
      limit: z.coerce.number().int().min(1).max(100).default(10),
    }),
    response: HistoryStats,
  }),

  // ------------------------------------------------------------------- queue
  getQueue: json({
    method: "GET",
    path: "/api/queue",
    summary: "This device's play queue (empty if it has none yet)",
    params: NoParams,
    query: NoQuery,
    response: QueueState,
  }),
  setQueue: json({
    method: "PUT",
    path: "/api/queue",
    summary: "Replace the queue and start playing from a position",
    params: NoParams,
    query: NoQuery,
    body: SetQueue,
    response: QueueState,
  }),
  updateQueue: json({
    method: "PATCH",
    path: "/api/queue",
    summary: "Change shuffle/repeat or save the playback position",
    params: NoParams,
    query: NoQuery,
    body: UpdateQueue,
    response: QueueState,
  }),
  clearQueue: json({
    method: "DELETE",
    path: "/api/queue",
    summary: "Empty the queue",
    params: NoParams,
    query: NoQuery,
    response: QueueState,
  }),
  addToQueue: json({
    method: "POST",
    path: "/api/queue/entries",
    summary: "Queue tracks next or at the end",
    params: NoParams,
    query: NoQuery,
    body: AddToQueue,
    response: QueueState,
  }),
  removeFromQueue: json({
    method: "DELETE",
    path: "/api/queue/entries/{entryId}",
    summary: "Remove an entry from the queue",
    params: QueueEntryParams,
    query: NoQuery,
    response: QueueState,
  }),
  advanceQueue: json({
    method: "POST",
    path: "/api/queue/next",
    summary: "Move to the next track (honouring repeat)",
    params: NoParams,
    query: NoQuery,
    body: Advance,
    response: QueueState,
  }),
  rewindQueue: json({
    method: "POST",
    path: "/api/queue/previous",
    summary: "Move to the previous track",
    params: NoParams,
    query: NoQuery,
    response: QueueState,
  }),
  jumpInQueue: json({
    method: "POST",
    path: "/api/queue/jump",
    summary: "Make an entry the current track",
    params: NoParams,
    query: NoQuery,
    body: Jump,
    response: QueueState,
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
      /**
       * Start offset in seconds for transcoded streams, used to resume after a quality
       * switch or to seek. Originals seek with HTTP Range requests instead.
       */
      start: z.coerce.number().min(0).optional(),
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
