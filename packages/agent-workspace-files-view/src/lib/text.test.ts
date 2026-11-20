/**
 * `useWorkspaceText`, on the two endings that used to be indistinguishable
 * from a blank pane (ticket #201).
 *
 * Both start the same way: the open succeeds, so the header — label, media
 * type, size, mtime — is already on screen. What follows is either nothing at
 * all (a pull that never settles) or an end frame carrying no bytes for a file
 * whose own header says it has 76.8 KB of them. Rendered as `loading` and
 * `ready` respectively, both look exactly like "this file is empty", which is
 * the bug report this test exists for.
 *
 * Ticket #253 adds the leg BEFORE them: an `openText` that never answers, which
 * had no timer at all. That one is worse to look at, because there is not even
 * a size on screen — only the panel's label over an empty gutter.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyWorkspaceFilesPort } from "@claude-bot/workspace-files-contract";
import { READ_STALL_MS, useWorkspaceText } from "./text.js";

const DIGEST = `sha256:${"b".repeat(64)}`;

interface Pull {
  kind: "chunk" | "end" | "refused";
  value?: { text: string };
  bytes?: number;
  code?: string;
  message?: string;
}

/**
 * A port that answers `openText` and then behaves exactly as the caller says.
 *
 * `pulls` is consumed in order; running out means the stream never answers
 * again, which is the stall this hook has to be able to describe.
 */
function portWith(options: { sizeBytes: number; pulls: readonly Pull[] }) {
  const closes = { count: 0 };
  let index = 0;
  const port = {
    contract: "workspace-files/v1",
    async refreshRoots() {
      return { ok: false as const, code: "unavailable" as const, message: "n/a" };
    },
    async listDirectory() {
      return { ok: false as const, code: "unavailable" as const, message: "n/a" };
    },
    async openText(ref: string) {
      return {
        ok: true as const,
        value: {
          document: {
            ref,
            label: "oh-my-pi-技术报告.md",
            mediaType: "text/plain; charset=utf-8",
            sizeBytes: options.sizeBytes,
            digest: DIGEST,
            modifiedAt: "2026-08-16T16:43:04.441Z",
          },
          stream: {
            async next(): Promise<Pull> {
              const pull = options.pulls[index];
              index += 1;
              if (!pull) return new Promise<Pull>(() => {});
              return pull;
            },
            close() {
              closes.count += 1;
            },
          },
        },
      };
    },
  };
  return { port: port as unknown as AnyWorkspaceFilesPort, closes };
}

/**
 * A port whose `openText` hangs until the test says otherwise (ticket #253).
 *
 * `answer()` resolves it with a real document and stream, which is how the
 * "the reply arrived after we gave up" case proves the stream is still closed.
 */
function portThatNeverOpens() {
  const opens = { count: 0 };
  const closes = { count: 0 };
  let release: (() => void) | null = null;
  const port = {
    contract: "workspace-files/v1",
    async refreshRoots() {
      return { ok: false as const, code: "unavailable" as const, message: "n/a" };
    },
    async listDirectory() {
      return { ok: false as const, code: "unavailable" as const, message: "n/a" };
    },
    openText(ref: string) {
      opens.count += 1;
      return new Promise((resolve) => {
        release = () => resolve({
          ok: true as const,
          value: {
            document: {
              ref,
              label: "per-slide-design.md",
              mediaType: "text/plain; charset=utf-8",
              sizeBytes: 28_717,
              digest: DIGEST,
              modifiedAt: "2026-08-18T03:56:34.206Z",
            },
            stream: {
              async next() {
                return new Promise(() => {});
              },
              close() {
                closes.count += 1;
              },
            },
          },
        });
      });
    },
  };
  return {
    port: port as unknown as AnyWorkspaceFilesPort,
    opens,
    closes,
    answer: () => release?.(),
  };
}

