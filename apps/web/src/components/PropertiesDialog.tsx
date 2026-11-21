import type { TagField, Track, TrackProperties, TrackTags } from "@hyperplayer/schemas";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, call, errorMessage } from "../api.ts";
import { duration } from "../format.ts";
import { useLibrary } from "../stores/library.ts";
import { useMarks } from "../stores/marks.ts";
import { usePlayer } from "../stores/player.ts";
import { Cover } from "./Cover.tsx";
import { Icon } from "./Icon.tsx";
import "./properties.css";
import { locale, msg, t, tn } from "../i18n.ts";

/** Which track's Properties are open. */
export const useProperties = create<{ track: Track | null; open: (t: Track) => void; close: () => void }>()(
  (set) => ({
    track: null,
    open: (track) => set({ track }),
    close: () => set({ track: null }),
  }),
);

const TAGS: { key: TagField; label: string }[] = [
  { key: "title", label: msg("Title") },
  { key: "artist", label: msg("Artist") },
  { key: "trackNumber", label: msg("Track number") },
  { key: "discNumber", label: msg("Disc number") },
  { key: "year", label: msg("Year") },
  { key: "genres", label: msg("Genres") },
];

/** A tag as its text field shows it. */
function text(tags: TrackTags, key: TagField): string {
  const v = tags[key];
  if (key === "genres") return (v as string[]).join(", ");
  return v === null ? "" : String(v);
}

/** The tag typed, as the server takes it; a string is an error to show. */
function parse(key: TagField, typed: string): TrackTags[TagField] | { error: string } {
  const s = typed.trim();
  if (key === "title" || key === "artist")
    return s ? s : { error: t("{} can't be empty", t(TAGS.find((x) => x.key === key)!.label)) };
  if (key === "genres")
    return s
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
  if (!s) return null;
  const n = Number(s);
  const max = key === "year" ? 9999 : key === "discNumber" ? 999 : 9999;
  if (!Number.isInteger(n) || n < (key === "year" ? 0 : 1) || n > max)
    return { error: t("“{}” isn't a valid {}", s, t(TAGS.find((x) => x.key === key)!.label).toLowerCase()) };
  return n;
}

const clock = (seconds: number) => duration(Math.round(seconds) * 1000);

/** A track's Properties: details, tags (edited in HyperPlayer only), marks, range and volume. */
export function PropertiesDialog() {
  const track = useProperties((s) => s.track);
  const close = useProperties((s) => s.close);
  if (!track) return null;
  return <Dialog key={track.id} track={track} onClose={close} />;
}

