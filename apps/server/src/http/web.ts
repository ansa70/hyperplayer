import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";

/** Types of the files a Vite build produces. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The page may load scripts, styles, media and data only from this server (covers and
 * audio included). Inline style attributes are allowed: React sets sizes with them.
 */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/**
 * The web player's build: `HP_WEB_DIR`, else beside the bundled server (`<bundle>/web`),
 * else the workspace's `apps/web/dist` when running from the sources. Null when there's none.
 */
export function findWebDir(configured: string | undefined): string | null {
  const candidates = configured
    ? [configured]
    : [resolve(import.meta.dirname, "../web"), resolve(import.meta.dirname, "../../../web/dist")];
  return candidates.find((d) => existsSync(join(d, "index.html"))) ?? null;
}

/**
 * Serves the web player at `/`: its files as they are (fingerprinted assets cached for a
 * year), and `index.html` for every other path that isn't the API, so the app's own
 * links (`/album/…`) work when opened directly or reloaded.
 */
export function serveWebApp(app: FastifyInstance, dir: string) {
  const root = resolve(dir);
  const index = join(root, "index.html");
  app.setNotFoundHandler((request, reply) => {
    let path: string;
    try {
      path = decodeURIComponent(request.url.split("?")[0] ?? "/");
    } catch {
      return reply.status(400).send({ error: "bad_request", message: "Malformed URL" });
    }
    if (
      (request.method !== "GET" && request.method !== "HEAD") ||
      path.startsWith("/api/") ||
      path === "/api"
    ) {
      return reply.status(404).send({ error: "not_found", message: `${request.method} ${path} not found` });
    }
    let file = resolve(root, `.${path}`);
    // Outside the build (`..`), or not a file: the app, which routes it itself.
    const inside = file === root || file.startsWith(root + sep);
    if (!inside || !existsSync(file) || !statSync(file).isFile()) file = index;
    const isIndex = file === index;
    reply
      .header("content-type", MIME[extname(file)] ?? "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header(
        "cache-control",
        isIndex
          ? "no-cache"
          : path.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "public, max-age=3600",
      );
    if (isIndex) reply.header("content-security-policy", CSP).header("referrer-policy", "same-origin");
    return reply.send(createReadStream(file));
  });
}
