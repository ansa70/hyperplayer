// Where the audio elements' sound goes. Through a Web Audio gain stage where possible, so
// ReplayGain can boost as well as cut (an element's own volume stops at 1). Not on iPhones
// and iPads: they suspend Web Audio when the screen locks, which would stop playback, so
// there the element's volume does it, and boosts are left out.

const APPLE_MOBILE =
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

let context: AudioContext | null = null;
const stages = new Map<HTMLAudioElement, GainNode>();
/** Listens to what's played (both elements, after their gain), for the visualizer. */
let analyser: AnalyserNode | null = null;

/** Routes `elements` through gain stages; call from a user's gesture (browsers require it). */
export function prepareOutput(elements: HTMLAudioElement[]) {
  if (APPLE_MOBILE || typeof AudioContext === "undefined") return;
  try {
    context ??= new AudioContext();
    if (!analyser) {
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      // The visualizer smooths the levels itself, as the Rust player's does.
      analyser.smoothingTimeConstant = 0;
    }
    for (const e of elements) {
      if (stages.has(e)) continue;
      const gain = context.createGain();
      context.createMediaElementSource(e).connect(gain).connect(context.destination);
      gain.connect(analyser);
      stages.set(e, gain);
    }
    if (context.state === "suspended") void context.resume();
  } catch {
    // Without Web Audio the elements play directly, and ReplayGain only cuts.
  }
}

/** Sets an element's loudness: the user's volume times the ReplayGain factor. */
export function setLevel(e: HTMLAudioElement, volume: number, gain: number) {
  const stage = stages.get(e);
  if (stage) {
    e.volume = 1;
    stage.gain.value = volume * gain;
  } else {
    e.volume = Math.min(1, volume * gain);
  }
}

/** The analyser of what's played, once the gain stages exist. */
export function getAnalyser(): AnalyserNode | null {
  return analyser;
}

/** Whether boosts are possible here (a gain stage, not just the element's volume). */
export function canBoost(): boolean {
  return !APPLE_MOBILE && typeof AudioContext !== "undefined";
}
