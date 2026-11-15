import { X509Certificate } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { connect, type PeerCertificate } from "node:tls";

/** A server refused or failed a request (its status and error code, when it answered). */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/** A self-signed certificate the user trusted: only this exact one is accepted. */
export interface Pin {
  fingerprint: string;
  /** The certificate itself (PEM), as the one authority it may be signed by. */
  certificate: string;
}

const TIMEOUT_MS = 30_000;

/**
 * The certificate `url`'s server offers, unchecked: only to compare with the fingerprint
 * the user accepted in the player.
 */
export function offeredCertificate(url: string): Promise<Pin> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: u.hostname.replace(/^\[|\]$/g, ""),
      port: Number(u.port || 443),
      servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname,
      rejectUnauthorized: false,
    });
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error("timed out")));
    socket.once("secureConnect", () => {
      const cert: PeerCertificate = socket.getPeerCertificate();
      socket.end();
      if (!cert?.raw) return reject(new SourceError(`${u.host} offered no certificate`));
      const pem = new X509Certificate(cert.raw).toString();
      resolve({ fingerprint: cert.fingerprint256, certificate: pem });
    });
    socket.once("error", (err) => reject(new SourceError(`${u.host} can't be reached: ${err.message}`)));
  });
}

/** Talks to one server, signed in with a device token. */
export class SourceClient {
  readonly #base: URL;
  readonly #token: string;
  readonly #pin: Pin | null;
  readonly #userAgent: string;

  constructor(url: string, token: string, pin: Pin | null, userAgent = "HyperPlayer (library)") {
    this.#base = new URL(url.endsWith("/") ? url : `${url}/`);
    this.#token = token;
    this.#pin = pin;
    this.#userAgent = userAgent;
  }

  /**
   * Starts a GET; the answer's body is the caller's to read (or destroy). `signal` stops it.
   * Error statuses are answers too: see `json` for turning them into errors.
   */
  get(path: string, headers: OutgoingHttpHeaders = {}, signal?: AbortSignal): Promise<IncomingMessage> {
    return this.request("GET", path, headers, signal);
  }

  request(
    method: "GET" | "POST",
    path: string,
    headers: OutgoingHttpHeaders = {},
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    const url = new URL(path.replace(/^\//, ""), this.#base);
    const https = url.protocol === "https:";
    const options: RequestOptions = {
      method,
      headers: {
        ...headers,
        authorization: `Bearer ${this.#token}`,
        "user-agent": this.#userAgent,
      },
      signal,
      timeout: TIMEOUT_MS,
    };
    if (https && this.#pin) {
      const pin = this.#pin;
      // The trusted certificate is the only authority; its name needn't match the address
      // (a home server's self-signed certificate rarely names every way to reach it).
      options.ca = pin.certificate;
      options.checkServerIdentity = (_host, cert) =>
        cert.fingerprint256 === pin.fingerprint
          ? undefined
          : new Error(`the server's certificate changed (SHA-256 ${cert.fingerprint256})`);
    }
    return new Promise((resolve, reject) => {
      const req = (https ? httpsRequest : httpRequest)(url, options, resolve);
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", (err) => {
        if (signal?.aborted) return reject(err);
        reject(new SourceError(`${this.#base.host} can't be reached: ${err.message}`));
      });
      req.end();
    });
  }

  /** A JSON answer; an error status becomes a `SourceError` with the server's message. */
  async json<T>(path: string): Promise<T> {
    const res = await this.get(path, { accept: "application/json" });
    const body = await readAll(res);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      throw new SourceError(`${this.#base.host} answered ${res.statusCode} with something other than JSON`);
    }
    if (res.statusCode !== 200) {
      const e = parsed as { error?: string; message?: string };
      throw new SourceError(
        e.message ?? `${this.#base.host} answered ${res.statusCode}`,
        res.statusCode ?? null,
        e.error ?? null,
      );
    }
    return parsed as T;
  }

  /** A binary answer (artwork), or a `SourceError`. */
  async bytes(path: string): Promise<{ data: Buffer; type: string }> {
    const res = await this.get(path);
    const data = await readAll(res);
    if (res.statusCode !== 200) {
      throw new SourceError(`${this.#base.host} answered ${res.statusCode}`, res.statusCode ?? null);
    }
    return { data, type: String(res.headers["content-type"] ?? "application/octet-stream") };
  }
}

async function readAll(res: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
