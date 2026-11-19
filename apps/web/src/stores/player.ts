// Playback. As in the Rust player, the server keeps the queue and decides what's next;
// this plays the current track and reports back. Two audio elements take turns: while
// one plays, the next track loads in the other, so it starts the moment this one ends.

import type {
  Preferences,
  QueueState,
  ShuffleScope,
  Silence,
  Track,
  TrackSource,
} from "@hyperplayer/schemas";
import { create } from "zustand";
import { api, artworkUrl, call, errorMessage } from "../api.ts";
import { begin, follow } from "../player/listening.ts";
import { canFade, fade, prepareOutput, setLevel, stopFade } from "../player/output.ts";
import { chooseStream, type Mode } from "../player/quality.ts";
import { compute, label, UNITY, type Applied, type RgMode } from "../player/replaygain.ts";
import { t } from "../i18n.ts";

interface PlayerState {
  queue: QueueState | null;
  /** The track loaded in the player (playing or paused). */
  track: Track | null;
  playing: boolean;
  /** Opening a stream. */
  loading: boolean;
  /** Seconds into the track. */
  position: number;
  /** What's streaming, e.g. "FLAC 24/96". */
  streamLabel: string;
  waveform: number[] | null;
  /** Silence found at the ends of the current track (with its waveform). */
  silence: Silence | null;
  volume: number;
  error: string;
  /** Streaming quality for this session (from the account's preference). */
  mode: Mode;
  rgMode: RgMode;
  preamp: number;
  /** Crossfade, from the account's preferences. */
  crossfade: { seconds: number; onSkip: boolean; albums: boolean };
  /** The ReplayGain applied to the current track, e.g. "RG −6.4 dB track". */
  rgLabel: string;

  loadQueue: () => Promise<void>;
  play: (
    source: TrackSource,
    start?: number,
    shuffle?: boolean,
    shuffleScope?: ShuffleScope,
  ) => Promise<void>;
  toggle: () => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seek: (seconds: number) => void;
  jump: (entryId: string) => Promise<void>;
  toggleShuffle: () => Promise<void>;
  /** Shuffles from the account's shuffle scope (saved first, by the caller): redraws if already on. */
  shuffleFrom: () => Promise<void>;
  cycleRepeat: () => Promise<void>;
  setVolume: (v: number) => void;
  setMode: (m: Mode) => void;
  /** Takes in the account's playback preferences. */
  setPreferences: (p: Preferences) => void;
  /** Takes in a track changed on the server (its trim), wherever it's held. */
  replaceTrack: (track: Track) => void;
  stop: () => void;
}

/** Saving more often than this while playing would only add load; pausing saves at once. */
const SAVE_EVERY = 10_000;
/** How long before the end the next track starts loading. */
const PRELOAD_BEFORE = 20;

/** A track loaded in one of the two audio elements. */
interface Loaded {
  entryId: string;
  track: Track;
  /** Transcodes started at `start` count their time from there. */
  offset: number;
  seekable: boolean;
  label: string;
}

const elements = typeof Audio === "undefined" ? [] : [new Audio(), new Audio()];
let active = 0;
/** What each element holds. */
const loaded: (Loaded | null)[] = [null, null];
/** The ReplayGain each element plays at. */
const gains: Applied[] = [UNITY, UNITY];

/** "Album in order": the queue was started from an album and isn't shuffled. */
function inAlbumOrder(): boolean {
  const q = usePlayer.getState().queue;
  return !!q && !q.shuffle && q.origin?.kind === "album";
}

/** Sets each element's loudness from the volume and its track's ReplayGain. */
function applyLevels() {
  const { volume, rgMode, preamp } = usePlayer.getState();
  elements.forEach((e, slot) => {
    const l = loaded[slot];
    gains[slot] = l ? compute(l.track.replayGain, rgMode, inAlbumOrder(), preamp) : UNITY;
    setLevel(e, volume, gains[slot]!.linear);
  });
  usePlayer.setState({ rgLabel: label(gains[active]!) });
}
let lastSaved = 0;
/** The track playing ended: moving on is in progress (once per ending). */
let advancing = false;

