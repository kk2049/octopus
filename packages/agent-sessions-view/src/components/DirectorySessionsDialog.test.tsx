import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectorySessionsDialog, type DirectorySessionsDialogProps } from "./DirectorySessionsDialog.js";

afterEach(() => document.querySelectorAll("[data-test-anchor]").forEach((node) => node.remove()));

function setup(anchorLeft = 400, surface?: HTMLElement) {
  const anchor = document.createElement("button");
  anchor.dataset.testAnchor = "";
  (surface ?? document.body).append(anchor);
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
    x: anchorLeft, y: 100, left: anchorLeft, right: anchorLeft + 24,
    top: 100, bottom: 124, width: 24, height: 24, toJSON: () => ({}),
  });
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("innerHeight", 768);
  const anchorRef = createRef<HTMLElement>();
  anchorRef.current = anchor;
  const props: DirectorySessionsDialogProps = {
    open: true, directoryLabel: "项目", matches: [], selected: null, pinned: [],
    anchorRef, onClose: vi.fn(), onSelect: vi.fn(),
  };
  const view = render(<DirectorySessionsDialog {...props} />);
  const edge = (side: "左" | "右") => screen.getByRole("separator", { name: `拖动${side}边框调整会话列表宽度` });
  const start = (side: "左" | "右", clientX: number) => {
    const handle = edge(side);
    Object.defineProperty(handle, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(handle, "releasePointerCapture", { configurable: true, value: vi.fn() });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX });
    return handle;
  };
  return { ...view, props, edge, start, dialog: () => screen.getByRole("dialog", { name: "「项目」下的会话" }) };
}

describe("directory session popover resizing", () => {
  it("drags the right border without moving the left border or closing the list", () => {
    const view = setup();
    expect(view.dialog()).toHaveStyle({ left: "430px", width: "240px" });
    const handle = view.start("右", 670);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 800 });
    expect(view.dialog()).toHaveStyle({ left: "430px", width: "370px" });
    expect(handle).toHaveAttribute("aria-valuenow", "370");
    expect(view.props.onClose).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    expect(view.dialog()).toHaveStyle({ width: "370px" });
    expect(document.body).not.toHaveClass("av-resizing-x");
  });

  it("drags the left border while holding the opposite border in place", () => {
    const view = setup(900);
    expect(view.dialog()).toHaveStyle({ left: "654px", width: "240px" });
    const handle = view.start("左", 654);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 454 });
    expect(view.dialog()).toHaveStyle({ left: "454px", width: "440px" });
    fireEvent.pointerUp(handle, { pointerId: 1 });
  });

  it.each(["左", "右"] as const)("bounds the %s border by the viewport and minimum readable width", (side) => {
    const view = setup();
    const handle = view.start(side, side === "左" ? 430 : 670);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: side === "左" ? -500 : 2000 });
    expect(view.dialog()).toHaveStyle(side === "左"
      ? { left: "8px", width: "662px" }
      : { left: "430px", width: "586px" });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: side === "左" ? 2000 : -500 });
    expect(view.dialog()).toHaveStyle({ left: "430px", width: "240px" });
    fireEvent.pointerUp(handle, { pointerId: 1 });
  });

  it("keeps the user's size through data updates and reopening, and restores it after a narrow viewport", () => {
    const view = setup();
    const handle = view.start("右", 670);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    view.rerender(<DirectorySessionsDialog {...view.props} matches={[]} selected="another-session" />);
    expect(view.dialog()).toHaveStyle({ width: "470px" });
    view.rerender(<DirectorySessionsDialog {...view.props} open={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<DirectorySessionsDialog {...view.props} />);
    expect(view.dialog()).toHaveStyle({ width: "470px" });
    vi.stubGlobal("innerWidth", 200);
    fireEvent.resize(window);
    expect(view.dialog()).toHaveStyle({ left: "8px", width: "184px" });
    vi.stubGlobal("innerWidth", 1024);
    fireEvent.resize(window);
    expect(view.dialog()).toHaveStyle({ left: "430px", width: "470px" });
  });

  it("supports keyboard adjustment on both borders and double-click reset", () => {
    const view = setup();
    fireEvent.keyDown(view.edge("右"), { key: "ArrowRight", shiftKey: true });
    expect(view.dialog()).toHaveStyle({ left: "430px", width: "280px" });
    fireEvent.keyDown(view.edge("左"), { key: "ArrowLeft" });
    expect(view.dialog()).toHaveStyle({ left: "420px", width: "290px" });
    fireEvent.doubleClick(view.edge("左"));
    expect(view.dialog()).toHaveStyle({ left: "430px", width: "240px" });
  });

  it.each(["pointerCancel", "lostPointerCapture", "blur", "resize", "close", "unmount"] as const)("cleans up an active drag on %s", (end) => {
    const view = setup();
    const handle = view.start("右", 670);
    expect(document.body).toHaveClass("av-resizing-x");
    if (end === "close") view.rerender(<DirectorySessionsDialog {...view.props} open={false} />);
    else if (end === "unmount") view.unmount();
    else if (end === "blur") fireEvent.blur(window);
    else if (end === "resize") {
      vi.stubGlobal("innerWidth", 200);
      fireEvent.resize(window);
    }
    else fireEvent[end](handle, { pointerId: 1 });
    expect(document.body).not.toHaveClass("av-resizing-x");
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    if (end !== "close" && end !== "unmount") expect(view.dialog()).toHaveStyle({ width: end === "resize" ? "184px" : "240px" });
  });

  it("ignores other pointer IDs and secondary buttons while preserving dismissal", () => {
    const view = setup();
    fireEvent.pointerDown(view.edge("右"), { pointerId: 2, button: 2, clientX: 670 });
    expect(document.body).not.toHaveClass("av-resizing-x");
    const handle = view.start("右", 670);
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 900 });
    fireEvent.pointerUp(handle, { pointerId: 2 });
    expect(view.dialog()).toHaveStyle({ width: "240px" });
    expect(document.body).toHaveClass("av-resizing-x");
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(view.props.onClose).toHaveBeenCalledTimes(2);
  });
});


it("keeps the directory portal and drag styling inside its App surface", () => {
  const surface = document.createElement("section");
  surface.dataset.appSurface = "sessions-plus";
  document.body.append(surface);
  try {
    const view = setup(400, surface);
    expect(view.dialog().parentElement).toBe(surface);
    const handle = view.start("右", 670);
    expect(surface).toHaveClass("av-resizing-x");
    expect(document.body).not.toHaveClass("av-resizing-x");
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(surface).not.toHaveClass("av-resizing-x");
    view.unmount();
  } finally { surface.remove(); }
});
