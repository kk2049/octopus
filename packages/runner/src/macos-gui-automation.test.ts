import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  MacGuiAutomationController,
  NativeMacGuiAutomationBackend,
  POINTER_ACTION_JXA,
  MAIN_SCREEN_SIZE_JXA,
  type MacGuiAutomationBackend,
  type MacGuiIndicator,
  type MacGuiPointerAction,
} from "./macos-gui-automation.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function backendFixture(options: { consent?: boolean } = {}) {
  const stopped = deferred();
  const indicator: MacGuiIndicator = {
    stopped: stopped.promise,
    close: vi.fn(),
  };
  const pointers: MacGuiPointerAction[] = [];
  const backend: MacGuiAutomationBackend = {
    available: true,
    requestConsent: vi.fn(async () => options.consent ?? true),
    preflightPermissions: vi.fn(async () => undefined),
    openIndicator: vi.fn(async () => indicator),
    captureScreen: vi.fn(async () => ({
      media_type: "image/jpeg" as const,
      data: "aW1hZ2U=",
      width: 1000,
      height: 500,
      pointWidth: 500,
      pointHeight: 250,
      captured_at: "2026-09-03T00:00:00.000Z",
      coordinate_space: { origin: "top_left" as const, width: 1000, height: 500, display: "main" as const },
    })),
    pointer: vi.fn(async (action) => { pointers.push(action); }),
    typeText: vi.fn(async () => undefined),
    keyPress: vi.fn(async () => undefined),
  };
  return { backend, indicator, pointers, stopped };
}

describe("MacGuiAutomationController", () => {
  it("requires Dashboard exposure and target-local consent before opening a bounded lease", async () => {
    const { backend } = backendFixture();
    const controller = new MacGuiAutomationController(backend, { now: () => 1_000, grantTtlMs: 900_000 });
    await expect(controller.requestControl({ controller_label: "Codex on source" }))
      .rejects.toThrow("not exposed");

    controller.setExposed(true);
    const opened = await controller.requestControl({ controller_label: "Codex on source" });
    expect(opened).toMatchObject({ granted: true, expires_at: new Date(901_000).toISOString() });
    expect(opened.grant_id).toMatch(/^gui_[0-9a-f]{32}$/);
    expect(backend.requestConsent).toHaveBeenCalledWith("Codex on source", expect.any(AbortSignal));
    expect(backend.preflightPermissions).toHaveBeenCalledOnce();
    expect(backend.openIndicator).toHaveBeenCalledOnce();
  });

  it("does not preflight or open an indicator when the target user denies consent", async () => {
    const { backend } = backendFixture({ consent: false });
    const controller = new MacGuiAutomationController(backend);
    controller.setExposed(true);
    await expect(controller.requestControl({ controller_label: "Agent" }))
      .resolves.toEqual({ granted: false, reason: "user_denied" });
    expect(backend.preflightPermissions).not.toHaveBeenCalled();
    expect(backend.openIndicator).not.toHaveBeenCalled();
  });

  it("requires a fresh capture for coordinates and maps image pixels to macOS points", async () => {
    const { backend, pointers } = backendFixture();
    const controller = new MacGuiAutomationController(backend);
    controller.setExposed(true);
    const opened = await controller.requestControl({ controller_label: "Agent" });
    const grant_id = opened.grant_id!;
    await expect(controller.click({ grant_id, x: 600, y: 200 }))
      .rejects.toThrow("capture_screen must succeed");

    const captured = await controller.captureScreen({ grant_id });
    expect(captured).not.toHaveProperty("pointWidth");
    await controller.click({ grant_id, x: 600, y: 200, click_count: 2 });
    expect(pointers).toEqual([{
      kind: "click",
      point: { x: 300, y: 100 },
      button: "left",
      clickCount: 2,
    }]);
    await expect(controller.click({ grant_id, x: 10, y: 10 }))
      .rejects.toThrow("capture_screen must succeed");
  });

  it("ends the lease and closes the visible indicator on local stop or Dashboard disable", async () => {
    const first = backendFixture();
    const controller = new MacGuiAutomationController(first.backend);
    controller.setExposed(true);
    const opened = await controller.requestControl({ controller_label: "Agent" });
    first.stopped.resolve();
    await vi.waitFor(() => expect(first.indicator.close).toHaveBeenCalledOnce());
    await expect(controller.captureScreen({ grant_id: opened.grant_id }))
      .rejects.toThrow("not active");

    const second = backendFixture();
    const next = new MacGuiAutomationController(second.backend);
    next.setExposed(true);
    const nextOpened = await next.requestControl({ controller_label: "Agent" });
    next.setExposed(false);
    expect(second.indicator.close).toHaveBeenCalledOnce();
    await expect(next.typeText({ grant_id: nextOpened.grant_id, text: "secret" }))
      .rejects.toThrow("not active");
  });

  it("aborts an in-flight native action when the target user stops control", async () => {
    const fixture = backendFixture();
    const started = deferred();
    fixture.backend.pointer = vi.fn(async (_action, signal) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("native action aborted")), { once: true });
      });
    });
    const controller = new MacGuiAutomationController(fixture.backend);
    controller.setExposed(true);
    const opened = await controller.requestControl({ controller_label: "Agent" });
    await controller.captureScreen({ grant_id: opened.grant_id });
    const click = controller.click({ grant_id: opened.grant_id, x: 10, y: 10 });
    await started.promise;
    fixture.stopped.resolve();
    await expect(click).rejects.toThrow("native action aborted");
    expect(fixture.indicator.close).toHaveBeenCalledOnce();
  });

  it("serializes physical desktop operations within one consent lease", async () => {
    const fixture = backendFixture();
    const started = deferred();
    const finish = deferred();
    fixture.backend.captureScreen = vi.fn(async () => {
      started.resolve();
      await finish.promise;
      return {
        media_type: "image/jpeg" as const,
        data: "aW1hZ2U=",
        width: 1000,
        height: 500,
        pointWidth: 500,
        pointHeight: 250,
        captured_at: "2026-09-03T00:00:00.000Z",
        coordinate_space: { origin: "top_left" as const, width: 1000, height: 500, display: "main" as const },
      };
    });
    const controller = new MacGuiAutomationController(fixture.backend);
    controller.setExposed(true);
    const opened = await controller.requestControl({ controller_label: "Agent" });
    const capture = controller.captureScreen({ grant_id: opened.grant_id });
    await started.promise;
    await expect(controller.typeText({ grant_id: opened.grant_id, text: "blocked" }))
      .rejects.toThrow("already in progress");
    finish.resolve();
    await capture;
  });
});

