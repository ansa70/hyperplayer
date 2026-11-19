import { NEXT_MODE } from "../player/replaygain.ts";
import { usePlayer } from "../stores/player.ts";
import { useSession } from "../stores/session.ts";
import { msg, t } from "../i18n.ts";

const QUALITY_LABEL = {
  auto: msg("AUTO"),
  original: msg("ORIGINAL"),
  "data-saver": msg("DATA SAVER"),
} as const;
const NEXT_QUALITY = { auto: "original", original: "data-saver", "data-saver": "auto" } as const;

/** The player's ReplayGain and quality chips: each cycles its mode (saved to the account). */
export function Chips() {
  const { mode, rgMode } = usePlayer();
  const update = useSession((s) => s.updatePreferences);
  return (
    <div className="chips">
      <button
        className="chip"
        title={t("Volume levelling (ReplayGain)")}
        onClick={() => void update({ replayGain: NEXT_MODE[rgMode] })}
      >
        RG {rgMode.toUpperCase()}
      </button>
      <button
        className="chip"
        title={t("Streaming quality")}
        onClick={() => void update({ quality: NEXT_QUALITY[mode] })}
      >
        {t(QUALITY_LABEL[mode])}
      </button>
    </div>
  );
}

/** What's streaming and how loud, e.g. "FLAC 24/192 · RG −6.4 dB album". */
export function useStreamInfo(): string {
  const { streamLabel, rgLabel } = usePlayer();
  return [streamLabel, rgLabel].filter(Boolean).join(" · ");
}
