import { api, type Track, TrackPage } from "@hyperplayer/schemas";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { ApiError } from "@hyperplayer/schemas";
import { call, errorMessage, url } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { TrackList } from "../components/TrackList.tsx";
import { useLibrary } from "../stores/library.ts";
import { usePlayer } from "../stores/player.ts";
import "./pages.css";
import "./uploads.css";
import { t, tn } from "../i18n.ts";

/** The extensions the server's library reads (apps/server/src/library/scanner.ts). */
const AUDIO = [
  ".mp3",
  ".flac",
  ".ogg",
  ".opus",
  ".m4a",
  ".aac",
  ".wav",
  ".aiff",
  ".aif",
  ".wv",
  ".ape",
  ".mpc",
];

interface Job {
  id: number;
  file: File;
  /** 0..1 while sending; then done or failed. */
  progress: number;
  state: "waiting" | "sending" | "done" | "failed";
  message: string;
}

function size(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return bytes === 0 ? "0 kB" : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

/** Sends one file, reporting progress (fetch can't, for uploads). */
function send(file: File, onProgress: (p: number) => void): Promise<Track> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url(api.uploadTrack.path, { name: file.name }));
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as Track);
      const err = ApiError.safeParse(body);
      reject(new Error(err.success ? err.data.message : `${xhr.status} ${xhr.statusText}`));
    };
    xhr.onerror = () => reject(new Error(t("The connection was lost")));
    xhr.send(file);
  });
}

/**
 * Your own music, uploaded to the server: private to you, playable everywhere you sign in.
 * Files go one at a time, each with its progress; then they're in your library.
 */
export function Uploads() {
  const { uploads, libraryChanged, notify } = useLibrary();
  const play = usePlayer((s) => s.play);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [mine, setMine] = useState<Track[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const nextId = useRef(0);

  const loadMine = () =>
    call(api.listUploads, { query: { limit: 500 } })
      .then((p: TrackPage) => setMine(p.items))
      .catch(() => {});
  useEffect(() => {
    void loadMine();
  }, []);

  const update = (id: number, change: Partial<Job>) =>
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...change } : j)));

  /** Sends the waiting files one after another. */
  const run = async (queue: Job[]) => {
    if (running.current) return;
    running.current = true;
    for (const job of queue) {
      update(job.id, { state: "sending" });
      try {
        const track = await send(job.file, (p) => update(job.id, { progress: p }));
        update(job.id, { state: "done", progress: 1, message: `${track.artistName} · ${track.albumTitle}` });
      } catch (e) {
        update(job.id, { state: "failed", message: errorMessage(e) });
      }
    }
    running.current = false;
    libraryChanged();
    void loadMine();
  };

  const add = (files: FileList | File[]) => {
    const list = [...files].filter((f) => AUDIO.some((ext) => f.name.toLowerCase().endsWith(ext)));
    const skipped = [...files].length - list.length;
    if (skipped > 0)
      notify(
        tn(
          "{n} file skipped: not audio the library reads",
          "{n} files skipped: not audio the library reads",
          skipped,
        ),
      );
    if (list.length === 0) return;
    const added = list.map((file): Job => ({
      id: nextId.current++,
      file,
      progress: 0,
      state: "waiting",
      message: "",
    }));
    setJobs((js) => [...js.filter((j) => j.state !== "done"), ...added]);
    void run(added);
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add(e.dataTransfer.files);
  };

  const remove = (track: Track) => {
    if (
      !window.confirm(t("Delete “{}” from your uploads? The file is removed from the server.", track.title))
    )
      return;
    call(api.deleteUpload, { params: { id: track.id } })
      .then(() => {
        setMine((m) => m.filter((x) => x.id !== track.id));
        libraryChanged();
      })
      .catch((e: unknown) => notify(errorMessage(e)));
  };

  if (uploads && !uploads.enabled) {
    return (
      <div className="page">
        <h1>{t("Uploads")}</h1>
        <p className="muted">
          {t("This server doesn't take uploads. Its admin can turn them on (HP_UPLOAD_DIR).")}
        </p>
      </div>
    );
  }

  return (
    <div className="page uploads">
      <div className="page-head">
        <h1>{t("Uploads")}</h1>
        {uploads && (
          <span className="muted">
            {tn("{n} track", "{n} tracks", uploads.tracks)} · {size(uploads.usedBytes)}
            {uploads.quotaBytes !== null && ` ${t("of {}", size(uploads.quotaBytes))}`}
          </span>
        )}
      </div>
      {uploads?.quotaBytes != null && (
        <div className="quota">
          <div style={{ width: `${Math.min(100, (uploads.usedBytes / uploads.quotaBytes) * 100)}%` }} />
        </div>
      )}
      <div
        className={`dropzone ${over ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
      >
        <Icon name="upload" size={28} />
        <strong>{t("Drop music files here, or choose them")}</strong>
        <span className="muted">
          {t(
            "Only you can see and play what you upload. Files up to {}; they're filed by their tags.",
            uploads ? size(uploads.maxFileBytes) : "…",
          )}
        </span>
        <input
          ref={input}
          type="file"
          multiple
          accept={["audio/*", ...AUDIO].join(",")}
          hidden
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {jobs.length > 0 && (
        <div className="jobs">
          {jobs.map((j) => (
            <div key={j.id} className={`job ${j.state}`}>
              <span className="ellipsis">{j.file.name}</span>
              <span className="faint job-state">
                {j.state === "waiting"
                  ? t("Waiting")
                  : j.state === "sending"
                    ? `${Math.round(j.progress * 100)}%`
                    : j.state === "done"
                      ? t("Added")
                      : t("Failed")}
              </span>
              <div className="job-bar">
                <div style={{ width: `${j.progress * 100}%` }} />
              </div>
              {j.message && (
                <span className={`job-message ${j.state === "failed" ? "error" : "faint"}`}>{j.message}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="caps section">{t("Your uploads")}</div>
      {mine.length === 0 ? (
        <p className="muted">{t("Nothing uploaded yet.")}</p>
      ) : (
        <TrackList
          tracks={mine}
          onPlay={(i) => void play({ kind: "tracks", trackIds: mine.map((t) => t.id) }, i, false)}
          extraItems={(i) => [{ label: t("Delete upload"), danger: true, onSelect: () => remove(mine[i]!) }]}
        />
      )}
    </div>
  );
}
