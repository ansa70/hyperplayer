import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whose library a database query sees: uploads are private to their owner, so the
 * `tracks` view (see db.ts) shows the shared tracks plus the requesting user's own
 * uploads. Each API request runs as its caller (`asViewer`); work outside requests, and
 * background work a request sets off (`inBackground`), sees every track.
 */
const store = new AsyncLocalStorage<string>();

/** Seen by background work: every track, whoever owns it. */
export const EVERYONE = "*";

/** The user whose library queries see now (a user id, "" for anonymous requests, or EVERYONE). */
export function viewer(): string {
  return store.getStore() ?? EVERYONE;
}

/** Runs `f`, and everything it sets off, as `userId` ("" for anonymous: shared tracks only). */
export function asViewer<T>(userId: string, f: () => T): T {
  return store.run(userId, f);
}

/** Runs `f` (a scan, a sync, a queue's worker) as background work: seeing every track. */
export function inBackground<T>(f: () => T): T {
  return store.exit(f);
}
