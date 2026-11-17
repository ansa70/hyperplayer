import "./components.css";

/** A row of buttons picking one option, like the Rust player's segmented controls. */
export function Segmented({
  value,
  options,
  onPick,
}: {
  value: string;
  options: { key: string; label: string }[];
  onPick: (key: string) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.key}
          role="radio"
          aria-checked={o.key === value}
          className={o.key === value ? "on" : ""}
          onClick={() => onPick(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
