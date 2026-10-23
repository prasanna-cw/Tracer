import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon, IconButton } from "./Icon";

export type MenuItem =
  | { kind: "check"; label: string; checked: boolean; onSelect: () => void }
  | { kind: "action"; label: string; icon?: string; disabled?: boolean; onSelect: () => void }
  | { kind: "heading"; label: string }
  | { kind: "separator" };

/**
 * An icon button with a popup menu (keyboard: arrows, Home/End, Esc; closes on outside click).
 * The popup is position:fixed so the scrolling toolbar never clips it.
 */
export function MenuButton({ icon, label, items }: { icon: string; label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open, pos]);

  const onKey = (e: KeyboardEvent) => {
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => buttons[(n + buttons.length) % buttons.length]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(buttons.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
      wrap.current?.querySelector("button")?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <IconButton icon={icon} label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && pos && (
        <div className="menu" role="menu" aria-label={label} ref={menu} style={pos} onKeyDown={onKey}>
          {items.map((item, i) => {
            if (item.kind === "separator") return <div key={i} className="menu-sep" role="separator" />;
            if (item.kind === "heading") return <div key={i} className="menu-heading">{item.label}</div>;
            const select = () => {
              setOpen(false);
              item.onSelect();
            };
            return item.kind === "check" ? (
              <button key={i} type="button" role="menuitemcheckbox" aria-checked={item.checked} onClick={select}>
                <Icon name={item.checked ? "check" : "blank"} />
                {item.label}
              </button>
            ) : (
              <button key={i} type="button" role="menuitem" disabled={item.disabled} onClick={select}>
                <Icon name={item.icon ?? "blank"} />
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
