import { z } from "zod";
import { api, NoBody, type Endpoint } from "./api.ts";
import { registry } from "./models.ts";

type JsonSchema = Record<string, unknown>;

/** Strip per-definition `$schema`/`$id` so definitions can be embedded in a bundle. */
const clean = ({ $schema: _s, $id: _i, ...rest }: JsonSchema): JsonSchema => rest;

/** Draft-07 bundle of every registered model, keyed under `definitions`. */
export function jsonSchemaBundle(): JsonSchema {
  const { schemas } = z.toJSONSchema(registry, {
    target: "draft-7",
    uri: (id) => `#/definitions/${id}`,
  });
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "HyperPlayer API models",
    definitions: Object.fromEntries(
      Object.entries(schemas).map(([name, s]) => [name, clean(s as JsonSchema)]),
    ),
  };
}

/** Inline schema for path/query parameters (plain scalars, never registered models). */
const inline = (schema: z.ZodType): JsonSchema =>
  clean(z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" }) as JsonSchema);

/** Reference to a registered model; every JSON response must be one. */
function ref(schema: z.ZodType): JsonSchema {
  const id = registry.get(schema)?.id;
  if (!id) throw new Error("JSON request and response bodies must be registered models");
  return { $ref: `#/components/schemas/${id}` };
}

function parameters(e: Endpoint): JsonSchema[] {
  const out: JsonSchema[] = [];
  for (const [location, schema] of [
    ["path", e.params],
    ["query", e.query],
  ] as const) {
    const s = inline(schema) as { properties?: Record<string, JsonSchema>; required?: string[] };
    for (const [name, prop] of Object.entries(s.properties ?? {})) {
      out.push({
        name,
        in: location,
        required: location === "path" || (s.required ?? []).includes(name),
        schema: prop,
      });
    }
  }
  return out;
}

function responses(e: Endpoint): JsonSchema {
  const error = {
    description: "Error",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
  };
  if (e.kind === "binary") {
    return {
      "200": {
        description: e.summary,
        content: Object.fromEntries(
          e.contentTypes.map((t) => [t, { schema: { type: "string", format: "binary" } }]),
        ),
      },
      "206": { description: "Partial content (range request)" },
      default: error,
    };
  }
  return {
    "200": {
      description: e.summary,
      content: { "application/json": { schema: ref(e.response) } },
    },
    default: error,
  };
}

/** OpenAPI 3.0 document describing the full HTTP API. */
export function openApiDocument(version = "0.0.0"): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const [operationId, e] of Object.entries(api) as [string, Endpoint][]) {
    paths[e.path] ??= {};
    paths[e.path]![e.method.toLowerCase()] = {
      operationId,
      summary: e.summary,
      parameters: parameters(e),
      security: e.access === "public" ? [] : [{ bearer: [] }, { session: [] }],
      ...(e.kind === "json" && e.body !== NoBody
        ? { requestBody: { required: true, content: { "application/json": { schema: ref(e.body) } } } }
        : {}),
      responses: responses(e),
    };
  }
  const { schemas } = z.toJSONSchema(registry, {
    target: "openapi-3.0",
    uri: (id) => `#/components/schemas/${id}`,
  });
  return {
    openapi: "3.0.3",
    info: { title: "HyperPlayer", version },
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "Device token from /api/auth/login" },
        session: { type: "apiKey", in: "cookie", name: "hp_session", description: "Browser session cookie" },
      },
      schemas: Object.fromEntries(Object.entries(schemas).map(([name, s]) => [name, clean(s as JsonSchema)])),
    },
  };
}
