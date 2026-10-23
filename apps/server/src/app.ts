import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import type { Readable } from "node:stream";
import { join } from "node:path";
import cors from "@fastify/cors";
import { api, openApiDocument, type ApiError, type LibraryStatus, type Session } from "@hyperplayer/schemas";
import Fastify, { type FastifyReply } from "fastify";
import sharp from "sharp";
import { Catalog } from "./catalog/catalog.ts";
import { Playlists } from "./collections/playlists.ts";
import { Queues } from "./collections/queues.ts";
import { Enricher } from "./enrich/enricher.ts";
import { httpClient } from "./enrich/http.ts";
import { LyricsService } from "./lyrics/lyrics.ts";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { Auth, type AuthContext } from "./auth/auth.ts";
import { HttpError, notFound, Router, SESSION_COOKIE } from "./http/contract.ts";
import { ArtworkStore } from "./library/artwork.ts";
import { Scanner } from "./library/scanner.ts";
import {
  mimeForContainer,
  openFile,
  parseRange,
  throttle,
  transcode,
  TranscodeError,
} from "./stream/stream.ts";

export const SERVER_VERSION = "0.1.0";

export async function buildApp(config: Config, opts: { logger?: boolean } = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, "library.db"));
  const artwork = new ArtworkStore(db, config.dataDir);
  const scanner = new Scanner(db, artwork);
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: config.trustProxy });
  const enricher = new Enricher(db, artwork, app.log, config.enrich);
  const catalog = new Catalog(db, enricher);
  const playlists = new Playlists(db, catalog);
  const queues = new Queues(db, catalog);
  // LRCLIB is an online lookup like enrichment, so it's off when enrichment is.
  const lyrics = new LyricsService(
    db,
    config.enrich.enabled
      ? httpClient({
          userAgent: `HyperPlayer/${SERVER_VERSION} ( ${config.enrich.contact} )`,
          minIntervalMs: { "lrclib.net": 250 },
        })
      : null,
  );
  // Native clients ignore CORS; browsers get access only from explicitly listed origins.
  if (config.corsOrigins.length) await app.register(cors, { origin: config.corsOrigins, credentials: true });

  let scanning: Promise<void> | null = null;
  const startScan = () => {
    scanning ??= scanner
      .scan(config.libraryPath)
      .then((s) => {
        app.log.info(s, "library scan finished");
        const relinked = playlists.relink();
        if (relinked) app.log.info({ relinked }, "playlist entries relinked to moved tracks");
        enricher.enqueuePending();
      })
      .catch((err: unknown) => app.log.error(err, "library scan failed"))
      .finally(() => (scanning = null));
    return scanning;
  };
  const status = (): LibraryStatus => ({
    scanning: scanning !== null,
    lastScanAt: catalog.lastScanAt(),
    ...catalog.counts(),
    enrichmentQueue: enricher.queueSize,
  });

  app.setErrorHandler((err, _req, reply) => {
    const body: ApiError =
      err instanceof HttpError
        ? { error: err.code, message: err.message }
        : { error: "internal", message: "Internal server error" };
    if (!(err instanceof HttpError)) app.log.error(err);
    return reply.status(err instanceof HttpError ? err.status : 500).send(body);
  });

  const auth = new Auth(db, config.defaultAdminPassword);
  if (await auth.ensureDefaultAdmin()) {
    app.log.warn(
      `Created the "admin" account with the default password. Sign in from a client to choose a real one; ` +
        `until then it can do nothing else.`,
    );
  }
  const route = new Router(app, auth, { validateResponses: config.validateResponses });
  const ok = { ok: true as const };
  const who = (a: AuthContext) => ({ deviceId: a.deviceId, userId: a.user.id });

  // ------------------------------------------------------------------ auth
  route.json(api.authStatus, () => ({
    defaultAdmin: auth.defaultAdminActive,
    serverVersion: SERVER_VERSION,
  }));
  const startSession = (session: Session, wantsCookie: boolean, reply: FastifyReply) => {
    if (wantsCookie) {
      reply.header(
        "Set-Cookie",
        `${SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` +
          (config.secureCookies ? "; Secure" : ""),
      );
    }
    return session;
  };
  route.json(api.login, async ({ body, request, reply }) =>
    startSession(await auth.login(body, request.ip), body.cookie, reply),
  );
  route.json(api.logout, ({ auth: a, reply }) => {
    auth.revoke(a, a.deviceId);
    reply.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return ok;
  });
  route.json(api.me, ({ auth: a }) => ({ user: a.user, device: auth.device(a) }));
  route.json(api.changePassword, async ({ auth: a, body }) => {
    await auth.changePassword(a, body.currentPassword, body.newPassword);
    return ok;
  });
  route.json(api.listDevices, ({ auth: a }) => auth.devices(a));
  route.json(api.revokeDevice, ({ auth: a, params }) => (auth.revoke(a, params.id), ok));
  route.json(api.onboard, ({ auth: a, body }) => auth.onboard(a, body));
  route.json(api.getPreferences, ({ auth: a }) => auth.preferences(a.user.id));
  route.json(api.updatePreferences, ({ auth: a, body }) => auth.updatePreferences(a.user.id, body));
  route.json(api.listUsers, () => auth.users());
  route.json(api.createUser, ({ body }) =>
    auth.createUser(body.username, body.password, body.admin, body.fullName),
  );

  // --------------------------------------------------------------- library
  route.json(api.libraryStatus, () => status());
  route.json(api.libraryScan, () => (void startScan(), status()));
  route.json(api.listArtists, ({ query }) => catalog.listArtists(query.offset, query.limit));
  route.json(
    api.getArtist,
    ({ params }) => catalog.getArtist(params.id) ?? Promise.reject(notFound("Artist")),
  );
  route.json(api.getArtistAlbums, ({ params }) => catalog.artistAlbums(params.id));
  route.json(api.listAlbums, ({ query }) => catalog.listAlbums(query.offset, query.limit, query.sort));
  route.json(api.getAlbum, ({ params }) => catalog.getAlbum(params.id) ?? Promise.reject(notFound("Album")));
  route.json(api.listTracks, ({ query }) => catalog.listTracks(query.offset, query.limit));
  route.json(api.nowPlaying, ({ params }) => {
    enricher.prioritizeTrack(params.id);
    return catalog.nowPlaying(params.id) ?? Promise.reject(notFound("Track"));
  });
  route.json(api.trackCredits, ({ params }) => {
    enricher.prioritizeTrack(params.id);
    return catalog.trackCredits(params.id) ?? Promise.reject(notFound("Track"));
  });
  route.json(api.lyrics, ({ params }) => lyrics.get(params.id) ?? Promise.reject(notFound("Track")));
  route.json(api.enrichArtist, ({ params }) => {
    if (!catalog.getArtist(params.id)) throw notFound("Artist");
    enricher.refreshArtist(params.id);
    return status();
  });
  route.json(api.search, ({ query }) => catalog.search(query.q, query.limit));

  // ------------------------------------------------------------- playlists
  route.json(api.listPlaylists, ({ auth: a }) => playlists.list(a.user.id));
  route.json(api.createPlaylist, ({ auth: a, body }) =>
    playlists.create(a.user.id, body.name, body.description ?? null, body.trackIds),
  );
  route.json(api.getPlaylist, ({ auth: a, params }) => playlists.get(a.user.id, params.id));
  route.json(api.updatePlaylist, ({ auth: a, params, body }) => playlists.update(a.user.id, params.id, body));
  route.json(api.deletePlaylist, ({ auth: a, params }) => (playlists.delete(a.user.id, params.id), ok));
  route.json(api.addToPlaylist, ({ auth: a, params, body }) =>
    playlists.add(a.user.id, params.id, body.source, body.position),
  );
  route.json(api.removeFromPlaylist, ({ auth: a, params }) =>
    playlists.remove(a.user.id, params.id, params.entryId),
  );
  route.json(api.movePlaylistEntry, ({ auth: a, params, body }) =>
    playlists.move(a.user.id, params.id, params.entryId, body.toIndex),
  );

  // ----------------------------------------------------------------- queue
  route.json(api.getQueue, ({ auth: a }) => queues.get(who(a)));
  route.json(api.setQueue, ({ auth: a, body }) => queues.set(who(a), body.source, body.start, body.shuffle));
  route.json(api.updateQueue, ({ auth: a, body }) => queues.update(who(a), body));
  route.json(api.clearQueue, ({ auth: a }) => queues.clear(who(a)));
  route.json(api.addToQueue, ({ auth: a, body }) => queues.add(who(a), body.source, body.placement));
  route.json(api.removeFromQueue, ({ auth: a, params }) => queues.remove(who(a), params.entryId));
  route.json(api.advanceQueue, ({ auth: a, body }) => queues.advance(who(a), body.auto));
  route.json(api.rewindQueue, ({ auth: a }) => queues.back(who(a)));
  route.json(api.jumpInQueue, ({ auth: a, body }) => queues.jump(who(a), body.entryId));

  route.binary(api.stream, async ({ params, query, request, reply }) => {
    const track = catalog.trackPath(params.id);
    if (!track) throw notFound("Track");
    const limit = (s: Readable) => (config.debugThrottleKbps ? throttle(s, config.debugThrottleKbps) : s);
    if (query.format !== "original") {
      const t = await transcode(config.ffmpeg, track.path, query.format, query.bitrate, query.start).catch(
        (err: unknown) => {
          throw err instanceof TranscodeError ? new HttpError(502, "transcode_failed", err.message) : err;
        },
      );
      request.raw.on("close", t.kill);
      return reply.header("Content-Type", t.mime).header("Cache-Control", "no-store").send(limit(t.stream));
    }
    const range = parseRange(request.headers.range, track.fileSize);
    reply.header("Accept-Ranges", "bytes").header("Content-Type", mimeForContainer(track.container));
    if (range === "unsatisfiable") {
      return reply.status(416).header("Content-Range", `bytes */${track.fileSize}`).send();
    }
    if (range) {
      return reply
        .status(206)
        .header("Content-Range", `bytes ${range.start}-${range.end}/${track.fileSize}`)
        .header("Content-Length", range.end - range.start + 1)
        .send(limit(openFile(track.path, range)));
    }
    return reply.header("Content-Length", track.fileSize).send(limit(openFile(track.path)));
  });

  route.binary(api.artwork, async ({ params, query, reply }) => {
    const art = catalog.artworkPath(params.id);
    if (!art) throw notFound("Artwork");
    // Private: artwork now requires a session, so shared caches must not keep it.
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    if (!query.size) return reply.header("Content-Type", art.mime).send(await readFile(art.path));
    const resized = await sharp(art.path)
      .resize(query.size, query.size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    return reply.header("Content-Type", "image/webp").send(resized);
  });

  app.get("/openapi.json", () => openApiDocument());
  app.addHook("onClose", () => {
    enricher.stop();
    db.close();
  });

  return { app, startScan, auth };
}
