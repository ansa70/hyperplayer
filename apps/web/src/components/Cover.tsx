import type { Artwork } from "@hyperplayer/schemas";
import { artworkUrl } from "../api.ts";
import "./components.css";

/** A cover (or artist image), square, with the cover's colour while it loads. */
export function Cover({
  art,
  size,
  round,
  className,
}: {
  art: Artwork | null | undefined;
  size: number;
  round?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`cover ${round ? "round" : ""} ${className ?? ""}`}
      style={{ width: size, height: size, background: art?.dominantColor ?? undefined }}
    >
      {art && <img src={artworkUrl(art.id, size)} alt="" loading="lazy" draggable={false} />}
    </div>
  );
}
