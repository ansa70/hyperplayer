import type { TrackSource } from "@hyperplayer/schemas";
import { api } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { TrackList } from "../components/TrackList.tsx";
import { duration } from "../format.ts";
import { useMarks } from "../stores/marks.ts";
import { usePlayer } from "../stores/player.ts";
import { useApi } from "../useApi.ts";
import "./pages.css";
import { t, tn } from "../i18n.ts";

/** The user's favourite tracks, the latest first. */
export function Favourites() {
  // Loaded again whenever a track is marked or unmarked.
  const version = useMarks((s) => s.version);
  const { data, error } = useApi(api.listFavourites, {}, version);
  const play = usePlayer((s) => s.play);
  const tracks = data ?? [];
  const source: TrackSource = { kind: "tracks", trackIds: tracks.map((t) => t.id) };
  const total = tracks.reduce((sum, t) => sum + t.durationMs, 0);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("Favourites")}</h1>
      </div>
      {error && <p className="error">{error}</p>}
      {tracks.length > 0 && (
        <>
          <p className="muted">
            {tn("{n} track", "{n} tracks", tracks.length)} · {duration(total)}
          </p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => void play(source, 0, false)}>
              <Icon name="play" size={16} /> {t("Play")}
            </button>
            <button
              className="outline-button"
              onClick={() => void play(source, Math.floor(Math.random() * tracks.length), true)}
            >
              {t("Shuffle")}
            </button>
          </div>
        </>
      )}
      {data && tracks.length === 0 && (
        <p className="muted">
          {t("No favourites yet. Right-click a track (or use its ⋯ menu) and pick Add to favourites.")}
        </p>
      )}
      <TrackList tracks={tracks} onPlay={(i) => void play(source, i, false)} />
    </div>
  );
}
