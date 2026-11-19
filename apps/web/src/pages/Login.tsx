import { useState, type FormEvent } from "react";
import { useSession } from "../stores/session.ts";
import "./Login.css";
import { t } from "../i18n.ts";

/** Signing in, and replacing a default password before anything else. */
export function Login() {
  const { status, defaultAdmin, serverVersion, error, busy, signIn, changePassword, user } = useSession();
  const [username, setUsername] = useState(defaultAdmin ? "admin" : "");
  const [password, setPassword] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const changing = status === "must-change-password";
  const mismatch = changing && confirm !== "" && next !== confirm;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (changing) {
      if (next === confirm) void changePassword(password, next);
    } else {
      void signIn(username.trim(), password);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <img src="/favicon.svg" alt="" width={56} height={56} />
        <h1>HyperPlayer</h1>
        {changing ? (
          <>
            <p className="muted">
              {user?.username} still has its default password. Choose a new one (at least 8 characters).
            </p>
            <input
              type="password"
              placeholder={t("Current password")}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <input
              type="password"
              placeholder={t("New password")}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <input
              type="password"
              placeholder={t("New password again")}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </>
        ) : (
          <>
            <input
              placeholder={t("Username")}
              autoComplete="username"
              autoCapitalize="none"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              type="password"
              placeholder={t("Password")}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {defaultAdmin && (
              <p className="faint">{t("First start: the admin's default password is “hyperplayer”.")}</p>
            )}
          </>
        )}
        {(error || mismatch) && <p className="login-error">{mismatch ? t("The passwords differ") : error}</p>}
        <button
          className="primary-button"
          type="submit"
          disabled={busy || (changing ? next.length < 8 || next !== confirm : !username || !password)}
        >
          {busy ? t("Please wait…") : changing ? t("Save password") : t("Sign in")}
        </button>
        {serverVersion && <p className="faint login-version">{t("Server {}", serverVersion)}</p>}
      </form>
    </div>
  );
}
