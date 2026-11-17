import type { LibraryStatus, User } from "@hyperplayer/schemas";
import { useEffect, useState, type FormEvent } from "react";
import { api, call, errorMessage } from "../../api.ts";
import { plural } from "../../format.ts";
import { useLibrary } from "../../stores/library.ts";
import { useSession } from "../../stores/session.ts";
import { Card } from "./Card.tsx";

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

  if (!lib) return <p className="muted">Loading…</p>;
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
      <Card title="Library">
        <p className="note">
          {plural(lib.artists, "artist")} · {plural(lib.albums, "album")} · {plural(lib.tracks, "track")}
          {lib.lastScanAt && ` · last scanned ${new Date(lib.lastScanAt).toLocaleString()}`}
          {lib.enrichmentQueue > 0 && ` · ${lib.enrichmentQueue} waiting for details`}
        </p>
        {lib.scanning ? (
          <div className="row">
            <span className="muted">
              Scanning…{" "}
              {progress &&
                (progress.phase === "listing"
                  ? `${progress.total} files found`
                  : `${progress.done} of ${progress.total} files read`)}
            </span>
            <button className="outline-button" onClick={() => void scan(call(api.cancelLibraryScan))}>
              Stop
            </button>
          </div>
        ) : (
          <div className="row">
            <button className="outline-button" onClick={() => void scan(call(api.libraryScan))}>
              Scan for changes
            </button>
          </div>
        )}
      </Card>
      <Card title="Music folders">
        {folders === null ? (
          <>
            {lib.folders.map((f) => (
              <div key={f.path} className="device">
                <span className="ellipsis">{f.path}</span>
                <span className={f.available ? "faint" : "error"}>
                  {f.available ? plural(f.tracks, "track") : "not reachable"}
                </span>
              </div>
            ))}
            <div className="row">
              <button
                className="outline-button"
                onClick={() => setFolders(lib.folders.map((f) => f.path).join("\n"))}
              >
                Change folders
              </button>
            </div>
          </>
        ) : (
          <form className="stack" onSubmit={saveFolders}>
            <p className="note">
              One folder per line, as the server sees it (e.g.{" "}
              {lib.pathStyle === "windows" ? "D:\\Music" : "/mnt/music"}).
            </p>
            <textarea rows={4} value={folders} onChange={(e) => setFolders(e.target.value)} />
            {error && <p className="note error">{error}</p>}
            <div className="row">
              <button className="outline-button" type="submit">
                Save and scan
              </button>
              <button className="outline-button" type="button" onClick={() => setFolders(null)}>
                Cancel
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
        notify("Account created.");
        return load();
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  return (
    <>
      <Card title="Accounts">
        {users.map((u) => (
          <div key={u.id} className="device">
            <span>
              {u.fullName || u.username}
              <span className="faint">
                {u.fullName ? ` · ${u.username}` : ""}
                {u.admin ? " · admin" : ""}
                {u.mustChangePassword ? " · must choose a password" : ""}
              </span>
            </span>
            {u.id !== me?.id && (
              <span className="row">
                <button
                  className="outline-button"
                  onClick={() =>
                    void act(
                      call(api.updateUser, { params: { id: u.id }, body: { admin: !u.admin } }),
                      u.admin ? `${u.username} is no longer an admin.` : `${u.username} is now an admin.`,
                    )
                  }
                >
                  {u.admin ? "Remove admin" : "Make admin"}
                </button>
                <button
                  className="outline-button"
                  onClick={() => {
                    const password = window.prompt(
                      `A temporary password for ${u.username} (at least 8 characters). They'll choose their own at the next sign-in.`,
                    );
                    if (password && password.length >= 8) {
                      void act(
                        call(api.updateUser, { params: { id: u.id }, body: { password } }),
                        `${u.username} was signed out everywhere and must choose a new password.`,
                      );
                    }
                  }}
                >
                  Reset password
                </button>
                <button
                  className="outline-button"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete ${u.username}, with their playlists and history? This can't be undone.`,
                      )
                    ) {
                      void act(call(api.deleteUser, { params: { id: u.id } }), `${u.username} was deleted.`);
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            )}
          </div>
        ))}
      </Card>
      <Card title="Add an account">
        <form className="stack" onSubmit={create}>
          <input
            placeholder="Username"
            autoCapitalize="none"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
          <input
            placeholder="Full name (optional)"
            value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Password (at least 8 characters)"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={form.admin}
              onChange={(e) => setForm({ ...form, admin: e.target.checked })}
            />
            Admin (can change the library and the accounts)
          </label>
          {error && <p className="note error">{error}</p>}
          <div className="row">
            <button
              className="outline-button"
              type="submit"
              disabled={!form.username.trim() || form.password.length < 8}
            >
              Add account
            </button>
          </div>
        </form>
      </Card>
    </>
  );
}
