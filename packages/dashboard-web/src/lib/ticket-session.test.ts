/**
 * The ticket-session adapter: server snake_case in, shared chat shapes out.
 *
 * The properties that matter are the ones a page bug would silently violate —
 * the two pre-log states stay distinguishable, defaults do not invent data,
 * and an older page can only merge when it is exactly adjacent.
 */

import { describe, expect, it } from "vitest";
import type { RichMessage } from "./transcript.js";
import {
  mergeOlder,
  nativeTicketConnected,
  nativeTicketControl,
  ticketTranscriptWakeKey,
  ticketSessionView,
  transcriptWindowOf,
  type TicketWindow,
} from "./ticket-session.js";

function msg(text: string): RichMessage {
  return { role: "assistant", timestamp: "2026-08-10T00:00:00Z", blocks: [{ type: "text", text }] };
}

it("requires fresh native daemon evidence and expires it without guessing from old receipts or managed-resume capability", () => {
  const now = Date.now();
  const runtime = { event: "CodexDaemonObserved", process_state: "alive", control_mode: "external_cli", turn_state: "working",
    observed_at: new Date(now).toISOString(), capabilities: { protocol_append: true } };
  expect(nativeTicketControl(runtime, false, now)).toBe("working");
  expect(nativeTicketControl({ ...runtime, turn_state: "idle" }, false, now)).toBe("idle");
  expect(nativeTicketControl(runtime, false, now + 10001)).toBe("unavailable");
  expect(nativeTicketControl({ ...runtime, event: "SessionEnd" }, false, now)).toBe("unavailable");
  expect(nativeTicketControl({ ...runtime, capabilities: { managed_resume: true } }, false, now)).toBe("unavailable");
  expect(nativeTicketControl(runtime, true, now)).toBe("closed");
});

it("reports a connected CLI's real turn state instead of calling it disconnected", () => {
  const now = Date.now();
  const codex = { event: "CodexDaemonObserved", process_state: "alive", control_mode: "external_cli", turn_state: "needs_input",
    observed_at: new Date(now).toISOString(), capabilities: { protocol_append: false } };
  // The Runner withholds append while a local decision is pending; the binding is still live.
  expect(nativeTicketControl(codex, false, now)).toBe("needs_input");
  expect(nativeTicketConnected("needs_input")).toBe(true);
  expect(nativeTicketControl({ ...codex, turn_state: "unknown", capabilities: { protocol_append: true } }, false, now)).toBe("unknown");
  expect(nativeTicketConnected("unknown")).toBe(true);
  // Liveness evidence still decides: an expired observation is not connected.
  expect(nativeTicketControl(codex, false, now + 10001)).toBe("unavailable");
  expect(nativeTicketControl({ ...codex, process_state: "exited" }, false, now)).toBe("unavailable");
  expect(nativeTicketConnected("unavailable")).toBe(false);
  expect(nativeTicketConnected("closed")).toBe(false);
  const claude = { event: "PermissionRequest", process_state: "alive", control_mode: "external_cli", turn_state: "needs_input",
    observed_at: new Date(now - 600_000).toISOString(), capabilities: { terminal_append: false } };
  expect(nativeTicketControl(claude, false, now, "claude")).toBe("needs_input");
});

it("accepts a hook-observed Claude TUI only while its exact process and tmux pane are proven", () => {
  const now = Date.now();
  // A long tool call emits no hook: an old observation is still the same live process.
  const runtime = { event: "PreToolUse", process_state: "alive", control_mode: "external_cli", turn_state: "working",
    observed_at: new Date(now - 600_000).toISOString(), capabilities: { terminal_append: true, protocol_append: false } };
  expect(nativeTicketControl(runtime, false, now, "claude")).toBe("working");
  expect(nativeTicketControl({ ...runtime, turn_state: "idle", event: "Stop" }, false, now, "claude")).toBe("idle");
  expect(nativeTicketControl({ ...runtime, process_state: "exited" }, false, now, "claude")).toBe("unavailable");
  expect(nativeTicketControl({ ...runtime, capabilities: { terminal_append: false } }, false, now, "claude")).toBe("unavailable");
  expect(nativeTicketControl({ ...runtime, control_mode: "octopus_headless" }, false, now, "claude")).toBe("unavailable");
  // The Codex rule is unchanged for Codex sessions.
  expect(nativeTicketControl(runtime, false, now, "codex")).toBe("unavailable");
});

