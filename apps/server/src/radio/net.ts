import { isIP } from "node:net";
import type { Fetch } from "../history/scrobbler.ts";

/**
 * Whether an address is on the server's own network. The directory is edited by anyone,
 * so its addresses aren't trusted to reach in there. Only the address as written is
 * looked at, not what its name resolves to.
 */
export function privateHost(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(host) === 6) {
    return (
      host === "::1" || host === "::" || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith("::ffff:")
    );
  }
  return false;
}

export class Refused extends Error {}

/**
 * GETs `address`, following redirects by hand so each one is checked like the first:
 * http(s) only, and (unless `allowPrivate`) nothing on the server's own network.
 * Resolves with the response and the address it finally came from.
 */
export async function fetchFollowing(
  fetch: Fetch,
  address: string,
  init: RequestInit,
  allowPrivate: boolean,
): Promise<{ res: Response; url: URL }> {
  let url = new URL(address);
  for (let hop = 0; hop < 5; hop++) {
    if ((url.protocol !== "http:" && url.protocol !== "https:") || (!allowPrivate && privateHost(url))) {
      throw new Refused(`refusing ${url.href}`);
    }
    const res = await fetch(url.href, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    return { res, url };
  }
  throw new Error(`${address}: too many redirects`);
}
