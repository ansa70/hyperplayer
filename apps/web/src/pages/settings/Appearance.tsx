import { useSession } from "../../stores/session.ts";
import { Card } from "./Card.tsx";

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

/** The account's appearance, as in the Rust player: accent, window tint, visualizer. */
export function Appearance() {
  const { preferences, updatePreferences } = useSession();
  if (!preferences) return <p className="muted">Loading…</p>;
  return (
    <>
      <Card title="Accent colour">
        <p className="note">
          Used for highlights, active controls and the waveform. “From the album” follows the cover of what's
          playing.
        </p>
        <div className="swatches">
          {SWATCHES.map((s) => (
            <button
              key={s}
              className={`swatch ${preferences.accent === s ? "on" : ""} ${s === "cover" ? "cover-swatch" : ""}`}
              style={s === "cover" ? undefined : { background: s }}
              title={s === "cover" ? "From the album" : s}
              aria-pressed={preferences.accent === s}
              onClick={() => void updatePreferences({ accent: s })}
            />
          ))}
        </div>
      </Card>
      <Card title="Window">
        <label className="check">
          <input
            type="checkbox"
            checked={preferences.coverBackground}
            onChange={(e) => void updatePreferences({ coverBackground: e.target.checked })}
          />
          Tint the window with the colours of the album playing
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={preferences.visualizer}
            onChange={(e) => void updatePreferences({ visualizer: e.target.checked })}
          />
          Show the live spectrum under the cover
        </label>
      </Card>
    </>
  );
}
