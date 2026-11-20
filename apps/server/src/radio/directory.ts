import type { RadioFacet, RadioOrder } from "@hyperplayer/schemas";
import { z } from "zod";
import type { Fetch } from "../history/scrobbler.ts";

/**
 * The Radio Browser directory (https://www.radio-browser.info): free, without a key, run
 * on several mirrors. The mirrors are listed by `all.api.radio-browser.info`; a request
 * goes to the one that last answered and moves on to the others when it fails. Answers
 * are cached for a while: the directory changes slowly, and it asks clients to go easy.
 */

/** A station as the server keeps it: the API's `RadioStation` without the caller's own flags. */
export interface StationRecord {
  id: string;
  name: string;
  streamUrl: string;
  homepage: string | null;
  /** Where the logo is fetched from (not given out: clients get it through the server). */
  logoUrl: string | null;
  country: string | null;
  countryCode: string | null;
  languages: string[];
  tags: string[];
  codec: string | null;
  bitrate: number | null;
  clicks: number;
  custom: boolean;
}

export interface StationQuery {
  q?: string | undefined;
  country?: string | undefined;
  language?: string | undefined;
  tag?: string | undefined;
  order: RadioOrder;
  offset: number;
  limit: number;
}

export class DirectoryUnavailable extends Error {}

const SERVERS_URL = "https://all.api.radio-browser.info/json/servers";
/** Used when the list of mirrors can't be had. */
const FALLBACK_SERVERS = [
  "de1.api.radio-browser.info",
  "fi1.api.radio-browser.info",
  "de2.api.radio-browser.info",
];
const SERVERS_TTL = 24 * 3600_000;
const SEARCH_TTL = 10 * 60_000;
const FACETS_TTL = 24 * 3600_000;
const CACHE_ENTRIES = 500;
/** Stations kept by id, for their stream and logo addresses when they're played or shown. */
const STATION_ENTRIES = 5000;
const TIMEOUT_MS = 10_000;

const ORDER: Record<RadioOrder, string> = {
  popular: "clickcount",
  trending: "clicktrend",
  votes: "votes",
  name: "name",
};

const RawStation = z.object({
  stationuuid: z.string(),
  name: z.string(),
  url: z.string(),
  url_resolved: z.string().nullish(),
  homepage: z.string().nullish(),
  favicon: z.string().nullish(),
  tags: z.string().nullish(),
  country: z.string().nullish(),
  countrycode: z.string().nullish(),
  language: z.string().nullish(),
  codec: z.string().nullish(),
  bitrate: z.number().nullish(),
  clickcount: z.number().nullish(),
});

const RawFacet = z.object({
  name: z.string(),
  stationcount: z.number(),
  iso_3166_1: z.string().nullish(),
});

