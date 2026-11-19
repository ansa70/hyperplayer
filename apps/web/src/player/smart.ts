// Smart playlists, as the Rust player edits them (apps/client/src/ui/smart.rs).

import type { SmartRule, SmartRules } from "@hyperplayer/schemas";
import { msg, t } from "../i18n.ts";

type Field = SmartRule["field"];
type Op = SmartRule["op"];
type Order = SmartRules["order"];

export const FIELDS: { key: Field; label: string }[] = [
  { key: "title", label: msg("Title") },
  { key: "artist", label: msg("Artist") },
  { key: "album", label: msg("Album") },
  { key: "genre", label: msg("Genre") },
  { key: "format", label: msg("Format") },
  { key: "year", label: msg("Year") },
  { key: "duration", label: msg("Duration") },
  { key: "sampleRate", label: msg("Sample rate") },
  { key: "plays", label: msg("Plays") },
  { key: "lossless", label: msg("Lossless") },
  { key: "lastPlayed", label: msg("Last played") },
  { key: "added", label: msg("Added") },
];

export const ORDERS: { key: Order; label: string }[] = [
  { key: "random", label: msg("Random") },
  { key: "title", label: msg("Title") },
  { key: "artist", label: msg("Artist") },
  { key: "album", label: msg("Album") },
  { key: "year", label: msg("Year") },
  { key: "added", label: msg("Recently added") },
  { key: "plays", label: msg("Plays") },
  { key: "lastPlayed", label: msg("Last played") },
];

/** The server's cap on a smart playlist's length. */
export const MAX_LIMIT = 500;

/** The operators a field takes (as the server checks them). */
export function ops(field: Field): Op[] {
  switch (field) {
    case "title":
    case "artist":
    case "album":
    case "genre":
    case "format":
      return ["contains", "notContains", "is", "isNot", "startsWith"];
    case "year":
    case "duration":
    case "sampleRate":
    case "plays":
      return ["is", "isNot", "lessThan", "greaterThan", "between"];
    case "lossless":
      return ["is"];
    case "lastPlayed":
      return ["inLast", "notInLast", "never"];
    case "added":
      return ["inLast", "notInLast"];
  }
}

/** How an operator reads after its field ("Year before", "Duration longer than"). */
export function opLabel(field: Field, op: Op): string {
  if (field === "year" && op === "lessThan") return t("before");
  if (field === "year" && op === "greaterThan") return t("after");
  if (field === "duration" && op === "lessThan") return t("shorter than");
  if (field === "duration" && op === "greaterThan") return t("longer than");
  const labels: Record<Op, string> = {
    contains: t("contains"),
    notContains: t("doesn't contain"),
    is: t("is"),
    isNot: t("is not"),
    startsWith: t("starts with"),
    lessThan: t("less than"),
    greaterThan: t("more than"),
    between: t("between"),
    inLast: t("in the last"),
    notInLast: t("not in the last"),
    never: t("never"),
  };
  return labels[op];
}

/** What to type for a field's value. */
export function hint(field: Field): string {
  const hints: Record<Field, string> = {
    title: t("name"),
    artist: t("name"),
    album: t("name"),
    genre: t("genre, e.g. Jazz"),
    format: t("e.g. FLAC"),
    year: t("e.g. 1975"),
    duration: t("seconds or m:ss"),
    sampleRate: t("kHz, e.g. 96"),
    plays: t("times"),
    lossless: t("yes or no"),
    lastPlayed: t("days"),
    added: t("days"),
  };
  return hints[field];
}

export const rule = (field: Field, op: Op): SmartRule => ({ field, op, value: "", value2: "" });

const rules = (list: SmartRule[], order: Order, limit: number): SmartRules => ({
  match: "all",
  rules: list,
  order,
  descending: false,
  limit,
});

/** The sidebar's "+" templates: created, then opened to be filled in. */
export const TEMPLATES: { key: string; label: string; name: string; rules: SmartRules }[] = [
  { key: "random", label: msg("Random tracks"), name: msg("Random mix"), rules: rules([], "random", 50) },
  {
    key: "artist",
    label: msg("From an artist"),
    name: msg("Artist mix"),
    rules: rules([rule("artist", "is")], "random", 100),
  },
  {
    key: "albums",
    label: msg("From albums"),
    name: msg("Album mix"),
    rules: rules([rule("album", "contains")], "album", 100),
  },
  {
    key: "genre",
    label: msg("By genre"),
    name: msg("Genre mix"),
    rules: rules([rule("genre", "is")], "random", 100),
  },
  {
    key: "custom",
    label: msg("Custom rules"),
    name: msg("Smart playlist"),
    rules: rules([rule("title", "contains")], "random", 100),
  },
];

/** `base`, or `base 2`, `base 3`… so it doesn't clash with a playlist already there. */
export function freshName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}
