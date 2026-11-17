import type { Track } from "@hyperplayer/schemas";
import { Link } from "react-router";
import { duration } from "../format.ts";
import { usePlayer } from "../stores/player.ts";
import "./components.css";

/** Tracks of an album (numbered) or a mixed list (with their artist and album). */
export function TrackList({
  tracks,
  onPlay,
  numbered,
}: {
  tracks: Track[];
  onPlay: (index: number) => void;
  numbered?: boolean;
}) {
  const playingId = usePlayer((s) => s.track?.id);
  const discs = new Set(tracks.map((t) => t.discNumber ?? 1)).size > 1;
  return (
    <div className="tracklist">
      {tracks.map((t, i) => {
        const playing = t.id === playingId;
        const newDisc = discs && (i === 0 || tracks[i - 1]!.discNumber !== t.discNumber);
        return (
          <div key={t.id}>
            {newDisc && <div className="caps disc">Disc {t.discNumber ?? 1}</div>}
            <button className={`track ${playing ? "playing" : ""}`} onClick={() => onPlay(i)}>
              <span className="track-number">{numbered ? (t.trackNumber ?? i + 1) : i + 1}</span>
              <span className="track-title">
                <span className="ellipsis">{t.title}</span>
                {!numbered && (
                  <span className="muted ellipsis track-sub">
                    <Link to={`/artist/${t.artistId}`} onClick={(e) => e.stopPropagation()}>
                      {t.artistName}
                    </Link>
                    {" · "}
                    <Link to={`/album/${t.albumId}`} onClick={(e) => e.stopPropagation()}>
                      {t.albumTitle}
                    </Link>
                  </span>
                )}
              </span>
              <span className="muted track-duration">{duration(t.durationMs)}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
