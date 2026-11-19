import type { Listen } from "@hyperplayer/schemas";
import { useState } from "react";
import { Link } from "react-router";
import { api, call } from "../api.ts";
import { Cover } from "../components/Cover.tsx";
import { TrackList } from "../components/TrackList.tsx";
import { duration } from "../format.ts";
import { usePlayer } from "../stores/player.ts";
import { useApi } from "../useApi.ts";
import "./pages.css";
import { locale, t, tn } from "../i18n.ts";

const DAYS = 30;
const PAGE = 50;

function listened(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return hours > 0 ? t("{} h {} min", hours, minutes) : t("{} min", minutes);
}

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString(locale(), { day: "numeric", month: "short" })} ${time}`;
}

/** Most played over the last 30 days, and every listen, newest first. */
export function History() {
  const stats = useApi(api.historyStats, { query: { days: DAYS, limit: 10 } });
  const play = usePlayer((s) => s.play);
  // The first page, then more as asked for.
  const first = useApi(api.listHistory, { query: { offset: 0, limit: PAGE } });
  const [more, setMore] = useState<Listen[]>([]);
  const recent = [...(first.data?.items ?? []), ...more];
  const total = first.data?.total ?? 0;
  const showMore = () =>
    call(api.listHistory, { query: { offset: recent.length, limit: PAGE } })
      .then((p) => setMore((m) => [...m, ...p.items]))
      .catch(() => {});

  const s = stats.data;
  const top = s?.topTracks.map((t) => t.track) ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("History")}</h1>
      </div>
      {s && (
        <p className="muted">
          {tn(
            "Last {} days: {n} listen, {} of music.",
            "Last {} days: {n} listens, {} of music.",
            s.listens,
            DAYS,
            listened(s.listenedMs),
          )}
        </p>
      )}
      {top.length > 0 && (
        <>
          <div className="caps section">{t("Most played")}</div>
          <TrackList
            tracks={top}
            onPlay={(i) => void play({ kind: "tracks", trackIds: top.map((t) => t.id) }, i, false)}
          />
        </>
      )}
      {s && s.topArtists.length > 0 && (
        <>
          <div className="caps section">{t("Top artists")}</div>
          <div className="top-artists">
            {s.topArtists.map((a) => (
              <Link key={a.artist.id} to={`/artist/${a.artist.id}`} className="top-artist">
                <Cover art={a.artist.image} size={96} round />
                <span className="ellipsis">{a.artist.name}</span>
                <span className="faint">{tn("{n} play", "{n} plays", a.plays)}</span>
              </Link>
            ))}
          </div>
        </>
      )}
      <div className="caps section">{t("Recently played")}</div>
      {recent.length === 0 && (
        <p className="muted">{t("Nothing yet: listens show up here once half a track is played.")}</p>
      )}
      <div className="queue">
        {recent.map((l) => (
          <div
            key={`${l.track.id}-${l.startedAt}`}
            role="button"
            tabIndex={0}
            className="queue-row"
            onClick={() => void play({ kind: "tracks", trackIds: [l.track.id] }, 0, false)}
          >
            <Cover art={l.track.cover} size={40} />
            <span className="queue-text">
              <span className="ellipsis">{l.track.title}</span>
              <span className="muted ellipsis">
                {l.track.artistName} · {l.track.albumTitle}
              </span>
            </span>
            <span className="faint">{when(l.startedAt)}</span>
            <span className="faint">{duration(l.playedMs)}</span>
          </div>
        ))}
      </div>
      {recent.length < total && (
        <button className="outline-button load-more" onClick={() => void showMore()}>
          {t("Show more")}
        </button>
      )}
    </div>
  );
}
