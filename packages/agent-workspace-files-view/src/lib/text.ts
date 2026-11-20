/**
 * Reading one text file to the end, as a hook.
 *
 * ── Three rules, and each one is a bug that would otherwise be invisible ────
 *
 *  1. **A late answer never lands.** Every await is followed by a check that
 *     this read is still the current one. A panel that switched files while a
 *     chunk was in flight would otherwise show the tail of the previous file
 *     under the new file's header — and the header would be right, which is what
 *     makes it dangerous.
 *  2. **The stream is closed on every exit.** Resource change, unmount, refusal,
 *     completion. The trusted side releases a scope's streams when the instance
 *     ends, but "eventually" is not the same as "when the reader closed the
 *     panel", and an unclosed stream holds a broker slot.
 *  3. **A refusal is a value, not an exception.** `approval_required`,
 *     `not_text`, `too_large`, `outside_workspace`, `unavailable` are all things
 *     a person should read. Throwing them would take out the panel's error
 *     boundary and replace an actionable sentence with "something went wrong".
 *
 * There is no retry anywhere in here. Re-issuing a read the Gate refused is how
 * one revoked grant becomes a stream of approval cards.
 *
 * ── The fourth rule: a read that stops is not a read that succeeded ─────────
 *
 * Ticket #201 arrived as "the tab opens, the header says
 * `text/plain · 76.8 KB`, and the body is blank." Every state above renders
 * something a person can act on EXCEPT one: a pull that never settles. The
 * header is already on screen by then (it comes from the open, not the
 * stream), so the panel sits at `loading` forever with an empty surface and no
 * sentence — indistinguishable from an empty file, and from a working read of
 * a slow one.
 *
 * Two states close that gap, and neither of them retries anything:
 *
 *  · **`stalled`** — no chunk and no end for `READ_STALL_MS` after the last
 *    thing that arrived. The stream is closed and whatever text did arrive is
 *    kept and labelled partial. Re-reading is a button, not a timer.
 *  · **`incomplete`** — the stream ended cleanly having delivered nothing for a
 *    file whose own header declares a non-zero size. That is the producer
 *    contradicting itself; `resource-stream/v1`'s client catches it over the
 *    wire, but an in-process port has no such adapter, and either way "0 of
 *    78,643 bytes" must not render as a blank editor.
 *
 * ── The fifth: the OPEN can go unanswered too (ticket #253) ─────────────────
 *
 * #201 timed every pull and left the `openText` above them untimed, which made
 * the first and longest leg of the read the only one with no ending at all. On
 * a phone that leg is a proposal, an HTTP round trip and a whole-file hash; a
 * request whose answer never comes back leaves this hook at `loading` with
 * `document: null` and `text: ""` FOREVER — a header that is only the panel
 * label, a spinner, an empty gutter, and no sentence. That reads as "the page
 * won't load" and it is indistinguishable from a slow read, so a reader retries
 * a request that already reached the device and already did its work.
 *
 *  · **`unanswered`** — no answer to the open for `READ_STALL_MS`. Same
 *    discipline as `stalled`: say so, stop this read, and leave the second
 *    attempt to the person. An open that lands afterwards is still RELEASED,
 *    because a stream nobody will read must not keep a broker slot.
 */

import { useEffect, useRef, useState } from "react";
import {
  WORKSPACE_FILES_LIMITS,
  type AnyWorkspaceFilesPort,
  type WorkspaceTextDocument,
} from "@claude-bot/workspace-files-contract";

/**
 * How long one leg of a read may go unanswered before the panel says so.
 *
 * One number for the open and for every pull, because they wait on the same
 * chain. Generous on purpose: a first answer crosses a MessagePort, a trusted
 * dispatcher, a device tunnel and a whole-file hash, and a slow laptop is not
 * an error. It only has to be short enough that a person does not read a blank
 * pane as a broken feature.
 */
export const READ_STALL_MS = 20_000;

/**
 * The sixth rule: a view budget is not a file limit (2026-10-20).
 *
 * The port reads a file of any size. This view holds the text in one string
 * and one editor model, so by default it stops after `wholeTextBytes`, keeps
 * what arrived, and says so as `too_large` with partial text — the caller
 * offers to load the rest (`budgetBytes = Infinity`) or to download the file.
 * Nothing is refused and nothing partial is presented as complete.
 */
export const TEXT_VIEW_BUDGET_BYTES = WORKSPACE_FILES_LIMITS.wholeTextBytes;

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}

