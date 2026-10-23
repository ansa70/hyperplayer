import type { CreditCategory } from "@hyperplayer/schemas";
import type { CreditRow } from "../library/tagCredits.ts";
import {
  recordingArtistRelations,
  recordingWorkRelations,
  workArtistRelations,
  type ArtistRelation,
  type Release,
} from "./musicbrainz.ts";

/** MusicBrainz relationship type → display role (when not derived from attributes) and category. */
const RELATION_TYPES: Record<string, [role: string | null, category: CreditCategory]> = {
  instrument: [null, "performance"],
  vocal: [null, "performance"],
  performer: ["performer", "performance"],
  conductor: ["conductor", "performance"],
  "performing orchestra": ["orchestra", "performance"],
  "chorus master": ["chorus master", "performance"],
  concertmaster: ["concertmaster", "performance"],
  programming: ["programming", "performance"],
  composer: ["composer", "composition"],
  lyricist: ["lyricist", "composition"],
  writer: ["writer", "composition"],
  librettist: ["librettist", "composition"],
  arranger: ["arranger", "composition"],
  "instrument arranger": ["arranger", "composition"],
  "vocal arranger": ["vocal arranger", "composition"],
  orchestrator: ["orchestrator", "composition"],
  producer: ["producer", "production"],
  remixer: ["remixer", "production"],
  engineer: ["engineer", "engineering"],
  recording: ["recording engineer", "engineering"],
  mix: ["mix engineer", "engineering"],
  mastering: ["mastering engineer", "engineering"],
  sound: ["sound engineer", "engineering"],
  audio: ["audio engineer", "engineering"],
  editor: ["editor", "engineering"],
  "liner notes": ["liner notes", "other"],
  photography: ["photography", "other"],
  design: ["design", "other"],
  "design/illustration": ["design", "other"],
  "art direction": ["art direction", "other"],
  "graphic design": ["graphic design", "other"],
  illustration: ["illustration", "other"],
};

/** Attributes that qualify a role rather than name an instrument. */
const QUALIFIERS = new Set(["additional", "guest", "solo", "assistant", "associate", "co", "executive"]);
const IGNORED_ATTRIBUTES = new Set([
  "task",
  "original",
  "minor",
  "live",
  "partial",
  "translated",
  "spoken vocals",
]);

function relationRoles(rel: ArtistRelation): { roles: string[]; category: CreditCategory } | null {
  const known = RELATION_TYPES[rel.type];
  if (!known) return null;
  const [fixedRole, category] = known;
  const qualifiers = rel.attributes.filter((a) => QUALIFIERS.has(a));
  const named = rel.attributes.filter((a) => !QUALIFIERS.has(a) && !IGNORED_ATTRIBUTES.has(a));
  const base = fixedRole
    ? [fixedRole]
    : named.length
      ? named
      : [rel.type === "vocal" ? "vocals" : "instruments"];
  // "co" + "producer" → "co-producer"; other qualifiers read naturally as a prefix.
  const prefix = qualifiers.map((q) => (q === "co" ? "co-" : `${q} `)).join("");
  return { roles: base.map((r) => `${prefix}${r}`), category };
}

function toRows(rels: ArtistRelation[]): CreditRow[] {
  return rels.flatMap((rel) => {
    const mapped = relationRoles(rel);
    if (!mapped) return [];
    const name = rel["target-credit"]?.trim() || rel.artist.name;
    return mapped.roles.map((role) => ({
      name,
      role,
      category: mapped.category,
      musicbrainzId: rel.artist.id,
    }));
  });
}

export interface ReleaseTrackCredits {
  recordingId: string;
  disc: number;
  position: number;
  title: string;
  credits: CreditRow[];
}

/**
 * Flattens a release lookup into per-track credits (recording performers plus
 * the writers of the performed work) and release-wide credits.
 */
export function releaseCredits(release: Release): { tracks: ReleaseTrackCredits[]; album: CreditRow[] } {
  const tracks = release.media.flatMap((medium) =>
    medium.tracks.map((t) => {
      const performers = toRows(recordingArtistRelations.parse(t.recording.relations));
      const writers = recordingWorkRelations
        .parse(t.recording.relations)
        .filter((w) => w.type === "performance")
        .flatMap((w) => toRows(workArtistRelations.parse(w.work.relations)));
      return {
        recordingId: t.recording.id,
        disc: medium.position,
        position: t.position,
        title: t.title,
        credits: dedupe([...performers, ...writers]),
      };
    }),
  );
  return { tracks, album: dedupe(toRows(release.relations)) };
}

function dedupe(rows: CreditRow[]): CreditRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.musicbrainzId ?? r.name}\u0000${r.role}`;
    return !seen.has(key) && (seen.add(key), true);
  });
}

const normalizeTitle = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export interface LocalTrack {
  id: string;
  recordingId: string | null;
  disc: number | null;
  position: number | null;
  title: string;
}

/** Pairs library tracks with release tracks: by recording id, then disc/position, then title. */
export function matchTracks(
  local: LocalTrack[],
  remote: ReleaseTrackCredits[],
): Map<string, ReleaseTrackCredits> {
  const out = new Map<string, ReleaseTrackCredits>();
  const byRecording = new Map(remote.map((r) => [r.recordingId, r]));
  const byPosition = new Map(remote.map((r) => [`${r.disc}/${r.position}`, r]));
  const byTitle = new Map(remote.map((r) => [normalizeTitle(r.title), r]));
  for (const t of local) {
    const match =
      (t.recordingId ? byRecording.get(t.recordingId) : undefined) ??
      (t.position ? byPosition.get(`${t.disc ?? 1}/${t.position}`) : undefined) ??
      byTitle.get(normalizeTitle(t.title));
    if (match) out.set(t.id, match);
  }
  return out;
}
