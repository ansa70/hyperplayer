import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api.ts";
import { Waveform } from "../components/Waveform.tsx";
import { duration } from "../format.ts";
import { picked, saveTrim } from "../player/trim.ts";
import { useLibrary } from "../stores/library.ts";
import { usePlayer } from "../stores/player.ts";
import { useSession } from "../stores/session.ts";
import "../components/menu.css";

/** Elapsed time, the waveform seek bar (with the trim menu for admins) and the track's length. */
export function Seek() {
  const { track, position, waveform, seek } = usePlayer();
  const admin = useSession((s) => s.user?.admin ?? false);
  const notify = useLibrary((s) => s.notify);
  const [menu, setMenu] = useState<{ at: number; x: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const length = (track?.durationMs ?? 0) / 1000;
  const trimmed = track?.trim?.startMs != null || track?.trim?.endMs != null;

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as Element).closest?.(".trim-menu")) setMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [menu]);

  const pick = (kind: "start" | "end" | "clear") => {
    const at = menu?.at ?? 0;
    setMenu(null);
    if (!track) return;
    saveTrim(track, picked(track, kind, at)).catch((e: unknown) => notify(errorMessage(e)));
  };

  return (
    <div className="seek" ref={ref}>
      <span className="muted seek-time">{duration(position * 1000)}</span>
      <div className="seek-bar">
        <Waveform
          points={waveform}
          position={position}
          duration={length}
          trimStart={(track?.trim?.startMs ?? 0) / 1000}
          trimEnd={track?.trim?.endMs ? track.trim.endMs / 1000 : null}
          onSeek={seek}
          onMenu={admin && track ? (at, x) => setMenu({ at, x }) : undefined}
        />
        {menu && (
          <div className="menu trim-menu" style={{ left: Math.max(0, menu.x - 115) }}>
            <div className="caps menu-heading">Trim, for everyone · {duration(menu.at * 1000)}</div>
            <button className="menu-item" onClick={() => pick("start")}>
              Start the track here
            </button>
            <button className="menu-item" onClick={() => pick("end")}>
              End the track here
            </button>
            {trimmed && (
              <button className="menu-item" onClick={() => pick("clear")}>
                Play the whole track
              </button>
            )}
          </div>
        )}
      </div>
      <span className="muted seek-time">{duration(track?.durationMs ?? 0)}</span>
    </div>
  );
}
