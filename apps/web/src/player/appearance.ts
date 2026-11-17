// Colours that follow the music, as in the Rust player (apps/client/src/ui/appearance.rs):
// the window's background gradient and the accent, taken from the playing album's cover
// unless the user picked a colour; and the text colours, kept legible on whatever those make.

import { artworkUrl } from "../api.ts";
import { usePlayer } from "../stores/player.ts";
import { useSession } from "../stores/session.ts";
import {
  accent,
  background,
  extract,
  fromHex,
  legible,
  luminance,
  textColours,
  toHex,
  type Rgb,
} from "./palette.ts";

/** The accent before any cover or choice applies. */
const DEFAULT_ACCENT = fromHex("#1ed760")!;
const BG = fromHex("#0c0d10")!;
const BASE = { text: fromHex("#f2f3f5")!, muted: fromHex("#9097a3")!, faint: fromHex("#5c6370")! };
/** Covers are sampled at this size: plenty for a palette. */
const SAMPLE_PX = 64;
/** The accent marks things (the playing track, toggles, the seek bar) rather than carrying text. */
const ACCENT_CONTRAST = 3;
/** How long the background fades to new colours (theme.css). */
const CROSSFADE_MS = 900;

let palette: Rgb[] = [];
let paletteOf: string | null = null;
let textTimer: ReturnType<typeof setTimeout> | undefined;
let shownMuted = luminance(BASE.muted);

/** Samples a cover's colours (once per artwork). */
function sample(artworkId: string | null) {
  if (artworkId === paletteOf) return;
  paletteOf = artworkId;
  if (!artworkId) {
    palette = [];
    apply();
    return;
  }
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    if (paletteOf !== artworkId) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SAMPLE_PX;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return;
    g.drawImage(img, 0, 0, SAMPLE_PX, SAMPLE_PX);
    palette = extract(g.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data, 4);
    apply();
  };
  // Same origin, so the canvas can read it; the server sizes it down.
  img.src = artworkUrl(artworkId, SAMPLE_PX / (window.devicePixelRatio || 1));
}

/** Sets the gradient, accent and text colours from the palette and the preferences. */
function apply() {
  const prefs = useSession.getState().preferences;
  const coverBackground = prefs?.coverBackground ?? true;
  const choice = prefs?.accent ?? "cover";
  const tints: Rgb[] = coverBackground && palette.length > 0 ? background(palette) : [BG, BG, BG];
  // Text runs across the whole gradient: it has to read on its lightest part.
  const lightest = tints.reduce((a, b) => (luminance(b) > luminance(a) ? b : a), BG);
  const chosen =
    choice === "cover" ? (accent(palette) ?? DEFAULT_ACCENT) : (fromHex(choice) ?? DEFAULT_ACCENT);
  const root = document.documentElement.style;
  tints.forEach((t, i) => root.setProperty(`--tint-${"abc"[i]}`, toHex(t)));
  root.setProperty("--accent", toHex(legible(chosen, lightest, ACCENT_CONTRAST)));
  const text = textColours(BASE, lightest);
  const setText = () => {
    root.setProperty("--text", toHex(text.text));
    root.setProperty("--muted", toHex(text.muted));
    root.setProperty("--faint", toHex(text.faint));
    shownMuted = luminance(text.muted);
  };
  clearTimeout(textTimer);
  // Lighter text reads on the old colours too, so it changes at once; darker text waits
  // for the background to finish fading to the new, darker colours.
  if (luminance(text.muted) >= shownMuted) setText();
  else textTimer = setTimeout(setText, CROSSFADE_MS);
}

/** Follows the playing track's cover and the account's appearance preferences. */
export function followAppearance() {
  usePlayer.subscribe((s, prev) => {
    if (s.track?.cover?.id !== prev.track?.cover?.id || (s.track === null) !== (prev.track === null)) {
      sample(s.track?.cover?.id ?? null);
    }
  });
  useSession.subscribe((s, prev) => {
    const [a, b] = [s.preferences, prev.preferences];
    if (a?.accent !== b?.accent || a?.coverBackground !== b?.coverBackground) apply();
  });
  sample(usePlayer.getState().track?.cover?.id ?? null);
  apply();
}
