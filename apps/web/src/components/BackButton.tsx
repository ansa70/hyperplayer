import { useBack } from "../layout/useBack.ts";
import { Icon } from "./Icon.tsx";
import { t } from "../i18n.ts";

/** Closes a page like Lyrics or the Queue, back to where it was opened from. */
export function BackButton({ title = t("Back") }: { title?: string }) {
  const back = useBack();
  return (
    <button className="icon-button back-button" title={title} onClick={back}>
      <Icon name="back" size={22} />
    </button>
  );
}