const el = () => elements[active]!;
const spare = () => elements[1 - active]!;
const trimStart = (t: Track) => (t.trim?.startMs ?? 0) / 1000;
const trimEnd = (t: Track) => (t.trim?.endMs ? t.trim.endMs / 1000 : null);
const length = (t: Track) => t.durationMs / 1000;

function currentEntry(q: QueueState | null) {
  return q && q.index !== null ? (q.entries[q.index] ?? null) : null;
}

export const usePlayer = create<PlayerState>()((set, get) => ({
  queue: null,
  track: null,
  playing: false,
  loading: false,
  position: 0,
  streamLabel: "",
  waveform: null,
  silence: null,
  volume: readVolume(),
  error: "",
  mode: "auto",
  rgMode: "auto",
  preamp: 0,
  rgLabel: "",
  crossfade: { seconds: 0, onSkip: false, albums: false },

  async loadQueue() {
    try {
      const queue = await call(api.getQueue);
      set({ queue });
      // Show the saved track, ready to resume where it stopped.
      const entry = currentEntry(queue);
      if (entry && !get().track) {
        set({ track: entry.track, position: queue.positionMs / 1000 });
        loadWaveform(entry.track);
        mediaMetadata(entry.track);
      }
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  async play(source, start = 0, shuffle, shuffleScope) {
    await queueOp(() => call(api.setQueue, { body: { source, start, shuffle, shuffleScope } }));
    playCurrent(0, true);
  },

  toggle() {
    const s = get();
    if (!loaded[active]) {
      // Nothing loaded yet: resume the queue's current track where it was left.
      const entry = currentEntry(s.queue);
      if (entry) playCurrent(s.queue!.positionMs / 1000);
      return;
    }
    if (el().paused) {
      void el()
        .play()
        .catch((e: unknown) => set({ error: errorMessage(e) }));
    } else {
      endFade();
      el().pause();
      savePosition();
    }
  },

  async next() {
    await queueOp(() => call(api.advanceQueue, { body: { auto: false } }));
    playCurrent(0, true);
  },

  async previous() {
    // Like most players: restart the track unless we're at its very beginning.
    const t = get().track;
    if (t && get().position - trimStart(t) > 3) {
      get().seek(trimStart(t));
      return;
    }
    await queueOp(() => call(api.rewindQueue));
    playCurrent(0, true);
  },

  seek(seconds) {
    const l = loaded[active];
    if (!l) return;
    const target = Math.max(0, Math.min(seconds, length(l.track) - 0.5));
    if (l.seekable) {
      el().currentTime = target;
    } else {
      // A transcode restarts at the target.
      load(active, l.entryId, l.track, target, !el().paused);
    }
    set({ position: target });
  },

  async jump(entryId) {
    await queueOp(() => call(api.jumpInQueue, { body: { entryId } }));
    playCurrent(0, true);
  },

  async toggleShuffle() {
    const before = currentEntry(get().queue)?.entryId;
    const on = !get().queue?.shuffle;
    await queueOp(() => call(api.updateQueue, { body: { shuffle: on } }));
    // Nothing playing: the server picked a track to start.
    if (currentEntry(get().queue)?.entryId !== before) playCurrent(0);
  },

  async shuffleFrom() {
    const before = currentEntry(get().queue)?.entryId;
    // On again: the server redraws from the (new) scope around the playing track.
    await queueOp(() => call(api.updateQueue, { body: { shuffle: true } }));
    if (currentEntry(get().queue)?.entryId !== before) playCurrent(0);
  },

  async cycleRepeat() {
    const next = { off: "all", all: "one", one: "off" } as const;
    const repeat = next[get().queue?.repeat ?? "off"];
    await queueOp(() => call(api.updateQueue, { body: { repeat } }));
  },

  setVolume(v) {
    set({ volume: v });
    applyLevels();
    try {
      localStorage.setItem("hp-volume", String(v));
    } catch {
      // Not kept, then.
    }
  },

  setMode(mode) {
    set({ mode });
  },

  replaceTrack(track) {
    for (const l of loaded) if (l?.track.id === track.id) l.track = track;
    const { queue, track: current } = get();
    set({
      track: current?.id === track.id ? track : current,
      queue: queue && {
        ...queue,
        entries: queue.entries.map((e) => (e.track.id === track.id ? { ...e, track } : e)),
      },
    });
  },

  setPreferences(p) {
    set({
      mode: p.quality,
      rgMode: p.replayGain,
      preamp: p.replayGainPreamp,
      crossfade: { seconds: p.crossfade, onSkip: p.crossfadeOnSkip, albums: p.crossfadeAlbums },
    });
    applyLevels();
  },

  stop() {
    endFade();
    for (const e of elements) {
      e.pause();
      e.removeAttribute("src");
      e.load();
    }
    loaded[0] = loaded[1] = null;
    set({ playing: false, loading: false });
  },
}));

function readVolume(): number {
  try {
    const v = Number(localStorage.getItem("hp-volume"));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
  } catch {
    return 1;
  }
}

/** Runs a queue request and takes in the queue it returns. */
async function queueOp(op: () => Promise<QueueState>) {
  try {
    const queue = await op();
    usePlayer.setState({ queue, error: "" });
  } catch (e) {
    usePlayer.setState({ error: errorMessage(e) });
    throw e;
  }
}

/**
 * Plays the queue's current track from `start` seconds (0: from its trimmed start), or
 * stops. A `skip` (another track picked, next, previous) crossfades into it when that's
 * wanted and something is playing; otherwise the track replaces the one playing.
 */
function playCurrent(start: number, skip = false) {
  const entry = currentEntry(usePlayer.getState().queue);
  if (!entry) {
    usePlayer.getState().stop();
    return;
  }
  const from = start > 0 ? start : trimStart(entry.track);
  const { crossfade } = usePlayer.getState();
  const playing = loaded[active] !== null && !el().paused;
  if (skip && crossfade.onSkip && crossfade.seconds > 0 && playing && canFade()) {
    // The one playing fades out in its element while the new one fades in in the other.
    endFade();
    const old = active;
    active = 1 - active;
    load(active, entry.entryId, entry.track, from, true);
    startFade(old, crossfade.seconds);
    return;
  }
  endFade();
  // The spare element is the other one; whatever it preloaded is no longer next.
  loaded[1 - active] = null;
  spare().removeAttribute("src");
  load(active, entry.entryId, entry.track, from, true);
}

/** The element fading out (a crossfade), and when it's done. */
let fadingSlot: number | null = null;
let fadeTimer: ReturnType<typeof setTimeout> | undefined;

/** Fades element `old` out and the active one in, over `seconds`. */
function startFade(old: number, seconds: number) {
  const { volume } = usePlayer.getState();
  fade(elements[old]!, volume * gains[old]!.linear, "out", seconds);
  fade(el(), volume * gains[active]!.linear, "in", seconds);
  fadingSlot = old;
  fadeTimer = setTimeout(endFade, seconds * 1000);
}

/** Ends a crossfade: the old track stops, and both elements are at their own level. */
function endFade() {
  clearTimeout(fadeTimer);
  if (fadingSlot === null) return;
  const old = elements[fadingSlot]!;
  old.pause();
  old.removeAttribute("src");
  loaded[fadingSlot] = null;
  fadingSlot = null;
  for (const e of elements) stopFade(e);
  applyLevels();
}

/**
 * How long the playing track and the next one overlap when one follows the other, as in
 * the Rust player: no longer than half of either, not within an album playing in order
 * unless that's wanted, and not at all where elements can't be faded (iPhones).
 */
function autoCrossfade(current: Track, next: Track): number {
  const { crossfade, queue } = usePlayer.getState();
  if (crossfade.seconds === 0 || !canFade()) return 0;
  const albumInOrder = !queue?.shuffle && current.albumId === next.albumId;
  if (albumInOrder && !crossfade.albums) return 0;
  const playable = (t: Track) => (trimEnd(t) ?? length(t)) - trimStart(t);
  return Math.min(crossfade.seconds, playable(current) / 2, playable(next) / 2);
}

/** Loads `track` into element `slot` from `start` seconds, and plays it if `autoplay`. */
function load(slot: number, entryId: string, track: Track, start: number, autoplay: boolean) {
  const e = elements[slot]!;
  const mode = usePlayer.getState().mode;
  const stream = chooseStream(track, mode, start);
  loaded[slot] = {
    entryId,
    track,
    offset: stream.seekable ? 0 : start,
    seekable: stream.seekable,
    label: stream.label,
  };
  e.preload = "auto";
  e.src = stream.url;
  applyLevels();
  if (stream.seekable && start > 0) {
    e.addEventListener("loadedmetadata", () => (e.currentTime = start), { once: true });
  }
  if (slot === active) {
    advancing = false;
    begin(track.id, track.durationMs);
    usePlayer.setState({
      track,
      position: start,
      streamLabel: stream.label,
      loading: autoplay,
      error: "",
    });
    loadWaveform(track);
    mediaMetadata(track);
    if (autoplay) {
      e.play().catch((err: unknown) => {
        // Replaced by another load before it started: not a failure.
        if (err instanceof DOMException && err.name === "AbortError") return;
        usePlayer.setState({ loading: false, error: errorMessage(err) });
      });
    }
  }
}

/** Position of element `slot` in its track, in seconds. */
function positionOf(slot: number): number {
  const l = loaded[slot];
  return l ? l.offset + elements[slot]!.currentTime : 0;
}

let waveformFor = "";
function loadWaveform(track: Track) {
  if (waveformFor === track.id) return;
  waveformFor = track.id;
  usePlayer.setState({ waveform: null, silence: null });
  call(api.waveform, { params: { id: track.id } })
    .then((w) => {
      if (waveformFor === track.id) {
        usePlayer.setState({ waveform: w.points.map((p) => p / 100), silence: w.silence ?? null });
      }
    })
    .catch(() => {});
}

function savePosition() {
  const ms = Math.round(positionOf(active) * 1000);
  lastSaved = Date.now();
  call(api.updateQueue, { body: { positionMs: ms } }).catch(() => {});
}

/** Once the current track nears its end, loads the next one in the spare element. */
function maybePreload() {
  const { queue } = usePlayer.getState();
  const l = loaded[active];
  // The spare element is still playing the end of the last track.
  if (fadingSlot !== null) return;
  if (!queue || !l || queue.upNext === null) return;
  const next = queue.entries[queue.upNext];
  if (!next || loaded[1 - active]?.entryId === next.entryId) return;
  const end = trimEnd(l.track) ?? length(l.track);
  if (end - positionOf(active) > PRELOAD_BEFORE) return;
  load(1 - active, next.entryId, next.track, trimStart(next.track), false);
}

/**
 * The current track has ended (or reached its trimmed end), or is about to and the next
 * fades in over its last `overlap` seconds: on to the next.
 */
async function ended(overlap = 0) {
  if (advancing) return;
  advancing = true;
  const { queue } = usePlayer.getState();
  const next = queue && queue.upNext !== null ? queue.entries[queue.upNext] : undefined;
  const preloaded = loaded[1 - active];
  if (next && preloaded?.entryId === next.entryId) {
    // The next track is ready in the spare element: start it now, then tell the server.
    const old = active;
    active = 1 - active;
    if (overlap > 0) {
      startFade(old, overlap);
    } else {
      elements[old]!.pause();
      loaded[old] = null;
    }
    advancing = false;
    begin(preloaded.track.id, preloaded.track.durationMs);
    usePlayer.setState({
      track: preloaded.track,
      position: positionOf(active),
      streamLabel: preloaded.label,
      rgLabel: label(gains[active]!),
    });
    loadWaveform(preloaded.track);
    mediaMetadata(preloaded.track);
    void el().play();
    try {
      await queueOp(() => call(api.advanceQueue, { body: { auto: true } }));
    } catch {
      return;
    }
    // The server disagrees about what's next (the queue changed meanwhile).
    if (currentEntry(usePlayer.getState().queue)?.entryId !== preloaded.entryId) playCurrent(0);
    return;
  }
  try {
    await queueOp(() => call(api.advanceQueue, { body: { auto: true } }));
  } catch {
    advancing = false;
    return;
  }
  playCurrent(0);
}

/** The silent clip that unlocks an element (see below): its events aren't playback. */
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

// The elements' events: only the active element's count (the spare one is preloading),
// and only while it holds a track.
elements.forEach((e, slot) => {
  setLevel(e, readVolume(), 1);
  const isActive = () => slot === active && loaded[slot] !== null && e.src !== SILENCE;
  e.addEventListener("playing", () => isActive() && usePlayer.setState({ playing: true, loading: false }));
  e.addEventListener("pause", () => isActive() && usePlayer.setState({ playing: false }));
  e.addEventListener("waiting", () => isActive() && usePlayer.setState({ loading: true }));
  e.addEventListener("ended", () => isActive() && void ended());
  e.addEventListener("error", () => {
    if (!isActive() || !loaded[slot]) return;
    usePlayer.setState({
      loading: false,
      playing: false,
      error: t("Cannot play {}", loaded[slot].track.title),
    });
  });
  e.addEventListener("timeupdate", () => {
    if (!isActive()) return;
    const l = loaded[slot];
    if (!l) return;
    const position = positionOf(slot);
    usePlayer.setState({ position });
    follow(l.track.id, position, !e.paused);
    const end = trimEnd(l.track);
    if (end !== null && position >= end && !e.paused) {
      void ended();
      return;
    }
    maybePreload();
    // Crossfading into the next track: it starts that long before this one ends.
    const next = loaded[1 - active];
    if (next && fadingSlot === null && !e.paused) {
      const overlap = autoCrossfade(l.track, next.track);
      const left = (end ?? length(l.track)) - position;
      if (overlap > 0 && left <= overlap) {
        void ended(left);
        return;
      }
    }
    if (!e.paused && Date.now() - lastSaved > SAVE_EVERY) savePosition();
    mediaPosition(position, l.track);
  });
});

// Browsers only let audio start from a user's gesture; Safari requires it of each
// element. The first tap or key unlocks both, so later starts (after a request) play.
if (typeof document !== "undefined") {
  const unlock = () => {
    prepareOutput(elements);
    applyLevels();
    for (const e of elements) {
      if (e.src) continue;
      e.src = SILENCE;
      e.play()
        .then(() => e.pause())
        .catch(() => {})
        .finally(() => {
          if (e.src === SILENCE) e.removeAttribute("src");
        });
    }
    document.removeEventListener("pointerdown", unlock, true);
    document.removeEventListener("keydown", unlock, true);
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
}

// ------------------------------------------------------------- media session

function mediaMetadata(track: Track) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artistName,
    album: track.albumTitle,
    artwork: track.cover
      ? [256, 512].map((size) => ({
          src: artworkUrl(track.cover!.id, size),
          sizes: `${size}x${size}`,
          type: "image/jpeg",
        }))
      : [],
  });
}

function mediaPosition(position: number, track: Track) {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const duration = length(track);
  if (!(duration > 0)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(position, duration),
      playbackRate: 1,
    });
  } catch {
    // Some browsers reject states while metadata loads.
  }
}

if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
  const p = () => usePlayer.getState();
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => p().toggle()],
    ["pause", () => p().toggle()],
    ["nexttrack", () => void p().next()],
    ["previoustrack", () => void p().previous()],
    ["seekto", (d) => d.seekTime !== undefined && p().seek(d.seekTime)],
  ];
  for (const [action, handler] of handlers) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Not supported here.
    }
  }
}
