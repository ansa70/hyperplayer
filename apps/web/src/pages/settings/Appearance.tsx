import { Segmented } from "../../components/Segmented.tsx";
import { useSession } from "../../stores/session.ts";
import { Card } from "./Card.tsx";
import { LANGUAGES, t, useLanguage } from "../../i18n.ts";

const SWATCHES = [
  "cover",
  "#1ed760",
  "#2dd4bf",
  "#5b8cff",
  "#a77bff",
  "#ff5fa2",
  "#ff5c5c",
  "#ff9f43",
  "#f5c542",
];

/** The account's appearance, as in the Rust player: accent, window tint, visualizer; and
 *  this browser's language. */
export function Appearance() {
  const { preferences, updatePreferences } = useSession();
  const { setting, setSetting } = useLanguage();
  if (!preferences) return <p className="muted">{t("Loading…")}</p>;
  return (
    <>
      <Card title={t("Accent colour")}>
        <p className="note">
          {t(
            "Used for highlights, active controls and the waveform. “From the album” follows the cover of what's playing.",
          )}
        </p>
        <div className="swatches">
          {SWATCHES.map((s) => (
            <button
              key={s}
              className={`swatch ${preferences.accent === s ? "on" : ""} ${s === "cover" ? "cover-swatch" : ""}`}
              style={s === "cover" ? undefined : { background: s }}
              title={s === "cover" ? t("From the album") : s}
              aria-pressed={preferences.accent === s}
              onClick={() => void updatePreferences({ accent: s })}
            />
          ))}
        </div>
      </Card>
      <Card title={t("Window")}>
        <label className="check">
          <input
            type="checkbox"
            checked={preferences.coverBackground}
            onChange={(e) => void updatePreferences({ coverBackground: e.target.checked })}
          />
          {t("Tint the window with the colours of the album playing")}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={preferences.visualizer}
            onChange={(e) => void updatePreferences({ visualizer: e.target.checked })}
          />
          {t("Show the live spectrum under the cover")}
        </label>
      </Card>
      <Card title={t("Language")}>
        <p className="note">{t("Automatic follows this browser's language. This browser only.")}</p>
        <Segmented
          value={setting}
          options={[
            { key: "", label: t("Automatic") },
            ...LANGUAGES.map((l) => ({ key: l.code, label: l.name })),
          ]}
          onPick={setSetting}
        />
      </Card>
    </>
  );
}
