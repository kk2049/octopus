/**
 * macOS physical-screen automation with a device-local consent lease.
 *
 * The Dashboard switch only makes this resource discoverable. Authority to
 * see or drive the screen is minted here, on the target Mac, after its logged-
 * in user accepts a native dialog. One active grant owns one floating stop
 * indicator and expires after exactly fifteen minutes (or earlier when the
 * indicator, Runner, source MCP connection, or Dashboard policy closes it).
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MACHINE_LIMITS } from "./limits.js";

export const MAC_GUI_AUTOMATION_PROTOCOL = "runner-macos-gui/v1" as const;
export const MAC_GUI_CONTROL_TTL_MS = MACHINE_LIMITS.guiControlTtlMs;
export const MAC_GUI_CONSENT_TIMEOUT_MS = MACHINE_LIMITS.guiConsentTimeoutMs;
export const MAC_GUI_SCREENSHOT_MAX_BYTES = MACHINE_LIMITS.guiScreenshotMaxBytes;
export const MAC_GUI_SCREENSHOT_MAX_WIDTH = MACHINE_LIMITS.guiScreenshotMaxWidth;

const execFileAsync = promisify(execFile);
const CONTROLLER_LABEL_MAX_BYTES = MACHINE_LIMITS.guiControllerLabelMaxBytes;
const TYPE_TEXT_MAX_BYTES = MACHINE_LIMITS.guiTypeTextMaxBytes;

export const MAC_GUI_KEYS = [
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "space",
  "arrow_up",
  "arrow_down",
  "arrow_left",
  "arrow_right",
  "home",
  "end",
  "page_up",
  "page_down",
] as const;
export type MacGuiKey = (typeof MAC_GUI_KEYS)[number];

export const MAC_GUI_MODIFIERS = ["command", "control", "option", "shift"] as const;
export type MacGuiModifier = (typeof MAC_GUI_MODIFIERS)[number];

export interface MacGuiScreenCapture {
  media_type: "image/jpeg";
  data: string;
  width: number;
  height: number;
  captured_at: string;
  coordinate_space: {
    origin: "top_left";
    width: number;
    height: number;
    display: "main";
  };
}

interface NativeScreenCapture extends MacGuiScreenCapture {
  pointWidth: number;
  pointHeight: number;
}

export interface MacGuiPoint {
  x: number;
  y: number;
}

export type MacGuiPointerAction =
  | { kind: "click"; point: MacGuiPoint; button: "left" | "right"; clickCount: number }
  | { kind: "scroll"; point: MacGuiPoint; deltaX: number; deltaY: number }
  | { kind: "drag"; from: MacGuiPoint; to: MacGuiPoint; durationMs: number };

export interface MacGuiIndicator {
  /** Resolves when the user clicks the local stop affordance or the panel dies. */
  stopped: Promise<void>;
  close(): void | Promise<void>;
}

export interface MacGuiAutomationBackend {
  readonly available: boolean;
  requestConsent(controllerLabel: string, signal: AbortSignal): Promise<boolean>;
  /** Trigger and verify the two macOS TCC grants before exposing a lease. */
  preflightPermissions(signal: AbortSignal): Promise<void>;
  openIndicator(controllerLabel: string, expiresAt: number, signal: AbortSignal): Promise<MacGuiIndicator>;
  captureScreen(signal: AbortSignal): Promise<NativeScreenCapture>;
  pointer(action: MacGuiPointerAction, signal: AbortSignal): Promise<void>;
  typeText(text: string, signal: AbortSignal): Promise<void>;
  keyPress(key: MacGuiKey, modifiers: readonly MacGuiModifier[], signal: AbortSignal): Promise<void>;
}

interface ActiveGrant {
  id: string;
  controllerLabel: string;
  expiresAt: number;
  indicator: MacGuiIndicator;
  timer: NodeJS.Timeout;
  operations: Set<AbortController>;
  lastCapture?: NativeScreenCapture;
}

