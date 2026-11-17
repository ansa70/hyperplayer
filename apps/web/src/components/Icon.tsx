import { icons, type IconName } from "./icons.ts";

/** Icons that read better filled than outlined, as in the Rust player. */
const FILLED: ReadonlySet<IconName> = new Set(["play", "pause", "previous", "next"]);

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={icons[name]} />
    </svg>
  );
}
