import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import { api, openApiDocument, type ApiError, type LibraryStatus } from "@hyperplayer/schemas";
import Fastify from "fastify";
import sharp from "sharp";
import { Catalog } from "./catalog/catalog.ts";
import { Enricher } from "./enrich/enricher.ts";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { binaryRoute, HttpError, jsonRoute, notFound } from "./http/contract.ts";
import { ArtworkStore } from "./library/artwork.ts";
import { Scanner } from "./library/scanner.ts";
import { mimeForContainer, openFile, parseRange, transcode } from "./stream/stream.ts";

export async function buildApp(config: Config, opts: { logger?: boolean } = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, "library.db"));
  const artwork = new ArtworkStore(db, config.dataDir);
  const scanner = new Scanner(db, artwork);
  const app = Fastify({ logger: opts.logger ?? true });
  const enricher = new Enricher(db, artwork, app.log, config.enrich);
  const catalog = new Catalog(db, enricher);
  await app.register(cors, { origin: true });

  let scanning: Promise<void> | null = null;
  const startScan = () => {
    scanning ??= scanner
      .scan(config.libraryPath)
      .then((s) => {
        app.log.info(s, "library scan finished");
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

  const v = { validateResponse: config.validateResponses };

  jsonRoute(app, api.libraryStatus, () => status(), v);
  jsonRoute(app, api.libraryScan, () => (void startScan(), status()), v);
  jsonRoute(app, api.listArtists, ({ query }) => catalog.listArtists(query.offset, query.limit), v);
  jsonRoute(
    app,
    api.getArtist,
    ({ params }) => catalog.getArtist(params.id) ?? Promise.reject(notFound("Artist")),
    v,
  );
  jsonRoute(app, api.getArtistAlbums, ({ params }) => catalog.artistAlbums(params.id), v);
  jsonRoute(app, api.listAlbums, ({ query }) => catalog.listAlbums(query.offset, query.limit, query.sort), v);
  jsonRoute(
    app,
    api.getAlbum,
    ({ params }) => catalog.getAlbum(params.id) ?? Promise.reject(notFound("Album")),
    v,
  );
  jsonRoute(app, api.listTracks, ({ query }) => catalog.listTracks(query.offset, query.limit), v);
  jsonRoute(
    app,
    api.nowPlaying,
    ({ params }) => {
      enricher.prioritizeTrack(params.id);
      return catalog.nowPlaying(params.id) ?? Promise.reject(notFound("Track"));
    },
    v,
  );
  jsonRoute(
    app,
    api.trackCredits,
    ({ params }) => {
      enricher.prioritizeTrack(params.id);
      return catalog.trackCredits(params.id) ?? Promise.reject(notFound("Track"));
    },
    v,
  );
  jsonRoute(
    app,
    api.enrichArtist,
    ({ params }) => {
      if (!catalog.getArtist(params.id)) throw notFound("Artist");
      enricher.refreshArtist(params.id);
      return status();
    },
    v,
  );
  jsonRoute(app, api.search, ({ query }) => catalog.search(query.q, query.limit), v);

  binaryRoute(app, api.stream, ({ params, query, request }, reply) => {
    const track = catalog.trackPath(params.id);
    if (!track) throw notFound("Track");
    if (query.format !== "original") {
      const t = transcode(config.ffmpeg, track.path, query.format, query.bitrate);
      request.raw.on("close", t.kill);
      return reply.header("Content-Type", t.mime).header("Cache-Control", "no-store").send(t.stream);
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
        .send(openFile(track.path, range));
    }
    return reply.header("Content-Length", track.fileSize).send(openFile(track.path));
  });

  binaryRoute(app, api.artwork, async ({ params, query }, reply) => {
    const art = catalog.artworkPath(params.id);
    if (!art) throw notFound("Artwork");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
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

  return { app, startScan };
}
