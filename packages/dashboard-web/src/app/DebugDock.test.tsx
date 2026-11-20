/**
 * Ticket #207 — where the 🐞 entry lives on a phone.
 *
 * The dock's floating trigger is pinned to the bottom-right corner, which is
 * also where a narrow page puts its own primary action; the report button was
 * covering it on every screen the shell renders. The fix is not "make it
 * smaller": the narrow-viewport entry moved into the shell's menu card, and the
 * floating circle became a wide-viewport affordance.
 *
 * That split is half React and half stylesheet, so this file tests both halves:
 *
 *  · the menu entry is really inside `#mobile-navigation` (the collapsible
 *    card), it opens the dock's panel, and it closes the card on the way — a
 *    trigger that leaves the menu covering its own panel is not an entry;
 *  · both triggers drive ONE panel. `open` moved up into `Shell` for exactly
 *    this reason, so the assertion that matters is that the dock renders a
 *    single panel no matter which of the two was pressed;
 *  · the media queries, statically. jsdom applies no media query and paints
 *    nothing, so `display: none` at ≤720px is unobservable through the DOM —
 *    but it is observable in the stylesheet, and a rule that quietly stops
 *    hiding the floating button is precisely the regression that puts the 🐞
 *    back on top of the page's own button.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap } from "../lib/bootstrap.js";
import { applyLanguage } from "../i18n/language.js";
import { renderPage, stubApi } from "../test-utils.js";
import { Shell } from "./Shell.js";
import { captureScreenshot } from "../lib/element-picker.js";
import { uploadAttachment, releaseAttachment, type Attachment } from "../lib/attachments.js";

vi.mock("../lib/element-picker.js", async (original) => ({
  ...await original<typeof import("../lib/element-picker.js")>(),
  captureScreenshot: vi.fn(), screenCaptureSupported: () => true,
}));
vi.mock("../lib/attachments.js", async (original) => ({
  ...await original<typeof import("../lib/attachments.js")>(),
  uploadAttachment: vi.fn(), releaseAttachment: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const screenshotFile = new File(["screen"], "screen.png", { type: "image/png" });
const screenshotAttachment: Attachment = { id: "debug-screen", label: "screen.png", path: "/service/staged/screen.png",
  bytes: 6, mediaType: "image/png", previewUrl: "blob:screen" };


// Read as text rather than through the CSS Module import: the transform hands
// back a class-name map, and the question here is what the rules say.
const HERE = dirname(fileURLToPath(import.meta.url));
const dockCss = readFileSync(join(HERE, "DebugDock.module.css"), "utf8");
const shellCss = readFileSync(join(HERE, "Shell.module.css"), "utf8");

const NARROW = "@media (max-width: 720px)";
const VIEWPORT_TEST_MARGIN = 8;

/** The body of the narrow-viewport media block, and the stylesheet without it. */
function splitNarrow(css: string): { narrow: string; wide: string } {
  const start = css.indexOf(NARROW);
  expect(start, `${NARROW} block is missing`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return { narrow: css.slice(start, end), wide: css.slice(0, start) + css.slice(end) };
}

/** Declarations of every rule whose selector list mentions `fragment`. */
function declarationsFor(css: string, fragment: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((rule) => rule[1]!.split(",").some((selector) => selector.includes(fragment)))
    .map((rule) => rule[2]!.replace(/\s+/g, " ").trim());
}

function asDev(): void {
  const payload = bootstrap as unknown as {
    approvals: boolean;
    features: string[];
    viewer: { dev: boolean };
  };
  // The approval chrome is a separate queue with its own polling; this file is
  // about the dock, so the shell renders without it.
  payload.approvals = false;
  payload.features = ["dev-pipeline"];
  payload.viewer.dev = true;
}

describe("debug dock entry in the shell", () => {
  beforeEach(() => {
    vi.mocked(captureScreenshot).mockReset();
    vi.mocked(uploadAttachment).mockReset();
    vi.mocked(releaseAttachment).mockClear();
    applyLanguage("zh-CN");
    asDev();
    stubApi({
      "/api/tickets": { models: ["codex-gpt-6-astra", "omp-gpt-5.6-sol"], efforts: ["high", "xhigh"], model_default: "codex-gpt-6-astra", effort_default: "xhigh" },
      "/api/dev/quota": { cards: [] },
      "/api/dev/system-status": { cpuPercent: 20, memoryPercent: 40, windowMs: 10_000, sampledAt: "2026-08-21T12:00:00Z" },
      "/api/deploy/active": {},
    });
  });

  it("puts the report entry inside the collapsible menu card, not loose in the bar", () => {
    renderPage(<Shell>页面</Shell>, "/tickets");

    const entry = document.querySelector("#debugDockMenuEntry");
    expect(entry).not.toBeNull();
    expect(entry!.closest("#mobile-navigation")).not.toBeNull();
  });

  it("localizes the draggable trigger without rebuilding the dock", () => {
    renderPage(<Shell>页面</Shell>, "/tickets");
    const toggle = document.querySelector("#debugDockToggle") as HTMLButtonElement;
    expect(toggle).toHaveAccessibleName("报告这个页面的问题");

    fireEvent.click(screen.getByText("状态与偏好"));
    fireEvent.change(screen.getByRole("combobox", { name: "语言" }), { target: { value: "en" } });
    expect(toggle).toHaveAccessibleName("Report a problem with this page");
    expect(toggle).toHaveAttribute("title", "Drag to move; click to report a problem with this page");
  });

  it("nests one expandable status region inside the existing mobile navigation card", () => {
    renderPage(<Shell>页面</Shell>, "/tickets");
    const status = screen.getByTestId("status-and-preferences");
    expect(status.closest("#mobile-navigation")).not.toBeNull();
    expect(status).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("状态与偏好"));
    expect(status).toHaveAttribute("open");
    expect(screen.getByRole("combobox", { name: "语言" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "主题" })).toBeInTheDocument();
  });

  it("opens the one dock panel from the menu and closes the menu behind it", async () => {
    const user = userEvent.setup();
    renderPage(<Shell>页面</Shell>, "/tickets");

    await user.click(screen.getByRole("button", { name: "打开主导航" }));
    expect(screen.getByRole("button", { name: "关闭主导航" })).toHaveAttribute("aria-expanded", "true");

    await user.click(document.querySelector("#debugDockMenuEntry") as HTMLElement);

    await waitFor(() => {
      expect(screen.getAllByRole("region", { name: "报告界面问题" })).toHaveLength(1);
    });
    expect(screen.getByRole("button", { name: "打开主导航" })).toHaveAttribute("aria-expanded", "false");
  });

  it("closes that same panel from the panel's own ✕", async () => {
    const user = userEvent.setup();
    renderPage(<Shell>页面</Shell>, "/tickets");

    await user.click(document.querySelector("#debugDockMenuEntry") as HTMLElement);
    await screen.findByRole("region", { name: "报告界面问题" });

    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("region", { name: "报告界面问题" })).toBeNull();
  });

  it("keeps a plain click while a drag moves the floating trigger without opening the panel", async () => {
    renderPage(<Shell>页面</Shell>, "/tickets");

    const toggle = document.querySelector("#debugDockToggle") as HTMLButtonElement;
    const capture = vi.fn();
    Object.defineProperty(toggle, "setPointerCapture", { configurable: true, value: capture });
    Object.defineProperty(toggle, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 940,
        y: 700,
        left: 940,
        top: 700,
        right: 984,
        bottom: 744,
        width: 44,
        height: 44,
        toJSON: () => ({}),
      }),
    });

    // No travel: it is still the ordinary accessible button action.
    fireEvent.pointerDown(toggle, { pointerId: 7, button: 0, clientX: 960, clientY: 720 });
    fireEvent.pointerUp(toggle, { pointerId: 7, button: 0, clientX: 960, clientY: 720 });
    fireEvent.click(toggle);
    expect(await screen.findByRole("region", { name: "报告界面问题" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    // Dragging well beyond the viewport clamps the whole 44px trigger to the
    // margin. The synthetic click emitted after pointerup must not reopen it.
    fireEvent.pointerDown(toggle, { pointerId: 8, button: 0, clientX: 960, clientY: 720 });
    fireEvent.pointerMove(toggle, { pointerId: 8, clientX: -4_000, clientY: -4_000 });
    expect(capture).toHaveBeenCalledWith(8);
    expect(toggle).toHaveStyle({
      transform: `translate(${VIEWPORT_TEST_MARGIN - 940}px, ${VIEWPORT_TEST_MARGIN - 700}px)`,
    });
    fireEvent.pointerUp(toggle, { pointerId: 8, button: 0, clientX: -4_000, clientY: -4_000 });
    fireEvent.click(toggle);
    expect(screen.queryByRole("region", { name: "报告界面问题" })).toBeNull();

    fireEvent.click(toggle);
    expect(await screen.findByRole("region", { name: "报告界面问题" })).toBeVisible();
  });

  it("files a simple first-party Codex xhigh ticket without a user-authored title", async () => {
    const user = userEvent.setup();
    const { calls } = stubApi({
      "/api/tickets": { models: ["codex-gpt-6-astra", "omp-gpt-5.6-sol"], efforts: ["high", "xhigh"], model_default: "codex-gpt-6-astra", effort_default: "xhigh" },
      "/api/dev/quota": { cards: [] },
      "/api/dev/system-status": { cpuPercent: 20, memoryPercent: 40, windowMs: 10_000, sampledAt: "2026-08-21T12:00:00Z" },
      "/api/deploy/active": {},
    });
    renderPage(<Shell>页面</Shell>, "/tickets");

    await user.click(document.querySelector("#debugDockMenuEntry") as HTMLElement);
    await user.type(screen.getByPlaceholderText(/描述问题与预期/), "按钮点了没有反应");
    await user.click(screen.getByRole("button", { name: "创建工单" }));

    await waitFor(() => expect(calls.some((call) => call.init?.method === "POST")).toBe(true));
    const request = calls.find((call) => call.init?.method === "POST")!.init!;
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("title");
    expect(payload).toMatchObject({ kind: "simple", model: "codex-gpt-6-astra", effort: "xhigh" });
  });

  it("consumes the report draft when a Fable approval receipt accepts it", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/tickets")) {
        const body = init?.method === "POST"
          ? {
              approval_required: true,
              pending_call_id: "pc_fable",
              message: "Fable 工单已提交 lht 审批；批准后才会创建并启动。",
            }
          : {
              models: ["claude-fable-5-1"],
              model_catalog: [{ id: "claude-fable-5-1", label: "Fable 5.1", family: "claude" }],
              efforts: ["high"],
              model_default: "claude-fable-5-1",
              effort_default: "high",
            };
        return new Response(JSON.stringify(body), {
          status: init?.method === "POST" ? 202 : 200,
          headers: { "content-type": "application/json" },
        });
      }
      const body = url.startsWith("/api/dev/system-status")
        ? { cpuPercent: 20, memoryPercent: 40, windowMs: 10_000, sampledAt: "2026-08-21T12:00:00Z" }
        : url.startsWith("/api/dev/quota") ? { cards: [] } : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    renderPage(<Shell>页面</Shell>, "/tickets");

    await user.click(document.querySelector("#debugDockMenuEntry") as HTMLElement);
    await screen.findByText("模型: Fable 5.1");
    const description = screen.getByPlaceholderText(/描述问题与预期/);
    await user.type(description, "原始 Fable 报告");
    await user.click(screen.getByRole("button", { name: "创建工单" }));

    expect(await screen.findByText(/提交 lht 审批/)).toBeVisible();
    expect(description).toHaveValue("");
    expect(screen.queryByRole("link", { name: /已创建工单/ })).toBeNull();
  });

  it("confirms a created ticket from the roster when its POST response is lost", async () => {
    const user = userEvent.setup();
    let submittedBody = "";
    let created = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/tickets")) {
        if (init?.method === "POST") {
          submittedBody = String(JSON.parse(String(init.body)).body);
          created = true;
          throw new TypeError("Load failed");
        }
        return new Response(JSON.stringify({
          models: ["omp-gpt-5.6-sol"],
          efforts: ["high"],
          tickets: created ? [{
            id: 394,
            body: submittedBody,
            requester: bootstrap.viewer.username,
            created_at: new Date().toISOString(),
          }] : [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = url.startsWith("/api/dev/system-status")
        ? { cpuPercent: 20, memoryPercent: 40, windowMs: 10_000, sampledAt: "2026-08-21T12:00:00Z" }
        : url.startsWith("/api/dev/quota") ? { cards: [] } : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    renderPage(<Shell>页面</Shell>, "/tickets");

    await user.click(document.querySelector("#debugDockMenuEntry") as HTMLElement);
    await user.type(screen.getByPlaceholderText(/描述问题与预期/), "按钮提交后误报失败");
    await user.click(screen.getByRole("button", { name: "创建工单" }));

    expect(await screen.findByRole("link", { name: /已创建工单 #394/ })).toBeVisible();
    expect(screen.queryByText("Load failed")).toBeNull();
    expect(vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("awaits screenshot capture and upload before accepting a report with its latest text and image", async () => {
    const user = userEvent.setup();
    const capture = deferred<File>();
    const upload = deferred<Attachment>();
    vi.mocked(captureScreenshot).mockReturnValue(capture.promise);
    vi.mocked(uploadAttachment).mockReturnValue(upload.promise);
    const { calls } = stubApi({
      "/api/tickets": { ticket: { id: 601 }, models: ["codex-gpt-6-astra"], efforts: ["xhigh"] },
      "/api/dev/quota": { cards: [] }, "/api/dev/system-status": {}, "/api/deploy/active": {},
    });
    renderPage(<Shell>页面</Shell>, "/tickets");
    await user.click(document.querySelector("#debugDockMenuEntry") as HTMLElement);
    const description = await screen.findByPlaceholderText(/描述问题与预期/);
    await user.type(description, "capture report");
    await user.click(document.querySelector("#debugDockShot") as HTMLElement);
    await user.click(screen.getByRole("button", { name: "创建工单" }));
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
    await user.type(description, " with latest detail");
    await act(async () => { capture.resolve(screenshotFile); });
    expect(uploadAttachment).toHaveBeenCalledWith(screenshotFile, expect.objectContaining({ current: expect.any(Function) }));
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
    await act(async () => { upload.resolve(screenshotAttachment); });
    await screen.findByRole("link", { name: /已创建工单 #601/ });
    const posts = calls.filter((call) => call.init?.method === "POST");
    expect(posts).toHaveLength(1);
    const payload = JSON.parse(String(posts[0]!.init!.body)) as { body: string };
    expect(payload.body).toContain("capture report with latest detail");
    expect(payload.body).toContain(screenshotAttachment.path);
    expect(description).toHaveValue("");
    expect(screen.queryByRole("link", { name: "screen.png" })).toBeNull();
    expect(vi.mocked(releaseAttachment).mock.calls.map(([item]) => item)).toContainEqual(screenshotAttachment);
  });

  it("discards a screenshot picker result after close without attaching it to the reopened dock", async () => {
    const user = userEvent.setup();
    const capture = deferred<File>();
    vi.mocked(captureScreenshot).mockReturnValue(capture.promise);
    renderPage(<Shell>页面</Shell>, "/tickets");
    await user.click(document.querySelector("#debugDockMenuEntry") as HTMLElement);
    await screen.findByRole("region", { name: "报告界面问题" });
    await user.click(document.querySelector("#debugDockShot") as HTMLElement);
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await user.click(document.querySelector("#debugDockMenuEntry") as HTMLElement);
    await screen.findByRole("region", { name: "报告界面问题" });
    await act(async () => { capture.resolve(screenshotFile); });
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "screen.png" })).toBeNull();
  });

  it("clears a picked element without starting a replacement pick", async () => {
    const user = userEvent.setup();
    renderPage(<Shell><div data-testid="page-target">页面</div></Shell>, "/tickets");

    await user.click(document.querySelector("#debugDockMenuEntry") as HTMLElement);
    await user.click(screen.getByRole("button", { name: "选取界面元素" }));
    await user.click(screen.getByTestId("page-target"));

    expect(await screen.findByRole("button", { name: "重新选取元素" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "取消选取" }));

    expect(screen.getByRole("button", { name: "选取界面元素" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "取消选取" })).toBeNull();
    expect(document.documentElement.style.cursor).toBe("");
  });

  it("renders no entry and no dock for a viewer without the dev pipeline", () => {
    (bootstrap as unknown as { features: string[] }).features = [];
    renderPage(<Shell>页面</Shell>, "/tickets");

    expect(document.querySelector("#debugDockMenuEntry")).toBeNull();
    expect(document.querySelector("#debugDockToggle")).toBeNull();
  });
});

describe("debug dock stylesheets", () => {
  it("hides the floating trigger below 720px so it cannot cover the page's own action", () => {
    const { narrow } = splitNarrow(dockCss);
    expect(declarationsFor(narrow, ".toggle").join(" ")).toMatch(/display:\s*none/);
  });

  it("centers the bug glyph without native button padding", () => {
    const toggle = declarationsFor(dockCss, ".toggle").join(" ");
    expect(toggle).toMatch(/display:\s*grid/);
    expect(toggle).toMatch(/place-items:\s*center/);
    expect(toggle).toMatch(/padding:\s*0/);
  });

  it("reserves touch gestures for dragging the floating trigger", () => {
    const toggle = declarationsFor(dockCss, ".toggle").join(" ");
    expect(toggle).toMatch(/touch-action:\s*none/);
    expect(toggle).toMatch(/cursor:\s*grab/);
  });

  it("hangs the phone panel from the top bar instead of the opposite corner", () => {
    const { narrow } = splitNarrow(dockCss);
    const dock = declarationsFor(narrow, ".dock").join(" ");
    expect(dock).toMatch(/top:/);
    expect(dock).toMatch(/bottom:\s*auto/);
  });

  it("shows the menu entry only below 720px, where the floating trigger is gone", () => {
    const { narrow, wide } = splitNarrow(shellCss);
    expect(declarationsFor(wide, ".debugEntry").join(" ")).toMatch(/display:\s*none/);
    const shown = declarationsFor(narrow, ".debugEntry").join(" ");
    expect(shown).toMatch(/display:\s*(flex|inline-flex)/);
    // The whole point of the move is a thumb-sized target in the card.
    expect(shown).toMatch(/min-height:\s*44px/);
  });
});

it("gives each filing picker a full-width grid row inside the viewport-capped panel", () => {
  const fields = declarationsFor(dockCss, ".fields").join(" ");
  expect(fields).toContain("display: grid");
  expect(fields).toContain("grid-template-columns: minmax(0, 1fr)");
  expect(fields).toContain("min-width: 0");
  expect(declarationsFor(dockCss, ".panel").join(" ")).toContain("calc(100vw - 32px)");
});
