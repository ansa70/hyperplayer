import { createHash, randomBytes } from "node:crypto";
import {
  Preferences as PreferencesSchema,
  type Device,
  type Preferences,
  type Session,
  type User,
} from "@hyperplayer/schemas";
import type { Db } from "../db.ts";
import { HttpError, notFound } from "../http/contract.ts";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./passwords.ts";

type Row = Record<string, unknown>;

/** Who is calling: resolved from the bearer token or session cookie. */
export interface AuthContext {
  user: User;
  deviceId: string;
}

const now = () => new Date().toISOString();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newId = () => randomBytes(8).toString("hex");

/** Opaque bearer token: 256 random bits, prefixed so it's recognisable in logs and secret scanners. */
const newToken = () => `hp_${randomBytes(32).toString("base64url")}`;

/** Failed sign-ins tolerated per key (IP or username) before backing off. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;

class FailureLimiter {
  readonly #failures = new Map<string, { count: number; first: number }>();

  /** Throws 429 while `key` is locked out. */
  check(key: string) {
    const f = this.#failures.get(key);
    if (!f) return;
    if (Date.now() - f.first > FAILURE_WINDOW_MS) {
      this.#failures.delete(key);
      return;
    }
    if (f.count >= MAX_FAILURES) {
      const retry = Math.ceil((f.first + FAILURE_WINDOW_MS - Date.now()) / 1000);
      throw new HttpError(429, "too_many_attempts", `Too many failed sign-ins; try again in ${retry} s`);
    }
  }

  fail(key: string) {
    const f = this.#failures.get(key);
    if (f && Date.now() - f.first <= FAILURE_WINDOW_MS) f.count++;
    else this.#failures.set(key, { count: 1, first: Date.now() });
  }

  clear(key: string) {
    this.#failures.delete(key);
  }
}

