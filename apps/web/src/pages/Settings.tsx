import type { Device } from "@hyperplayer/schemas";
import { useEffect, useState, type FormEvent } from "react";
import { api, call, errorMessage } from "../api.ts";
import { Segmented } from "../components/Segmented.tsx";
import { install, useInstall } from "../install.ts";
import { Library, Users } from "./settings/Admin.tsx";
import { Appearance } from "./settings/Appearance.tsx";
import { Card } from "./settings/Card.tsx";
import { Scrobbling } from "./settings/Scrobbling.tsx";
import { canBoost } from "../player/output.ts";
import { useLibrary } from "../stores/library.ts";
import { useSession } from "../stores/session.ts";
import "./pages.css";
import "./settings.css";
import { locale, t } from "../i18n.ts";

type Tab = "playback" | "appearance" | "account" | "scrobbling" | "library" | "users";

/** Settings, like the Rust player's: playback (the account's preferences) and the account. */
export function Settings() {
  const [tab, setTab] = useState<Tab>("playback");
  const { serverVersion, user } = useSession();
  const canInstall = useInstall((s) => s.prompt !== null);
  return (
    <div className="page settings">
      <div className="page-head">
        <h1>{t("Settings")}</h1>
        {canInstall && (
          <button className="outline-button" onClick={() => void install()}>
            {t("Install app")}
          </button>
        )}
      </div>
      <Segmented
        value={tab}
        options={[
          { key: "playback", label: t("Playback") },
          { key: "appearance", label: t("Appearance") },
          { key: "account", label: t("Account") },
          { key: "scrobbling", label: t("Scrobbling") },
          ...(user?.admin
            ? [
                { key: "library", label: t("Library") },
                { key: "users", label: t("Users") },
              ]
            : []),
        ]}
        onPick={(k) => setTab(k as Tab)}
      />
      {tab === "playback" && <Playback />}
      {tab === "appearance" && <Appearance />}
      {tab === "account" && <Account />}
      {tab === "scrobbling" && <Scrobbling />}
      {tab === "library" && <Library />}
      {tab === "users" && <Users />}
      <p className="faint versions">{t("HyperPlayer web · server {}", serverVersion)}</p>
    </div>
  );
}

function Playback() {
  const { preferences, updatePreferences } = useSession();
  const [preamp, setPreamp] = useState(preferences?.replayGainPreamp ?? 0);
  const [crossfade, setCrossfade] = useState(preferences?.crossfade ?? 0);
  if (!preferences) return <p className="muted">{t("Loading…")}</p>;
  return (
    <>
      <Card title={t("Streaming quality")}>
        <p className="note">
          {t(
            "Auto streams the original file when this browser plays it, and a smaller version on a slow or metered connection. Original always streams the file as it is; Data saver uses about 128 kbit/s.",
          )}
        </p>
        <Segmented
          value={preferences.quality}
          options={[
            { key: "auto", label: t("Auto") },
            { key: "original", label: t("Original") },
            { key: "data-saver", label: t("Data saver") },
          ]}
          onPick={(k) => void updatePreferences({ quality: k as typeof preferences.quality })}
        />
      </Card>
      <Card title={t("Volume levelling (ReplayGain)")}>
        <p className="note">
          {t(
            "Evens out loudness between tracks using their ReplayGain tags. Auto keeps an album's own dynamics while it plays in order, and levels track by track otherwise.",
          )}
          {!canBoost() && ` ${t("On this device it can only turn tracks down, not up.")}`}
        </p>
        <Segmented
          value={preferences.replayGain}
          options={[
            { key: "auto", label: t("Auto") },
            { key: "track", label: t("Track") },
            { key: "album", label: t("Album") },
            { key: "off", label: t("Off") },
          ]}
          onPick={(k) => void updatePreferences({ replayGain: k as typeof preferences.replayGain })}
        />
        <label className="slider-row">
          <span className="muted">{t("Pre-amp")}</span>
          <input
            type="range"
            min={-15}
            max={15}
            step={0.5}
            value={preamp}
            onChange={(e) => setPreamp(Number(e.target.value))}
            onPointerUp={() => void updatePreferences({ replayGainPreamp: preamp })}
            onKeyUp={() => void updatePreferences({ replayGainPreamp: preamp })}
          />
          <span className="slider-value">
            {preamp > 0 ? "+" : ""}
            {preamp} dB
          </span>
        </label>
        <p className="note">
          {t("Added to every ReplayGain adjustment; boosts are still limited so peaks never clip.")}
        </p>
      </Card>
      <Card title={t("Crossfade")}>
        <p className="note">
          {t(
            "Fades each track into the next in the desktop player (the web player plays them back to back, for now). Tracks at different sample rates change without a fade.",
          )}
        </p>
        <label className="slider-row">
          <span className="muted">{t("Length")}</span>
          <input
            type="range"
            min={0}
            max={12}
            step={1}
            value={crossfade}
            onChange={(e) => setCrossfade(Number(e.target.value))}
            onPointerUp={() => void updatePreferences({ crossfade })}
            onKeyUp={() => void updatePreferences({ crossfade })}
          />
          <span className="slider-value">{crossfade === 0 ? t("Off") : `${crossfade} s`}</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={crossfade === 0}
            checked={preferences.crossfadeOnSkip}
            onChange={(e) => void updatePreferences({ crossfadeOnSkip: e.target.checked })}
          />
          {t("Also when skipping to another track")}
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={crossfade === 0}
            checked={preferences.crossfadeAlbums}
            onChange={(e) => void updatePreferences({ crossfadeAlbums: e.target.checked })}
          />
          {t("Also between tracks of an album playing in order (gapless otherwise, as live albums need)")}
        </label>
      </Card>
    </>
  );
}

