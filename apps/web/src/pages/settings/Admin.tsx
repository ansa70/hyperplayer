import type { LibraryStatus, User } from "@hyperplayer/schemas";
import { useEffect, useState, type FormEvent } from "react";
import { api, call, errorMessage } from "../../api.ts";
import { useLibrary } from "../../stores/library.ts";
import { useSession } from "../../stores/session.ts";
import { Card } from "./Card.tsx";
import { locale, t, tn } from "../../i18n.ts";

/** The server's library (admins): what's in it, its music folders, and scanning. */
export function Library() {
  const [lib, setLib] = useState<LibraryStatus | null>(null);
  const [folders, setFolders] = useState<string | null>(null);
  const [error, setError] = useState("");
  const notify = useLibrary((s) => s.notify);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      call(api.libraryStatus)
        .then((s) => {
          if (stop) return;
          setLib(s);
          // Follow a scan while it runs.
          if (s.scanning) timer = setTimeout(load, 1500);
        })
        .catch(() => {});
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [lib?.scanning]);

  if (!lib) return <p className="muted">{t("Loading…")}</p>;
  const scan = (op: Promise<LibraryStatus>) => op.then(setLib).catch((e: unknown) => notify(errorMessage(e)));
  const saveFolders = (e: FormEvent) => {
    e.preventDefault();
    const paths = (folders ?? "")
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    setError("");
    call(api.setLibraryFolders, { body: { paths } })
      .then((s) => {
        setLib(s);
        setFolders(null);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };
  const progress = lib.scanProgress;
  return (
    <>
      <Card title={t("Library")}>
        <p className="note">
          {tn("{n} artist", "{n} artists", lib.artists)} · {tn("{n} album", "{n} albums", lib.albums)} ·{" "}
          {tn("{n} track", "{n} tracks", lib.tracks)}
          {lib.lastScanAt && ` · ${t("last scanned {}", new Date(lib.lastScanAt).toLocaleString(locale()))}`}
          {lib.enrichmentQueue > 0 && ` · ${t("{} waiting for details", lib.enrichmentQueue)}`}
        </p>
        {lib.scanning ? (
          <div className="row">
            <span className="muted">
              {t("Scanning…")}{" "}
              {progress &&
                (progress.phase === "listing"
                  ? t("{} files found", progress.total)
                  : t("{} of {} files read", progress.done, progress.total))}
            </span>
            <button className="outline-button" onClick={() => void scan(call(api.cancelLibraryScan))}>
              {t("Stop")}
            </button>
          </div>
        ) : (
          <div className="row">
            <button className="outline-button" onClick={() => void scan(call(api.libraryScan))}>
              {t("Scan for changes")}
            </button>
          </div>
        )}
      </Card>
      <Card title={t("Music folders")}>
        {folders === null ? (
          <>
            {lib.folders.map((f) => (
              <div key={f.path} className="device">
                <span className="ellipsis">{f.path}</span>
                <span className={f.available ? "faint" : "error"}>
                  {f.available ? tn("{n} track", "{n} tracks", f.tracks) : t("not reachable")}
                </span>
              </div>
            ))}
            <div className="row">
              <button
                className="outline-button"
                onClick={() => setFolders(lib.folders.map((f) => f.path).join("\n"))}
              >
                {t("Change folders")}
              </button>
            </div>
          </>
        ) : (
          <form className="stack" onSubmit={saveFolders}>
            <p className="note">
              {t(
                "One folder per line, as the server sees it (e.g. {}).",
                lib.pathStyle === "windows" ? "D:\\Music" : "/mnt/music",
              )}
            </p>
            <textarea rows={4} value={folders} onChange={(e) => setFolders(e.target.value)} />
            {error && <p className="note error">{error}</p>}
            <div className="row">
              <button className="outline-button" type="submit">
                {t("Save and scan")}
              </button>
              <button className="outline-button" type="button" onClick={() => setFolders(null)}>
                {t("Cancel")}
              </button>
            </div>
          </form>
        )}
      </Card>
    </>
  );
}

/** The server's accounts (admins): add, make admin, reset a password, remove. */
export function Users() {
  const me = useSession((s) => s.user);
  const notify = useLibrary((s) => s.notify);
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ username: "", fullName: "", password: "", admin: false });
  const [error, setError] = useState("");
  const load = () =>
    call(api.listUsers)
      .then(setUsers)
      .catch(() => {});
  useEffect(() => {
    void load();
  }, []);
  const act = (op: Promise<unknown>, done: string) =>
    op
      .then(() => {
        notify(done);
        return load();
      })
      .catch((e: unknown) => notify(errorMessage(e)));

  const create = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    call(api.createUser, {
      body: {
        username: form.username.trim(),
        password: form.password,
        fullName: form.fullName.trim() || undefined,
        admin: form.admin,
      },
    })
      .then(() => {
        setForm({ username: "", fullName: "", password: "", admin: false });
        notify(t("Account created."));
        return load();
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  return (
    <>
      <Card title={t("Accounts")}>
        {users.map((u) => (
          <div key={u.id} className="device">
            <span>
              {u.fullName || u.username}
              <span className="faint">
                {u.fullName ? ` · ${u.username}` : ""}
                {u.admin ? ` · ${t("admin")}` : ""}
                {u.mustChangePassword ? ` · ${t("must choose a password")}` : ""}
              </span>
            </span>
            {u.id !== me?.id && (
              <span className="row">
                <button
                  className="outline-button"
                  onClick={() =>
                    void act(
                      call(api.updateUser, { params: { id: u.id }, body: { admin: !u.admin } }),
                      u.admin
                        ? t("{} is no longer an admin.", u.username)
                        : t("{} is now an admin.", u.username),
                    )
                  }
                >
                  {u.admin ? t("Remove admin") : t("Make admin")}
                </button>
                <button
                  className="outline-button"
                  onClick={() => {
                    const password = window.prompt(
                      t(
                        "A temporary password for {} (at least 8 characters). They'll choose their own at the next sign-in.",
                        u.username,
                      ),
                    );
                    if (password && password.length >= 8) {
                      void act(
                        call(api.updateUser, { params: { id: u.id }, body: { password } }),
                        t("{} was signed out everywhere and must choose a new password.", u.username),
                      );
                    }
                  }}
                >
                  {t("Reset password")}
                </button>
                <button
                  className="outline-button"
                  onClick={() => {
                    if (
                      window.confirm(
                        t("Delete {}, with their playlists and history? This can't be undone.", u.username),
                      )
                    ) {
                      void act(
                        call(api.deleteUser, { params: { id: u.id } }),
                        t("{} was deleted.", u.username),
                      );
                    }
                  }}
                >
                  {t("Delete")}
                </button>
              </span>
            )}
          </div>
        ))}
      </Card>
      <Card title={t("Add an account")}>
        <form className="stack" onSubmit={create}>
          <input
            placeholder={t("Username")}
            autoCapitalize="none"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
          <input
            placeholder={t("Full name (optional)")}
            value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder={t("Password (at least 8 characters)")}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={form.admin}
              onChange={(e) => setForm({ ...form, admin: e.target.checked })}
            />
            {t("Admin (can change the library and the accounts)")}
          </label>
          {error && <p className="note error">{error}</p>}
          <div className="row">
            <button
              className="outline-button"
              type="submit"
              disabled={!form.username.trim() || form.password.length < 8}
            >
              {t("Add account")}
            </button>
          </div>
        </form>
      </Card>
    </>
  );
}