// Execute the shipped script against a fake bridge: no osascript, screen capture,
// TCC request or desktop input. This tests ordering/arguments, not macOS's ABI.
function pointerBridge() {
  const calls: string[] = [];
  const post = vi.fn((_: number, event: unknown) => { calls.push("post"); void event; });
  const mouse = vi.fn((_source: unknown, type: number, point: unknown, button: number) => {
    calls.push("create");
    return { type, point, button, isNil: (): boolean => false };
  });
  const scroll = vi.fn((..._args: unknown[]) => ({ isNil: (): boolean => false }));
  const fields = vi.fn();
  const sleep = vi.fn();
  const imports = vi.fn();
  const run = (action: MacGuiPointerAction) => runInNewContext(`${POINTER_ACTION_JXA}; run(argv)`, {
    argv: [JSON.stringify(action)], ObjC: { import: imports },
    $: {
      AXIsProcessTrusted: () => true,
      CGEventCreateMouseEvent: mouse,
      CGEventSetIntegerValueField: fields,
      CGEventCreateScrollWheelEvent2: scroll,
      CGEventPost: post,
      NSThread: { sleepForTimeInterval: sleep },
      CFRelease: () => { throw new Error("manual release is unsafe for an opaque bridge wrapper"); },
    },
  });
  return { run, calls, mouse, scroll, fields, post, sleep, imports };
}

const point = { x: 1026.703125, y: 916.1666666666666 };
const singleClick: MacGuiPointerAction = { kind: "click", point, button: "left", clickCount: 1 };