function Account() {
  const { user, signOut } = useSession();
  const notify = useLibrary((s) => s.notify);
  const [name, setName] = useState(user?.fullName ?? "");
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwMessage, setPwMessage] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);

  const loadDevices = () =>
    call(api.listDevices)
      .then(setDevices)
      .catch(() => {});
  useEffect(() => {
    void loadDevices();
  }, []);

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    call(api.updateMe, { body: { fullName: name.trim() || null } })
      .then((u) => {
        useSession.setState({ user: u });
        notify(t("Saved."));
      })
      .catch((err: unknown) => notify(errorMessage(err)));
  };
  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    if (pw.next !== pw.confirm) return setPwMessage(t("The new passwords differ."));
    call(api.changePassword, { body: { currentPassword: pw.current, newPassword: pw.next } })
      .then(() => {
        setPw({ current: "", next: "", confirm: "" });
        setPwMessage(t("Password changed. Other devices were signed out."));
      })
      .catch((err: unknown) => setPwMessage(errorMessage(err)));
  };

  return (
    <>
      <Card title={t("Your name")}>
        <form className="row" onSubmit={saveName}>
          <input value={name} placeholder={user?.username} onChange={(e) => setName(e.target.value)} />
          <button className="outline-button" type="submit">
            {t("Save")}
          </button>
        </form>
        <p className="note">
          {t("Signed in as")} <b>{user?.username}</b>
          {user?.admin ? " (admin)" : ""}.
        </p>
      </Card>
      <Card title={t("Password")}>
        <form className="stack" onSubmit={changePassword}>
          <input
            type="password"
            autoComplete="current-password"
            placeholder={t("Current password")}
            value={pw.current}
            onChange={(e) => setPw({ ...pw, current: e.target.value })}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder={t("New password (at least 8 characters)")}
            value={pw.next}
            onChange={(e) => setPw({ ...pw, next: e.target.value })}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder={t("New password again")}
            value={pw.confirm}
            onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
          />
          <div className="row">
            <button className="outline-button" type="submit" disabled={!pw.current || pw.next.length < 8}>
              {t("Change password")}
            </button>
            {pwMessage && <span className="muted">{pwMessage}</span>}
          </div>
        </form>
      </Card>
      <Card title={t("Devices")}>
        <p className="note">
          {t("Everywhere this account is signed in. Signing a device out also clears its queue.")}
        </p>
        {devices.map((d) => (
          <div key={d.id} className="device">
            <span>
              {d.name}
              {d.current && <span className="faint"> {t("· this device")}</span>}
              <span className="faint">
                {" "}
                {t("· last seen {}", new Date(d.lastSeenAt).toLocaleDateString(locale()))}
              </span>
            </span>
            {!d.current && (
              <button
                className="outline-button"
                onClick={() =>
                  call(api.revokeDevice, { params: { id: d.id } })
                    .then(loadDevices)
                    .catch((err: unknown) => notify(errorMessage(err)))
                }
              >
                {t("Sign out")}
              </button>
            )}
          </div>
        ))}
      </Card>
      <button className="outline-button sign-out" onClick={() => void signOut()}>
        {t("Sign out of this browser")}
      </button>
    </>
  );
}
