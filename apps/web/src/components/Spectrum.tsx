import { useEffect, useRef } from "react";
import { getAnalyser } from "../player/output.ts";
import { usePlayer } from "../stores/player.ts";
import { useSession } from "../stores/session.ts";
import { useRadio } from "../stores/radio.ts";

// As the Rust player's (apps/client/src/spectrum.rs): 28 bands spaced evenly in pitch
// from 40 Hz to 16 kHz, each its loudest bin, from −75 to −15 dB, quick to rise and
// slow to fall.
const BANDS = 28;
const LOW_HZ = 40;
const HIGH_HZ = 16_000;
const FLOOR_DB = -75;
const TOP_DB = -15;

/** The live spectrum under the cover; nothing where the browser's audio isn't routed through Web Audio. */
export function Spectrum({ height = 44 }: { height?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const trackPlaying = usePlayer((s) => s.playing);
  const radioPlaying = useRadio((s) => s.playing);
  const playing = trackPlaying || radioPlaying;
  const enabled = useSession((s) => s.preferences?.visualizer ?? true);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !enabled) return;
    const levels = new Float32Array(BANDS);
    let bins: Float32Array<ArrayBuffer> | null = null;
    let frame = 0;
    let idle = 0;
    const draw = () => {
      const analyser = getAnalyser();
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      if (c.width !== Math.round(w * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(height * dpr);
      }
      if (analyser && playing) {
        bins ??= new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(bins);
        const rate = analyser.context.sampleRate;
        const binHz = rate / analyser.fftSize;
        const top = Math.min(HIGH_HZ, rate / 2);
        for (let b = 0; b < BANDS; b++) {
          const lo = LOW_HZ * Math.pow(top / LOW_HZ, b / BANDS);
          const hi = LOW_HZ * Math.pow(top / LOW_HZ, (b + 1) / BANDS);
          const first = Math.floor(lo / binHz);
          const last = Math.min(Math.max(Math.floor(hi / binHz), first + 1), bins.length);
          let db = -Infinity;
          for (let k = first; k < last; k++) db = Math.max(db, bins[k]!);
          const target = Math.min(1, Math.max(0, (db - FLOOR_DB) / (TOP_DB - FLOOR_DB)));
          const level = levels[b]!;
          levels[b] = target > level ? level + (target - level) * 0.6 : level * 0.85 + target * 0.15;
        }
        idle = 0;
      } else {
        for (let b = 0; b < BANDS; b++) levels[b]! *= 0.8;
        idle++;
      }
      const g = c.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, height);
      const accent = getComputedStyle(c).getPropertyValue("--accent").trim() || "#1ed760";
      const gradient = g.createLinearGradient(0, height, 0, 0);
      gradient.addColorStop(0, `color-mix(in srgb, ${accent} 55%, transparent)`);
      gradient.addColorStop(1, accent);
      g.fillStyle = gradient;
      const step = w / BANDS;
      levels.forEach((level, i) => {
        const h = Math.max(2, level * height);
        g.beginPath();
        g.roundRect(i * step + step * 0.15, height - h, step * 0.7, h, 2);
        g.fill();
      });
      // At rest once the bars have settled: nothing to redraw until playback resumes.
      if (playing || idle < 40) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [enabled, playing, height]);

  if (!enabled) return null;
  return <canvas ref={canvas} className="spectrum" style={{ height }} aria-hidden />;
}
