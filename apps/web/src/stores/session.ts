// Who is signed in, and their account-wide preferences.

import type { Preferences, User } from "@hyperplayer/schemas";
import { create } from "zustand";
import { api, call, errorMessage, setUnauthorizedHandler } from "../api.ts";

type Status =
  /** Finding out whether the cookie still signs us in. */
  | "checking"
  | "signed-out"
  /** Signed in with a default password, which must be changed first. */
  | "must-change-password"
  | "signed-in";

interface SessionState {
  status: Status;
  user: User | null;
  preferences: Preferences | null;
  /** The server's built-in admin still has its default password: pre-fill it. */
  defaultAdmin: boolean;
  serverVersion: string;
  error: string;
  busy: boolean;
  restore: () => Promise<void>;
  signIn: (username: string, password: string) => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  signOut: () => Promise<void>;
  updatePreferences: (change: Partial<Preferences>) => Promise<void>;
}

/** This browser's device id, kept so it keeps its play queue across sign-ins. */
function deviceId(): string {
  const key = "hp-device-id";
  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const id = `web-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    localStorage.setItem(key, id);
    return id;
  } catch {
    // No storage (a private window): a new device each time.
    return `web-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  }
}

/** A name for this device in the account's device list, e.g. "Firefox on Android". */
function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

export const useSession = create<SessionState>()((set, get) => ({
  status: "checking",
  user: null,
  preferences: null,
  defaultAdmin: false,
  serverVersion: "",
  error: "",
  busy: false,

  async restore() {
    try {
      const status = await call(api.authStatus);
      set({ defaultAdmin: status.defaultAdmin, serverVersion: status.serverVersion });
    } catch {
      // Shown when signing in fails.
    }
    try {
      const me = await call(api.me);
      await signedIn(me.user);
    } catch {
      set({ status: "signed-out" });
    }
  },

  async signIn(username, password) {
    set({ busy: true, error: "" });
    try {
      const session = await call(api.login, {
        body: { username, password, deviceName: deviceName(), deviceId: deviceId(), cookie: true },
      });
      await signedIn(session.user);
    } catch (e) {
      set({ error: errorMessage(e) });
    } finally {
      set({ busy: false });
    }
  },

  async changePassword(current, next) {
    set({ busy: true, error: "" });
    try {
      await call(api.changePassword, { body: { currentPassword: current, newPassword: next } });
      const me = await call(api.me);
      await signedIn(me.user);
    } catch (e) {
      set({ error: errorMessage(e) });
    } finally {
      set({ busy: false });
    }
  },

  async signOut() {
    try {
      await call(api.logout);
    } catch {
      // Signed out either way.
    }
    set({ status: "signed-out", user: null, preferences: null });
  },

  async updatePreferences(change) {
    const previous = get().preferences;
    if (previous) set({ preferences: { ...previous, ...change } });
    try {
      set({ preferences: await call(api.updatePreferences, { body: change }) });
    } catch (e) {
      set({ preferences: previous, error: errorMessage(e) });
    }
  },
}));

async function signedIn(user: User) {
  if (user.mustChangePassword) {
    useSession.setState({ status: "must-change-password", user });
    return;
  }
  let preferences: Preferences | null = null;
  try {
    preferences = await call(api.getPreferences);
  } catch {
    // Defaults until they load.
  }
  useSession.setState({ status: "signed-in", user, preferences, error: "" });
}

setUnauthorizedHandler(() => {
  if (useSession.getState().status === "signed-in") {
    useSession.setState({ status: "signed-out", user: null, preferences: null });
  }
});
