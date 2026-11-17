import { useEffect, useRef } from "react";
import { api } from "../api.ts";
import { usePlayer } from "../stores/player.ts";
import { useApi } from "../useApi.ts";
import "./pages.css";

/** The playing track's lyrics; synced ones follow the music, and a line seeks there when tapped. */
export function Lyrics() {
  const track = usePlayer((s) => s.track);
  if (!track) return <div className="page muted">Nothing playing.</div>;
  return <TrackLyrics key={track.id} trackId={track.id} title={track.title} artist={track.artistName} />;
}

function TrackLyrics({ trackId, title, artist }: { trackId: string; title: string; artist: string }) {
  const { data, loading } = useApi(api.lyrics, { params: { id: trackId } });
  const position = usePlayer((s) => s.position);
  const seek = usePlayer((s) => s.seek);
  const current = useRef<HTMLButtonElement>(null);
  const lines = data?.lines ?? [];
  const synced = data?.synced ?? false;
  const ms = position * 1000;
  let at = -1;
  if (synced) for (let i = 0; i < lines.length && (lines[i]!.timeMs ?? 0) <= ms; i++) at = i;

  useEffect(() => {
    current.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [at]);

  return (
    <div className="page lyrics">
      <div className="caps">Lyrics</div>
      <h1>{title}</h1>
      <div className="muted lyrics-artist">{artist}</div>
      {loading ? (
        <p className="faint">Looking for lyrics…</p>
      ) : data?.instrumental ? (
        <p className="muted">Instrumental.</p>
      ) : lines.length === 0 ? (
        <p className="muted">No lyrics found for this track.</p>
      ) : (
        <div className={`lyrics-lines ${synced ? "synced" : ""}`}>
          {lines.map((l, i) =>
            l.text === "" ? (
              <div key={i} className="lyrics-break" />
            ) : synced ? (
              <button
                key={i}
                ref={i === at ? current : undefined}
                className={`lyrics-line ${i === at ? "now" : i < at ? "past" : ""}`}
                onClick={() => l.timeMs !== null && seek(l.timeMs / 1000)}
              >
                {l.text}
              </button>
            ) : (
              <div key={i} className="lyrics-line">
                {l.text}
              </div>
            ),
          )}
        </div>
      )}
      {data && data.source !== "none" && (
        <p className="faint lyrics-source">
          {data.source === "lrclib"
            ? "From LRCLIB"
            : data.source === "file"
              ? "From a .lrc file"
              : "From the file's tags"}
        </p>
      )}
    </div>
  );
}