/** An http(s) address, or null. */
export function webUrl(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  try {
    const url = new URL(v);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const list = (value: string | null | undefined, max: number) =>
  [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, max);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A directory entry as a station, or null for one that can't be played (no usable address). */
export function toStation(raw: z.output<typeof RawStation>): StationRecord | null {
  const id = raw.stationuuid.toLowerCase();
  const streamUrl = webUrl(raw.url_resolved) ?? webUrl(raw.url);
  const name = raw.name.trim();
  if (!UUID.test(id) || !streamUrl || !name) return null;
  const codec = raw.codec?.trim().toUpperCase();
  const countryCode = raw.countrycode?.trim().toUpperCase();
  return {
    id,
    name,
    streamUrl,
    homepage: webUrl(raw.homepage),
    logoUrl: webUrl(raw.favicon),
    country: raw.country?.trim() || null,
    countryCode: countryCode && /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
    languages: list(raw.language, 5),
    tags: list(raw.tags?.toLowerCase(), 12),
    codec: codec && codec !== "UNKNOWN" ? codec : null,
    bitrate: raw.bitrate && raw.bitrate > 0 ? Math.round(raw.bitrate) : null,
    clicks: Math.max(0, Math.round(raw.clickcount ?? 0)),
    custom: false,
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class RadioDirectory {
  readonly #fetch: Fetch;
  readonly #userAgent: string;
  #servers: { hosts: string[]; until: number } | null = null;
  #preferred: string | null = null;
  readonly #cache = new Map<string, { until: number; value: Promise<unknown> }>();
  readonly #stations = new Map<string, StationRecord>();

  constructor(opts: { userAgent: string; fetch?: Fetch | undefined }) {
    this.#userAgent = opts.userAgent;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async #hosts(): Promise<string[]> {
    if (this.#servers && this.#servers.until > Date.now()) return this.#servers.hosts;
    let hosts: string[] = [];
    try {
      const res = await this.#fetch(SERVERS_URL, this.#init());
      if (res.ok) {
        const servers = z.array(z.object({ name: z.string() })).parse(await res.json());
        hosts = [...new Set(servers.map((s) => s.name.toLowerCase()))].filter((h) =>
          /^[a-z0-9.-]+\.api\.radio-browser\.info$/.test(h),
        );
      }
    } catch {
      // The fallback list below.
    }
    if (!hosts.length) hosts = FALLBACK_SERVERS;
    // Spread clients over the mirrors, as the directory asks.
    hosts = hosts
      .map((h) => [Math.random(), h] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, h]) => h);
    this.#servers = { hosts, until: Date.now() + SERVERS_TTL };
    return hosts;
  }

  #init(init: RequestInit = {}): RequestInit {
    return {
      ...init,
      headers: { "User-Agent": this.#userAgent, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
  }

  /** GETs `path` (with its query) from a mirror, trying the others when one fails. */
  async #get(path: string): Promise<unknown> {
    const hosts = await this.#hosts();
    const order = this.#preferred ? [this.#preferred, ...hosts.filter((h) => h !== this.#preferred)] : hosts;
    let last: unknown = null;
    for (const host of order) {
      try {
        const res = await this.#fetch(`https://${host}${path}`, this.#init());
        if (!res.ok) throw new Error(`${host}${path}: ${res.status}`);
        const body: unknown = await res.json();
        this.#preferred = host;
        return body;
      } catch (err) {
        last = err;
        if (this.#preferred === host) this.#preferred = null;
      }
    }
    throw new DirectoryUnavailable(`The radio directory can't be reached (${String(last)})`);
  }

  /** `load`'s answer, shared by callers within `ttl`; failures aren't kept. */
  #cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
    const value = load();
    this.#cache.delete(key);
    this.#cache.set(key, { until: Date.now() + ttl, value });
    value.catch(() => {
      if (this.#cache.get(key)?.value === value) this.#cache.delete(key);
    });
    for (const k of this.#cache.keys()) {
      if (this.#cache.size <= CACHE_ENTRIES) break;
      this.#cache.delete(k);
    }
    return value;
  }

  #remember(stations: StationRecord[]) {
    for (const s of stations) {
      this.#stations.delete(s.id);
      this.#stations.set(s.id, s);
    }
    for (const k of this.#stations.keys()) {
      if (this.#stations.size <= STATION_ENTRIES) break;
      this.#stations.delete(k);
    }
  }

  #parseStations(body: unknown): StationRecord[] {
    const raw = z.array(z.unknown()).parse(body);
    const stations = raw.flatMap((r) => {
      const parsed = RawStation.safeParse(r);
      const station = parsed.success ? toStation(parsed.data) : null;
      return station ? [station] : [];
    });
    this.#remember(stations);
    return stations;
  }

  /** A page of working stations; `more` when the directory may have further ones. */
  search(query: StationQuery): Promise<{ items: StationRecord[]; more: boolean }> {
    const params = new URLSearchParams({
      order: ORDER[query.order],
      reverse: String(query.order !== "name"),
      hidebroken: "true",
      offset: String(query.offset),
      limit: String(query.limit),
    });
    if (query.q) params.set("name", query.q);
    if (query.country) params.set("countrycode", query.country);
    if (query.language) {
      params.set("language", query.language.toLowerCase());
      params.set("languageExact", "true");
    }
    if (query.tag) {
      params.set("tag", query.tag.toLowerCase());
      params.set("tagExact", "true");
    }
    const path = `/json/stations/search?${params.toString()}`;
    return this.#cached(path, SEARCH_TTL, async () => {
      const body = await this.#get(path);
      const items = this.#parseStations(body);
      return { items, more: (body as unknown[]).length >= query.limit };
    }).then((page) => {
      // A cached page's stations are remembered again (they may have been pushed out).
      this.#remember(page.items);
      return page;
    });
  }

  /** Counts a play of the station (the directory keeps one per listener a day). */
  async click(id: string): Promise<void> {
    await this.#get(`/json/url/${encodeURIComponent(id)}`);
  }

  /** A station by its uuid, or null when the directory doesn't have it (any more). */
  async station(id: string): Promise<StationRecord | null> {
    const known = this.#stations.get(id);
    if (known) return known;
    const body = await this.#get(`/json/stations/byuuid?${new URLSearchParams({ uuids: id }).toString()}`);
    return this.#parseStations(body).find((s) => s.id === id) ?? null;
  }

  countries(): Promise<RadioFacet[]> {
    return this.#facets("countries", (f) => {
      const code = f.iso_3166_1?.trim().toUpperCase();
      return code && /^[A-Z]{2}$/.test(code) ? { value: code, label: f.name.trim() || code } : null;
    });
  }

  languages(): Promise<RadioFacet[]> {
    return this.#facets("languages", (f) => {
      const name = f.name.trim();
      return name ? { value: name, label: capitalize(name) } : null;
    });
  }

  async tags(limit: number): Promise<RadioFacet[]> {
    const tags = await this.#facets("tags", (f) => {
      const name = f.name.trim().toLowerCase();
      // Tags are free text: many are one station's stray words.
      return name && name.length <= 40 ? { value: name, label: name } : null;
    });
    return tags.slice(0, limit);
  }

  #facets(
    kind: "countries" | "languages" | "tags",
    map: (f: z.output<typeof RawFacet>) => { value: string; label: string } | null,
  ): Promise<RadioFacet[]> {
    // Tags: the 1000 most used are plenty for browsing.
    const limit = kind === "tags" ? "&limit=1000" : "";
    const path = `/json/${kind}?order=stationcount&reverse=true&hidebroken=true${limit}`;
    return this.#cached(path, FACETS_TTL, async () => {
      const raw = z.array(z.unknown()).parse(await this.#get(path));
      const merged = new Map<string, RadioFacet>();
      for (const r of raw) {
        const parsed = RawFacet.safeParse(r);
        const facet = parsed.success ? map(parsed.data) : null;
        if (!facet || parsed.data!.stationcount <= 0) continue;
        // The directory lists some names twice (case, spacing): their counts add up.
        const prev = merged.get(facet.value);
        merged.set(facet.value, {
          ...facet,
          label: prev?.label ?? facet.label,
          stations: (prev?.stations ?? 0) + parsed.data!.stationcount,
        });
      }
      return [...merged.values()].sort((a, b) => b.stations - a.stations);
    });
  }
}
