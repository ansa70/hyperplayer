// The HyperPlayer API, typed from the shared contract (`@hyperplayer/schemas`): every
// call names an endpoint of `api`, and its params, query, body and response follow
// that endpoint's Zod schemas. The page is served by the server itself, so requests are
// same-origin and signed in by the HttpOnly session cookie.

import { api, ApiError, type JsonEndpoint } from "@hyperplayer/schemas";
import type { z } from "zod";

export { api };

/** An error response from the server, with its code (`not_found`, `unauthorized`, …). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Params<E extends JsonEndpoint> = z.input<E["params"]>;
type Query<E extends JsonEndpoint> = z.input<E["query"]>;
type Body<E extends JsonEndpoint> = z.input<E["body"]>;

export interface CallInput<E extends JsonEndpoint> {
  params?: Params<E>;
  query?: Query<E>;
  body?: Body<E>;
  signal?: AbortSignal;
}

/** Called when the session has ended (signed out elsewhere, or the device revoked). */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(f: () => void) {
  onUnauthorized = f;
}

/** Fills `{name}` placeholders in a contract path, and appends a query string. */
export function url(path: string, params: object = {}, query: object = {}): string {
  const values = params as Record<string, string | number | undefined>;
  const filled = path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(String(values[name] ?? "")),
  );
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(
    query as Record<string, string | number | boolean | null | undefined>,
  )) {
    if (v !== undefined && v !== null) search.set(k, String(v));
  }
  const qs = search.toString();
  return qs ? `${filled}?${qs}` : filled;
}

/** Calls a JSON endpoint and returns its response, checked against the contract. */
export async function call<E extends JsonEndpoint>(
  endpoint: E,
  input: CallInput<E> = {},
): Promise<z.output<E["response"]>> {
  const res = await fetch(url(endpoint.path, input.params ?? {}, input.query ?? {}), {
    method: endpoint.method,
    credentials: "same-origin",
    headers: input.body === undefined ? undefined : { "content-type": "application/json" },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: input.signal,
  });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = ApiError.safeParse(json);
    if (res.status === 401) onUnauthorized();
    throw new HttpError(
      res.status,
      err.success ? err.data.error : "http_error",
      err.success ? err.data.message : `${res.status} ${res.statusText}`,
    );
  }
  return endpoint.response.parse(json) as z.output<E["response"]>;
}

/** The URL of an artwork image, at about `size` pixels. */
export function artworkUrl(id: string, size?: number): string {
  // Twice the size on sharp screens, in steps the server caches well.
  const px = size ? Math.min(4096, Math.ceil((size * (window.devicePixelRatio || 1)) / 64) * 64) : undefined;
  return url(api.artwork.path, { id }, { size: px });
}

/** A short message for an error, for the status line. */
export function errorMessage(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
