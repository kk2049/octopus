import { describe, expect, it, vi } from "vitest";
import { resourceId } from "../sessionhub/core.js";
import type { AppAuthorityBundles } from "./bundle.js";
import { watchTranscript } from "./transcript-watch.js";
import type { SessionResourceWatchEvent } from "./types.js";

const RESOURCE = resourceId({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: "s1" });
const PAGE = {
  total_messages: 1,
  offset: 0,
  messages: [{ role: "user", content: "hello" }],
  meta: { activity: { state: "idle" } },
  projection_version: { epoch: "runner-epoch-one", sequence: 7 },
};

describe("Session Plus transcript follow", () => {
  it("projects changing runtime capabilities and clears missing observations without new messages", async () => {
    vi.useFakeTimers();
    const events: SessionResourceWatchEvent[] = [];
    let runtime: unknown = { process_state: "unknown", observed_at: "2026-09-08T12:00:00Z",
      capabilities: { managed_resume: true }, pid: 123, cwd: "/private/local-path" };
    const bundles = {
      get: () => ({ owner: "alice" }),
      openController: () => ({ caps: { request: async () => ({ status: "succeeded", result: {
        ...PAGE, meta: { ...PAGE.meta, runtime },
      } }) }, close() {} }),
    } as unknown as AppAuthorityBundles;
    const watched = watchTranscript({ bundles, instanceId: "instance", resource: RESOURCE,
      timeoutMs: 100, pollMs: 5, maxMessages: 200, audit() {}, listener: event => events.push(event) });
    try {
      expect(watched.ok).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(events[0]).toMatchObject({ type: "data", data: { runtime: { capabilities: { managed_resume: true } } } });
      expect(JSON.stringify(events)).not.toContain("private/local-path");
      expect(JSON.stringify(events)).not.toContain('"pid"');
      runtime = { process_state: "alive", capabilities: { managed_resume: false, protocol_append: false } };
      await vi.advanceTimersByTimeAsync(5);
      expect(events[1]).toMatchObject({ type: "data", data: { runtime: { capabilities: { managed_resume: false } } } });
      runtime = null;
      await vi.advanceTimersByTimeAsync(5);
      expect(events[2]).toMatchObject({ type: "data", data: { runtime: null } });
      expect(events).toHaveLength(3);
    } finally {
      if (watched.ok) watched.subscription.close();
      vi.useRealTimers();
    }
  });

  it("reconnects after a transient Runner failure even when the transcript is unchanged", async () => {
    const replies = [
      { status: "succeeded", result: PAGE },
      { status: "failed", reason: "temporary Runner loss" },
      { status: "succeeded", result: PAGE },
    ];
    let requests = 0;
    let closed = 0;
    const events: SessionResourceWatchEvent[] = [];
    const bundles = {
      get: () => ({ owner: "alice" }),
      openController: () => ({
        caps: {
          request: async () => {
            requests += 1;
            return replies.shift() ?? { status: "succeeded", result: PAGE };
          },
        },
        close: () => { closed += 1; },
      }),
    } as unknown as AppAuthorityBundles;

    const watched = watchTranscript({
      bundles,
      instanceId: "instance",
      resource: RESOURCE,
      timeoutMs: 100,
      pollMs: 5,
      maxMessages: 200,
      audit() {},
      listener: (event) => events.push(event),
    });
    expect(watched.ok).toBe(true);
    if (!watched.ok) return;

    await waitFor(() => events.some((event) => event.type === "status" && event.state === "live"));
    expect(events.map((event) => event.type)).toEqual(["data", "error", "status"]);
    expect(events[0]).toMatchObject({
      type: "data",
      data: { version: PAGE.projection_version },
    });
    expect(events.find((event) => event.type === "error")).toMatchObject({ terminal: false });
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(closed).toBe(0);

    watched.subscription.close();
    expect(closed).toBe(1);
  });

  it("polls until the device pushes, then follows pushes without losing one that lands mid-read", async () => {
    vi.useFakeTimers();
    let requests = 0;
    let wake: () => void = () => { throw new Error("transcript projection listener not attached"); };
    let detached = 0;
    let hold: ((reply: unknown) => void) | null = null;
    let holdNext = false;
    const bundles = {
      get: () => ({ owner: "alice" }),
      openController: () => ({
        caps: {
          request: async () => {
            requests += 1;
            const reply = { status: "succeeded", result: { ...PAGE, messages: [{ role: "user", content: `turn-${requests}` }] } };
            if (!holdNext) return reply;
            holdNext = false;
            return await new Promise((resolve) => { hold = () => resolve(reply); });
          },
        },
        close() {},
      }),
    } as unknown as AppAuthorityBundles;
    const watched = watchTranscript({
      bundles,
      instanceId: "instance",
      resource: RESOURCE,
      timeoutMs: 100,
      pollMs: 5,
      maxMessages: 200,
      projection: {
        watchTranscript(_owner, _device, _source, _sessionId, _maxMessages, listener) {
          wake = listener;
          return () => { detached += 1; };
        },
      },
      audit() {},
      listener() {},
    });
    try {
      expect(watched.ok).toBe(true);
      if (!watched.ok) return;
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(1);
      // Subscribed but nothing pushed yet: the ordinary poll keeps running.
      await vi.advanceTimersByTimeAsync(12);
      expect(requests).toBeGreaterThan(1);
      wake();
      await vi.advanceTimersByTimeAsync(0);
      const afterPush = requests;
      // A device that pushes replaces the four-second poll.
      await vi.advanceTimersByTimeAsync(25);
      expect(requests).toBe(afterPush);

      // The final answer lands while the previous read is still running.
      holdNext = true;
      wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(afterPush + 1);
      wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(afterPush + 1);
      hold!(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(afterPush + 2);
      watched.subscription.close();
      expect(detached).toBe(1);
    } finally {
      if (watched.ok) watched.subscription.close();
      vi.useRealTimers();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it.each(["succeeded", "denied"])("opens a split transcript push subscription only after a %s Gate read", async status => {
  vi.useFakeTimers();
  let resolve!: (reply: unknown) => void;
  const pending = new Promise(yes => { resolve = yes; });
  const detached = vi.fn();
  const subscribe = vi.fn(() => detached);
  const bundles = { get: () => ({ owner: "alice" }), openController: () => ({
    caps: { request: () => pending }, close() {},
  }) } as unknown as AppAuthorityBundles;
  const watched = watchTranscript({ bundles, instanceId: "instance", resource: RESOURCE,
    timeoutMs: 1000, pollMs: 10, maxMessages: 20, isSplitSession: () => true,
    projection: { watchTranscript: subscribe }, audit() {}, listener() {} });
  try {
    expect(subscribe).not.toHaveBeenCalled();
    resolve({ status, result: PAGE, reason: "revoked" });
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribe).toHaveBeenCalledTimes(status === "succeeded" ? 1 : 0);
    if (status === "succeeded") expect(subscribe).toHaveBeenCalledWith("alice", "laptop", "claude", "s1", 20, expect.any(Function));
  } finally { if (watched.ok) watched.subscription.close(); vi.useRealTimers(); }
});
