import type { Access, BinaryEndpoint, JsonEndpoint } from "@hyperplayer/schemas";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Auth, AuthContext } from "../auth/auth.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);

/** Name of the browser session cookie (an HttpOnly alternative to the bearer header). */
export const SESSION_COOKIE = "hp_session";

/** `/api/artists/{id}` → `/api/artists/:id` */
const toFastifyPath = (path: string) => path.replace(/\{(\w+)\}/g, ":$1");

function parse<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(400, "bad_request", `Invalid ${where}: ${z.prettifyError(result.error)}`);
  return result.data;
}

function cookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Finds the caller's token. Cookies are sent by browsers automatically, so a
 * cookie-authenticated request that changes state must come from our own origin
 * (CSRF protection); bearer headers are never attached implicitly and need no check.
 */
function token(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  const fromCookie = cookie(request, SESSION_COOKIE);
  if (fromCookie && !SAFE_METHODS.has(request.method)) {
    const origin = request.headers.origin;
    let sameOrigin = false;
    try {
      sameOrigin = origin !== undefined && new URL(origin).host === request.headers.host;
    } catch {
      // Malformed Origin: treat as cross-origin.
    }
    if (!sameOrigin) throw new HttpError(403, "cross_origin", "Cross-origin request rejected");
  }
  return fromCookie;
}

export interface Input<E extends JsonEndpoint | BinaryEndpoint> {
  params: z.output<E["params"]>;
  query: z.output<E["query"]>;
  body: E extends JsonEndpoint ? z.output<E["body"]> : undefined;
  /** The caller. Accessing it on a public endpoint is a programming error and throws. */
  auth: AuthContext;
  request: FastifyRequest;
  reply: FastifyReply;
}

/**
 * Registers endpoints from the shared contract. Every request is authorised
 * according to the endpoint's `access` before params, query and body are
 * validated and typed from the contract; JSON responses are checked against
 * the response schema at compile time and, optionally, at runtime.
 */
export class Router {
  readonly #app: FastifyInstance;
  readonly #auth: Auth;
  readonly #validateResponses: boolean;

  constructor(app: FastifyInstance, auth: Auth, opts: { validateResponses: boolean }) {
    this.#app = app;
    this.#auth = auth;
    this.#validateResponses = opts.validateResponses;
  }

  #authorize(access: Access, request: FastifyRequest): AuthContext | null {
    if (access === "public") return null;
    const t = token(request);
    const ctx = t ? this.#auth.authenticate(t) : null;
    if (!ctx) throw new HttpError(401, "unauthorized", "Sign in required");
    // A default password only buys enough access to replace it.
    if (ctx.user.mustChangePassword && access !== "session") {
      throw new HttpError(403, "password_change_required", "Choose a new password first");
    }
    if (access === "admin" && !ctx.user.admin) throw new HttpError(403, "forbidden", "Admins only");
    return ctx;
  }

  #input<E extends JsonEndpoint | BinaryEndpoint>(
    endpoint: E,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Input<E> {
    const auth = this.#authorize(endpoint.access, request);
    const input = {
      params: parse<E["params"]>(endpoint.params, request.params, "path parameters"),
      query: parse<E["query"]>(endpoint.query, request.query, "query"),
      body:
        endpoint.kind === "json"
          ? parse(endpoint.body, request.body ?? undefined, "request body")
          : undefined,
      request,
      reply,
    };
    return Object.defineProperty(input, "auth", {
      get() {
        if (!auth) throw new Error(`${endpoint.path} is public and has no caller`);
        return auth;
      },
    }) as Input<E>;
  }

  json<E extends JsonEndpoint>(
    endpoint: E,
    handler: (input: Input<E>) => z.input<E["response"]> | Promise<z.input<E["response"]>>,
  ) {
    this.#app.route({
      method: endpoint.method,
      url: toFastifyPath(endpoint.path),
      handler: async (request, reply) => {
        const result = await handler(this.#input(endpoint, request, reply));
        return reply.send(this.#validateResponses ? endpoint.response.parse(result) : result);
      },
    });
  }

  /** Binary endpoints write the response themselves. */
  binary<E extends BinaryEndpoint>(
    endpoint: E,
    handler: (input: Input<E>) => Promise<FastifyReply> | FastifyReply,
  ) {
    this.#app.route({
      method: endpoint.method,
      url: toFastifyPath(endpoint.path),
      handler: (request, reply) => handler(this.#input(endpoint, request, reply)),
    });
  }
}