export interface MacGuiAutomationControllerOptions {
  now?: () => number;
  grantTtlMs?: number;
}

export class MacGuiAutomationController {
  private exposed = false;
  private requesting = false;
  private requestAbort: AbortController | null = null;
  private active: ActiveGrant | null = null;
  private readonly now: () => number;
  private readonly grantTtlMs: number;

  constructor(
    private readonly backend: MacGuiAutomationBackend,
    options: MacGuiAutomationControllerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.grantTtlMs = options.grantTtlMs ?? MAC_GUI_CONTROL_TTL_MS;
  }

  get available(): boolean {
    return this.backend.available;
  }

  /** A server-authored device policy update; false synchronously ends control. */
  setExposed(enabled: boolean): void {
    this.exposed = enabled && this.backend.available;
    if (!this.exposed) {
      this.requestAbort?.abort();
      this.endActive();
    }
  }

  async requestControl(args: Readonly<Record<string, unknown>>): Promise<{
    granted: boolean;
    grant_id?: string;
    expires_at?: string;
    reason?: "user_denied";
  }> {
    const controllerLabel = boundedText(args.controller_label, CONTROLLER_LABEL_MAX_BYTES);
    if (!controllerLabel) throw new Error("controller_label is required");
    if (!this.backend.available) throw new Error("macOS GUI automation is unavailable in this login session");
    if (!this.exposed) throw new Error("GUI automation is not exposed for this Runner");
    if (this.requesting || this.liveGrant()) {
      throw new Error("another GUI control request or lease is already active on this Mac");
    }
    this.requesting = true;
    const requestAbort = new AbortController();
    this.requestAbort = requestAbort;
    try {
      const allowed = await this.backend.requestConsent(controllerLabel, requestAbort.signal);
      if (!allowed) {
        if (!this.exposed || requestAbort.signal.aborted) {
          throw new Error("GUI automation was disabled while consent was pending");
        }
        return { granted: false, reason: "user_denied" };
      }
      if (!this.exposed) throw new Error("GUI automation was disabled while consent was pending");
      await this.backend.preflightPermissions(requestAbort.signal);
      if (!this.exposed) throw new Error("GUI automation was disabled while macOS permissions were being checked");

      const id = `gui_${randomUUID().replace(/-/g, "")}`;
      const expiresAt = this.now() + this.grantTtlMs;
      const indicator = await this.backend.openIndicator(controllerLabel, expiresAt, requestAbort.signal);
      if (!this.exposed) {
        await indicator.close();
        throw new Error("GUI automation was disabled before the local indicator opened");
      }
      const timer = setTimeout(() => this.endGrant(id), Math.max(1, expiresAt - this.now()));
      timer.unref?.();
      this.active = { id, controllerLabel, expiresAt, indicator, timer, operations: new Set() };
      void indicator.stopped.then(
        () => this.endGrant(id),
        () => this.endGrant(id),
      );
      return { granted: true, grant_id: id, expires_at: new Date(expiresAt).toISOString() };
    } finally {
      this.requesting = false;
      if (this.requestAbort === requestAbort) this.requestAbort = null;
    }
  }

  async captureScreen(args: Readonly<Record<string, unknown>>): Promise<MacGuiScreenCapture> {
    const grant = this.requireGrant(args.grant_id);
    const capture = await this.runOperation(grant, (signal) => this.backend.captureScreen(signal));
    // The bytes were captured while this exact grant was live. If the person
    // stopped control during the await, do not disclose them afterwards.
    if (this.active !== grant || this.now() >= grant.expiresAt) {
      throw new Error("GUI control ended before the screenshot completed");
    }
    grant.lastCapture = capture;
    const { pointWidth: _pointWidth, pointHeight: _pointHeight, ...result } = capture;
    return result;
  }

