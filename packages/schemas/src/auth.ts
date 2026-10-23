import { z } from "zod";
import { Id, named } from "./models.ts";

/*
 * Accounts and devices. Each signed-in client is a device holding an opaque
 * bearer token; the server stores only a hash of it. Tokens travel in the
 * `Authorization: Bearer` header (native clients) or an HttpOnly cookie (browsers).
 */

const Timestamp = z.iso.datetime();

export const Username = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[\p{L}\p{N}._-]+$/u, "letters, digits, dots, dashes and underscores only");

/** Long passphrases welcome; the floor keeps out trivially guessable ones. */
export const Password = z.string().min(8).max(1024);

/** Client-chosen id, so a device keeps its queue across logins. */
export const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const User = named(
  "User",
  z.object({
    id: Id,
    username: z.string(),
    fullName: z.string().nullable(),
    admin: z.boolean(),
    /**
     * Still using a default password: until it is changed, the session may only
     * read `/api/me`, change the password, or sign out.
     */
    mustChangePassword: z.boolean(),
    createdAt: Timestamp,
  }),
);

export const Device = named(
  "Device",
  z.object({
    id: DeviceId,
    name: z.string(),
    createdAt: Timestamp,
    lastSeenAt: Timestamp,
    /** The device making this request. */
    current: z.boolean(),
  }),
);

export const DeviceList = named("DeviceList", z.array(Device));
export const UserList = named("UserList", z.array(User));

export const AuthStatus = named(
  "AuthStatus",
  z.object({
    /** The built-in `admin` account still has its default password: clients can pre-fill the first sign-in. */
    defaultAdmin: z.boolean(),
    serverVersion: z.string(),
  }),
);

const DeviceInfo = {
  deviceName: z.string().trim().min(1).max(100),
  /** Reuse an existing device id (keeps its queue); a new one is generated when omitted. */
  deviceId: DeviceId.optional(),
  /** Also set an HttpOnly session cookie (browsers). */
  cookie: z.boolean().default(false),
};

export const Login = named(
  "Login",
  z.object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(1024),
    ...DeviceInfo,
  }),
);

export const Session = named(
  "Session",
  z.object({
    /** Bearer token for this device. Shown once; the server keeps only a hash. */
    token: z.string(),
    user: User,
    device: Device,
  }),
);

export const Me = named("Me", z.object({ user: User, device: Device }));

export const ChangePassword = named(
  "ChangePassword",
  z.object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: Password,
  }),
);

const FullName = z.string().trim().max(200);

export const CreateUser = named(
  "CreateUser",
  z.object({
    username: Username,
    password: Password,
    fullName: FullName.optional(),
    admin: z.boolean().default(false),
  }),
);

export const Onboard = named(
  "Onboard",
  z.object({
    fullName: FullName.optional(),
    username: Username,
    password: Password,
  }),
  "First-run registration of the everyday user, made from the admin's session.",
);

export const Preferences = named(
  "Preferences",
  z.object({
    /** Streaming quality mode; see the client's adaptive streaming. */
    quality: z.enum(["auto", "original", "data-saver"]).default("auto"),
  }),
  "Per-user settings that follow the account to every device.",
);

export const UpdatePreferences = named(
  "UpdatePreferences",
  z.object({
    quality: z.enum(["auto", "original", "data-saver"]).optional(),
  }),
);

export type User = z.infer<typeof User>;
export type Device = z.infer<typeof Device>;
export type Session = z.infer<typeof Session>;
export type AuthStatus = z.infer<typeof AuthStatus>;
export type Preferences = z.infer<typeof Preferences>;
