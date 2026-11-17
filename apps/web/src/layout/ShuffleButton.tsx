import type { ShuffleScope } from "@hyperplayer/schemas";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { usePlayer } from "../stores/player.ts";
import { useSession } from "../stores/session.ts";
import "../components/menu.css";

const SCOPES: { key: ShuffleScope; label: string }[] = [
  { key: "library", label: "Whole library" },
  { key: "album", label: "This album" },
  { key: "artist", label: "This artist" },
  { key: "genre", label: "This genre" },
  { key: "playlist", label: "This playlist" },
];

/** While shuffling, what from ("Album: Kind of Blue"), as the Rust player shows it. */
function shuffleLabel(scope: ShuffleScope | null, name: string): string {
  switch (scope) {
    case null:
      return "";
    case "library":
      return "Whole library";
    default:
      return `${scope[0]!.toUpperCase()}${scope.slice(1)}: ${name}`;
  }
}

/**
 * The shuffle button: a click turns shuffle on or off; a right-click (a long press on
 * Android) or the caption opens the "Shuffle from" menu, which saves the scope and
 * shuffles from it.
 */
export function ShuffleButton({ large }: { large?: boolean }) {
  const { queue, toggleShuffle, shuffleFrom } = usePlayer();
  const { preferences, updatePreferences } = useSession();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const scope = preferences?.shuffleScope ?? "library";
  const on = queue?.shuffle ?? false;

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const pick = async (s: ShuffleScope) => {
    setOpen(false);
    await updatePreferences({ shuffleScope: s });
    await shuffleFrom();
  };
  const caption = on
    ? shuffleLabel(queue?.shuffleScope ?? null, queue?.origin?.name ?? "")
    : hover
      ? `Shuffle from: ${SCOPES.find((s) => s.key === scope)?.label ?? ""}`
      : "";

  return (
    <div
      className="shuffle"
      ref={ref}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {caption && (
        <button className={`shuffle-caption ellipsis ${on ? "on" : ""}`} onClick={() => setOpen(!open)}>
          {caption}
        </button>
      )}
      <button
        className={`icon-button ${on ? "active" : ""}`}
        title="Shuffle (right-click to choose what from)"
        onClick={() => void toggleShuffle()}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
      >
        <Icon name="shuffle" size={large ? 22 : 18} />
      </button>
      {open && (
        <div className="menu shuffle-menu" role="menu">
          <div className="caps menu-heading">Shuffle from</div>
          {SCOPES.map((s) => (
            <button
              key={s.key}
              role="menuitemradio"
              aria-checked={s.key === scope}
              className={`menu-item ${s.key === scope ? "checked" : ""}`}
              onClick={() => void pick(s.key)}
            >
              {s.label}
              {s.key === scope && <span>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
