import { useEffect, useRef, useState, type ReactNode } from "react";
import "./menu.css";
import { t } from "../i18n.ts";

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  /** A submenu (e.g. the playlists to add to), shown in place. */
  items?: MenuItem[];
  danger?: boolean;
}

/** A "⋯" button that opens a menu of actions; on phones the menu is a sheet from the bottom. */
export function MenuButton({
  items,
  title = t("More"),
  children,
}: {
  items: () => MenuItem[];
  title?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState<MenuItem[] | null>(null);
  const [heading, setHeading] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div className="menu-anchor" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        className="icon-button menu-button"
        title={title}
        onClick={() => {
          setHeading("");
          setOpen(open ? null : items());
        }}
      >
        {children ?? <span className="dots">⋯</span>}
      </button>
      {open && (
        <div className="menu" role="menu">
          {heading && <div className="caps menu-heading">{heading}</div>}
          {open.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`menu-item ${item.danger ? "danger" : ""}`}
              onClick={() => {
                if (item.items) {
                  setHeading(item.label);
                  setOpen(item.items);
                } else {
                  setOpen(null);
                  item.onSelect?.();
                }
              }}
            >
              {item.label}
              {item.items && <span className="faint">›</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
