import type { BinaryEndpoint, JsonEndpoint } from "@hyperplayer/schemas";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

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

/** `/api/artists/{id}` → `/api/artists/:id` */
const toFastifyPath = (path: string) => path.replace(/\{(\w+)\}/g, ":$1");

function parse<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(400, "bad_request", `Invalid ${where}: ${z.prettifyError(result.error)}`);
  return result.data;
}

interface Input<E extends JsonEndpoint | BinaryEndpoint> {
  params: z.output<E["params"]>;
  query: z.output<E["query"]>;
  request: FastifyRequest;
}

/**
 * Registers a JSON endpoint from the shared contract. Params and query are
 * validated and typed from the contract; the handler's return type is checked
 * against the response schema at compile time and, optionally, at runtime.
 */
export function jsonRoute<E extends JsonEndpoint>(
  app: FastifyInstance,
  endpoint: E,
  handler: (input: Input<E>) => z.input<E["response"]> | Promise<z.input<E["response"]>>,
  opts: { validateResponse: boolean },
) {
  app.route({
    method: endpoint.method,
    url: toFastifyPath(endpoint.path),
    handler: async (request, reply) => {
      const params = parse<E["params"]>(endpoint.params, request.params, "path parameters");
      const query = parse<E["query"]>(endpoint.query, request.query, "query");
      const result = await handler({ params, query, request });
      return reply.send(opts.validateResponse ? endpoint.response.parse(result) : result);
    },
  });
}

/** Registers a binary endpoint; the handler writes the response itself. */
export function binaryRoute<E extends BinaryEndpoint>(
  app: FastifyInstance,
  endpoint: E,
  handler: (input: Input<E>, reply: FastifyReply) => Promise<FastifyReply> | FastifyReply,
) {
  app.route({
    method: endpoint.method,
    url: toFastifyPath(endpoint.path),
    handler: async (request, reply) => {
      const params = parse<E["params"]>(endpoint.params, request.params, "path parameters");
      const query = parse<E["query"]>(endpoint.query, request.query, "query");
      return handler({ params, query, request }, reply);
    },
  });
}
