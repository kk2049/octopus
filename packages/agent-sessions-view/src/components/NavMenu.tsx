import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A small context menu for the navigator: one instance, positioned at the
 * pointer or under the ⋯ button that opened it.
 *
 * A nested list ("移到文件夹 ▸") replaces the items in place with a back row
 * rather than cascading, which keeps it usable on a phone and inside a narrow
 * Dock group. Arrow keys move, Enter acts, Escape or a press outside closes.
 */
export interface NavMenuItem {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** Present: activating the row opens this list instead of acting. */
  children?: NavMenuItem[];
}

export interface NavMenuState {
  x: number;
  y: number;
  title: string;
  items: NavMenuItem[];
}

const MARGIN = 8;

export function NavMenu({ menu, host, onSelect, onClose }: {
  menu: NavMenuState | null;
  /** Portal target outside the rail's clipping, normally the App surface. */
  host?: HTMLElement | null;
  onSelect(key: string): void;
  onClose(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState<NavMenuItem[]>([]);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  // The caller keys each opening, so path and position start fresh per menu.
  const level = path.at(-1)?.children ?? menu?.items ?? [];

  // Clamp into the frame once the real size is known, before paint.
  useLayoutEffect(() => {
    const node = root.current;
    if (!menu || !node) return;
    const box = node.getBoundingClientRect();
    const view = node.ownerDocument.defaultView;
    const width = view?.innerWidth ?? 1024;
    const height = view?.innerHeight ?? 768;
    setPosition({
      left: Math.max(MARGIN, Math.min(menu.x, width - box.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(menu.y, height - box.height - MARGIN)),
    });
    node.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])")?.focus({ preventScroll: true });
  }, [menu, path]);

  // Keyboard users return to the row or folder that opened the menu. Read the
  // opener before the first item takes focus (a layout effect, below).
  const opener = useRef<Element | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = typeof document === "undefined" ? null : document.activeElement;
  useEffect(() => () => {
    const target = opener.current;
    const active = target?.ownerDocument.activeElement;
    if (target instanceof HTMLElement && target.isConnected
      && (!active || active === target.ownerDocument.body || !active.isConnected)) target.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: Event): void => {
      if (root.current && event.target instanceof Node && root.current.contains(event.target)) return;
      onClose();
    };
    const doc = root.current?.ownerDocument ?? document;
    doc.addEventListener("pointerdown", outside, true);
    doc.defaultView?.addEventListener("blur", onClose);
    doc.defaultView?.addEventListener("resize", onClose);
    return () => {
      doc.removeEventListener("pointerdown", outside, true);
      doc.defaultView?.removeEventListener("blur", onClose);
      doc.defaultView?.removeEventListener("resize", onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  const activate = (item: NavMenuItem): void => {
    if (item.disabled) return;
    if (item.children) setPath((previous) => [...previous, item]);
    else {
      onClose();
      onSelect(item.key);
    }
  };
  const move = (delta: number): void => {
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(root.current!.ownerDocument.activeElement as HTMLButtonElement);
    buttons[(index + delta + buttons.length) % buttons.length]!.focus();
  };
  return createPortal(
    <div
      ref={root}
      className="nav-menu"
      role="menu"
      aria-label={path.at(-1)?.label ?? menu.title}
      data-av-nav-menu
      style={{ left: position?.left ?? menu.x, top: position?.top ?? menu.y, visibility: position ? "visible" : "hidden" }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
        else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
        else if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); onClose(); }
        else if (event.key === "ArrowLeft" && path.length) { event.preventDefault(); setPath((previous) => previous.slice(0, -1)); }
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="nav-menu-title">{path.at(-1)?.label ?? menu.title}</div>
      {path.length ? (
        <button type="button" role="menuitem" className="nav-menu-item back" onClick={() => setPath((previous) => previous.slice(0, -1))}>
          ‹ 返回
        </button>
      ) : null}
      {level.map((item) => (
        <button
          type="button"
          role="menuitem"
          key={item.key}
          data-av-nav-menu-item={item.key}
          className={`nav-menu-item${item.danger ? " danger" : ""}`}
          disabled={item.disabled}
          aria-haspopup={item.children ? "menu" : undefined}
          onClick={() => activate(item)}
        >
          <span>{item.label}</span>
          {item.children ? <span aria-hidden="true">›</span> : null}
        </button>
      ))}
    </div>,
    host ?? document.body,
  );
}