/**
 * When a still-streaming read repaints. Every repaint hands the whole text so
 * far to the surface, and touching a string built by appending forces V8 to
 * copy all of it, so each repaint costs O(text). Repainting per 256 KiB chunk
 * made a read O(n²) and crashed a tab at 40 MiB; a fixed interval is O(n²) too
 * on a slow link. So a repaint also waits until the text has grown by
 * `STREAM_REPAINT_GROWTH`: repaints are O(log n) and their copies sum to O(n).
 * The end, a stop and a refusal always publish the complete text.
 */
export const STREAM_REPAINT_MS = 400;
export const STREAM_REPAINT_GROWTH = 1.25;

function displayBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

export interface TextState {
  status: "empty" | "loading" | "ready" | "refused";
  document: WorkspaceTextDocument | null;
  text: string;
  /** True while more chunks are still arriving. */
  streaming: boolean;
  message: string;
  code: string;
}

const EMPTY: TextState = Object.freeze({
  status: "empty",
  document: null,
  text: "",
  streaming: false,
  message: "",
  code: "",
});

const LOADING: TextState = Object.freeze({
  ...EMPTY,
  status: "loading",
  streaming: true,
});

interface ScopedTextState {
  port: AnyWorkspaceFilesPort;
  ref: string;
  reload: number;
  budget: number;
  value: TextState;
}

interface TextRequest {
  port: AnyWorkspaceFilesPort;
  ref: string;
  reload: number;
  budget: number;
  /** Zero while an effect cleanup is waiting to see whether StrictMode remounts it. */
  owner: number;
  cancelled: boolean;
  close(): void;
}

/**
 * Open `ref` and pull it to a definite end.
 *
 * `reload` is a counter the caller bumps; it is the ONLY way a second read of
 * the same ref happens, which is what keeps a refusal from looping. A changed
 * `budgetBytes` is the caller asking for that second read with more room.
 */
