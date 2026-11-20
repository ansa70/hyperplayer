import { z } from "zod";
import { named } from "./models.ts";

/*
 * Internet radio. Stations come from the Radio Browser directory (radio-browser.info,
 * looked up by the server) or are added by a user from a stream address. Each user keeps
 * their own favourites; a station added by address is theirs only.
 */

const Count = z.int().nonnegative();

/** A Radio Browser station's uuid, or `custom-…` for one a user added. */
export const RadioStationId = named(
  "RadioStationId",
  z.string().regex(/^(?:[0-9a-f-]{36}|custom-[0-9a-f]{16})$/),
);

export const RadioStation = named(
  "RadioStation",
  z.object({
    id: RadioStationId,
    name: z.string(),
    /** The address the server plays the station from (the directory's, or the user's). */
    streamUrl: z.url(),
    homepage: z.string().nullable(),
    /** Whether the station has a logo (`/api/radio/stations/{id}/logo`). */
    hasLogo: z.boolean(),
    country: z.string().nullable(),
    /** ISO 3166-1 alpha-2, upper case. */
    countryCode: z.string().nullable(),
    languages: z.array(z.string()),
    tags: z.array(z.string()),
    /** As the directory reports it (e.g. `MP3`, `AAC`); null when unknown. */
    codec: z.string().nullable(),
    /** In kbit/s; null when unknown. */
    bitrate: z.int().positive().nullable(),
    /** How often the station was played through the directory recently (its popularity). */
    clicks: Count,
    /** Added by a user from a stream address rather than found in the directory. */
    custom: z.boolean(),
    favourite: z.boolean(),
  }),
);

export const RadioStationPage = named(
  "RadioStationPage",
  z.object({
    items: z.array(RadioStation),
    offset: Count,
    limit: Count,
    /** Whether asking for the next page may return more (the directory doesn't give totals). */
    more: z.boolean(),
  }),
);

export const RadioStationList = named("RadioStationList", z.object({ items: z.array(RadioStation) }));

export const RadioOrder = named(
  "RadioOrder",
  z.enum(["popular", "trending", "votes", "name"]),
  "`popular`: most played; `trending`: most gaining; `votes`: best liked; `name`: alphabetical.",
);

export const RadioFacet = named(
  "RadioFacet",
  z.object({
    /** What to filter on: a country code, a language or a tag. */
    value: z.string(),
    /** For people: a country's name, else the value itself. */
    label: z.string(),
    stations: Count,
  }),
);

export const RadioFacets = named(
  "RadioFacets",
  z.object({ items: z.array(RadioFacet) }),
  "Countries, languages or tags to browse the directory by, the ones with most stations first.",
);

export const AddRadioStation = named(
  "AddRadioStation",
  z.object({
    name: z.string().trim().min(1).max(200),
    /** The stream (or a `.pls`/`.m3u` playlist of it). */
    streamUrl: z.url({ protocol: /^https?$/ }).max(2000),
    homepage: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .nullable()
      .default(null),
  }),
);

export const RadioNowPlaying = named(
  "RadioNowPlaying",
  z.object({
    /** What the station says is playing, as it says it; null when it says nothing (or nobody listens). */
    title: z.string().nullable(),
    /** The title split at its first " - ", the usual "Artist - Song"; null when it isn't. */
    artist: z.string().nullable(),
    song: z.string().nullable(),
  }),
  "The song a station is playing, known while someone on this server listens to it.",
);

export const RadioCodec = named(
  "RadioCodec",
  z.enum(["mp3", "aac"]),
  "Stream types a player can play as stations send them.",
);

export type RadioNowPlaying = z.infer<typeof RadioNowPlaying>;
export type RadioCodec = z.infer<typeof RadioCodec>;
export type RadioStationId = z.infer<typeof RadioStationId>;
export type RadioStation = z.infer<typeof RadioStation>;
export type RadioStationList = z.infer<typeof RadioStationList>;
export type RadioStationPage = z.infer<typeof RadioStationPage>;
export type RadioOrder = z.infer<typeof RadioOrder>;
export type RadioFacet = z.infer<typeof RadioFacet>;
export type RadioFacets = z.infer<typeof RadioFacets>;
export type AddRadioStation = z.infer<typeof AddRadioStation>;
