import { forwardRef, useLayoutEffect, useRef, type ComponentRef, type MutableRefObject, type Ref } from "react";
import Button, { type ButtonProps } from "antd/es/button";
import Checkbox, { type CheckboxProps } from "antd/es/checkbox";
import Input from "antd/es/input/Input";
import type { InputProps, InputRef } from "antd/es/input/Input";
import TextArea from "antd/es/input/TextArea";
import type { TextAreaProps, TextAreaRef } from "antd/es/input/TextArea";
import Tooltip, { type TooltipProps } from "antd/es/tooltip";
import { appPopupContainer } from "./popup-container.js";

export type AvButtonTone = "default" | "primary" | "danger" | "quiet";
export interface AvButtonProps extends Omit<ButtonProps, "type" | "danger" | "autoInsertSpace"> {
  tone?: AvButtonTone;
}

export function AvButton({ tone = "default", className, children, loading, disabled, ...props }: AvButtonProps) {
  const legacy = className?.split(/\s+/).find((name) => name === "primary" || name === "danger");
  const resolved = tone === "default" && legacy ? legacy : tone;
  return (
    <Button
      type={resolved === "primary" ? "primary" : resolved === "quiet" ? "text" : "default"}
      danger={resolved === "danger"}
      autoInsertSpace={false}
      className={["av-button", className].filter(Boolean).join(" ")}
      loading={loading}
      disabled={disabled || Boolean(loading)}
      {...props}
    >
      {children}
    </Button>
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as MutableRefObject<T | null>).current = value;
}

export const AvInput = forwardRef<HTMLInputElement, InputProps>(function AvInput(props, ref) {
  return (
    <Input
      {...props}
      className={["av-input", props.className].filter(Boolean).join(" ")}
      ref={(handle: InputRef | null) => assignRef(ref, handle?.input ?? null)}
    />
  );
});

/** What the person's own edit left the caret at, for the guard below. */
interface CaretSnapshot {
  value: string;
  start: number;
  end: number;
}

function snapshotCaret(area: HTMLTextAreaElement): CaretSnapshot {
  const end = area.value.length;
  return {
    value: area.value,
    start: area.selectionStart ?? end,
    end: area.selectionEnd ?? end,
  };
}

function restoreCaret(area: HTMLTextAreaElement, caret: CaretSnapshot): void {
  if (area.ownerDocument.activeElement !== area) return;
  if (area.value !== caret.value) return;
  if (area.selectionStart === caret.start && area.selectionEnd === caret.end) return;
  area.setSelectionRange(caret.start, caret.end);
}

/**
 * Map the end of a composition preview to the end of the text that replaced it.
 *
 * Some mobile engines emit compositionend while the preview value is still in
 * the textarea, then deliver the committed candidate in a trailing input. A
 * controlled write can leave that input's selection collapsed elsewhere. Text
 * after the preview caret is outside the composition range and therefore must
 * remain an exact suffix; its known length locates the committed range without
 * the ambiguity of a longest-common-prefix search in repeated text. Textarea
 * offsets and string indices are both UTF-16 code units.
 */
function caretAfterCompositionCommit(
  previous: CaretSnapshot,
  observed: CaretSnapshot,
): CaretSnapshot {
  const suffix = previous.value.slice(previous.end);
  if (!observed.value.endsWith(suffix)) return observed;
  const end = observed.value.length - suffix.length;
  return { value: observed.value, start: end, end };
}

/**
 * A controlled textarea that keeps the caret where the person put it.
 *
 * ── The failure this exists for (ticket #189) ──────────────────────────────
 *
 * "Sometimes the cursor is not where the text actually goes." That is the
 * signature of a controlled `<textarea>` whose `value` gets written back by
 * React after the browser has already applied the edit: assigning `value`
 * collapses the DOM selection to the end, while the painted caret — which
 * mobile browsers do not necessarily repaint for a programmatic value write —
 * stays where it was. The next keystroke then lands at the end, under a caret
 * drawn in the middle.
 *
 * It is specifically a MOBILE symptom because that write happens far more
 * often there: an Android IME reports composition text through `input` events
 * whose value React does not yet own, so React reconciles the node back to its
 * state and takes the selection with it.
 *
 * So this records the caret the person's own edit produced and, after the
 * controlled commit, restores it — but only when every one of these holds:
 *
 *  · the element is still focused (otherwise the caret is nobody's business);
 *  · its value is EXACTLY what that edit produced (a value that moved on is a
 *    different document, and a caret offset into it would be a guess);
 *  · the selection actually moved (no-ops never touch the DOM);
 *  · no IME composition is open — composition edits are recorded but restored
 *    only from a microtask after `compositionend`, because calling
 *    `setSelectionRange` mid-composition is how you break Gboard.
 *
 * A normal pending snapshot is dropped on the next microtask, so a host that
 * ignores `onChange` (and therefore never re-renders) cannot have a stale
 * caret restored over a later deliberate click or arrow key. A composition
 * snapshot stays through a trailing committed input, then expires next task.
 *
 * Child effects run before parent effects, so this lands after antd's own
 * auto-size measurement rather than being undone by it.
 */
