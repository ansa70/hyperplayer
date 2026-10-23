import { z } from "zod";
import type { HttpClient } from "./http.ts";

const Entities = z.looseObject({
  entities: z.record(
    z.string(),
    z.looseObject({
      sitelinks: z.record(z.string(), z.looseObject({ title: z.string() })).default({}),
      descriptions: z.record(z.string(), z.looseObject({ value: z.string() })).default({}),
      claims: z
        .record(
          z.string(),
          z.array(
            z.looseObject({
              mainsnak: z.looseObject({ datavalue: z.looseObject({ value: z.unknown() }).optional() }),
            }),
          ),
        )
        .default({}),
    }),
  ),
});

const Summary = z.looseObject({
  type: z.string(),
  extract: z.string().default(""),
  content_urls: z.looseObject({ desktop: z.looseObject({ page: z.string() }) }).optional(),
});

export interface WikiProfile {
  /** Wikipedia summary, or Wikidata's one-line description when there is no article. */
  biography: string | null;
  biographyUrl: string | null;
  /** Freely licensed photo on Wikimedia Commons (Wikidata P18). */
  imageUrl: string | null;
}

/** Biography from Wikipedia and photo from Wikimedia Commons, both via the artist's Wikidata item. */
export class Wikipedia {
  readonly #http: HttpClient;
  readonly #lang: string;

  constructor(http: HttpClient, lang: string) {
    this.#http = http;
    this.#lang = lang;
  }

  async profile(wikidataUrl: string): Promise<WikiProfile> {
    const qid = wikidataUrl.match(/Q\d+$/)?.[0];
    if (!qid) return { biography: null, biographyUrl: null, imageUrl: null };
    const sites = [`${this.#lang}wiki`, "enwiki"];
    const { entities } = await this.#http.json(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks%7Cclaims%7Cdescriptions&sitefilter=${sites.join("%7C")}&languages=${this.#lang}%7Cen&format=json`,
      Entities,
    );
    const entity = entities[qid];
    const image = entity?.claims.P18?.[0]?.mainsnak.datavalue?.value;
    const imageUrl =
      typeof image === "string"
        ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(image)}?width=1200`
        : null;

    for (const site of sites) {
      const title = entity?.sitelinks[site]?.title;
      if (!title) continue;
      const lang = site.replace(/wiki$/, "");
      const summary = await this.#http.json(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
        Summary,
      );
      if (summary.type === "standard" && summary.extract) {
        return {
          biography: summary.extract,
          biographyUrl: summary.content_urls?.desktop.page ?? null,
          imageUrl,
        };
      }
    }
    // No article (common for side projects and ensembles): fall back to Wikidata's description,
    // e.g. "American musical group; jazz quartet led by Miles Davis".
    const description = (entity?.descriptions[this.#lang] ?? entity?.descriptions.en)?.value;
    return description
      ? {
          biography: `${description[0]!.toUpperCase()}${description.slice(1)}.`,
          biographyUrl: `https://www.wikidata.org/wiki/${qid}`,
          imageUrl,
        }
      : { biography: null, biographyUrl: null, imageUrl };
  }
}

const FanartArtist = z.looseObject({
  artistthumb: z.array(z.looseObject({ url: z.string(), likes: z.coerce.number().default(0) })).default([]),
  artistbackground: z
    .array(z.looseObject({ url: z.string(), likes: z.coerce.number().default(0) }))
    .default([]),
});

/** fanart.tv: curated artist photos and wide backgrounds (needs a free API key). */
export class Fanart {
  readonly #http: HttpClient;
  readonly #key: string;

  constructor(http: HttpClient, key: string) {
    this.#http = http;
    this.#key = key;
  }

  async artist(mbid: string): Promise<{ thumb: string | null; background: string | null }> {
    const res = await this.#http.json(
      `https://webservice.fanart.tv/v3/music/${mbid}?api_key=${this.#key}`,
      FanartArtist,
    );
    const best = (images: { url: string; likes: number }[]) =>
      [...images].sort((a, b) => b.likes - a.likes)[0]?.url ?? null;
    return { thumb: best(res.artistthumb), background: best(res.artistbackground) };
  }
}
