import type { SmartRule, SmartRules } from "@hyperplayer/schemas";
import { TRACK_GENRES } from "../catalog/genres.ts";
import type { Db } from "../db.ts";
import { HttpError } from "../http/contract.ts";

type Row = Record<string, unknown>;

/** A piece of WHERE clause and the values bound to its `?`s. */
interface Sql {
  sql: string;
  args: (string | number)[];
}

const TEXT_OPS = ["contains", "notContains", "is", "isNot", "startsWith"];
const NUMBER_OPS = ["is", "isNot", "lessThan", "greaterThan", "between"];
const DATE_OPS = ["inLast", "notInLast"];

/** The operators each field takes. */
const OPS: Record<SmartRule["field"], string[]> = {
  title: TEXT_OPS,
  artist: TEXT_OPS,
  album: TEXT_OPS,
  genre: TEXT_OPS,
  format: TEXT_OPS,
  year: NUMBER_OPS,
  duration: NUMBER_OPS,
  sampleRate: NUMBER_OPS,
  plays: NUMBER_OPS,
  lossless: ["is"],
  lastPlayed: [...DATE_OPS, "never"],
  added: DATE_OPS,
};

/** Text columns; `artist` is the track's or the album's artist. */
const TEXT: Partial<Record<SmartRule["field"], string[]>> = {
  title: ["t.title"],
  artist: ["ar.name", "aa.name"],
  album: ["al.title"],
  format: ["t.codec"],
};

/** Numbers, in the units rules use. */
const NUMBER: Partial<Record<SmartRule["field"], string>> = {
  year: "t.year",
  duration: "t.duration_ms / 1000.0",
  sampleRate: "t.sample_rate / 1000.0",
  plays: "coalesce(h.plays, 0)",
};

const ORDER: Record<SmartRules["order"], string> = {
  random: "random()",
  title: "t.title COLLATE NOCASE",
  artist: "ar.sort_name COLLATE NOCASE",
  album: "al.title COLLATE NOCASE",
  year: "t.year",
  added: "al.added_at",
  plays: "coalesce(h.plays, 0)",
  lastPlayed: "h.last",
};

const invalid = (message: string) => new HttpError(400, "invalid_rule", message);
const like = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Throws on a rule whose operator doesn't suit its field. */
export function checkRules(rules: SmartRules) {
  for (const r of rules.rules) {
    if (!OPS[r.field].includes(r.op)) throw invalid(`"${r.op}" doesn't apply to ${r.field}`);
    if (r.value.trim()) condition(r, 0); // parses the value
  }
}

/** A number as a rule writes it: plain, or m:ss for a duration. */
function number(rule: SmartRule, text: string): number {
  const t = text.trim();
  const clock = /^(\d+):([0-5]\d)$/.exec(t);
  const n = rule.field === "duration" && clock ? Number(clock[1]) * 60 + Number(clock[2]) : Number(t);
  if (!t || !Number.isFinite(n)) throw invalid(`"${text}" isn't a number (${rule.field})`);
  return n;
}