describe("ticketSessionView", () => {
  it("preserves capacity runtime through ticket reads and older paging", () => {
    const runtime = { recovery: { state: "waiting_capacity" as const, attempts: 2, retry_at: "2026-09-24T12:05:00Z" } };
    const view = ticketSessionView({ messages: [msg("new")], offset: 1, total_messages: 2, meta: { runtime } });
    if (view.kind !== "window") throw new Error("missing window");
    const paged = mergeOlder(view.window, { messages: [msg("old")], offset: 0 });
    expect(transcriptWindowOf(paged, null).runtime).toEqual(runtime);
  });
  it("wakes again when an already-known session starts its turn", () => {
    const idle = ticketTranscriptWakeKey("preallocated", null);
    const running = ticketTranscriptWakeKey("preallocated", "2026-08-13T00:00:00Z");
    expect(idle).not.toBe(running);
    // Codex begins without an id, then publishes thread.started while the same
    // turn marker remains live; that transition also gets a distinct wake-up.
    expect(ticketTranscriptWakeKey(null, "2026-08-13T00:00:00Z")).not.toBe(
      ticketTranscriptWakeKey("codex-thread", "2026-08-13T00:00:00Z"),
    );
  });

  it("keeps 'running but no log yet' distinct from 'never started'", () => {
    expect(ticketSessionView({ pending: true, running: true, turn_started_at: "T1" })).toEqual({
      kind: "starting",
      since: "T1",
    });
    expect(ticketSessionView({ pending: true, running: false })).toEqual({ kind: "idle" });
  });

  it("passes a read error through as an error, not an empty window", () => {
    expect(ticketSessionView({ error: "scan failed" })).toEqual({
      kind: "error",
      message: "scan failed",
    });
  });

  it("maps a window with server offsets and totals intact", () => {
    const view = ticketSessionView({
      messages: [msg("a"), msg("b")],
      offset: 40,
      total_messages: 42,
      meta: { source: "omp", activity: { state: "tool", tool: "Bash", observed_at: "T2" } },
    });
    expect(view.kind).toBe("window");
    if (view.kind !== "window") return;
    expect(view.window).toMatchObject({ offset: 40, total: 42, cliKind: "omp" });
    expect(view.window.messages).toHaveLength(2);
    // The provider-vouched activity survives the mapping.
    expect(view.activity).toMatchObject({ state: "tool", tool: "Bash" });
  });

  it("defaults a headless response to a zero-offset full window", () => {
    const view = ticketSessionView({ messages: [msg("only")] });
    expect(view).toMatchObject({ kind: "window", window: { offset: 0, total: 1 } });
  });
});

describe("transcriptWindowOf", () => {
  it("renames into the shared contract shape without inventing fields", () => {
    const win: TicketWindow = { messages: [msg("x")], offset: 3, total: 9, cliKind: "omp" };
    expect(transcriptWindowOf(win, { state: "running" })).toEqual({
      messages: win.messages,
      offset: 3,
      totalMessages: 9,
      activity: { state: "running" },
      cliKind: "omp",
    });
    expect(transcriptWindowOf(win, null).activity).toBeNull();
  });
});

describe("mergeOlder", () => {
  const win: TicketWindow = { messages: [msg("c"), msg("d")], offset: 2, total: 4 };

  it("prepends an exactly-adjacent page and lowers the offset", () => {
    const merged = mergeOlder(win, { messages: [msg("a"), msg("b")], offset: 0, total_messages: 4 });
    expect(merged.offset).toBe(0);
    expect(merged.total).toBe(4);
    expect(merged.messages.map((m) => m.blocks?.[0]?.text)).toEqual(["a", "b", "c", "d"]);
  });

  it("trusts the request arithmetic when the page carries no offset", () => {
    const merged = mergeOlder(win, { messages: [msg("b")] });
    expect(merged.offset).toBe(1);
    expect(merged.messages).toHaveLength(3);
  });

  it("keeps provider display mode while prepending older messages", () => {
    const merged = mergeOlder({ ...win, cliKind: "omp" }, {
      messages: [msg("b")],
      meta: { source: "omp" },
    });
    expect(merged.cliKind).toBe("omp");
  });

  it("drops a page that is not adjacent instead of splicing a lying window", () => {
    expect(mergeOlder(win, { messages: [msg("a")], offset: 0 })).toBe(win);
    expect(mergeOlder(win, { messages: [] })).toBe(win);
  });
});