/** Updating last-seen on every request would write constantly; once a minute is plenty. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

export const DEFAULT_ADMIN = "admin";
export const DEFAULT_PASSWORD = "hyperplayer";

export class Auth {
  readonly #db: Db;
  readonly #limiter = new FailureLimiter();
  readonly #defaultPassword: string;

  constructor(db: Db, defaultPassword = DEFAULT_PASSWORD) {
    this.#db = db;
    this.#defaultPassword = defaultPassword;
  }

  /**
   * First start: creates `admin` with the default password, flagged so its sessions can do
   * nothing but set a real one. Also hands playlists without an owner (made before
   * accounts existed) to the first admin. Returns whether the admin was just created.
   */
  async ensureDefaultAdmin(): Promise<boolean> {
    let created = false;
    if (!this.#db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
      const user = await this.createUser(DEFAULT_ADMIN, this.#defaultPassword, true);
      this.#db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(user.id);
      created = true;
    }
    this.#db
      .prepare(
        `UPDATE playlists SET owner_id = (SELECT id FROM users WHERE admin = 1 ORDER BY created_at LIMIT 1)
         WHERE owner_id IS NULL`,
      )
      .run();
    return created;
  }

  /** The default admin hasn't been claimed yet (its password is still the default). */
  get defaultAdminActive(): boolean {
    return Boolean(
      this.#db
        .prepare("SELECT 1 FROM users WHERE username = ? AND must_change_password = 1")
        .get(DEFAULT_ADMIN),
    );
  }

  async login(
    input: { username: string; password: string; deviceName: string; deviceId?: string },
    ip: string,
  ): Promise<Session> {
    const userKey = `user:${input.username.toLowerCase()}`;
    const ipKey = `ip:${ip}`;
    this.#limiter.check(ipKey);
    this.#limiter.check(userKey);
    const row = this.#db
      .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(input.username) as Row | undefined;
    // Always run a full hash so unknown usernames take as long as wrong passwords.
    const ok = await verifyPassword(input.password, row ? String(row.password_hash) : DUMMY_HASH);
    if (!row || !ok) {
      this.#limiter.fail(ipKey);
      this.#limiter.fail(userKey);
      throw new HttpError(401, "bad_credentials", "Wrong username or password");
    }
    this.#limiter.clear(userKey);
    return this.#issue(this.#user(row), input.deviceName, input.deviceId);
  }

  /** Resolves a token to its user and device, or null when unknown or revoked. */
  authenticate(token: string): AuthContext | null {
    const row = this.#db
      .prepare(
        `SELECT d.id AS device_id, d.last_seen_at, u.* FROM devices d JOIN users u ON u.id = d.user_id
         WHERE d.token_hash = ?`,
      )
      .get(sha256(token)) as Row | undefined;
    if (!row) return null;
    if (Date.now() - Date.parse(String(row.last_seen_at)) > LAST_SEEN_RESOLUTION_MS) {
      this.#db
        .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
        .run(now(), row.device_id as string);
    }
    return { user: this.#user(row), deviceId: String(row.device_id) };
  }

  device(auth: AuthContext): Device {
    return this.devices(auth).find((d) => d.current)!;
  }

  devices(auth: AuthContext): Device[] {
    return (
      this.#db
        .prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC")
        .all(auth.user.id) as Row[]
    ).map((d) => ({
      id: String(d.id),
      name: String(d.name),
      createdAt: String(d.created_at),
      lastSeenAt: String(d.last_seen_at),
      current: d.id === auth.deviceId,
    }));
  }

  /** Signs a device out. Its queue is kept, so signing back in with the same id resumes it. */
  revoke(auth: AuthContext, deviceId: string) {
    const r = this.#db
      .prepare("DELETE FROM devices WHERE id = ? AND user_id = ?")
      .run(deviceId, auth.user.id);
    if (!r.changes) throw notFound("Device");
  }

  async changePassword(auth: AuthContext, current: string, next: string) {
    const row = this.#db.prepare("SELECT password_hash FROM users WHERE id = ?").get(auth.user.id) as Row;
    if (!(await verifyPassword(current, String(row.password_hash)))) {
      throw new HttpError(403, "bad_credentials", "Current password is wrong");
    }
    if (next === current || next === this.#defaultPassword) {
      throw new HttpError(400, "weak_password", "Choose a password different from the current one");
    }
    this.#db
      .prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
      .run(await hashPassword(next), auth.user.id);
    // Anyone who learned the old password may have signed in: keep only this device.
    this.#db.prepare("DELETE FROM devices WHERE user_id = ? AND id <> ?").run(auth.user.id, auth.deviceId);
  }

  users(): User[] {
    return (this.#db.prepare("SELECT * FROM users ORDER BY created_at").all() as Row[]).map((r) =>
      this.#user(r),
    );
  }

  async createUser(username: string, password: string, admin: boolean, fullName?: string): Promise<User> {
    if (this.#db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
      throw new HttpError(409, "username_taken", `“${username}” is already taken`);
    }
    const id = newId();
    this.#db
      .prepare(
        "INSERT INTO users (id, username, full_name, password_hash, admin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, username, fullName?.trim() || null, await hashPassword(password), admin ? 1 : 0, now());
    return this.#user(this.#db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row);
  }

  /**
   * First run, from the admin's session: registers the person who'll actually listen, and
   * hands them this device (keeping its queue) and the playlists made so far. The admin
   * account stays, for managing the server, but is signed out of this device.
   */
  async onboard(
    auth: AuthContext,
    input: { username: string; password: string; fullName?: string },
  ): Promise<Session> {
    const users = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM users").get() as Row).n);
    if (users !== 1) {
      throw new HttpError(
        409,
        "already_onboarded",
        "This server already has its users; an admin can add more",
      );
    }
    const user = await this.createUser(input.username, input.password, false, input.fullName);
    const token = newToken();
    const db = this.#db;
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE playlists SET owner_id = ? WHERE owner_id = ?").run(user.id, auth.user.id);
      db.prepare("UPDATE devices SET user_id = ?, token_hash = ?, last_seen_at = ? WHERE id = ?").run(
        user.id,
        sha256(token),
        now(),
        auth.deviceId,
      );
      db.prepare("UPDATE queues SET user_id = ? WHERE device_id = ?").run(user.id, auth.deviceId);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { token, user, device: this.device({ user, deviceId: auth.deviceId }) };
  }

  preferences(userId: string): Preferences {
    const row = this.#db.prepare("SELECT data FROM user_preferences WHERE user_id = ?").get(userId) as
      | Row
      | undefined;
    // Parsing through the schema fills in defaults for preferences added since they were saved.
    return PreferencesSchema.parse(row ? JSON.parse(String(row.data)) : {});
  }

  updatePreferences(userId: string, changes: Partial<Preferences>): Preferences {
    const next = PreferencesSchema.parse({
      ...this.preferences(userId),
      ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
    });
    this.#db
      .prepare(
        `INSERT INTO user_preferences (user_id, data) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data`,
      )
      .run(userId, JSON.stringify(next));
    return next;
  }

  #user(r: Row): User {
    return {
      id: String(r.id),
      username: String(r.username),
      fullName: (r.full_name as string | null) ?? null,
      admin: Boolean(r.admin),
      mustChangePassword: Boolean(r.must_change_password),
      createdAt: String(r.created_at),
    };
  }

  /** Creates (or re-keys) a device and returns its new token, shown only this once. */
  #issue(user: User, name: string, requestedId?: string): Session {
    const existing = requestedId
      ? (this.#db.prepare("SELECT user_id FROM devices WHERE id = ?").get(requestedId) as Row | undefined)
      : undefined;
    // A device id signed in by another account can't be taken over (it would expose that queue).
    const owned = !existing || existing.user_id === user.id;
    const takenByQueue = requestedId && !existing && this.#queueOwnedByOther(requestedId, user.id);
    const deviceId =
      requestedId && owned && !takenByQueue ? requestedId : `dev-${randomBytes(12).toString("hex")}`;
    const token = newToken();
    const at = now();
    this.#db
      .prepare(
        `INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash, last_seen_at = excluded.last_seen_at`,
      )
      .run(deviceId, user.id, name, sha256(token), at, at);
    this.#db
      .prepare("UPDATE queues SET user_id = ? WHERE device_id = ? AND user_id IS NULL")
      .run(user.id, deviceId);
    return { token, user, device: this.device({ user, deviceId }) };
  }

  #queueOwnedByOther(deviceId: string, userId: string): boolean {
    const q = this.#db.prepare("SELECT user_id FROM queues WHERE device_id = ?").get(deviceId) as
      | Row
      | undefined;
    return Boolean(q?.user_id && q.user_id !== userId);
  }
}