/** Let the open/pull promise chain settle without letting the watchdog fire. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useWorkspaceText — a read that stops is not a read that succeeded", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls a pull that never answers `stalled`, keeps the partial text, closes the stream", async () => {
    const { port, closes } = portWith({
      sizeBytes: 78_643,
      pulls: [{ kind: "chunk", value: { text: "# Oh My Pi\n" }, bytes: 11 }],
    });
    const { result } = renderHook(() => useWorkspaceText(port, "f1"));

    await settle();
    expect(result.current.document?.sizeBytes).toBe(78_643);
    expect(result.current.text).toBe("# Oh My Pi\n");
    expect(result.current.status).toBe("loading");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_STALL_MS + 10);
    });

    expect(result.current.status).toBe("refused");
    expect(result.current.code).toBe("stalled");
    expect(result.current.streaming).toBe(false);
    // Whatever arrived is kept: the pane labels it partial rather than blanking.
    expect(result.current.text).toBe("# Oh My Pi\n");
    expect(closes.count).toBe(1);
  });

  it("does not fire the watchdog while chunks keep arriving", async () => {
    const { port } = portWith({
      sizeBytes: 6,
      pulls: [
        { kind: "chunk", value: { text: "abc" }, bytes: 3 },
        { kind: "chunk", value: { text: "def" }, bytes: 3 },
        { kind: "end" },
      ],
    });
    const { result } = renderHook(() => useWorkspaceText(port, "f1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_STALL_MS * 3);
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.text).toBe("abcdef");
    expect(result.current.code).toBe("");
  });

  it("calls an end that delivered nothing for a non-empty file `incomplete`", async () => {
    const { port } = portWith({ sizeBytes: 78_643, pulls: [{ kind: "end" }] });
    const { result } = renderHook(() => useWorkspaceText(port, "f1"));

    await settle();

    expect(result.current.status).toBe("refused");
    expect(result.current.code).toBe("incomplete");
    expect(result.current.document?.sizeBytes).toBe(78_643);
  });

  it("calls an open that never answers `unanswered`, with nothing to show for it", async () => {
    const { port, opens } = portThatNeverOpens();
    const { result } = renderHook(() => useWorkspaceText(port, "f1"));

    await settle();
    // The shape a reader reported: a spinner, no size, an empty surface.
    expect(result.current.status).toBe("loading");
    expect(result.current.document).toBeNull();
    expect(result.current.text).toBe("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_STALL_MS + 10);
    });

    expect(result.current.status).toBe("refused");
    expect(result.current.code).toBe("unanswered");
    expect(result.current.streaming).toBe(false);
    // Still exactly one open: the watchdog explains, it never asks again.
    expect(opens.count).toBe(1);
  });

  it("releases a stream whose open landed after the watchdog gave up", async () => {
    const { port, opens, closes, answer } = portThatNeverOpens();
    const { result } = renderHook(() => useWorkspaceText(port, "f1"));

    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_STALL_MS + 10);
    });
    expect(result.current.code).toBe("unanswered");

    await act(async () => {
      answer();
      await vi.advanceTimersByTimeAsync(0);
    });

    // The late answer neither lands on screen nor keeps a broker slot.
    expect(result.current.code).toBe("unanswered");
    expect(result.current.document).toBeNull();
    expect(closes.count).toBe(1);
    expect(opens.count).toBe(1);
  });

  it("does not fire the open watchdog once the open has answered", async () => {
    const { port } = portWith({ sizeBytes: 3, pulls: [{ kind: "chunk", value: { text: "abc" }, bytes: 3 }, { kind: "end" }] });
    const { result } = renderHook(() => useWorkspaceText(port, "f1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_STALL_MS * 2);
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.text).toBe("abc");
  });

  it("still reports a genuinely empty file as ready", async () => {
    const { port } = portWith({ sizeBytes: 0, pulls: [{ kind: "end" }] });
    const { result } = renderHook(() => useWorkspaceText(port, "f1"));

    await settle();

    expect(result.current.status).toBe("ready");
    expect(result.current.text).toBe("");
    expect(result.current.code).toBe("");
  });
});

describe("useWorkspaceText — a view budget is not a file limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops at the budget, keeps the leading text, says so, and releases the stream", async () => {
    const { port, closes } = portWith({
      sizeBytes: 30,
      pulls: [
        { kind: "chunk", value: { text: "0123456789" } },
        { kind: "chunk", value: { text: "abcdefghij" } },
        { kind: "chunk", value: { text: "never-read" } },
      ],
    });
    const { result } = renderHook(() => useWorkspaceText(port, "f1", 0, 15));

    await settle();

    expect(result.current.status).toBe("refused");
    expect(result.current.code).toBe("too_large");
    expect(result.current.text).toBe("0123456789abcdefghij");
    expect(result.current.message).toMatch(/已载入前/);
    expect(closes.count).toBe(1);
  });

  it("reads the whole file when the caller lifts the budget", async () => {
    const { port } = portWith({
      sizeBytes: 20,
      pulls: [
        { kind: "chunk", value: { text: "0123456789" } },
        { kind: "chunk", value: { text: "abcdefghij" } },
        { kind: "end" },
      ],
    });
    const { result } = renderHook(() => useWorkspaceText(port, "f1", 0, Number.POSITIVE_INFINITY));

    await settle();

    expect(result.current.status).toBe("ready");
    expect(result.current.text).toBe("0123456789abcdefghij");
  });

  it("counts the budget in UTF-8 bytes, matching the file size it is compared with", async () => {
    // 4 characters, 12 bytes: under a 10-byte budget after the first chunk.
    const { port } = portWith({
      sizeBytes: 24,
      pulls: [
        { kind: "chunk", value: { text: "日志文本" } },
        { kind: "chunk", value: { text: "其余内容" } },
      ],
    });
    const { result } = renderHook(() => useWorkspaceText(port, "f1", 0, 10));

    await settle();

    expect(result.current.code).toBe("too_large");
    expect(result.current.text).toBe("日志文本");
  });
});
