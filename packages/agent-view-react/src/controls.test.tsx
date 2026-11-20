/**
 * The caret contract of the shared textarea.
 *
 * Ticket #189 reported it from a phone: "sometimes the cursor is not where the
 * text actually goes." These cases pin the mechanism rather than the anecdote —
 * a controlled write that collapses the DOM selection while the painted caret
 * stays put — and pin the one thing the fix must never do, which is touch the
 * selection while an IME composition is open.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { AvTextArea } from "./controls.js";

/**
 * One edit, as a browser performs it: the value changes AND the caret lands
 * where the person was typing.
 *
 * The prototype setter deliberately bypasses React's per-node value tracker,
 * which is the only way to dispatch an edit whose caret is not at the end —
 * assigning through the tracked property collapses the selection first, which
 * would make every case below trivially pass for the wrong reason.
 */
function editAt(area: HTMLTextAreaElement, value: string, caret: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(area, value);
  area.setSelectionRange(caret, caret);
  fireEvent.change(area);
}

/** A composition preview arrives as an input event before React's onChange. */
function composeAt(area: HTMLTextAreaElement, value: string, caret: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(area, value);
  area.setSelectionRange(caret, caret);
  fireEvent.input(area);
}

/** The committed candidate can arrive in a trailing input after compositionend. */
function commitAt(area: HTMLTextAreaElement, value: string, caret: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(area, value);
  area.setSelectionRange(caret, caret);
  fireEvent.input(area);
}

/**
 * A host that reproduces the browser half of the bug: after the edit it
 * reassigns the value and collapses the selection, exactly as a controlled
 * `value` write does when React reconciles the node.
 */
function CollapsingHost({ collapseTo }: { collapseTo: number }) {
  const [value, setValue] = useState("");
  const [, force] = useState(0);
  return (
    <>
      <AvTextArea
        aria-label="box"
        value={value}
        onChange={(event) => {
          const area = event.target;
          setValue(area.value);
          area.setSelectionRange(collapseTo, collapseTo);
        }}
      />
      <button type="button" onClick={() => force((n) => n + 1)}>重绘</button>
    </>
  );
}

function box(): HTMLTextAreaElement {
  return screen.getByLabelText("box") as HTMLTextAreaElement;
}

describe("AvTextArea caret guard", () => {
  it("keeps a mid-text caret instead of letting it jump to the end", () => {
    render(<CollapsingHost collapseTo={5} />);
    const area = box();
    area.focus();
    editAt(area, "abXcd", 3);
    expect(area.value).toBe("abXcd");
    expect(area.selectionStart).toBe(3);
    expect(area.selectionEnd).toBe(3);
  });

  it("keeps an end-of-text caret from being pulled backwards", () => {
    render(<CollapsingHost collapseTo={0} />);
    const area = box();
    area.focus();
    editAt(area, "abcd", 4);
    expect(area.selectionStart).toBe(4);
  });

  it("never moves the selection while an IME composition is open", () => {
    render(<CollapsingHost collapseTo={0} />);
    const area = box();
    area.focus();
    fireEvent.compositionStart(area);
    editAt(area, "ni", 2);
    // Whatever the IME and the host left behind stands: calling
    // setSelectionRange mid-composition is how a Gboard session is destroyed.
    expect(area.selectionStart).toBe(0);
    fireEvent.compositionEnd(area);
  });

  it("keeps both the committed IME text and caret at the preview position", async () => {
    render(<CollapsingHost collapseTo={0} />);
    const area = box();
    area.focus();
    editAt(area, "abcd", 4);
    area.setSelectionRange(2, 2);
    fireEvent.compositionStart(area);

    composeAt(area, "abzicd", 4);
    area.setSelectionRange(0, 0);
    expect(area.value).toBe("abzicd");

    composeAt(area, "ab字cd", 3);
    area.setSelectionRange(0, 0);
    fireEvent.compositionEnd(area);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(area.value).toBe("ab字cd");
    expect(area.selectionStart).toBe(3);
    expect(area.selectionEnd).toBe(3);
  });

  it("lets a delayed WebKit autocorrect input land before restoring the composition caret", async () => {
    render(<CollapsingHost collapseTo={0} />);
    const area = box();
    area.focus();
    editAt(area, "abcd", 4);
    area.setSelectionRange(2, 2);
    fireEvent.compositionStart(area);

    composeAt(area, "abzicd", 4);
    area.setSelectionRange(0, 0);
    fireEvent.compositionEnd(area);

    let selectionBeforeCommit = -1;
    queueMicrotask(() => {
      selectionBeforeCommit = area.selectionStart;
      // WebKit can commit the candidate plus its automatic space after the
      // compositionend handlers and their microtasks have been scheduled.
      commitAt(area, "ab字 cd", 0);
    });
    await Promise.resolve();

    expect(selectionBeforeCommit).toBe(0);
    expect(area.value).toBe("ab字 cd");
    expect(area.selectionStart).toBe(4);
    expect(area.selectionEnd).toBe(4);
  });

  it("maps the preview caret when the committed value arrives after compositionend", async () => {
    render(<CollapsingHost collapseTo={0} />);
    const area = box();
    area.focus();
    editAt(area, "abcd", 4);
    area.setSelectionRange(2, 2);
    fireEvent.compositionStart(area);

    composeAt(area, "abzicd", 4);
    area.setSelectionRange(0, 0);
    fireEvent.compositionEnd(area);
    commitAt(area, "ab字cd", 0);
    await Promise.resolve();

    expect(area.value).toBe("ab字cd");
    expect(area.selectionStart).toBe(3);
    expect(area.selectionEnd).toBe(3);
  });

  it("uses the preview suffix to map repeated committed text", async () => {
    render(<CollapsingHost collapseTo={0} />);
    const area = box();
    area.focus();
    editAt(area, "aaa", 3);
    area.setSelectionRange(1, 1);
    fireEvent.compositionStart(area);

    composeAt(area, "aaaaa", 3);
    area.setSelectionRange(0, 0);
    fireEvent.compositionEnd(area);
    commitAt(area, "aaaa", 0);
    await Promise.resolve();

    expect(area.value).toBe("aaaa");
    expect(area.selectionStart).toBe(2);
    expect(area.selectionEnd).toBe(2);
  });

  it("leaves a deliberate caret move alone across later renders", () => {
    render(<CollapsingHost collapseTo={4} />);
    const area = box();
    area.focus();
    editAt(area, "abcd", 4);
    // No edit — just the person putting the caret somewhere and something else
    // causing a render. Nothing was recorded, so nothing is restored.
    area.setSelectionRange(1, 1);
    fireEvent.click(screen.getByRole("button", { name: "重绘" }));
    expect(area.selectionStart).toBe(1);
  });

  it("does nothing to a textarea that is not focused", () => {
    render(<CollapsingHost collapseTo={0} />);
    const area = box();
    editAt(area, "abcd", 4);
    expect(area.selectionStart).toBe(0);
  });

  it("still forwards the ref to the real textarea element", () => {
    let captured: HTMLTextAreaElement | null = null;
    render(<AvTextArea aria-label="box" ref={(node) => { captured = node; }} />);
    expect(captured).toBe(box());
  });
});