  async click(args: Readonly<Record<string, unknown>>): Promise<{ clicked: true; authorization_active: boolean }> {
    const grant = this.requireGrant(args.grant_id);
    const point = this.screenPoint(grant, args.x, args.y);
    const button = args.button === undefined ? "left" : enumValue(args.button, ["left", "right"] as const, "button");
    const clickCount = boundedInteger(args.click_count ?? 1, 1, MACHINE_LIMITS.guiClickCountMax, "click_count");
    grant.lastCapture = undefined;
    await this.runOperation(grant, (signal) =>
      this.backend.pointer({ kind: "click", point, button, clickCount }, signal));
    return { clicked: true, authorization_active: this.active === grant && this.now() < grant.expiresAt };
  }

  async scroll(args: Readonly<Record<string, unknown>>): Promise<{ scrolled: true; authorization_active: boolean }> {
    const grant = this.requireGrant(args.grant_id);
    const point = this.screenPoint(grant, args.x, args.y);
    const direction = enumValue(args.direction, ["up", "down", "left", "right"] as const, "direction");
    const amount = boundedInteger(args.amount ?? 3, 1, MACHINE_LIMITS.guiScrollAmountMax, "amount");
    const deltaX = direction === "left" ? amount : direction === "right" ? -amount : 0;
    const deltaY = direction === "up" ? amount : direction === "down" ? -amount : 0;
    grant.lastCapture = undefined;
    await this.runOperation(grant, (signal) =>
      this.backend.pointer({ kind: "scroll", point, deltaX, deltaY }, signal));
    return { scrolled: true, authorization_active: this.active === grant && this.now() < grant.expiresAt };
  }

  async drag(args: Readonly<Record<string, unknown>>): Promise<{ dragged: true; authorization_active: boolean }> {
    const grant = this.requireGrant(args.grant_id);
    const from = this.screenPoint(grant, args.from_x, args.from_y);
    const to = this.screenPoint(grant, args.to_x, args.to_y);
    const durationMs = boundedInteger(args.duration_ms ?? 500, 100, MACHINE_LIMITS.guiDragDurationMaxMs, "duration_ms");
    grant.lastCapture = undefined;
    await this.runOperation(grant, (signal) =>
      this.backend.pointer({ kind: "drag", from, to, durationMs }, signal));
    return { dragged: true, authorization_active: this.active === grant && this.now() < grant.expiresAt };
  }

  async typeText(args: Readonly<Record<string, unknown>>): Promise<{ typed: true; authorization_active: boolean }> {
    const grant = this.requireGrant(args.grant_id);
    const text = typeof args.text === "string" ? args.text : "";
    if (Buffer.byteLength(text, "utf8") > TYPE_TEXT_MAX_BYTES) throw new Error("text is too large");
    grant.lastCapture = undefined;
    await this.runOperation(grant, (signal) => this.backend.typeText(text, signal));
    return { typed: true, authorization_active: this.active === grant && this.now() < grant.expiresAt };
  }

  async keyPress(args: Readonly<Record<string, unknown>>): Promise<{ pressed: true; authorization_active: boolean }> {
    const grant = this.requireGrant(args.grant_id);
    const key = enumValue(args.key, MAC_GUI_KEYS, "key");
    const modifiers = MAC_GUI_MODIFIERS.filter((modifier) => args[`modifier_${modifier}`] === true);
    grant.lastCapture = undefined;
    await this.runOperation(grant, (signal) => this.backend.keyPress(key, modifiers, signal));
    return { pressed: true, authorization_active: this.active === grant && this.now() < grant.expiresAt };
  }

  releaseControl(args: Readonly<Record<string, unknown>>): { released: boolean } {
    const grantId = boundedText(args.grant_id, MACHINE_LIMITS.guiGrantIdMaxBytes);
    if (!grantId) throw new Error("grant_id is required");
    return { released: this.endGrant(grantId) };
  }

  close(): void {
    this.exposed = false;
    this.requestAbort?.abort();
    this.endActive();
  }

