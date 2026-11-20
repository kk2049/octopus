import { describe, expect, it } from "vitest";
import { visibleCanvasArea } from "./viewport.js";
import { pinchCamera, zoomCameraAt } from "./canvas-touch.js";

describe("mobile canvas viewport", () => {
  it("fits below host chrome in portrait, landscape and a keyboard-resized visual viewport", () => {
    expect(visibleCanvasArea(56, 844)).toEqual({ height: 788, offsetTop: 0, visibleHeight: 788 });
    expect(visibleCanvasArea(56, 390)).toEqual({ height: 334, offsetTop: 0, visibleHeight: 334 });
    expect(visibleCanvasArea(56, 300)).toEqual({ height: 244, offsetTop: 0, visibleHeight: 244 });
    expect(visibleCanvasArea(56, 300, 100)).toEqual({ height: 344, offsetTop: 44, visibleHeight: 300 });
  });
  it("keeps the world point under the pinch midpoint while zooming and translating", () => {
    const result = pinchCamera({ x: 20, y: 30, zoom: 1 }, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 80, y: 130 }, { x: 280, y: 130 }]);
    expect(result).toEqual({ x: -80, y: -10, zoom: 2 });
    expect((180 - result.x) / result.zoom).toBe(130);
    expect((130 - result.y) / result.zoom).toBe(70);
  });
  it("keeps a distant canvas location under the zoom-button anchor", () => {
    const camera = { x: -15000, y: -8000, zoom: 0.85 }, anchor = { x: 195, y: 450 };
    const world = { x: (anchor.x - camera.x) / camera.zoom, y: (anchor.y - camera.y) / camera.zoom };
    const next = zoomCameraAt(camera, camera.zoom + 0.1, anchor);
    expect(world.x * next.zoom + next.x).toBeCloseTo(anchor.x);
    expect(world.y * next.zoom + next.y).toBeCloseTo(anchor.y);
  });
  it("bounds pinch zoom and handles initially coincident fingers", () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    expect(pinchCamera(camera, [{ x: 0, y: 0 }, { x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 100, y: 0 }]).zoom).toBe(2.4);
    expect(pinchCamera(camera, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 0 }]).zoom).toBe(0.2);
  });
});
