import { z } from "zod";

export class NotFound extends Error {}

export interface HttpClient {
  json<S extends z.ZodType>(url: string, schema: S): Promise<z.output<S>>;
  bytes(url: string): Promise<{ data: Uint8Array; mime: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch wrapper with a per-host minimum interval between requests (MusicBrainz
 * allows one request per second per client) and retries on 503/429.
 */
export function httpClient(opts: { userAgent: string; minIntervalMs?: Record<string, number> }): HttpClient {
  const nextSlot = new Map<string, number>();

  async function request(url: string, accept: string): Promise<Response> {
    const host = new URL(url).host;
    const interval = opts.minIntervalMs?.[host] ?? 0;
    for (let attempt = 0; ; attempt++) {
      if (interval) {
        // Reserve the next slot synchronously so concurrent callers queue up behind each other.
        const now = Date.now();
        const slot = Math.max(now, nextSlot.get(host) ?? 0);
        nextSlot.set(host, slot + interval);
        await sleep(slot - now);
      }
      const res = await fetch(url, {
        headers: { "User-Agent": opts.userAgent, Accept: accept },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) throw new NotFound(url);
      if ((res.status === 503 || res.status === 429) && attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
      return res;
    }
  }

  return {
    async json(url, schema) {
      const res = await request(url, "application/json");
      return schema.parse(await res.json());
    },
    async bytes(url) {
      const res = await request(url, "image/*");
      return { data: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "" };
    },
  };
}