function Dialog({ track, onClose }: { track: Track; onClose: () => void }) {
  const [props, setProps] = useState<TrackProperties | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [tags, setTags] = useState<Record<TagField, string>>({} as Record<TagField, string>);
  const [reset, setReset] = useState<TagField[]>([]);
  const [rating, setRating] = useState(0);
  const [favourite, setFavourite] = useState(false);
  const [excluded, setExcluded] = useState(false);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [volume, setVolume] = useState(0);

  useEffect(() => {
    call(api.trackProperties, { params: { id: track.id } })
      .then((p) => {
        setProps(p);
        setTags(
          Object.fromEntries(TAGS.map(({ key }) => [key, text(p.tags, key)])) as Record<TagField, string>,
        );
        setRating(p.track.rating);
        setFavourite(p.track.favourite);
        setExcluded(p.track.shuffleExcluded);
        const total = p.track.durationMs / 1000;
        setRange([
          (p.track.trim?.startMs ?? 0) / 1000,
          Math.min(total, (p.track.trim?.endMs ?? p.track.durationMs) / 1000),
        ]);
        setVolume(p.track.volumeDb);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [track.id]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  const save = async () => {
    if (!props) return;
    const changed: Partial<TrackTags> = {};
    for (const { key } of TAGS) {
      if (tags[key].trim() === text(props.tags, key).trim()) continue;
      if (reset.includes(key) && tags[key].trim() === text(props.original, key).trim()) continue;
      const value = parse(key, tags[key]);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return setError(value.error);
      (changed as Record<string, unknown>)[key] = value;
    }
    const t0 = props.track;
    const total = t0.durationMs;
    const startMs = Math.round(range[0] * 1000) > 0 ? Math.round(range[0] * 1000) : null;
    const endMs = Math.round(range[1] * 1000) < total - 500 ? Math.round(range[1] * 1000) : null;
    const near = (a: number | null, b: number | null) =>
      a === null || b === null ? a === b : Math.abs(a - b) < 500;
    const trimChanged = !near(startMs, t0.trim?.startMs ?? null) || !near(endMs, t0.trim?.endMs ?? null);
    const body = {
      ...(Object.keys(changed).length ? { tags: changed } : {}),
      ...(reset.length ? { reset } : {}),
      ...(Math.abs(volume - t0.volumeDb) > 0.01 ? { volumeDb: volume } : {}),
      ...(trimChanged ? { trim: { startMs, endMs } } : {}),
    };
    const marks = {
      ...(favourite !== t0.favourite ? { favourite } : {}),
      ...(excluded !== t0.shuffleExcluded ? { shuffleExcluded: excluded } : {}),
      ...(rating !== t0.rating ? { rating } : {}),
    };
    if (!Object.keys(body).length && !Object.keys(marks).length) return onClose();
    setSaving(true);
    setError("");
    try {
      if (Object.keys(body).length) await call(api.updateTrackProperties, { params: { id: track.id }, body });
      let updated = (await call(api.trackProperties, { params: { id: track.id } })).track;
      if (Object.keys(marks).length)
        updated = await call(api.setTrackMarks, { params: { id: track.id }, body: marks });
      useMarks.getState().took(updated);
      usePlayer.getState().replaceTrack(updated);
      useLibrary.getState().notify(t("Saved “{}”", updated.title));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  const total = (props?.track.durationMs ?? track.durationMs) / 1000;
  const whole = range[0] <= 0 && range[1] >= total - 0.5;
  return (
    <div className="props-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="props" role="dialog" aria-label={t("Properties")}>
        <header className="props-head">
          <Cover art={track.cover} size={72} />
          <div className="props-title">
            <h2 className="ellipsis">{props?.track.title ?? track.title}</h2>
            <div className="muted ellipsis">
              {track.artistName} · {track.albumTitle}
            </div>
          </div>
          <button className="icon-button" title={t("Close")} onClick={onClose}>
            <Icon name="windowClose" size={18} />
          </button>
        </header>
        <div className="props-body">
          {!props && !error && <p className="faint">{t("Loading…")}</p>}
          {props && (
            <>
              <section>
                <div className="caps">{t("Your rating and marks")}</div>
                <div className="stars" role="radiogroup" aria-label={t("Rating")}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      className={n <= rating ? "on" : ""}
                      title={tn("{n} star", "{n} stars", n)}
                      onClick={() => setRating(rating === n ? 0 : n)}
                    >
                      <Icon name="star" size={22} />
                    </button>
                  ))}
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={favourite}
                    onChange={(e) => setFavourite(e.target.checked)}
                  />
                  {t("Favourite")}
                </label>
                <label className="check">
                  <input type="checkbox" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} />
                  {t("Leave out of library shuffle")}
                </label>
              </section>
              <section>
                <div className="caps">{t("Tags")}</div>
                <p className="note">
                  {t(
                    "Edits are kept in HyperPlayer: the file itself isn't changed. Separate genres with commas.",
                  )}
                </p>
                {TAGS.map(({ key, label }) => {
                  const edited = props.edited.includes(key) && !reset.includes(key);
                  const original = text(props.original, key);
                  return (
                    <div key={key} className="props-row">
                      <label htmlFor={`tag-${key}`}>{t(label)}</label>
                      <div className="props-field">
                        <input
                          id={`tag-${key}`}
                          value={tags[key] ?? ""}
                          inputMode={
                            ["trackNumber", "discNumber", "year"].includes(key) ? "numeric" : undefined
                          }
                          onChange={(e) => setTags({ ...tags, [key]: e.target.value })}
                          onKeyDown={(e) => e.key === "Enter" && void save()}
                        />
                        {edited && (
                          <span className="accent small">
                            {original
                              ? t("Edited · in the file: {}", original)
                              : t("Edited · empty in the file")}
                          </span>
                        )}
                      </div>
                      {edited ? (
                        <button
                          className="icon-button"
                          title={t("Back to the file's")}
                          onClick={() => {
                            setReset([...reset, key]);
                            setTags({ ...tags, [key]: original });
                          }}
                        >
                          <Icon name="replay" size={16} />
                        </button>
                      ) : (
                        <span />
                      )}
                    </div>
                  );
                })}
              </section>
              <section>
                <div className="caps">{t("Playback, for everyone")}</div>
                <div className="props-row">
                  <label>{t("Part played")}</label>
                  <div className="range">
                    <div
                      className="range-fill"
                      style={{
                        left: `${(range[0] / total) * 100}%`,
                        right: `${100 - (range[1] / total) * 100}%`,
                      }}
                    />
                    <input
                      type="range"
                      aria-label={t("Start")}
                      min={0}
                      max={total}
                      step={0.5}
                      value={range[0]}
                      onChange={(e) => setRange([Math.min(Number(e.target.value), range[1] - 1), range[1]])}
                    />
                    <input
                      type="range"
                      aria-label={t("End")}
                      min={0}
                      max={total}
                      step={0.5}
                      value={range[1]}
                      onChange={(e) => setRange([range[0], Math.max(Number(e.target.value), range[0] + 1)])}
                    />
                  </div>
                  <span />
                </div>
                <div className="props-row">
                  <span />
                  <div className="props-inline muted">
                    {clock(range[0])} – {clock(range[1])} ·{" "}
                    {whole ? t("the whole track") : t("of {}", clock(total))}
                    <button className="outline-button" disabled={whole} onClick={() => setRange([0, total])}>
                      {t("Whole track")}
                    </button>
                  </div>
                  <span />
                </div>
                <div className="props-row">
                  <label htmlFor="props-volume">{t("Volume")}</label>
                  <div className="props-inline">
                    <input
                      id="props-volume"
                      type="range"
                      min={-12}
                      max={12}
                      step={0.5}
                      value={volume}
                      onChange={(e) => setVolume(Number(e.target.value))}
                    />
                    <span className="props-db">
                      {volume > 0 ? "+" : ""}
                      {volume} dB
                    </span>
                    <button className="outline-button" disabled={volume === 0} onClick={() => setVolume(0)}>
                      0 dB
                    </button>
                  </div>
                  <span />
                </div>
                <p className="note">
                  {t(
                    "Added to ReplayGain (boosts are still limited so peaks never clip), or applied by itself when the track has none.",
                  )}
                </p>
              </section>
              <section>
                <div className="caps">{t("Details")}</div>
                <Details p={props} />
              </section>
            </>
          )}
        </div>
        <footer className="props-foot">
          <span className="error">{error}</span>
          <button className="outline-button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="primary-button" disabled={!props || saving} onClick={() => void save()}>
            {t("Save")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Details({ p }: { p: TrackProperties }) {
  const f = p.track.format;
  const rg = p.track.replayGain;
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale(), { dateStyle: "medium" });
  const db = (g: number) => `${g >= 0 ? "+" : "−"}${Math.abs(g).toFixed(1)} dB`;
  const format = [
    f.codec,
    ...(f.container !== f.codec ? [f.container] : []),
    f.lossless ? t("lossless") : t("lossy"),
    ...(f.bitrate ? [`${Math.round(f.bitrate / 1000)} kbit/s`] : []),
    ...(f.sampleRate ? [`${f.sampleRate / 1000} kHz`] : []),
    ...(f.bitDepth ? [`${f.bitDepth} bit`] : []),
    ...(f.channels
      ? [
          f.channels === 1
            ? t("mono")
            : f.channels === 2
              ? t("stereo")
              : tn("{n} channel", "{n} channels", f.channels),
        ]
      : []),
  ].join(" · ");
  const gains = [
    ...(rg.trackGain !== null ? [t("track {}", db(rg.trackGain))] : []),
    ...(rg.albumGain !== null ? [t("album {}", db(rg.albumGain))] : []),
  ];
  const rows: [string, string][] = [
    [t("Album"), p.track.albumTitle],
    [t("Duration"), duration(p.track.durationMs)],
    [t("Format"), format],
    [t("File size"), `${(p.track.fileSize / 1_048_576).toFixed(1)} MB`],
    [t("File"), p.path],
    [t("ReplayGain"), gains.length ? gains.join(" · ") : t("none in the file")],
    [
      t("Your plays"),
      p.lastPlayedAt
        ? tn("{n} · last on {}", "{n} · last on {}", p.plays, date(p.lastPlayedAt))
        : t("never played"),
    ],
    ...(p.addedAt ? [[t("Added"), date(p.addedAt)] as [string, string]] : []),
    ...(p.musicbrainzRecordingId
      ? [[t("MusicBrainz ID"), p.musicbrainzRecordingId] as [string, string]]
      : []),
  ];
  return (
    <dl className="props-details">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
