// Internet radio, as in the Rust player: a station plays outside the queue. Starting one
// pauses the queue where it is; "back to the queue" plays it on from there, and playing
// any track leaves the radio. The server relays the station (any format, any address);
// pausing hangs up, since live radio doesn't wait, and playing connects again.

import type { RadioStation } from "@hyperplayer/schemas";
import { create } from "zustand";
import { api, call, errorMessage, url } from "../api.ts";
import { t } from "../i18n.ts";
import { radioElement, radioHooks } from "../player/radioElement.ts";
import { restoreMediaMetadata, usePlayer } from "./player.ts";

/** How often the song a station plays is asked for; the first time sooner. */
const POLL_EVERY = 15_000;
const FIRST_POLL = 3_000;
/** A station that stops is connected again this many times in a row before giving up. */
const RECONNECTS = 3;
/** Playing this long counts as working again (the next stop starts counting afresh). */
const HEALTHY = 60_000;

interface RadioState {
  /** The station that's the current thing (playing, or paused). */
  live: RadioStation | null;
  /** The song it says is playing. */
  title: string | null;
  playing: boolean;
  loading: boolean;
  /** When it started playing (ms), for the time listened. */
  since: number;
  error: string;
  favourites: RadioStation[];

  play: (station: RadioStation) => void;
  toggle: () => void;
  /** Stops the station; the queue's track shows again. */
  leave: () => void;
  backToQueue: () => void;
  loadFavourites: () => Promise<void>;
  setFavourite: (station: RadioStation, on: boolean) => Promise<void>;
}

let wanted = false;
let failures = 0;
let playingSince = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** The station's stream: MP3 and AAC as it sends them, else MP3 from the server (Data Saver: 96k always). */
function streamUrl(station: RadioStation): string {
  const saver = usePlayer.getState().mode === "data-saver";
  return url(
    api.radioStream.path,
    { id: station.id },
    { direct: saver ? "" : "mp3,aac", format: "mp3", bitrate: saver ? 96 : 192 },
  );
}

export function logoUrl(station: RadioStation, size: number): string {
  const px = Math.min(512, Math.ceil((size * (window.devicePixelRatio || 1)) / 32) * 32);
  return url(api.radioLogo.path, { id: station.id }, { size: px });
}

function connect() {
  const station = useRadio.getState().live;
  const e = radioElement;
  if (!station || !e) return;
  wanted = true;
  clearTimeout(retryTimer);
  useRadio.setState({ loading: true, error: "" });
  e.src = streamUrl(station);
  e.play().catch((err: unknown) => {
    if (err instanceof DOMException && err.name === "AbortError") return;
    useRadio.setState({ loading: false, playing: false, error: errorMessage(err) });
  });
  schedulePoll(FIRST_POLL);
}

function hangUp() {
  wanted = false;
  clearTimeout(retryTimer);
  clearTimeout(pollTimer);
  const e = radioElement;
  if (!e) return;
  e.pause();
  e.removeAttribute("src");
  e.load();
}

/** The stream stopped or failed while wanted: connect again, a little later each time. */
function dropped() {
  if (!wanted) return;
  if (playingSince && Date.now() - playingSince > HEALTHY) failures = 0;
  failures++;
  playingSince = 0;
  const station = useRadio.getState().live;
  if (!station || failures > RECONNECTS) {
    hangUp();
    useRadio.setState({
      playing: false,
      loading: false,
      error: station ? t("{} stopped sending audio.", station.name) : "",
    });
    return;
  }
  useRadio.setState({ loading: true });
  retryTimer = setTimeout(connect, failures * 1000);
}

function schedulePoll(after: number) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    const station = useRadio.getState().live;
    if (!station || !wanted) return;
    call(api.radioNowPlaying, { params: { id: station.id } })
      .then((np) => {
        if (useRadio.getState().live?.id !== station.id) return;
        if (np.title !== useRadio.getState().title) {
          useRadio.setState({ title: np.title });
          mediaMetadata();
        }
      })
      .catch(() => {})
      .finally(() => schedulePoll(POLL_EVERY));
  }, after);
}

function mediaMetadata() {
  const { live, title } = useRadio.getState();
  if (!live || !("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: title ?? live.name,
    artist: live.name,
    artwork: live.hasLogo
      ? [256, 512].map((size) => ({
          src: logoUrl(live, size / 2),
          sizes: `${size}x${size}`,
          type: "image/webp",
        }))
      : [],
  });
  try {
    // Live: no length, no position.
    navigator.mediaSession.setPositionState?.();
  } catch {
    // Not supported here.
  }
}

export const useRadio = create<RadioState>()((set, get) => ({
  live: null,
  title: null,
  playing: false,
  loading: false,
  since: 0,
  error: "",
  favourites: [],

  play(station) {
    const player = usePlayer.getState();
    // The queue's track pauses where it is (and its position is saved).
    if (player.playing) player.toggle();
    hangUp();
    failures = 0;
    set({ live: station, title: null, since: Date.now(), playing: false, error: "" });
    mediaMetadata();
    connect();
  },

  toggle() {
    const { live, playing, loading } = get();
    if (!live) return;
    if (playing || loading) {
      hangUp();
      set({ playing: false, loading: false });
    } else {
      failures = 0;
      set({ since: Date.now() });
      connect();
    }
  },

  leave() {
    if (!get().live) return;
    hangUp();
    set({ live: null, title: null, playing: false, loading: false, error: "" });
    restoreMediaMetadata();
  },

  backToQueue() {
    get().leave();
    const player = usePlayer.getState();
    if (player.track) player.toggle();
  },

  async loadFavourites() {
    try {
      const list = await call(api.listRadioFavourites);
      set({ favourites: list.items });
      const live = get().live;
      if (live) set({ live: { ...live, favourite: list.items.some((s) => s.id === live.id) } });
    } catch {
      // Shown as none.
    }
  },

  async setFavourite(station, on) {
    if (on) await call(api.addRadioFavourite, { params: { id: station.id } });
    else await call(api.removeRadioFavourite, { params: { id: station.id } });
    await get().loadFavourites();
  },
}));

radioHooks.live = () => useRadio.getState().live !== null;
radioHooks.toggle = () => useRadio.getState().toggle();

// A track starting to play leaves the radio.
usePlayer.subscribe((s, prev) => {
  if (s.playing && !prev.playing && useRadio.getState().live) useRadio.getState().leave();
});

if (radioElement) {
  const e = radioElement;
  const ours = () => wanted && e.getAttribute("src") !== null;
  e.addEventListener("playing", () => {
    if (!ours()) return;
    playingSince = Date.now();
    useRadio.setState({ playing: true, loading: false, error: "" });
  });
  e.addEventListener("waiting", () => ours() && useRadio.setState({ loading: true }));
  e.addEventListener("pause", () => ours() && useRadio.setState({ playing: false }));
  e.addEventListener("ended", () => ours() && dropped());
  e.addEventListener("error", () => ours() && dropped());
}
