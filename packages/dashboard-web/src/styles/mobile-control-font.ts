/** Only the top-level host can measure page zoom; an opaque iframe's viewport
 * describes its slot and its visualViewport.scale is always 1. */
export function mobileControlFontSize(layoutWidth: number, windowWidth: number, touch: boolean): number {
  if (!touch || !Number.isFinite(layoutWidth) || !Number.isFinite(windowWidth)
    || layoutWidth <= 0 || windowWidth <= 0) return 16;
  // At 75% page zoom a 390px phone has a 520 CSS-pixel layout viewport.
  // Round up so fractional layout pixels cannot put the used font below 16.
  return Math.min(64, Math.max(16, Math.ceil(16 * layoutWidth / windowWidth * 100) / 100));
}

/** Owns one document-lifetime observer, installed before React's first render.
 * It never changes viewport metadata, focus, scroll, or the browser's zoom. */
export function observeMobileControlFont(win: Window, changed: (size: number) => void): () => void {
  const root = win.document.documentElement;
  const touch = win.matchMedia("(hover: none) and (pointer: coarse)");
  let previous = 0;
  const update = () => {
    const size = mobileControlFontSize(root.clientWidth, win.outerWidth || win.screen.width, touch.matches);
    if (size === previous) return;
    previous = size;
    root.style.setProperty("--mobile-control-font-size", `${size}px`);
    changed(size);
  };
  update();
  win.addEventListener("resize", update);
  win.addEventListener("orientationchange", update);
  win.addEventListener("pageshow", update);
  win.visualViewport?.addEventListener("resize", update);
  touch.addEventListener("change", update);
  return () => {
    win.removeEventListener("resize", update);
    win.removeEventListener("orientationchange", update);
    win.removeEventListener("pageshow", update);
    win.visualViewport?.removeEventListener("resize", update);
    touch.removeEventListener("change", update);
    root.style.removeProperty("--mobile-control-font-size");
  };
}
