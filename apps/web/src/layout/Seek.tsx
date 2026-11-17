import { Waveform } from "../components/Waveform.tsx";
import { duration } from "../format.ts";
import { usePlayer } from "../stores/player.ts";

/** Elapsed time, the waveform seek bar and the track's length. */
export function Seek() {
  const { track, position, waveform, seek } = usePlayer();
  const length = (track?.durationMs ?? 0) / 1000;
  return (
    <div className="seek">
      <span className="muted seek-time">{duration(position * 1000)}</span>
      <Waveform
        points={waveform}
        position={position}
        duration={length}
        trimStart={(track?.trim?.startMs ?? 0) / 1000}
        trimEnd={track?.trim?.endMs ? track.trim.endMs / 1000 : null}
        onSeek={seek}
      />
      <span className="muted seek-time">{duration(track?.durationMs ?? 0)}</span>
    </div>
  );
}