  private async runOperation<T>(grant: ActiveGrant, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active !== grant || this.now() >= grant.expiresAt) {
      throw new Error("GUI control is not active; request permission on the target Mac again");
    }
    // Screen state and keyboard focus are shared mutable resources. Serial
    // calls keep a capture/action pair meaningful and prevent two MCP calls
    // from driving the physical desktop at once.
    if (grant.operations.size > 0) {
      throw new Error("another GUI operation is already in progress on this Mac");
    }
    const controller = new AbortController();
    grant.operations.add(controller);
    try {
      return await operation(controller.signal);
    } catch (error) {
      // A native failure can follow partial input. Revoke locally even if the
      // MCP close never arrives; revocation cannot undo an already posted event.
      this.endGrant(grant.id);
      throw error;
    } finally {
      grant.operations.delete(controller);
    }
  }

  private liveGrant(): ActiveGrant | null {
    const active = this.active;
    if (active && this.now() >= active.expiresAt) {
      this.endGrant(active.id);
      return null;
    }
    return active;
  }

  private requireGrant(value: unknown): ActiveGrant {
    const grantId = boundedText(value, MACHINE_LIMITS.guiGrantIdMaxBytes);
    if (!grantId) throw new Error("grant_id is required");
    const active = this.liveGrant();
    if (!this.exposed || !active || active.id !== grantId) {
      throw new Error("GUI control is not active; request permission on the target Mac again");
    }
    return active;
  }

  private screenPoint(grant: ActiveGrant, xValue: unknown, yValue: unknown): MacGuiPoint {
    const capture = grant.lastCapture;
    if (!capture) throw new Error("capture_screen must succeed before coordinate actions");
    const x = boundedNumber(xValue, 0, Math.max(0, capture.width - 1), "x");
    const y = boundedNumber(yValue, 0, Math.max(0, capture.height - 1), "y");
    return {
      x: x * capture.pointWidth / capture.width,
      y: y * capture.pointHeight / capture.height,
    };
  }

  private endActive(): void {
    if (this.active) this.endGrant(this.active.id);
  }

  private endGrant(id: string): boolean {
    const active = this.active;
    if (!active || active.id !== id) return false;
    this.active = null;
    clearTimeout(active.timer);
    for (const operation of active.operations) operation.abort();
    active.operations.clear();
    try {
      void Promise.resolve(active.indicator.close()).catch(() => undefined);
    } catch {
      // Keep the original native failure even if indicator cleanup throws.
    }
    return true;
  }
}

