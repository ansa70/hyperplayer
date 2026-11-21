import { api } from "../../api.ts";
import { TrackList } from "../../components/TrackList.tsx";
import { useMarks } from "../../stores/marks.ts";
import { usePlayer } from "../../stores/player.ts";
import { useApi } from "../../useApi.ts";
import { Card } from "./Card.tsx";
import { t } from "../../i18n.ts";

/** The tracks the shuffle button leaves out when it draws from the whole library. */
export function Shuffle() {
  const version = useMarks((s) => s.version);
  const { data, error } = useApi(api.listShuffleExclusions, {}, version);
  const play = usePlayer((s) => s.play);
  const tracks = data ?? [];
  return (
    <Card title={t("Left out of the whole-library shuffle")}>
      <p className="note">
        {t(
          "The shuffle button skips these tracks when it draws from the whole library; they still play from their album, a playlist or a search, and when shuffling an album, artist or genre. Right-click a track (or use its ⋯ menu) to leave it out or bring it back.",
        )}
      </p>
      {error && <p className="error">{error}</p>}
      {data && tracks.length === 0 && <p className="faint">{t("No tracks are left out.")}</p>}
      <TrackList
        tracks={tracks}
        onPlay={(i) => void play({ kind: "tracks", trackIds: tracks.map((t) => t.id) }, i, false)}
      />
    </Card>
  );
}
