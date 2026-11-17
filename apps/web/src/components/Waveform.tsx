import { useEffect, useRef, useState } from "react";
import "./components.css";

/**
 * The seek bar drawn as the track's waveform, like the Rust player's: the played part
 * in the accent colour, the parts trimmed off faded. Click or drag to seek.
 */
export function Waveform({
  points,
  position,
  duration,
  trimStart,
  trimEnd,
  onSeek,
}: {
  points: number[] | null;
  position: number;
  duration: number;
  trimStart: number;
  trimEnd: number | null;
  onSeek: (seconds: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setWidth(c.clientWidth));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const height = c.clientHeight;
    c.width = width * dpr;
    c.height = height * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const style = getComputedStyle(c);
    const accent = style.getPropertyValue("--accent").trim() || "#1ed760";
    const muted = style.getPropertyValue("--muted").trim() || "#9097a3";
    const faint = style.getPropertyValue("--faint").trim() || "#5c6370";
    const bars = points && points.length > 0 ? points : Array.from({ length: 160 }, () => 0.06);
    const step = width / bars.length;
    const shown = duration > 0 ? (drag ?? position) / duration : 0;
    const hoverAt = hover !== null && duration > 0 ? hover / duration : -1;
    const start = duration > 0 ? trimStart / duration : 0;
    const end = duration > 0 && trimEnd !== null ? trimEnd / duration : 1;
    bars.forEach((p, i) => {
      const at = (i + 0.5) / bars.length;
      const h = Math.max(2, p * height);
      g.globalAlpha = at < start || at > end ? 0.3 : 1;
      g.fillStyle = at <= shown ? accent : at <= hoverAt ? muted : faint;
      g.fillRect(i * step, (height - h) / 2, Math.max(1, step * 0.62), h);
    });
    g.globalAlpha = 1;
  }, [points, position, duration, trimStart, trimEnd, hover, drag, width]);

  const timeAt = (clientX: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
  };

  return (
    <canvas
      ref={canvas}
      className="waveform"
      onPointerMove={(e) => {
        setHover(timeAt(e.clientX));
        if (drag !== null) setDrag(timeAt(e.clientX));
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(timeAt(e.clientX));
      }}
      onPointerUp={(e) => {
        if (drag !== null) onSeek(timeAt(e.clientX));
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    />
  );
}