/** Only advertise a currently logged-in Aqua session owned by this Runner uid. */
export function macGuiAutomationHostAvailable(platform = process.platform): boolean {
  if (platform !== "darwin" || typeof process.getuid !== "function") return false;
  try {
    if (statSync("/dev/console").uid !== process.getuid()) return false;
    for (const executable of ["/usr/bin/osascript", "/usr/sbin/screencapture", "/usr/bin/sips"]) {
      accessSync(executable, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export class NativeMacGuiAutomationBackend implements MacGuiAutomationBackend {
  readonly available = macGuiAutomationHostAvailable();

  constructor(private readonly executeScript: MacGuiScriptExecutor = executeMacGuiScript) {}

  async requestConsent(controllerLabel: string, signal: AbortSignal): Promise<boolean> {
    if (!this.available) return false;
    try {
      const { stdout } = await execFileAsync("/usr/bin/osascript", [
        "-e",
        CONSENT_APPLESCRIPT,
        controllerLabel,
      ], {
        timeout: MAC_GUI_CONSENT_TIMEOUT_MS + 5_000,
        maxBuffer: 16 * 1024,
        encoding: "utf8",
        signal,
      });
      return String(stdout).trim() === "ALLOW";
    } catch (error) {
      if (signal.aborted) throw error;
      return false;
    }
  }

  async preflightPermissions(signal: AbortSignal): Promise<void> {
    // `screencapture` is the same executable used for real captures, so a
    // successful throwaway frame proves Screen Recording permission for the
    // actual path rather than for a different helper process.
    await this.captureScreen(signal);
    try {
      const { stdout } = await execFileAsync("/usr/bin/osascript", [
        "-l",
        "JavaScript",
        "-e",
        ACCESSIBILITY_PREFLIGHT_JXA,
      ], { timeout: 30_000, maxBuffer: 16 * 1024, encoding: "utf8", signal });
      if (String(stdout).trim() !== "TRUSTED") throw new Error("not trusted");
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(
        "macOS Accessibility permission is missing; allow the Runner/Node process in System Settings → Privacy & Security → Accessibility, then request control again",
      );
    }
  }

  async openIndicator(controllerLabel: string, expiresAt: number, signal: AbortSignal): Promise<MacGuiIndicator> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "octopus-gui-indicator-"));
    const readyPath = path.join(directory, "ready");
    const seconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1_000));
    const child = spawn("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      CONTROL_INDICATOR_JXA,
      readyPath,
      controllerLabel,
      String(seconds),
    ], { stdio: "ignore" });
    try {
      await waitForIndicator(child, readyPath, signal);
    } catch (error) {
      child.kill("SIGTERM");
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    let closed = false;
    // The process can exit in the narrow interval between observing `ready`
    // and installing this listener. Treat that as an already-stopped panel so
    // the authorization never survives without its visible kill switch.
    const stopped = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
    return {
      stopped,
      close: async () => {
        if (closed) return;
        closed = true;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await stopped;
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  async captureScreen(signal: AbortSignal): Promise<NativeScreenCapture> {
    if (!this.available) throw new Error("macOS GUI automation is unavailable in this login session");
    const directory = await mkdtemp(path.join(os.tmpdir(), "octopus-gui-capture-"));
    const pngPath = path.join(directory, "screen.png");
    const jpegPath = path.join(directory, "screen.jpg");
    try {
      await execFileAsync("/usr/sbin/screencapture", ["-x", "-m", "-t", "png", pngPath], {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        signal,
      });
      await execFileAsync("/usr/bin/sips", [
        "-Z",
        String(MAC_GUI_SCREENSHOT_MAX_WIDTH),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "72",
        pngPath,
        "--out",
        jpegPath,
      ], { timeout: 30_000, maxBuffer: 64 * 1024, signal });
      const [bytes, imageSize, pointSize] = await Promise.all([
        readFile(jpegPath),
        imageDimensions(jpegPath, signal),
        mainScreenPointSize(signal),
      ]);
      if (!bytes.length || bytes.length > MAC_GUI_SCREENSHOT_MAX_BYTES) {
        throw new Error(`screen capture exceeds the ${MAC_GUI_SCREENSHOT_MAX_BYTES}-byte safety limit`);
      }
      return {
        media_type: "image/jpeg",
        data: bytes.toString("base64"),
        width: imageSize.width,
        height: imageSize.height,
        pointWidth: pointSize.width,
        pointHeight: pointSize.height,
        captured_at: new Date().toISOString(),
        coordinate_space: {
          origin: "top_left",
          width: imageSize.width,
          height: imageSize.height,
          display: "main",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/permission|not authorized|denied|could not create image/i.test(message)) {
        throw new Error(
          "macOS Screen Recording permission is missing; allow the Runner/Node process in System Settings → Privacy & Security → Screen Recording, then request control again",
        );
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async pointer(action: MacGuiPointerAction, signal: AbortSignal): Promise<void> {
    await this.inputScript(action.kind, ["-l", "JavaScript", "-e", POINTER_ACTION_JXA, JSON.stringify(action)], signal, true);
  }

  async typeText(text: string, signal: AbortSignal): Promise<void> {
    await this.inputScript("type_text", ["-e", TYPE_TEXT_APPLESCRIPT, text], signal);
  }

  async keyPress(key: MacGuiKey, modifiers: readonly MacGuiModifier[], signal: AbortSignal): Promise<void> {
    const code = KEY_CODES[key];
    const using = modifiers.length
      ? ` using {${modifiers.map((modifier) => `${modifier} down`).join(", ")}}`
      : "";
    const script = `tell application "System Events"\nif UI elements enabled is false then error "Accessibility permission is missing"\nkey code ${code}${using}\nend tell`;
    await this.inputScript("key_press", ["-e", script], signal);
  }

  private async inputScript(operation: string, args: string[], signal: AbortSignal, acknowledge = false): Promise<void> {
    try {
      const { stdout } = await this.executeScript(args, signal);
      if (acknowledge && stdout.trim() !== "OK") throw new Error("missing native completion acknowledgement");
    } catch (error) {
      throw macGuiInputError(operation, error, args);
    }
  }
}

type MacGuiScriptExecutor = (args: string[], signal: AbortSignal) => Promise<{ stdout: string }>;

async function executeMacGuiScript(args: string[], signal: AbortSignal): Promise<{ stdout: string }> {
  return await execFileAsync("/usr/bin/osascript", args, {
    timeout: 10_000, maxBuffer: 16 * 1024, encoding: "utf8", signal,
  });
}

function macGuiInputError(operation: string, error: unknown, args: string[]): Error {
  const row = error && typeof error === "object"
    ? error as { stderr?: unknown; message?: unknown; code?: unknown; signal?: unknown; killed?: unknown }
    : {};
  // execFile.message includes the command, script and argv (potentially typed
  // secrets). Prefer stderr and never fall back to that command echo.
  let detail = typeof row.stderr === "string" && row.stderr.trim()
    ? row.stderr
    : typeof row.message === "string" && !row.message.startsWith("Command failed:")
      ? row.message : "native process returned no diagnostic";
  for (const argument of args.slice(args.indexOf("-e") + 1).filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    detail = detail.split(argument).join("[argument]");
    detail = detail.split(JSON.stringify(argument).slice(1, -1)).join("[argument]");
  }
  detail = detail
    .replace(/Command failed:[\s\S]*/g, "[command omitted]")
    .replace(/https?:\/\/[^\s]+/g, "[url]")
    .replace(/(?:\/Users|\/home|\/private|\/var|\/tmp)\/[^\s:]+/g, "[path]")
    .replace(/(["'`])[^\r\n]*?\1/g, "[quoted]")
    .replace(/\b(token|password|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ").trim();
  if (detail.length > 768) detail = `…${detail.slice(-767)}`;
  const code = typeof row.code === "number" || (typeof row.code === "string" && /^[A-Z0-9_]{1,48}$/.test(row.code))
    ? String(row.code) : "unknown";
  const signal = typeof row.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(row.signal) ? row.signal : "none";
  return new Error(`macOS GUI ${operation} failed (exit=${code}, signal=${signal}, killed=${row.killed === true}): ${detail}; input outcome unknown; do not retry automatically`);
}

const KEY_CODES: Record<MacGuiKey, number> = {
  enter: 36,
  tab: 48,
  escape: 53,
  backspace: 51,
  delete: 117,
  space: 49,
  arrow_up: 126,
  arrow_down: 125,
  arrow_left: 123,
  arrow_right: 124,
  home: 115,
  end: 119,
  page_up: 116,
  page_down: 121,
};

const CONSENT_APPLESCRIPT = String.raw`
on run argv
  set controllerName to item 1 of argv
  try
    set answer to display dialog "Octopus 中运行于「" & controllerName & "」的 Agent 请求查看并操作这台 Mac。允许后，它可在未来 15 分钟内截取主屏幕、点击、滚动、拖动和键盘输入。桌面右上角会一直显示可随时终止的浮层。" buttons {"拒绝", "允许 15 分钟"} default button "拒绝" cancel button "拒绝" with title "Octopus 远程操作请求" with icon caution giving up after 120
    if gave up of answer then return "TIMEOUT"
    if button returned of answer is "允许 15 分钟" then return "ALLOW"
    return "DENY"
  on error number -128
    return "DENY"
  end try
end run`;

const TYPE_TEXT_APPLESCRIPT = String.raw`
on run argv
  tell application "System Events"
    if UI elements enabled is false then error "Accessibility permission is missing"
    keystroke (item 1 of argv)
  end tell
end run`;

const ACCESSIBILITY_PREFLIGHT_JXA = String.raw`
function run() {
  ObjC.import("ApplicationServices");
  ObjC.import("Foundation");
  var options = $.NSMutableDictionary.dictionary;
  options.setObjectForKey(true, $.kAXTrustedCheckOptionPrompt);
  return $.AXIsProcessTrustedWithOptions(options) ? "TRUSTED" : "MISSING";
}`;

/** Static JXA: the only variable input is parsed JSON, never executable text. */
export const POINTER_ACTION_JXA = String.raw`
function run(argv) {
  var stage = "import";
  var attempted = 0;
  var posted = 0;
  // One bounded, short-lived osascript owns the event references until exit.
  // Do not manually CFRelease bridged objects between mouse-down and mouse-up.
  var events = [];
  try {
    ObjC.import("ApplicationServices");
    ObjC.import("CoreGraphics");
    ObjC.import("Foundation");
    stage = "accessibility";
    if (!$.AXIsProcessTrusted()) throw new Error("Accessibility permission is missing");
    stage = "decode";
    var action = JSON.parse(argv[0]);
    function point(p) { return { x: Number(p.x), y: Number(p.y) }; }
    function checked(event) {
      if (!event || (typeof event.isNil === "function" && event.isNil())) {
        throw new Error("cannot create event");
      }
      return event;
    }
    function mouse(type, p, button, clicks, wait) {
      stage = "create_mouse";
      var event = checked($.CGEventCreateMouseEvent(null, type, point(p), button));
      if (clicks) {
        stage = "click_state";
        $.CGEventSetIntegerValueField(event, 1, clicks);
      }
      events.push({ event: event, wait: wait || 0 });
    }
    // Prepare every event before the first post. Bridge/argument failures must
    // not strand an otherwise avoidable mouse-down on the physical desktop.
    if (action.kind === "click") {
      var right = action.button === "right";
      for (var i = 1; i <= action.clickCount; i++) {
        mouse(right ? 3 : 1, action.point, right ? 1 : 0, i, 0.035);
        mouse(right ? 4 : 2, action.point, right ? 1 : 0, i, i < action.clickCount ? 0.08 : 0);
      }
    } else if (action.kind === "scroll") {
      mouse(5, action.point, 0, 0, 0);
      stage = "create_scroll";
      // Fixed arity avoids the variadic C ABI at the JXA/Apple Silicon boundary.
      var scroll = checked($.CGEventCreateScrollWheelEvent2(null, 1, 2, action.deltaY, action.deltaX, 0));
      events.push({ event: scroll, wait: 0 });
    } else if (action.kind === "drag") {
      mouse(5, action.from, 0, 0, 0);
      mouse(1, action.from, 0, 1, 0);
      var steps = Math.max(2, Math.min(60, Math.ceil(action.durationMs / 16)));
      for (var step = 1; step <= steps; step++) {
        var ratio = step / steps;
        mouse(6, {
          x: action.from.x + (action.to.x - action.from.x) * ratio,
          y: action.from.y + (action.to.y - action.from.y) * ratio
        }, 0, 1, action.durationMs / steps / 1000);
      }
      mouse(2, action.to, 0, 1, 0);
    } else {
      throw new Error("unknown pointer action");
    }
    for (var index = 0; index < events.length; index++) {
      stage = "post";
      attempted++;
      $.CGEventPost(0, events[index].event);
      posted++;
      if (events[index].wait) {
        stage = "pause";
        $.NSThread.sleepForTimeInterval(events[index].wait);
      }
    }
    return "OK";
  } catch (error) {
    // Counts describe calls, not delivery receipts. A failing post may already
    // have reached the desktop. Never replay or send compensating input here.
    throw new Error("stage=" + stage + " attempted=" + attempted + " posted=" + posted + ": " + String(error));
  }
}`;

/** Accessory NSPanel: visible on every Space, floating, and deliberately tiny. */
const CONTROL_INDICATOR_JXA = String.raw`
function run(argv) {
  ObjC.import("AppKit");
  ObjC.import("Foundation");
  var readyPath = argv[0];
  var controller = argv[1];
  var seconds = Math.max(1, Number(argv[2]));
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var width = 360;
  var height = 104;
  var style = $.NSTitledWindowMask | $.NSUtilityWindowMask;
  var panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, width, height), style, $.NSBackingStoreBuffered, false
  );
  panel.title = "Octopus 正在远程操作";
  panel.level = $.NSFloatingWindowLevel;
  panel.hidesOnDeactivate = false;
  panel.becomesKeyOnlyIfNeeded = true;
  panel.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorFullScreenAuxiliary;
  var screen = $.NSScreen.mainScreen.visibleFrame;
  panel.setFrameOrigin($.NSMakePoint(screen.origin.x + screen.size.width - width - 18, screen.origin.y + screen.size.height - height - 18));
  var label = $.NSTextField.labelWithString("控制来源：" + controller + " · 最长 15 分钟");
  label.frame = $.NSMakeRect(16, 58, width - 32, 22);
  label.lineBreakMode = $.NSLineBreakByTruncatingMiddle;
  var button = $.NSButton.alloc.initWithFrame($.NSMakeRect(width - 156, 15, 140, 32));
  button.title = "立即终止远程操作";
  button.bezelStyle = $.NSBezelStyleRounded;
  button.target = app;
  button.action = "terminate:";
  panel.contentView.addSubview(label);
  panel.contentView.addSubview(button);
  panel.orderFrontRegardless;
  $("ready").writeToFileAtomicallyEncodingError($(readyPath), true, $.NSUTF8StringEncoding, null);
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(seconds, app, "terminate:", null, false);
  app.run;
  return "STOPPED";
}`;

async function waitForIndicator(child: ChildProcess, readyPath: string, signal: AbortSignal): Promise<void> {
  let exited = false;
  let spawnError: Error | null = null;
  child.once("exit", () => { exited = true; });
  child.once("error", (error) => { spawnError = error; });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("macOS GUI control request was cancelled");
    if (spawnError) throw spawnError;
    if (exited) throw new Error("macOS GUI control indicator exited before it became visible");
    try {
      await access(readyPath);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("macOS GUI control indicator did not become visible");
}

async function imageDimensions(imagePath: string, signal: AbortSignal): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", imagePath], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
    encoding: "utf8",
    signal,
  });
  const width = Number(String(stdout).match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(String(stdout).match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("cannot read captured screen dimensions");
  }
  return { width, height };
}

export const MAIN_SCREEN_SIZE_JXA = String.raw`
function run() {
  ObjC.import("AppKit");
  // screencapture -m captures the primary display, not the keyboard-focus screen.
  var frame = $.NSScreen.screens.objectAtIndex(0).frame;
  return JSON.stringify({ width: Number(frame.size.width), height: Number(frame.size.height) });
}`;

async function mainScreenPointSize(signal: AbortSignal): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAIN_SCREEN_SIZE_JXA], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
    encoding: "utf8",
    signal,
  });
  const value = JSON.parse(String(stdout)) as { width?: unknown; height?: unknown };
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("cannot read main-screen coordinate space");
  }
  return { width, height };
}

function boundedText(value: unknown, maxBytes: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text && Buffer.byteLength(text, "utf8") <= maxBytes ? text : "";
}

function boundedNumber(value: unknown, min: number, max: number, name: string): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

function boundedInteger(value: unknown, min: number, max: number, name: string): number {
  const number = boundedNumber(value, min, max, name);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}