function condition(r: SmartRule, now: number): Sql {
  const v = r.value.trim();
  const text = TEXT[r.field];
  if (text) {
    const one = (column: string): Sql => {
      switch (r.op) {
        case "is":
        case "isNot":
          return { sql: `${column} = ? COLLATE NOCASE`, args: [v] };
        case "startsWith":
          return { sql: `${column} LIKE ? ESCAPE '\\'`, args: [`${like(v)}%`] };
        default:
          return { sql: `${column} LIKE ? ESCAPE '\\'`, args: [`%${like(v)}%`] };
      }
    };
    const any = text.map(one);
    const sql = `(${any.map((c) => c.sql).join(" OR ")})`;
    const negated = r.op === "isNot" || r.op === "notContains";
    return { sql: negated ? `NOT ${sql}` : sql, args: any.flatMap((c) => c.args) };
  }
  if (r.field === "genre") {
    const match =
      r.op === "is" || r.op === "isNot"
        ? { sql: "value = ? COLLATE NOCASE", arg: v }
        : { sql: "value LIKE ? ESCAPE '\\'", arg: r.op === "startsWith" ? `${like(v)}%` : `%${like(v)}%` };
    const exists = `EXISTS (SELECT 1 FROM json_each(${TRACK_GENRES}) WHERE ${match.sql})`;
    const negated = r.op === "isNot" || r.op === "notContains";
    return { sql: negated ? `NOT ${exists}` : exists, args: [match.arg] };
  }
  const column = NUMBER[r.field];
  if (column) {
    const a = number(r, v);
    switch (r.op) {
      case "is":
        return { sql: `${column} = ?`, args: [a] };
      case "isNot":
        return { sql: `(${column} IS NULL OR ${column} <> ?)`, args: [a] };
      case "lessThan":
        return { sql: `${column} < ?`, args: [a] };
      case "greaterThan":
        return { sql: `${column} > ?`, args: [a] };
      default: {
        const b = number(r, r.value2 || v);
        return { sql: `${column} BETWEEN ? AND ?`, args: [Math.min(a, b), Math.max(a, b)] };
      }
    }
  }
  if (r.field === "lossless") {
    const yes = ["yes", "true", "1"].includes(v.toLowerCase());
    if (!yes && !["no", "false", "0"].includes(v.toLowerCase())) throw invalid(`lossless is "yes" or "no"`);
    return { sql: "t.lossless = ?", args: [yes ? 1 : 0] };
  }
  // Dates: lastPlayed (from this user's listens) or added (when the album first appeared).
  const date = r.field === "lastPlayed" ? "h.last" : "al.added_at";
  if (r.op === "never") return { sql: "h.last IS NULL", args: [] };
  const days = number(r, v);
  const since = new Date(now - days * 86_400_000).toISOString();
  return r.op === "inLast"
    ? { sql: `${date} >= ?`, args: [since] }
    : { sql: `(${date} IS NULL OR ${date} < ?)`, args: [since] };
}

/**
 * The tracks matching `rules` for `userId` (whose listens count for plays and last played),
 * in the rules' order, up to their limit; and how many match in all.
 */
export function smartTracks(
  db: Db,
  userId: string,
  rules: SmartRules,
): { trackIds: string[]; matching: number } {
  const now = Date.now();
  // A rule still being written (no value yet) doesn't count.
  const active = rules.rules.filter((r) => r.op === "never" || r.value.trim());
  const conditions = active.map((r) => condition(r, now));
  const where = conditions.length
    ? conditions.map((c) => c.sql).join(rules.match === "all" ? " AND " : " OR ")
    : "1";
  const args = conditions.flatMap((c) => c.args);
  const from = `FROM tracks t
    JOIN artists ar ON ar.id = t.artist_id
    JOIN albums al ON al.id = t.album_id
    JOIN artists aa ON aa.id = al.artist_id
    LEFT JOIN (SELECT track_id, count(*) AS plays, max(started_at) AS last FROM listens
               WHERE user_id = ? GROUP BY track_id) h ON h.track_id = t.id
    WHERE ${where}`;
  const matching = Number((db.prepare(`SELECT count(*) AS n ${from}`).get(userId, ...args) as Row).n);
  // Ties keep albums in order; missing values (no year, never played) go last either way.
  const key = ORDER[rules.order];
  const order =
    rules.order === "random"
      ? key
      : `${key} IS NULL, ${key} ${rules.descending ? "DESC" : "ASC"}, al.title COLLATE NOCASE, t.disc_number, t.track_number`;
  const trackIds = (
    db.prepare(`SELECT t.id ${from} ORDER BY ${order} LIMIT ?`).all(userId, ...args, rules.limit) as Row[]
  ).map((r) => String(r.id));
  return { trackIds, matching };
}