export const AvTextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function AvTextArea(props, ref) {
  const node = useRef<HTMLTextAreaElement | null>(null);
  const pending = useRef<CaretSnapshot | null>(null);
  const compositionCaret = useRef<CaretSnapshot | null>(null);
  const composing = useRef(false);
  const endingComposition = useRef(false);

  const expirePendingAfterEvent = (caret: CaretSnapshot): void => {
    queueMicrotask(() => {
      if (pending.current === caret) pending.current = null;
    });
  };

  const restorePendingAfterEvent = (caret: CaretSnapshot): void => {
    queueMicrotask(() => {
      if (pending.current !== caret || composing.current) return;
      pending.current = null;
      const area = node.current;
      if (area) restoreCaret(area, caret);
    });
  };

  const finishCompositionAfterEvent = (caret: CaretSnapshot): void => {
    setTimeout(() => {
      if (compositionCaret.current !== caret) return;
      compositionCaret.current = null;
      if (pending.current !== caret || composing.current) return;
      pending.current = null;
      const area = node.current;
      if (area) restoreCaret(area, caret);
    }, 0);
  };

  useLayoutEffect(() => {
    const area = node.current;
    const caret = pending.current;
    pending.current = null;
    if (!area || !caret || composing.current) return;
    restoreCaret(area, caret);
  });

  return (
    <TextArea
      {...props}
      className={["av-textarea", props.className].filter(Boolean).join(" ")}
      onCompositionStart={(event) => {
        composing.current = true;
        endingComposition.current = false;
        pending.current = null;
        compositionCaret.current = null;
        props.onCompositionStart?.(event);
      }}
      onCompositionEndCapture={(event) => {
        // React can dispatch its trailing controlled onChange before the
        // bubble-phase compositionend handler. Mark the composition closed in
        // capture phase so that change consumes, rather than overwrites, the
        // caret saved by the last composition input.
        composing.current = false;
        endingComposition.current = true;
        props.onCompositionEndCapture?.(event);
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        const area = event.currentTarget;
        const recorded = compositionCaret.current ?? pending.current;
        const caret = recorded?.value === area.value ? recorded : snapshotCaret(area);
        // Keep the final composition snapshot through the browser's trailing
        // input/change event. Some mobile engines emit that after
        // compositionend with an already-collapsed DOM selection.
        compositionCaret.current = caret;
        pending.current = caret;
        endingComposition.current = false;
        props.onCompositionEnd?.(event);
        // Do not write selection in a microtask here. WebKit can deliver an
        // autocorrect/automatic-space input after compositionend, and moving
        // the caret before that input makes the IME apply its already-planned
        // edit to a different range. A trailing input consumes this snapshot
        // and restores its own mapped caret; without one, the next task closes
        // the composition and restores the final preview exactly once.
        finishCompositionAfterEvent(caret);
      }}
      onInputCapture={(event) => {
        // React may defer its synthetic onChange until compositionend. Capture
        // the native composition input before the controlled host can write
        // its value back and collapse the DOM selection.
        if (composing.current) compositionCaret.current = snapshotCaret(event.currentTarget);
        props.onInputCapture?.(event);
      }}
      onChange={(event) => {
        const observed = snapshotCaret(event.target);
        if (composing.current) {
          // Keep the browser/IME result but never move selection until the
          // composition has ended.
          compositionCaret.current = observed;
        } else {
          const committed = compositionCaret.current;
          const caret = committed
            ? committed.value === observed.value
              ? committed
              : caretAfterCompositionCommit(committed, observed)
            : observed;
          compositionCaret.current = null;
          pending.current = caret;
          if (!committed) expirePendingAfterEvent(caret);
          else if (!endingComposition.current) restorePendingAfterEvent(caret);
        }
        props.onChange?.(event);
      }}
      ref={(handle: TextAreaRef | null) => {
        node.current = handle?.resizableTextArea?.textArea ?? null;
        assignRef(ref, node.current);
      }}
    />
  );
});

export function AvCheckbox(props: CheckboxProps) {
  return <Checkbox {...props} className={["av-checkbox", props.className].filter(Boolean).join(" ")} />;
}

export const AvTooltip = forwardRef<ComponentRef<typeof Tooltip>, TooltipProps>(function AvTooltip(props, ref) {
  return <Tooltip {...props} ref={ref} getPopupContainer={props.getPopupContainer ?? appPopupContainer} />;
});
