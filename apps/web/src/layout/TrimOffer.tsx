import { useState } from "react";
import { errorMessage } from "../api.ts";
import { saveTrim, suggest } from "../player/trim.ts";
import { useLibrary } from "../stores/library.ts";
import { usePlayer } from "../stores/player.ts";
import { useSession } from "../stores/session.ts";

/** Tracks whose offer was put off ("Not now") while this page is open. */
const putOff = new Set<string>();

/** Offers admins to skip a long silence found in the playing track, as the Rust player does. */
export function TrimOffer() {
  const { track, silence } = usePlayer();
  const admin = useSession((s) => s.user?.admin ?? false);
  const notify = useLibrary((s) => s.notify);
  const [, rerender] = useState(0);
  if (!admin || !track || !silence || track.trim !== null || putOff.has(track.id)) return null;
  const offer = suggest(track.durationMs, silence);
  if (!offer) return null;
  const decide = (trim: Parameters<typeof saveTrim>[1]) =>
    saveTrim(track, trim).catch((e: unknown) => notify(errorMessage(e)));
  return (
    <div className="trim-offer">
      <strong>Skip the silence?</strong>
      <p className="muted">{offer.text}</p>
      <div className="trim-offer-buttons">
        <button className="outline-button" onClick={() => void decide({ startMs: null, endMs: null })}>
          Never for this track
        </button>
        <button
          className="outline-button"
          onClick={() => {
            putOff.add(track.id);
            rerender((n) => n + 1);
          }}
        >
          Not now
        </button>
        <button className="outline-button" onClick={() => void decide(offer.trim)}>
          Skip it
        </button>
      </div>
    </div>
  );
}