describe("native pointer script without desktop input", () => {
  it("builds both fractional-point mouse events before posting, without manual bridge release", () => {
    const bridge = pointerBridge();
    expect(bridge.run(singleClick)).toBe("OK");
    expect(bridge.imports).toHaveBeenCalledWith("CoreGraphics");
    expect(bridge.mouse.mock.calls).toEqual([[null, 1, point, 0], [null, 2, point, 0]]);
    expect(bridge.calls).toEqual(["create", "create", "post", "post"]);
    expect(bridge.fields.mock.calls.map((call) => call.slice(1))).toEqual([[1, 1], [1, 1]]);
    expect(bridge.sleep).toHaveBeenCalledWith(0.035);
  });

  it("keeps right double-click event types, click states and pause order", () => {
    const bridge = pointerBridge();
    bridge.run({ ...singleClick, button: "right", clickCount: 2 });
    expect(bridge.mouse.mock.calls.map((call) => [call[1], call[3]])).toEqual([[3, 1], [4, 1], [3, 1], [4, 1]]);
    expect(bridge.fields.mock.calls.map((call) => call[2])).toEqual([1, 1, 2, 2]);
    expect(bridge.sleep.mock.calls).toEqual([[0.035], [0.08], [0.035]]);
  });

  it("constructs fixed-arity signed scroll axes before moving the cursor", () => {
    const bridge = pointerBridge();
    bridge.run({ kind: "scroll", point, deltaX: -7, deltaY: 0 });
    expect(bridge.scroll).toHaveBeenCalledWith(null, 1, 2, 0, -7, 0);
    expect(bridge.post).toHaveBeenCalledTimes(2);
    const failed = pointerBridge();
    failed.scroll.mockImplementation(() => { throw new Error("bridge function unavailable"); });
    expect(() => failed.run({ kind: "scroll", point, deltaX: 0, deltaY: -2 }))
      .toThrow("stage=create_scroll attempted=0 posted=0");
    expect(failed.post).not.toHaveBeenCalled();
  });

  it("bounds a drag to 63 events and reaches its exact endpoint", () => {
    const bridge = pointerBridge();
    bridge.run({ kind: "drag", from: { x: 0, y: 0 }, to: point, durationMs: 2000 });
    expect(bridge.mouse).toHaveBeenCalledTimes(63);
    expect(bridge.mouse.mock.calls.at(-2)).toEqual([null, 6, point, 0]);
    expect(bridge.mouse.mock.calls.at(-1)).toEqual([null, 2, point, 0]);
    expect(bridge.post).toHaveBeenCalledTimes(63);
  });

  it("recognizes a truthy bridged nil before any event is posted", () => {
    const bridge = pointerBridge();
    bridge.mouse.mockImplementationOnce((_source, type, point, button) => ({ type, point, button, isNil: () => true }));
    expect(() => bridge.run(singleClick)).toThrow("stage=create_mouse attempted=0 posted=0: Error: cannot create event");
    expect(bridge.post).not.toHaveBeenCalled();
  });

  it("does not send mouse-down when preparing mouse-up fails", () => {
    const bridge = pointerBridge();
    bridge.fields.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error("native field failure"); });
    expect(() => bridge.run(singleClick)).toThrow("stage=click_state attempted=0 posted=0");
    expect(bridge.post).not.toHaveBeenCalled();
  });

  it("records partial post attempts and never retries or sends compensating events", () => {
    const bridge = pointerBridge();
    bridge.post.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error("native post failure"); });
    expect(() => bridge.run(singleClick)).toThrow("stage=post attempted=2 posted=1: Error: native post failure");
    expect(bridge.post).toHaveBeenCalledTimes(2);
    const paused = pointerBridge();
    paused.sleep.mockImplementation(() => { throw new Error("pause failed"); });
    expect(() => paused.run(singleClick)).toThrow("stage=pause attempted=1 posted=1");
    expect(paused.post).toHaveBeenCalledOnce();
  });
});

