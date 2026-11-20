export interface WorkWindow {
  id: string;
  node: string;
  /** Scope where this personal detail was opened; not shared membership. */
  scope?: string;
  version?: string;
  filePath?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  closed?: boolean;
  z: number;
  scroll?: number;
  editField?: "title" | "summary" | "body";
  /** Optional canvas-world anchor; screen x/y are retained for migration. */
  worldX?: number;
  worldY?: number;
}
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}
/** Shared by opening and rendering so every zoom tier fits the same viewport. */
export function detailWindowSize(zoom: number, viewport: { width: number; height: number }) {
  const tier = zoom < 0.65 ? { width: 430, height: 430 } : zoom > 1.55 ? { width: 760, height: 660 } : { width: 570, height: 560 };
  return { width: Math.max(280, Math.min(tier.width, viewport.width - 24)), height: Math.max(240, Math.min(tier.height, viewport.height - 30)) };
}
export function clampWindow(
  window: WorkWindow,
  width: number,
  height: number,
): WorkWindow {
  const w = Math.max(280, Math.min(window.width, width - 24)),
    h = Math.max(240, Math.min(window.height, height - 80));
  return {
    ...window,
    width: w,
    height: h,
    x: Math.max(12, Math.min(window.x, width - w - 12)),
    y: Math.max(12, Math.min(window.y, height - h - 12)),
  };
}
export function openWindow(
  windows: WorkWindow[],
  node: string,
  anchor: { x: number; y: number },
  viewport: { width: number; height: number },
  version?: string,
  worldAnchor?: { x: number; y: number },
): WorkWindow[] {
  const key = `${node}:${version ?? "current"}`,
    z = Math.max(0, ...windows.map((window) => window.z)) + 1;
  const old = windows.find((window) => window.id === key);
  if (old)
    return windows.map((window) =>
      window === old
        ? { ...window, closed: false, minimized: false, z, worldX: worldAnchor?.x ?? window.worldX, worldY: worldAnchor?.y ?? window.worldY }
        : window,
    );
  return [
    ...windows,
    clampWindow(
      {
        id: key,
        node,
        version,
        x: anchor.x + 35,
        y: anchor.y + 35,
        width: 570,
        height: 560,
        minimized: false,
        z,
        worldX: worldAnchor?.x,
        worldY: worldAnchor?.y,
      },
      viewport.width,
      viewport.height,
    ),
  ];
}
