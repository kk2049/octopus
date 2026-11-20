import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNNER_SESSION_PROJECTION_SCHEMA, type RunnerSessionProjection } from "./session-projection.js";
import { RunnerSessionProjector } from "./session-projector.js";

async function runDelay(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
}

describe("RunnerSessionProjector", () => {
  afterEach(() => vi.useRealTimers());

  it("owns one source observer per resource and rejects callbacks from a released generation", async () => {
    vi.useFakeTimers();
    const observers: Array<{ changed: () => void; close: ReturnType<typeof vi.fn> }> = [];
    const reads: string[] = [];
    const projector = new RunnerSessionProjector({
      send: () => {},
      watchTranscriptSource: (_source, _id, changed) => {
        const close = vi.fn(); observers.push({ changed, close }); return close;
      },
      dispatcher: { handle: async (request) => {
        reads.push(String(request.args.id));
        return { id: request.id, type: "rpc_result", ok: true, result: {
          rich: true, offset: 0, total_messages: 0, messages: [], meta: { source: "codex", id: request.args.id },
        } };
      } },
    });
    const subscribe = (id: string, max_messages = 20) => projector.handleCommand({
      schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript_subscribe", source: "codex", session_id: id, max_messages,
    });
    subscribe("one"); subscribe("two");
    await runDelay(0);
    subscribe("one", 40);
    await runDelay(0);
    expect(observers).toHaveLength(2);
    observers[0]!.changed();
    await runDelay(75);
    expect(reads.at(-1)).toBe("one");
    projector.handleCommand({ schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript_unsubscribe", source: "codex", session_id: "one" });
    expect(observers[0]!.close).toHaveBeenCalledOnce();
    subscribe("one");
    await runDelay(0);
    const count = reads.length;
    observers[0]!.changed();
    await runDelay(75);
    expect(reads).toHaveLength(count);
    projector.close();
    expect(observers.map((item) => item.close.mock.calls.length)).toEqual([1, 1, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues bounded cold backfill without waiting for a browser refresh and stops when covered", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const sent: RunnerSessionProjection[] = [];
    const projector = new RunnerSessionProjector({ send: (frame) => sent.push(frame), dispatcher: {
      handle: async (request) => {
        expect(request.args.primary_window).toBe(true);
        calls++;
        return { id: request.id, type: "rpc_result", ok: true, result: {
          total_found: 2000, primary_window: true, index_pending: calls < 3,
          sessions: [{ id: "retained", source: "codex" }],
        } };
      },
    } });
    projector.start();
    await runDelay(0);
    await runDelay(1000);
    await runDelay(1000);
    expect(calls).toBe(3);
    expect(sent).toHaveLength(2);
    expect(sent.at(-1)).toMatchObject({ index_pending: false, sessions: [{ id: "retained" }] });
    await runDelay(1000);
    expect(calls).toBe(3);
    projector.close();
  });

  it("coalesces invalidations into full rosters and pushes only subscribed transcripts", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const sent: RunnerSessionProjection[] = [];
    const dispatcher = {
      async handle(request: { id: string; method: string; args: Record<string, unknown> }) {
        calls.push(request.method);
        if (request.method === "list_recent_sessions") {
          return {
            type: "rpc_result" as const,
            id: request.id,
            ok: true,
            result: { total_found: 1, sessions: [{ id: "s-1", source: "claude", path: "/private" }] },
          };
        }
        return {
          type: "rpc_result" as const,
          id: request.id,
          ok: true,
          result: {
            rich: true,
            offset: 0,
            total_messages: 1,
            meta: { id: "s-1", source: "claude", path: "/private" },
            messages: [{ role: "assistant", blocks: [{ type: "text", text: "ok" }] }],
          },
        };
      },
    };
    const projector = new RunnerSessionProjector({ dispatcher, send: (projection) => sent.push(projection) });
    projector.start();
    await runDelay(0);
    expect(calls).toEqual(["list_recent_sessions"]);
    expect(sent[0]).toMatchObject({ kind: "roster_full", sequence: 1 });
    expect(JSON.stringify(sent[0])).not.toContain("/private");

    for (let index = 0; index < 20; index += 1) projector.notifyChanged();
    await runDelay(74);
    expect(calls).toHaveLength(1);
    await runDelay(1);
    expect(calls).toEqual(["list_recent_sessions", "list_recent_sessions"]);

    projector.handleCommand({
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "transcript_subscribe",
      source: "claude",
      session_id: "s-1",
      max_messages: 100,
    });
    await runDelay(0);
    expect(calls.at(-1)).toBe("read_session");
    expect(sent.at(-1)).toMatchObject({ kind: "transcript", source: "claude", session_id: "s-1" });

    const before = calls.length;
    projector.handleCommand({
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "transcript_unsubscribe",
      source: "claude",
      session_id: "s-1",
    });
    projector.notifyChanged();
    await runDelay(75);
    expect(calls.slice(before)).toEqual(["list_recent_sessions"]);
    // The two identical roster reads are observed locally but do not wake the
    // Host; only the initial roster and the subscribed transcript are sent.
    expect(sent.map((projection) => projection.sequence)).toEqual([1, 2]);
    projector.close();
  });

  it("reconciles an external Codex prompt into a new top row without emitting unchanged frames", async () => {
    vi.useFakeTimers();
    let promptStarted = false;
    const calls: string[] = [];
    const sent: RunnerSessionProjection[] = [];
    const dispatcher = {
      async handle(request: { id: string; method: string; args: Record<string, unknown> }) {
        calls.push(request.method);
        const oldSession = {
          id: "old",
          source: "codex",
          sort_activity: "2026-08-25T14:00:00Z",
        };
        const resumedSession = {
          id: "resumed",
          source: "codex",
          sort_activity: promptStarted ? "2026-08-25T14:05:00Z" : "2026-08-25T13:00:00Z",
        };
        return {
          type: "rpc_result" as const,
          id: request.id,
          ok: true,
          result: {
            total_found: 2,
            sessions: promptStarted ? [resumedSession, oldSession] : [oldSession, resumedSession],
          },
        };
      },
    };
    const projector = new RunnerSessionProjector({
      dispatcher,
      send: (projection) => sent.push(projection),
      reconcileMs: 1_000,
    });

    projector.start();
    await runDelay(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "roster_full" });
    expect(sent[0]?.kind === "roster_full" ? sent[0].sessions[0]?.id : undefined).toBe("old");

    // No hook and no content change: the device may scan, but the Host and
    // browser receive no duplicate frame and cross no extra refresh Gate.
    await runDelay(1_001);
    expect(calls).toEqual(["list_recent_sessions", "list_recent_sessions"]);
    expect(sent).toHaveLength(1);

    // A real user prompt changes the scanner's stable key. The next bounded
    // reconcile publishes that semantic change even when Codex fired no hook.
    promptStarted = true;
    await runDelay(1_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ kind: "roster_full" });
    expect(sent[1]?.kind === "roster_full" ? sent[1].sessions[0]?.id : undefined).toBe("resumed");
    expect(sent.map((projection) => projection.sequence)).toEqual([1, 2]);
    projector.close();
  });

  it("coalesces app-server activity into the exact subscribed transcript without refreshing the roster", async () => {
    vi.useFakeTimers();
    const calls: Array<{ method: string; id?: unknown }> = [];
    const sent: RunnerSessionProjection[] = [];
    const dispatcher = {
      async handle(request: { id: string; method: string; args: Record<string, unknown> }) {
        calls.push({ method: request.method, id: request.args.id });
        if (request.method === "list_recent_sessions") {
          return {
            type: "rpc_result" as const,
            id: request.id,
            ok: true,
            result: { total_found: 2, sessions: [] },
          };
        }
        return {
          type: "rpc_result" as const,
          id: request.id,
          ok: true,
          result: {
            rich: true,
            offset: 0,
            total_messages: 1,
            messages: [{ role: "assistant", content: String(request.args.id) }],
          },
        };
      },
    };
    const projector = new RunnerSessionProjector({
      dispatcher,
      send: (projection) => sent.push(projection),
    });
    projector.start();
    await runDelay(0);
    for (const sessionId of ["one", "two"]) {
      projector.handleCommand({
        schema: RUNNER_SESSION_PROJECTION_SCHEMA,
        kind: "transcript_subscribe",
        source: "codex",
        session_id: sessionId,
        max_messages: 100,
      });
    }
    await runDelay(0);
    calls.length = 0;
    sent.length = 0;

    for (let index = 0; index < 20; index += 1) {
      projector.notifyTranscriptChanged("codex", "one");
    }
    await runDelay(249);
    expect(calls).toEqual([]);
    await runDelay(1);
    expect(calls).toEqual([{ method: "read_session", id: "one" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "transcript_checked", source: "codex", session_id: "one" });
    projector.close();
  });
});

it("never reads other subscriptions when one session changes", async () => {
  vi.useFakeTimers();
  const reads: string[] = [];
  const projector = new RunnerSessionProjector({
    dispatcher: { async handle(request) {
      if (request.method === "read_session") reads.push(String(request.args.id));
      return { type: "rpc_result", id: request.id, ok: true, result: request.method === "read_session"
        ? { rich: true, messages: [], meta: {}, total_messages: 0, offset: 0 }
        : { sessions: [], total_found: 0 } };
    } }, send() {},
  });
  for (const id of ["a", "b", "c"]) projector.handleCommand({ schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript_subscribe", source: "codex", session_id: id, max_messages: 20 });
  await vi.advanceTimersByTimeAsync(0); reads.length = 0;
  for (let i = 0; i < 20; i++) projector.notifySessionChanged("codex", "a");
  await vi.advanceTimersByTimeAsync(250);
  expect(reads).toEqual(["a"]);
  projector.close(); vi.useRealTimers();
});

it("renews an unchanged source without a read or content revision and forces a fresh resubscribe", async () => {
  vi.useFakeTimers();
  const sent: RunnerSessionProjection[] = [];
  const checks: Array<() => void> = [];
  const handle = vi.fn(async (request: { id: string }) => ({ id: request.id, type: "rpc_result" as const, ok: true,
    result: { rich: true, offset: 0, total_messages: 0, messages: [] } }));
  const projector = new RunnerSessionProjector({ dispatcher: { handle }, send: frame => sent.push(frame),
    watchTranscriptSource: (_s, _id, _changed, checked) => { checks.push(checked!); return () => {}; } });
  const subscribe = () => projector.handleCommand({ schema: RUNNER_SESSION_PROJECTION_SCHEMA,
    kind: "transcript_subscribe", source: "codex", session_id: "one", max_messages: 20 });
  try {
    subscribe(); await runDelay(0);
    checks[0]!(); checks[0]!();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(sent.map(frame => frame.kind)).toEqual(["transcript", "transcript_checked", "transcript_checked"]);
    expect(sent[2]).toMatchObject({ content_sequence: sent[0]!.sequence });
    projector.notifyTranscriptChanged("codex", "one"); checks[0]!();
    expect(sent).toHaveLength(3);
    await runDelay(250);
    expect(sent.at(-1)).toMatchObject({ kind: "transcript_checked", content_sequence: sent[0]!.sequence });
    projector.handleCommand({ schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript_unsubscribe", source: "codex", session_id: "one" });
    subscribe(); await runDelay(0);
    expect(sent.at(-1)?.kind).toBe("transcript");
    const length = sent.length;
    checks[0]!();
    expect(sent).toHaveLength(length);
    checks[1]!();
    expect(sent.at(-1)).toMatchObject({ kind: "transcript_checked", content_sequence: sent[length - 1]!.sequence });
  } finally { projector.close(); vi.useRealTimers(); }
});
