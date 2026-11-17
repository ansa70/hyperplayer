import type { Artwork } from "@hyperplayer/schemas";
import { artworkUrl } from "../api.ts";
import "./components.css";

/** A playlist's cover: up to four album covers in a grid, or one. */
export function Mosaic({ covers, size }: { covers: Artwork[]; size: number }) {
  if (covers.length < 4) {
    const one = covers[0];
    return (
      <div
        className="cover"
        style={{ width: size, height: size, background: one?.dominantColor ?? undefined }}
      >
        {one && <img src={artworkUrl(one.id, size)} alt="" loading="lazy" />}
      </div>
    );
  }
  return (
    <div className="cover mosaic" style={{ width: size, height: size }}>
      {covers.slice(0, 4).map((c) => (
        <img key={c.id} src={artworkUrl(c.id, size / 2)} alt="" loading="lazy" />
      ))}
    </div>
  );
}
