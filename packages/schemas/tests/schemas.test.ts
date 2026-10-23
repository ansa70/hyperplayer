import { expect, test } from "vite-plus/test";
import { api, jsonSchemaBundle, openApiDocument, Pagination, Track } from "../src/index.ts";

test("every registered model ends up in the JSON Schema bundle", () => {
  const defs = jsonSchemaBundle().definitions as Record<string, unknown>;
  expect(Object.keys(defs)).toEqual(
    expect.arrayContaining(["Artist", "Album", "Track", "NowPlaying", "ApiError"]),
  );
});

test("every endpoint appears in the OpenAPI document", () => {
  const paths = openApiDocument().paths as Record<string, Record<string, { operationId: string }>>;
  const operationIds = Object.values(paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
  expect(operationIds.sort()).toEqual(Object.keys(api).sort());
});

test("pagination coerces query strings and applies defaults", () => {
  expect(Pagination.parse({ offset: "20" })).toEqual({ offset: 20, limit: 100 });
  expect(() => Pagination.parse({ limit: "0" })).toThrow();
});

test("tracks reject unknown shapes", () => {
  expect(Track.safeParse({ id: "x" }).success).toBe(false);
});

test("only the sign-in endpoints are public", () => {
  // Widening this list must be a deliberate, reviewed change.
  const open = Object.entries(api)
    .filter(([, e]) => e.access === "public")
    .map(([name]) => name)
    .sort();
  expect(open).toEqual(["authStatus", "login"]);
  // Reachable while a default password is still in place: just enough to replace it.
  const session = Object.entries(api)
    .filter(([, e]) => e.access === "session")
    .map(([name]) => name)
    .sort();
  expect(session).toEqual(["changePassword", "logout", "me"]);
});
