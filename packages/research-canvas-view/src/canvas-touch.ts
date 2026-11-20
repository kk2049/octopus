import { useEffect, useRef, type RefObject } from "react";
import type { Camera } from "./windows/state.js";
type Point = { x: number; y: number };
export function zoomCameraAt(camera: Camera, requestedZoom: number, anchor: Point): Camera {
  const zoom = Math.max(0.2, Math.min(2.4, requestedZoom));
  return { zoom, x: anchor.x - (anchor.x - camera.x) * zoom / camera.zoom, y: anchor.y - (anchor.y - camera.y) * zoom / camera.zoom };
}
const midpoint = (points: Point[]) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
const distance = (points: Point[]) => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
export function pinchCamera(camera: Camera, start: Point[], next: Point[]): Camera {
  const before = midpoint(start), after = midpoint(next);
  const zoom = Math.max(0.2, Math.min(2.4, camera.zoom * distance(next) / Math.max(1, distance(start))));
  return { zoom, x: after.x - (before.x - camera.x) * zoom / camera.zoom, y: after.y - (before.y - camera.y) * zoom / camera.zoom };
}
/** Two fingers take ownership from a card/connection gesture before it can commit. */
export function useCanvasTouch(root: RefObject<HTMLDivElement | null>, camera: Camera, change: (camera: Camera) => void, cancel: RefObject<(() => void) | null>, suppressClick: RefObject<boolean>) {
  const current = useRef(camera);
  current.current = camera;
  useEffect(() => {
    const surface = root.current?.querySelector<HTMLElement>(".rv-canvas");
    if (!surface) return;
    const touches = new Map<number, Point>();
    let pinch: { camera: Camera; start: Point[]; ids: number[] } | null = null;
    const point = (event: PointerEvent) => { const rect = surface.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      touches.set(event.pointerId, point(event));
      if (touches.size === 1) suppressClick.current = false;
      if (touches.size < 2) return;
      event.preventDefault(); event.stopPropagation();
      cancel.current?.();
      suppressClick.current = true;
      if (!pinch) {
        const ids = [...touches.keys()].slice(0, 2);
        pinch = { camera: current.current, start: ids.map(id => touches.get(id)!), ids };
        for (const id of ids) surface.setPointerCapture(id);
      }
    };
    const move = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, point(event));
      if (!pinch) return;
      event.preventDefault(); event.stopPropagation();
      if (pinch.ids.every(id => touches.has(id))) change(pinchCamera(pinch.camera, pinch.start, pinch.ids.map(id => touches.get(id)!)));
    };
    const end = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) return;
      touches.delete(event.pointerId);
      if (pinch) { event.preventDefault(); event.stopPropagation(); }
      // After lifting one finger, finish this gesture before accepting a new drag.
      if (!touches.size) pinch = null;
    };
    surface.addEventListener("pointerdown", down, true);
    surface.addEventListener("pointermove", move, true);
    surface.addEventListener("pointerup", end, true);
    surface.addEventListener("pointercancel", end, true);
    return () => {
      surface.removeEventListener("pointerdown", down, true);
      surface.removeEventListener("pointermove", move, true);
      surface.removeEventListener("pointerup", end, true);
      surface.removeEventListener("pointercancel", end, true);
    };
  }, [root, change, cancel, suppressClick]);
}
