import { useEffect, useState, type RefObject } from "react";

/** Visible space below the host chrome, including the on-screen keyboard. */
export function visibleCanvasArea(top: number, height: number, offsetTop = 0) {
  const bottom = offsetTop + height;
  const offset = Math.max(0, offsetTop - top);
  return { height: Math.max(1, bottom - top), offsetTop: offset, visibleHeight: Math.max(1, bottom - Math.max(top, offsetTop)) };
}
export function useCanvasViewport(root: RefObject<HTMLDivElement | null>) {
  const [viewport, setViewport] = useState({ width: 1200, height: 800, offsetTop: 0, visibleHeight: 800, coarse: false });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const visual = window.visualViewport;
    const pointer = window.matchMedia?.("(pointer: coarse)");
    const update = () => {
      const rect = element.getBoundingClientRect();
      // Browser page zoom remains native; don't resize the document around it.
      const keyboardViewport = visual && visual.scale === 1 ? visual : null;
      const area = visibleCanvasArea(rect.top, keyboardViewport?.height ?? window.innerHeight, keyboardViewport?.offsetTop ?? 0);
      element.style.height = `${area.height}px`;
      element.style.setProperty("--rv-visible-top", `${area.offsetTop}px`);
      element.style.setProperty("--rv-visible-height", `${area.visibleHeight}px`);
      const next = { ...area, width: rect.width, coarse: pointer?.matches ?? false };
      setViewport(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    visual?.addEventListener("resize", update);
    visual?.addEventListener("scroll", update);
    pointer?.addEventListener("change", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
      pointer?.removeEventListener("change", update);
    };
  }, [root]);
  return viewport;
}
