import { uiText } from "../i18n/ui-text.js";
/**
 * Pointing at something on a TRUSTED page, and photographing the screen.
 *
 * ── Two pickers, and why there have to be two ───────────────────────────────
 *
 * Session Plus renders an Agent View in a sandboxed frame on another origin.
 * Picking an element inside it is the frame's own job — the trusted page cannot
 * read that DOM, by construction — so it asks over the debug channel and the
 * View's embedded agent answers. Every OTHER page in this app is ordinary
 * trusted DOM, and there the picker is right here. The dock chooses between
 * them by asking whether a page registered an in-frame picker.
 *
 * ── Screenshots: why not html2canvas ────────────────────────────────────────
 *
 * The obvious route was to rasterise the picked subtree with html2canvas. It
 * loses on both halves of this feature:
 *
 *  · for the case that prompted the request — an element inside the Agent View
 *    — the parent document cannot read that subtree at all, so html2canvas
 *    would have to ship INSIDE the released View bundle. That bundle is one
 *    self-contained document addressed by digest: adding a rasteriser to it
 *    changes the release identity and the hostname it is served from, for a
 *    debug affordance;
 *  · html2canvas re-implements layout and paint from the computed styles it can
 *    read. It has no access to the frame, to a canvas, to a `<video>`, or to
 *    anything drawn by the compositor, so the picture it returns is a drawing
 *    of the DOM rather than of the screen — and "what I actually saw" is the
 *    whole content of a UI bug report.
 *
 * `getDisplayMedia` has neither problem: it is a browser API, needs no
 * dependency, captures the composited result including the frame, and is gated
 * by the browser's own picker so nothing is captured without an explicit
 * choice. One frame is grabbed and the track is stopped immediately — this is
 * a screenshot, not a recording, and the stream must not outlive it.
 */

import { describeElement, type PickedElement, type PickedElementLike } from "./element-path.js";

export interface ElementPicker {
  /** Arm the overlay; the next click reports and disarms. */
  start(): void;
  /** Disarm without reporting. Idempotent. */
  stop(): void;
}

/** Set by a page that owns a frame it can ask instead. */
export type FramePicker = () => Promise<PickedElementLike | null>;

let framePicker: FramePicker | null = null;

/**
 * A page with an untrusted frame registers how to pick inside it.
 *
 * A registry rather than a prop, because the dock lives in the app shell and
 * the frame lives in one page's subtree; threading a callback up through the
 * router would make every other page carry a parameter about Session Plus.
 * Returns its own un-registration so a page cannot leak a dead handler.
 */
export function registerFramePicker(picker: FramePicker): () => void {
  framePicker = picker;
  return () => {
    if (framePicker === picker) framePicker = null;
  };
}

export function currentFramePicker(): FramePicker | null {
  return framePicker;
}

/**
 * Arm a click-to-describe overlay over this document.
 *
 * The click is SWALLOWED: an armed picker must never double as a real press on
 * whatever button happened to be underneath, which on this app could be a
 * deploy or an approval.
 */
export function createElementPicker(
  doc: Document,
  onPick: (picked: PickedElement) => void,
): ElementPicker {
  let armed = false;
  let highlighted: { el: HTMLElement; outline: string } | null = null;

  const clearHighlight = (): void => {
    if (highlighted) highlighted.el.style.outline = highlighted.outline;
    highlighted = null;
  };

  const onOver = (event: Event): void => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    clearHighlight();
    highlighted = { el, outline: el.style.outline };
    el.style.outline = "2px solid #e5484d";
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") stop();
  };

  const onClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    const el = event.target;
    stop();
    if (el instanceof Element) onPick(describeElement(el, doc.location?.pathname ?? ""));
  };

  function stop(): void {
    if (!armed) return;
    armed = false;
    clearHighlight();
    doc.removeEventListener("mouseover", onOver, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("keydown", onKey, true);
    doc.documentElement.style.cursor = "";
  }

  return {
    start() {
      if (armed) return;
      armed = true;
      doc.addEventListener("mouseover", onOver, true);
      doc.addEventListener("click", onClick, true);
      doc.addEventListener("keydown", onKey, true);
      doc.documentElement.style.cursor = "crosshair";
    },
    stop,
  };
}

export function screenCaptureSupported(): boolean {
  return typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getDisplayMedia === "function"
    && typeof HTMLCanvasElement !== "undefined";
}

/**
 * One frame of whatever the person chooses to share, as a PNG file.
 *
 * The track is stopped on every exit, including the failures. A capture that
 * outlives its screenshot is a tab that keeps saying "sharing your screen"
 * until it is closed, which is a far worse bug than the one being reported.
 */
export async function captureScreenshot(): Promise<File> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
    // Chrome's own tab-capture path. It puts THIS tab first in the picker,
    // which is what somebody reporting a UI bug is almost always after.
    preferCurrentTab: true,
  } as MediaStreamConstraints);
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error(uiText("这次屏幕捕获没有画面轨道"));
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // One painted frame. `play()` resolves before the first frame on some
    // engines, so wait for a real animation tick rather than a fixed delay.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || track.getSettings().width || 1280;
    canvas.height = video.videoHeight || track.getSettings().height || 720;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(uiText("这个浏览器不能把画面画到 canvas 上"));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    video.pause();
    video.srcObject = null;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error(uiText("这次屏幕捕获没有产生图片"));
    return new File([blob], "screen.png", { type: "image/png" });
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
