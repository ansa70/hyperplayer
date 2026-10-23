import type { CreditCategory } from "@hyperplayer/schemas";
import type { IAudioMetadata } from "music-metadata";

export interface CreditRow {
  name: string;
  role: string;
  category: CreditCategory;
  musicbrainzId: string | null;
}

/** music-metadata's normalised credit fields → (role, category). */
const COMMON_ROLES = [
  ["composer", "composer", "composition"],
  ["lyricist", "lyricist", "composition"],
  ["writer", "writer", "composition"],
  ["arranger", "arranger", "composition"],
  ["conductor", "conductor", "performance"],
  ["producer", "producer", "production"],
  ["remixer", "remixer", "production"],
  ["engineer", "engineer", "engineering"],
  ["mixer", "mix", "engineering"],
  ["djmixer", "DJ mix", "engineering"],
] as const satisfies readonly (readonly [keyof IAudioMetadata["common"], string, CreditCategory])[];

/** `Bill Evans (piano)` → name + instrument, as written by Picard into Vorbis PERFORMER tags. */
export function parsePerformer(value: string): { name: string; role: string } | null {
  const m = value.trim().match(/^(.*?)\s*\(([^()]+)\)$/);
  if (m?.[1]) return { name: m[1].trim(), role: m[2]!.trim() };
  return value.trim() ? { name: value.trim(), role: "performer" } : null;
}

/** ID3 TMCL/IPLS: alternating `role, name` pairs. */
function involvedPeople(value: unknown): { name: string; role: string }[] {
  const flat = (Array.isArray(value) ? value.flat() : [value]).filter(
    (v): v is string => typeof v === "string",
  );
  const out: { name: string; role: string }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (flat[i]!.trim() && flat[i + 1]!.trim())
      out.push({ role: flat[i]!.trim(), name: flat[i + 1]!.trim() });
  }
  return out;
}

/** Extracts every credit the file's tags carry. */
export function creditsFromTags(meta: IAudioMetadata): CreditRow[] {
  const rows: CreditRow[] = [];
  const add = (name: string, role: string, category: CreditCategory) =>
    rows.push({ name, role, category, musicbrainzId: null });

  for (const tags of Object.values(meta.native)) {
    for (const tag of tags) {
      const id = tag.id.toUpperCase();
      if (id === "PERFORMER" && typeof tag.value === "string") {
        const p = parsePerformer(tag.value);
        if (p) add(p.name, p.role, "performance");
      } else if (id === "TMCL" || id === "IPLS") {
        for (const p of involvedPeople(tag.value)) add(p.name, p.role, "performance");
      }
    }
  }
  for (const [field, role, category] of COMMON_ROLES) {
    for (const name of meta.common[field] ?? []) if (name.trim()) add(name.trim(), role, category);
  }

  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.name.toLowerCase()}\u0000${r.role.toLowerCase()}`;
    return !seen.has(key) && (seen.add(key), true);
  });
}