describe("native input diagnostics", () => {
  it("retains bounded stderr and exit metadata instead of the echoed script and arguments", async () => {
    const execute = vi.fn(async () => { throw Object.assign(new Error(`Command failed: ${POINTER_ACTION_JXA}`), {
      code: 1, stderr: `stage=post attempted=2 posted=1: native error /Users/private/Desktop/file token=secret-value`,
    }); });
    const backend = new NativeMacGuiAutomationBackend(execute);
    const error = await backend.pointer(singleClick, new AbortController().signal).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("exit=1");
    expect(message).toContain("stage=post attempted=2 posted=1");
    expect(message).toContain("input outcome unknown; do not retry automatically");
    expect(message).not.toMatch(/function run|secret-value|Users\/private/);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("redacts typed text, quoted native values and paths before bounding the error", async () => {
    const secret = "private input\nsecond line";
    const execute = vi.fn(async () => { throw Object.assign(new Error("Command failed: secret command"), {
      code: 1, stderr: `${secret} ${JSON.stringify(secret)} "private title" /private/tmp/file ` + "x".repeat(2000) + " native exception -1743",
    }); });
    const backend = new NativeMacGuiAutomationBackend(execute);
    const error = await backend.typeText(secret, new AbortController().signal).catch((error: Error) => error);
    const message = (error as Error).message;
    expect(message).toContain("native exception -1743");
    expect(message).not.toMatch(/private input|second line|private title|secret command|private\/tmp/);
    expect(message.length).toBeLessThan(1000);
  });

  it("redacts even short input echoed by the native error", async () => {
    const backend = new NativeMacGuiAutomationBackend(async () => {
      throw Object.assign(new Error("Command failed"), { stderr: "cannot type 密码" });
    });
    await expect(backend.typeText("密码", new AbortController().signal)).rejects.toThrow("cannot type [argument]");
  });

  it("handles killed processes with no stderr without leaking the command or replaying", async () => {
    const execute = vi.fn(async () => { throw Object.assign(new Error("Command failed: private-script private-value"), {
      code: null, signal: "SIGTERM", killed: true,
    }); });
    const backend = new NativeMacGuiAutomationBackend(execute);
    await expect(backend.keyPress("enter", [], new AbortController().signal))
      .rejects.toThrow("exit=unknown, signal=SIGTERM, killed=true");
    expect(execute).toHaveBeenCalledOnce();
    await expect(backend.typeText("private-value", new AbortController().signal))
      .rejects.toThrow("native process returned no diagnostic");
  });

  it("refuses a pointer process without the completion acknowledgement", async () => {
    const backend = new NativeMacGuiAutomationBackend(async () => ({ stdout: "" }));
    await expect(backend.pointer(singleClick, new AbortController().signal))
      .rejects.toThrow("missing native completion acknowledgement");
  });
});

describe("main-display pixels and failure revocation", () => {
  it("uses the primary display even when another screen has keyboard focus", () => {
    const result = runInNewContext(`${MAIN_SCREEN_SIZE_JXA}; run()`, {
      ObjC: { import: vi.fn() },
      $: { NSScreen: {
        mainScreen: { frame: { size: { width: 800, height: 600 } } },
        screens: { objectAtIndex: (index: number) => {
          expect(index).toBe(0);
          return { frame: { size: { width: 1470, height: 956 } } };
        } },
      } },
    });
    expect(JSON.parse(result)).toEqual({ width: 1470, height: 956 });
  });

  it("reproduces the ticket's resized Retina conversion and rejects image-edge overflow", async () => {
    const { backend, pointers } = backendFixture();
    const capture = await backend.captureScreen(new AbortController().signal);
    vi.mocked(backend.captureScreen).mockResolvedValue({ ...capture, width: 1920, height: 1248, pointWidth: 1470, pointHeight: 956 });
    const controller = new MacGuiAutomationController(backend);
    controller.setExposed(true);
    const { grant_id } = await controller.requestControl({ controller_label: "Agent" });
    await controller.captureScreen({ grant_id });
    await expect(controller.click({ grant_id, x: 1920, y: 0 })).rejects.toThrow("x must be between");
    await expect(controller.click({ grant_id, x: 0, y: 1248 })).rejects.toThrow("y must be between");
    await controller.click({ grant_id, x: 1341, y: 1196 });
    expect(pointers).toEqual([singleClick]);
    controller.close();
  });

  it("revokes locally on a partial input failure and never reuses its capture or consent", async () => {
    const { backend, indicator } = backendFixture();
    const failure = new Error("stage=post attempted=2 posted=1; input outcome unknown");
    vi.mocked(backend.pointer).mockRejectedValue(failure);
    const controller = new MacGuiAutomationController(backend);
    controller.setExposed(true);
    const { grant_id } = await controller.requestControl({ controller_label: "Agent" });
    await controller.captureScreen({ grant_id });
    await expect(controller.click({ grant_id, x: 1, y: 2 })).rejects.toBe(failure);
    expect(indicator.close).toHaveBeenCalledOnce();
    await expect(controller.captureScreen({ grant_id })).rejects.toThrow("not active");
    await expect(controller.click({ grant_id, x: 1, y: 2 })).rejects.toThrow("not active");
    expect(backend.pointer).toHaveBeenCalledOnce();
    expect(backend.requestConsent).toHaveBeenCalledOnce();
    expect(controller.releaseControl({ grant_id })).toEqual({ released: false });
  });

  it("keeps the native failure when indicator cleanup throws synchronously", async () => {
    const { backend, indicator } = backendFixture();
    vi.mocked(indicator.close).mockImplementation(() => { throw new Error("indicator close failed"); });
    const failure = new Error("native input failed; outcome unknown");
    vi.mocked(backend.typeText).mockRejectedValue(failure);
    const controller = new MacGuiAutomationController(backend);
    controller.setExposed(true);
    const { grant_id } = await controller.requestControl({ controller_label: "Agent" });
    await expect(controller.typeText({ grant_id, text: "text" })).rejects.toBe(failure);
    await expect(controller.captureScreen({ grant_id })).rejects.toThrow("not active");
  });

  it("expires an untouched lease at fifteen minutes without renewing consent", async () => {
    const { backend, indicator } = backendFixture();
    let now = 1000;
    const controller = new MacGuiAutomationController(backend, { now: () => now });
    controller.setExposed(true);
    const { grant_id } = await controller.requestControl({ controller_label: "Agent" });
    now += 900_000;
    await expect(controller.captureScreen({ grant_id })).rejects.toThrow("not active");
    expect(indicator.close).toHaveBeenCalledOnce();
    expect(backend.captureScreen).not.toHaveBeenCalled();
    expect(backend.requestConsent).toHaveBeenCalledOnce();
  });
});