export function useWorkspaceText(
  port: AnyWorkspaceFilesPort,
  ref: string | null,
  reload = 0,
  budgetBytes = TEXT_VIEW_BUDGET_BYTES,
): TextState {
  const [scoped, setScoped] = useState<ScopedTextState | null>(null);
  const request = useRef<TextRequest | null>(null);
  const ownerSequence = useRef(0);

  useEffect(() => {
    if (!ref) {
      request.current = null;
      setScoped(null);
      return;
    }

    const owner = ++ownerSequence.current;
    let active = request.current;
    const reusable =
      active !== null
      && !active.cancelled
      && active.port === port
      && active.ref === ref
      && active.reload === reload
      && active.budget === budgetBytes;

    if (reusable) {
      // React StrictMode probes an effect with setup -> cleanup -> setup while
      // preserving its refs. Transfer ownership of the same in-flight read; a
      // second openText call could mean a second approval card.
      active!.owner = owner;
    } else {
      let streamClosed = false;
      let closeStream: (() => void) | null = null;
      active = {
        port,
        ref,
        reload,
        budget: budgetBytes,
        owner,
        cancelled: false,
        close() {
          if (!closeStream || streamClosed) return;
          streamClosed = true;
          closeStream();
        },
      };
      request.current = active;
      setScoped({ port, ref, reload, budget: budgetBytes, value: LOADING });

      const running = active;
      const live = (): boolean =>
        !running.cancelled && running.owner !== 0 && request.current === running;
      const publish = (next: TextState): void => {
        if (live()) {
          setScoped({ port: running.port, ref: running.ref, reload: running.reload, budget: running.budget, value: next });
        }
      };

      // The watchdog is armed around each unanswered pull and disarmed by the
      // answer. It publishes and closes; it never re-issues anything.
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const disarm = (): void => {
        if (watchdog === null) return;
        clearTimeout(watchdog);
        watchdog = null;
      };
      const armed = active.close;
      active.close = () => {
        disarm();
        armed();
      };

      void (async () => {
        // Armed around the open for the same reason it is armed around every
        // pull: this await is the one a person waits on with nothing on screen
        // but the file's name.
        watchdog = setTimeout(() => {
          watchdog = null;
          if (!live()) return;
          publish({
            ...EMPTY,
            status: "refused",
            message: "这个文件的读取一直没有得到回应，本次读取已结束。",
            code: "unanswered",
          });
          // Cancel BEFORE the answer can arrive. A successful open that lands
          // after this finds `live()` false below and closes its own stream.
          running.cancelled = true;
          running.close();
        }, READ_STALL_MS);
        const opened = await port.openText(ref).catch(() => null);
        disarm();
        if (!opened) {
          publish({ ...EMPTY, status: "refused", message: "这次读取没有返回结果。", code: "unavailable" });
          return;
        }
        if (!opened.ok) {
          publish({ ...EMPTY, status: "refused", message: opened.message, code: opened.code });
          return;
        }
        // A SUCCESSFUL open must be released even when this read is already
        // cancelled. Capture its handle before checking liveness.
        const { document, stream } = opened.value;
        closeStream = () => void stream.close();
        if (!live()) {
          running.close();
          return;
        }
        publish({ status: "loading", document, text: "", streaming: true, message: "", code: "" });

        let text = "";
        let loadedBytes = 0;
        let repaintedAt = 0;
        let repaintedBytes = 0;
        for (;;) {
          watchdog = setTimeout(() => {
            watchdog = null;
            if (!live()) return;
            // Publish BEFORE cancelling: `publish` is gated on liveness, and
            // this sentence is the whole point of the timer.
            publish({
              status: "refused",
              document,
              text,
              streaming: false,
              message: "这个文件的内容在读取中途停住了，本次读取已结束。",
              code: "stalled",
            });
            running.cancelled = true;
            running.close();
          }, READ_STALL_MS);
          const read = await stream.next().catch(() => null);
          disarm();
          if (!live()) {
            running.close();
            return;
          }
          if (!read) {
            publish({ status: "refused", document, text, streaming: false, message: "这条资源流没有继续。", code: "unavailable" });
            running.close();
            return;
          }
          if (read.kind === "chunk") {
            try {
              text += read.value.text;
            } catch {
              // V8 caps one string near 2^29 code units: a real browser limit.
              publish({
                status: "refused",
                document,
                text,
                streaming: false,
                message: `浏览器无法在一页内容纳这么长的文本，已载入前 ${displayBytes(loadedBytes)}；完整内容请下载。`,
                code: "too_large",
              });
              running.close();
              return;
            }
            loadedBytes += utf8Length(read.value.text);
            if (loadedBytes >= running.budget && loadedBytes < document.sizeBytes) {
              publish({
                status: "refused",
                document,
                text,
                streaming: false,
                message: document.sizeBytes <= WORKSPACE_FILES_LIMITS.wholeTextMaxBytes
                  ? `文件共 ${displayBytes(document.sizeBytes)}，已载入前 ${displayBytes(loadedBytes)}；可继续载入全部或下载。`
                  : `文件共 ${displayBytes(document.sizeBytes)}，已载入前 ${displayBytes(loadedBytes)}；整份显示会超出浏览器页面内存，完整内容请下载。`,
                code: "too_large",
              });
              running.close();
              return;
            }
            const now = Date.now();
            if (
              repaintedBytes === 0
              || (now - repaintedAt >= STREAM_REPAINT_MS && loadedBytes >= repaintedBytes * STREAM_REPAINT_GROWTH)
            ) {
              repaintedAt = now;
              repaintedBytes = loadedBytes;
              publish({ status: "loading", document, text, streaming: true, message: "", code: "" });
            }
            continue;
          }
          if (read.kind === "end") {
            // An end that delivered nothing for a file the header says is not
            // empty is the producer contradicting itself. Rendering it as
            // `ready` would put a blank surface under a "76.8 KB" header.
            const declared = document.sizeBytes;
            publish(
              !text && typeof declared === "number" && declared > 0
                ? {
                    status: "refused",
                    document,
                    text,
                    streaming: false,
                    message: "这次读取已经结束，但没有送来任何内容。",
                    code: "incomplete",
                  }
                : { status: "ready", document, text, streaming: false, message: "", code: "" },
            );
            running.close();
            return;
          }
          // `refused` mid-stream. Keep what arrived, but label it partial.
          publish({ status: "refused", document, text, streaming: false, message: read.message, code: read.code });
          running.close();
          return;
        }
      })();
    }

    return () => {
      // Zero suppresses state publication immediately. Actual close waits one
      // microtask so StrictMode's replacement setup can claim the request.
      if (active!.owner === owner) active!.owner = 0;
      const released = active!;
      queueMicrotask(() => {
        if (released.owner !== 0 || released.cancelled) return;
        released.cancelled = true;
        released.close();
      });
    };
  }, [port, ref, reload, budgetBytes]);

  // Effects run after a render may already have been committed. Derive the
  // visible value from its scope here so a new port/ref/reload can never paint
  // the previous file while the replacement effect is still pending.
  if (!ref) return EMPTY;
  return scoped?.port === port && scoped.ref === ref && scoped.reload === reload && scoped.budget === budgetBytes
    ? scoped.value
    : LOADING;
}
