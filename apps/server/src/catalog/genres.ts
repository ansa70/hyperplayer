/**
 * A track's genres, as SQL over a track `t` joined with its artist `ar`: its file tags, or
 * the artist's MusicBrainz genres when the file has none (as the catalog shows them).
 */
export const TRACK_GENRES = "CASE WHEN t.genres = '[]' THEN coalesce(ar.mb_genres, '[]') ELSE t.genres END";

/** True for a track (`t`, with its artist `ar`) in the genre bound to `?`, whatever its case. */
export const IN_GENRE = `EXISTS (SELECT 1 FROM json_each(${TRACK_GENRES}) WHERE value = ? COLLATE NOCASE)`;
