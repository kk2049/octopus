import { sessionResourceSnapshot } from "./resource-store.js";
/**
 * The controller's six rules, driven through a scriptable port.
 *
 * Each test is one of the orchestration behaviours that used to live in the
 * Session Plus App and now has to hold for every consumer of these modules. The
 * port here answers on demand rather than immediately, because four of the six
 * rules are only observable while a request is still in flight.
 */

import { useEffect } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_PERMISSION_PROFILES,
  type AttachFileChunkRequest,
  type ReadWindowRequest,
  type SessionOperation,
  type SessionsPort,
  type SessionsProjection,
  type SessionsReply,
  type SessionsSnapshot,
  type StartSessionRequest,
} from "@claude-bot/agent-sessions-contract";
import { SessionsProvider, useSessions, useSessionResource, useSessionNavigation, useSessionSearch } from "./context.js";
import type { SessionsController } from "./controller.js";
import { ChatTranscript, SHARED_CHAT_CLASSES } from "./components/ChatTranscript.js";
import {
  NEW_SESSION_PROMPT_DRAFT_RESOURCE,
  type ComposerDraftPersistence,
  type ComposerDraftRecord,
} from "./composer-drafts.js";

interface Pending {
  label: string;
  settle(ok?: boolean): void;
  /** Answer with an exact reply (e.g. a result carrying an opId). */
  settleWith(reply: SessionsReply): void;
}

interface Harness {
  port: SessionsPort;
  calls: string[];
  /** Every start request the port received, verbatim. */
  starts: StartSessionRequest[];
  turns: Array<{ action: string; resource: string; effort?: string; model?: string }>;
  prompts: Array<{ action: string; resource: string; prompt: string }>;
  pending: Pending[];
  publish(projection: SessionsProjection): void;
  operation(record: SessionOperation): void;
  settleAll(ok?: boolean): Promise<void>;
  /** Settle the newest pending call whose label starts with `prefix`. */
  settleOne(prefix: string, reply: SessionsReply): Promise<void>;
  /** Make the next roster refresh throw synchronously at the port boundary. */
  throwNextRefresh(): void;
  of(prefix: string): string[];
}

function harness(): Harness {
  const calls: string[] = [];
  const starts: StartSessionRequest[] = [];
  const turns: Array<{ action: string; resource: string; effort?: string; model?: string }> = [];
  const prompts: Array<{ action: string; resource: string; prompt: string }> = [];
  const pending: Pending[] = [];
  const listeners = new Set<() => void>();
  let snapshot: SessionsSnapshot = { phase: "open", projection: null, operations: [], refusal: "" };
  let refreshThrows = false;

  const publish = (next: SessionsSnapshot): void => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const defer = (label: string): Promise<SessionsReply> => {
    calls.push(label);
    return new Promise<SessionsReply>((resolve) => {
      pending.push({
        label,
        settle: (ok = true) => resolve({ ok, result: null, message: ok ? "" : "被拒绝" }),
        settleWith: (reply) => resolve(reply),
      });
    });
  };

  const port: SessionsPort = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearRefusal: () => publish({ ...snapshot, refusal: "" }),
    refreshSessions: () => {
      if (refreshThrows) {
        refreshThrows = false;
        calls.push("refreshSessions");
        throw new Error("provider threw");
      }
      return defer("refreshSessions");
    },
    search: (query) => defer(`search:${query}`),
    readWindow: (request: ReadWindowRequest) =>
      defer(`readWindow:${request.resource}:${request.limit}:${request.offset ?? "tail"}`),
    listWorkspaces: (device) => defer(`listWorkspaces:${device}`),
    start: (request) => {
      starts.push(request);
      return defer(`start:${request.device}:${request.directory}:${request.effort}`);
    },
    append: (resource, prompt, _profile, effort, model) => {
      turns.push({ action: "append", resource, ...(effort ? { effort } : {}), ...(model ? { model } : {}) });
      prompts.push({ action: "append", resource, prompt });
      return defer(`append:${resource}`);
    },
    resume: (resource, prompt, _profile, effort, model) => {
      turns.push({ action: "resume", resource, ...(effort ? { effort } : {}), ...(model ? { model } : {}) });
      prompts.push({ action: "resume", resource, prompt });
      return defer(`resume:${resource}`);
    },
    takeover: (resource, prompt, _profile, effort, model) => {
      turns.push({ action: "takeover", resource, ...(effort ? { effort } : {}), ...(model ? { model } : {}) });
      prompts.push({ action: "takeover", resource, prompt });
      return defer(`takeover:${resource}`);
    },
    fallback: (resource, prompt, _profile, effort, model) => {
      turns.push({ action: "fallback", resource, ...(effort ? { effort } : {}), ...(model ? { model } : {}) });
      prompts.push({ action: "fallback", resource, prompt });
      return defer(`fallback:${resource}`);
    },
    interrupt: (resource) => defer(`interrupt:${resource}`),
    releaseControl: (resource) => defer(`releaseControl:${resource}`),
    respondInteraction: (resource, interactionId) => defer(`respondInteraction:${resource}:${interactionId}`),
    openTerminal: (device, workspace) => defer(`openTerminal:${device}:${workspace}`),
    readTerminal: (device, terminal) => defer(`readTerminal:${device}:${terminal}`),
    sendTerminal: (device, terminal) => defer(`sendTerminal:${device}:${terminal}`),
    closeTerminal: (device, terminal) => defer(`closeTerminal:${device}:${terminal}`),
    pin: (resource) => defer(`pin:${resource}`),
    setTitle: (resource, title) => defer(`setTitle:${resource}:${title}`),
    markReviewed: (resource, completedAt) => defer(`markReviewed:${resource}:${completedAt}`),
    attachFile: () => defer("attachFile"),
    setFileAnnotations: (fileKey) => defer(`setFileAnnotations:${fileKey}`),
  };

  return {
    port,
    calls,
    starts,
    turns,
    prompts,
    pending,
    publish: (projection) => act(() => publish({ ...snapshot, projection })),
    operation: (record) =>
      act(() =>
        publish({ ...snapshot, operations: [record, ...snapshot.operations.filter((row) => row.id !== record.id)] }),
      ),
    async settleAll(ok = true) {
      await act(async () => {
        const rows = pending.splice(0, pending.length);
        for (const row of rows) row.settle(ok);
        await Promise.resolve();
      });
    },
    async settleOne(prefix, reply) {
      await act(async () => {
        for (let i = pending.length - 1; i >= 0; i--) {
          if (!pending[i].label.startsWith(prefix)) continue;
          const [row] = pending.splice(i, 1);
          row.settleWith(reply);
          break;
        }
        await Promise.resolve();
      });
    },
    throwNextRefresh: () => { refreshThrows = true; },
    of: (prefix) => calls.filter((call) => call.startsWith(prefix)),
  };
}

function mount(
  h: Harness,
  option?: ComposerDraftPersistence | string,
): { current: SessionsController } {
  const box = { current: null as unknown as SessionsController };
  const draftPersistence = typeof option === "string" ? undefined : option;
  const initialSelectedResource = typeof option === "string" ? option : undefined;
  function Probe() {
    box.current = useSessions();
    return null;
  }
  render(
    <SessionsProvider
      port={h.port}
      draftPersistence={draftPersistence}
      initialSelectedResource={initialSelectedResource}
    >
      <Probe />
    </SessionsProvider>,
  );
  return box as { current: SessionsController };
}

const SESSION = {
  resourceId: "res-1",
  deviceId: "laptop",
  cliKind: "codex",
  cwdDisplay: "~/projects/x",
  status: "live",
  resumable: true,
  lastActivity: new Date().toISOString(),
};

const PROJECTION: SessionsProjection = {
  sessions: [SESSION],
  sources: [{ kind: "runner", device: "laptop", online: true }],
};

const LONG_TAIL = Array.from({ length: 200 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  blocks: [{ type: "text", text: `行 ${index}` }],
}));

describe("sessions controller", () => {
  it("bounds sustained wakes, preserves their trailing read, and lets manual refresh bypass the delay", async () => {
    vi.useFakeTimers();
    const h = harness();
    const box = { current: null as unknown as SessionsController };
    function Probe() { box.current = useSessions(); return null; }
    const view = render(<SessionsProvider port={h.port} wakeToken={0}><Probe /></SessionsProvider>);
    try {
      h.publish(PROJECTION); await h.settleAll();
      for (let token = 1; token <= 19; token++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        view.rerender(<SessionsProvider port={h.port} wakeToken={token}><Probe /></SessionsProvider>);
      }
      expect(h.of("refreshSessions")).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(h.of("refreshSessions")).toHaveLength(2);
      await h.settleAll();
      view.rerender(<SessionsProvider port={h.port} wakeToken={20}><Probe /></SessionsProvider>);
      act(() => box.current.refresh());
      expect(h.of("refreshSessions")).toHaveLength(3);
      await h.settleAll();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(h.of("refreshSessions")).toHaveLength(3);
      view.rerender(<SessionsProvider port={h.port} wakeToken={21}><Probe /></SessionsProvider>);
      expect(h.of("refreshSessions")).toHaveLength(4);
      await h.settleAll();
      view.rerender(<SessionsProvider port={h.port} wakeToken={22}><Probe /></SessionsProvider>);
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(h.of("refreshSessions")).toHaveLength(4);
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it("stops automatic wake reads after refusal until an explicit refresh succeeds", async () => {
    vi.useFakeTimers();
    const h = harness();
    const box = { current: null as unknown as SessionsController };
    function Probe() { box.current = useSessions(); return null; }
    const view = render(<SessionsProvider port={h.port} wakeToken={0}><Probe /></SessionsProvider>);
    try {
      h.publish(PROJECTION);
      view.rerender(<SessionsProvider port={h.port} wakeToken={1}><Probe /></SessionsProvider>);
      await h.settleOne("refreshSessions", { ok: false, code: "denied", result: null, message: "refused" });
      view.rerender(<SessionsProvider port={h.port} wakeToken={2}><Probe /></SessionsProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(h.of("refreshSessions")).toHaveLength(1);
      act(() => box.current.refresh()); await h.settleAll();
      view.rerender(<SessionsProvider port={h.port} wakeToken={3}><Probe /></SessionsProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(h.of("refreshSessions")).toHaveLength(3);
      await h.settleAll();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it("coalesces 18 wake/user triggers into one in-flight and one trailing roster refresh", async () => {
    const h = harness();
    const box = { current: null as unknown as SessionsController };
    function Probe() {
      box.current = useSessions();
      return null;
    }
    const view = render(
      <SessionsProvider port={h.port} wakeToken={0}><Probe /></SessionsProvider>,
    );
    h.publish(PROJECTION);
    expect(h.of("refreshSessions")).toHaveLength(1);
    expect(box.current.rosterRefreshing).toBe(true);

    for (let trigger = 1; trigger <= 18; trigger += 1) {
      if (trigger % 2 === 0) {
        act(() => box.current.refresh());
      } else {
        view.rerender(
          <SessionsProvider port={h.port} wakeToken={trigger}><Probe /></SessionsProvider>,
        );
      }
    }
    // Boot is still in flight. Every later intent occupies the same one-slot
    // trailing edge instead of opening 18 more capability reads.
    expect(h.of("refreshSessions")).toHaveLength(1);
    expect(box.current.rosterRefreshing).toBe(true);
    await h.settleOne("refreshSessions", { ok: true, result: null, message: "" });
    expect(h.of("refreshSessions")).toHaveLength(2);
    expect(box.current.rosterRefreshing).toBe(true);
    await h.settleOne("refreshSessions", { ok: true, result: null, message: "" });
    expect(h.of("refreshSessions")).toHaveLength(2);
    expect(box.current.rosterRefreshing).toBe(false);
  });

  it("keeps cached rows scanning until the current port read settles, ignoring an old port reply", async () => {
    const first = harness();
    const next = harness();
    const box = { current: null as unknown as SessionsController };
    function Probe() { box.current = useSessions(); return null; }
    const view = render(<SessionsProvider port={first.port}><Probe /></SessionsProvider>);
    first.publish({ ...PROJECTION, resourceState: "ready" });
    expect(box.current.sessions).toHaveLength(1);
    expect(box.current.rosterRefreshing).toBe(true);
    view.rerender(<SessionsProvider port={next.port}><Probe /></SessionsProvider>);
    next.publish({ ...PROJECTION, resourceState: "ready" });
    await first.settleAll();
    expect(box.current.rosterRefreshing).toBe(true);
    await next.settleOne("refreshSessions", { ok: true, result: null, message: "" });
    expect(box.current.rosterRefreshing).toBe(false);
    next.publish({ ...PROJECTION, resourceState: "loading" });
    expect(box.current.rosterRefreshing).toBe(true);
    next.publish({ ...PROJECTION, resourceState: "ready" });
    expect(box.current.rosterRefreshing).toBe(false);
    await next.settleAll();
  });

  it("recovers after a refusal and a synchronous provider throw", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    // The explicit user refresh is retained behind the boot read.
    act(() => controller.current.refresh());
    h.throwNextRefresh();
    await h.settleOne("refreshSessions", {
      ok: false,
      code: "denied",
      result: null,
      message: "被拒绝",
    });
    // The refused boot attempt released the interlock and pumped the retained
    // request; that provider call threw, but was contained as another settled
    // attempt rather than wedging the controller.
    expect(h.of("refreshSessions")).toHaveLength(2);
    act(() => controller.current.refresh());
    expect(h.of("refreshSessions")).toHaveLength(3);
    await h.settleOne("refreshSessions", { ok: true, result: null, message: "" });
  });

  it("runs an explicit user refresh now, with one trailing refresh while it is pending", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    const before = h.of("refreshSessions").length;

    act(() => controller.current.refresh());
    act(() => controller.current.refresh());
    expect(h.of("refreshSessions")).toHaveLength(before + 1);
    await h.settleOne("refreshSessions", { ok: true, result: null, message: "" });
    expect(h.of("refreshSessions")).toHaveLength(before + 2);
    await h.settleOne("refreshSessions", { ok: true, result: null, message: "" });
  });

  it("does not pump a queued roster refresh after the Provider unmounts", async () => {
    const h = harness();
    const box = { current: null as unknown as SessionsController };
    function Probe() {
      box.current = useSessions();
      return null;
    }
    const view = render(<SessionsProvider port={h.port}><Probe /></SessionsProvider>);
    h.publish(PROJECTION);
    act(() => box.current.refresh());
    expect(h.of("refreshSessions")).toHaveLength(1);

    view.unmount();
    await h.settleOne("refreshSessions", { ok: true, result: null, message: "" });
    expect(h.of("refreshSessions")).toHaveLength(1);
  });

  it("on boot: selects, reads the tail once and refreshes the roster", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    expect(controller.current.selected).toBe("res-1");
    expect(h.of("readWindow")).toEqual(["readWindow:res-1:200:tail"]);
    expect(h.of("refreshSessions")).toHaveLength(1);
    await h.settleAll();
  });

  it("keeps an App-validated recovered selection instead of replacing it with the roster default", async () => {
    const h = harness();
    const controller = mount(h, "res-2");
    h.publish({ ...PROJECTION, sessions: [SESSION, { ...SESSION, resourceId: "res-2" }] });
    expect(controller.current.selected).toBe("res-2");
    expect(h.of("readWindow")).toEqual(["readWindow:res-2:200:tail"]);
    await h.settleAll();
  });

  it("tracks transcript refreshes by resource while queued cached chats stay visible", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [SESSION, { ...SESSION, resourceId: "res-2" }],
      transcript: {
        "res-1": { messages: [{ role: "assistant", text: "一" }], offset: 0 },
        "res-2": { messages: [{ role: "assistant", text: "二" }], offset: 0 },
      },
    });
    await h.settleAll();

    act(() => {
      controller.current.read("res-1", 200);
      controller.current.read("res-2", 200);
    });
    expect(controller.current.transcriptRefreshing("res-1")).toBe(true);
    expect(controller.current.transcriptRefreshing("res-2")).toBe(true);
    expect(controller.current.windowOf("res-2")?.messages?.[0]?.text).toBe("二");

    await h.settleOne("readWindow:res-1", { ok: true, result: null, message: "" });
    expect(controller.current.transcriptRefreshing("res-1")).toBe(false);
    expect(controller.current.transcriptRefreshing("res-2")).toBe(true);
    await h.settleOne("readWindow:res-2", { ok: true, result: null, message: "" });
    expect(controller.current.transcriptBusy).toBe(false);
  });

  it("keeps a newer per-resource transcript when a later frame carries an older boundary", async () => {
    const h = harness();
    const controller = mount(h);
    const version = (sequence: number) => ({ epoch: "runner-epoch-one", sequence });
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 40,
          totalMessages: 42,
          version: version(10),
          messages: [
            { role: "assistant", text: "进度" },
            { role: "assistant", text: "任务完成" },
          ],
        },
      },
    });
    expect(controller.current.windowOf("res-1")).toMatchObject({
      offset: 40,
      totalMessages: 42,
      version: version(10),
      messages: [{ text: "进度" }, { text: "任务完成" }],
    });

    h.publish({
      ...PROJECTION,
      notice: "更高的页面帧 revision",
      transcript: {
        "res-1": {
          offset: 0,
          totalMessages: 41,
          version: version(9),
          messages: [{ role: "assistant", text: "更老的 history boundary" }],
        },
      },
    });
    expect(controller.current.windowOf("res-1")).toMatchObject({
      offset: 40,
      totalMessages: 42,
      version: version(10),
      messages: [{ text: "进度" }, { text: "任务完成" }],
    });
    await h.settleAll();
  });

  it("acknowledges review only on explicit selection and restores the marker on refusal", async () => {
    const h = harness();
    const controller = mount(h);
    const completedAt = "2026-08-25T10:05:00Z";
    h.publish({
      ...PROJECTION,
      reviewedAt: {},
      sessions: [{ ...SESSION, completedAt, sortActivity: completedAt }],
    });
    await h.settleAll();
    expect(h.of("markReviewed")).toHaveLength(0);
    expect(controller.current.roster[0]?.needsReview).toBe(true);

    act(() => controller.current.select(SESSION.resourceId));
    expect(h.of("markReviewed")).toEqual([`markReviewed:${SESSION.resourceId}:${completedAt}`]);
    expect(controller.current.roster[0]?.needsReview).toBe(false);

    await h.settleOne("markReviewed", {
      ok: false,
      result: null,
      message: "验收状态未保存",
      code: "action_rejected",
    });
    expect(controller.current.roster[0]?.needsReview).toBe(true);
  });

  it("waits for the settled roster before choosing the default chat", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      resourceState: "loading",
      sessions: [{ ...SESSION, resourceId: "fast-observer" }],
    });
    expect(controller.current.rosterRefreshing).toBe(true);
    expect(controller.current.selected).toBeNull();
    expect(h.of("readWindow")).toHaveLength(0);

    h.publish(PROJECTION);
    expect(controller.current.rosterRefreshing).toBe(true);
    expect(controller.current.selected).toBe("res-1");
    expect(h.of("readWindow")).toEqual(["readWindow:res-1:200:tail"]);
    await h.settleAll();
    expect(controller.current.rosterRefreshing).toBe(false);
  });

  it.each(["truncated", "backfilling"])("keeps headless roots and history selections while the recent window is %s", async (state) => {
    const h = harness();
    const controller = mount(h);
    const flags = state === "truncated" ? { rosterTruncated: true } : { rosterIndexPending: true };
    h.publish({ ...PROJECTION, ...flags, sessions: [{ ...SESSION, executionMode: "exec" }],
      sessionHistory: { device: "device", source: "all", cursor: "", hasMore: false, totalFound: 501,
        sessions: [{ ...SESSION, resourceId: "older", title: "Older task" }] } });
    expect(controller.current.selected).toBe("res-1");
    await h.settleAll();
    act(() => controller.current.select("older"));
    expect(controller.current.sessionOf("older")?.title).toBe("Older task");
    expect(controller.current.sessionAbsent("older")).toBe(false);
    await h.settleAll();
    h.publish({ ...PROJECTION, ...flags });
    expect(controller.current.sessionOf("older")?.title).toBe("Older task");
    expect(controller.current.selectedAbsent).toBe(false);
    expect(controller.current.sessionAbsent("older")).toBe(false);
  });

  it("opens search-only sessions and retains the selection after a full recent roster replaces the search", async () => {
    const h = harness();
    const controller = mount(h);
    const recent = { ...PROJECTION, rosterTruncated: true, sessions: Array.from({ length: 500 }, (_, index) =>
      ({ ...SESSION, resourceId: `recent-${index}` })) };
    const older = { ...SESSION, resourceId: "search-only", title: "Older search result", status: "idle" };
    h.publish({ ...recent, search: { query: "Older", results: [{ session: older }] } });
    await h.settleAll();
    expect(controller.current.sessionOf(older.resourceId)).toEqual(older);
    expect(controller.current.sessions).toHaveLength(500);
    expect(h.of("readWindow").some((call) => call.includes(older.resourceId))).toBe(false);

    let release!: () => void;
    act(() => {
      controller.current.select(older.resourceId);
      release = controller.current.retainTranscript(older.resourceId);
    });
    expect(controller.current.current).toEqual(older);
    expect(h.of("readWindow")).toContain("readWindow:search-only:200:tail");
    await h.settleAll();
    // Two frames exercise retention through repeated cache pressure, rather
    // than merely reading the previous render's summary cache.
    h.publish(recent);
    h.publish({ ...recent, customTitles: { [older.resourceId]: "Retained search" } });
    expect(controller.current.current?.title).toBe("Retained search");
    expect(controller.current.sessionOf(older.resourceId)?.title).toBe("Retained search");
    expect(controller.current.selectedAbsent).toBe(false);
    expect(controller.current.sessionAbsent(older.resourceId)).toBe(false);
    act(() => controller.current.send(older.resourceId, "continue"));
    expect(h.turns).toContainEqual({ action: "resume", resource: older.resourceId });
    await h.settleAll();
    act(() => controller.current.select("recent-1"));
    h.publish(recent);
    h.publish({ ...recent });
    expect(controller.current.current?.resourceId).toBe("recent-1");
    expect(controller.current.sessionOf(older.resourceId)).toEqual(older);
    act(release);
    await h.settleAll();
  });

  it("uses current roster facts ahead of search hits and preserves search-only input restrictions", async () => {
    const h = harness();
    const controller = mount(h);
    const child = { ...SESSION, resourceId: "search-child", inputMode: "parent_owned" as const };
    h.publish({ ...PROJECTION, search: { query: "task", results: [
      { session: { ...SESSION, title: "Stale search title", status: "idle" } },
      { session: child },
      { snippet: "No session identity" },
    ] } });
    await h.settleAll();
    expect(controller.current.sessionOf(SESSION.resourceId)).toEqual(SESSION);
    expect(controller.current.sessionOf("unknown")).toBeNull();
    expect(controller.current.sessionAbsent(child.resourceId)).toBe(false);
    act(() => controller.current.select(child.resourceId));
    expect(controller.current.selectedAbsent).toBe(false);
    act(() => controller.current.send(child.resourceId, "must stay with parent"));
    act(() => controller.current.takeover(child.resourceId, "must stay with parent"));
    expect(h.turns).toHaveLength(0);
    await h.settleAll();
  });

  it("does not automatically open subagents and preserves an explicitly selected child", async () => {
    const h = harness();
    const controller = mount(h);
    const child = { ...SESSION, resourceId: "child", parentResourceId: "res-1", lastActivity: "2099-01-01T00:00:00Z" };
    h.publish({ ...PROJECTION, sessions: [child] });
    expect(controller.current.selected).toBeNull();
    expect(h.of("readWindow")).toHaveLength(0);
    h.publish({ ...PROJECTION, sessions: [child, SESSION] });
    expect(controller.current.selected).toBe("res-1");
    await h.settleAll();
    act(() => controller.current.select("child"));
    h.publish({ ...PROJECTION, sessions: [child, SESSION] });
    expect(controller.current.selected).toBe("child");
    await h.settleAll();
  });

  it("answers the exact projected interaction and refreshes that transcript", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        runtime: {
          process_state: "alive",
          turn_state: "needs_input",
          capabilities: { respond: true },
          interaction: {
            id: "ai_current",
            provider: "codex",
            kind: "question",
            title: "Codex 需要你的回答",
            questions: [{
              id: "acceptance",
              header: "验收结果",
              prompt: "通过吗？",
              options: [{ label: "通过" }],
              multiple: false,
              allow_other: false,
              secret: false,
            }],
            created_at: "2026-08-12T03:00:00Z",
            expires_at: "2026-08-12T03:10:00Z",
            capabilities: { respond: true, allow: true, deny: true },
          },
        },
      }],
    });
    await h.settleAll();
    const before = h.of("readWindow:res-1").length;
    const rosterBefore = h.of("refreshSessions").length;
    const answered = controller.current.respondInteraction("res-1", "ai_current", {
      decision: "allow",
      answers: { acceptance: ["通过"] },
    });
    expect(h.of("respondInteraction")).toEqual(["respondInteraction:res-1:ai_current"]);
    await h.settleAll();
    await answered;
    expect(h.of("readWindow:res-1")).toHaveLength(before + 1);
    expect(h.of("refreshSessions")).toHaveLength(rosterBefore + 1);
    expect(controller.current.resolvedInteractionOf("res-1")).toMatchObject({
      interaction: { id: "ai_current" },
      response: { decision: "allow", answers: { acceptance: ["通过"] } },
    });
  });

  it("serializes history and tail reads for the same resource", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    // The boot read is outstanding; a second one would interleave a page of
    // history with a tail refresh and produce a window that is neither. So it
    // waits at the door rather than at the provider.
    act(() => controller.current.read("res-1", 60, 0));
    expect(h.of("readWindow")).toEqual(["readWindow:res-1:200:tail"]);
    // …and it is not forgotten: dropping it is how a panel loads forever.
    await h.settleAll();
    expect(h.of("readWindow")).toEqual(["readWindow:res-1:200:tail", "readWindow:res-1:60:0"]);
    await h.settleAll();
  });

  it("keeps a second resource asked for mid-read, and asks for one window once", async () => {
    const h = harness();
    const controller = mount(h);
    const second = { ...SESSION, resourceId: "res-2" };
    h.publish({ ...PROJECTION, sessions: [SESSION, second] });
    expect(h.of("readWindow")).toEqual(["readWindow:res-1:200:tail"]);

    // A second chat panel, opened for its own session while the boot read is in
    // flight. Nothing else will ever ask on its behalf.
    act(() => controller.current.read("res-2", 200));
    // Two more requests that are the SAME window as one already pending: the
    // answer on its way is their answer, so neither becomes a second read.
    act(() => controller.current.read("res-2", 200));
    act(() => controller.current.read("res-1", 200));
    expect(h.of("readWindow")).toEqual(["readWindow:res-1:200:tail", "readWindow:res-2:200:tail"]);

    await h.settleAll();
    expect(h.of("readWindow")).toEqual(["readWindow:res-1:200:tail", "readWindow:res-2:200:tail"]);
    await h.settleAll();
  });

  it("asks for a missing transcript once, and not again on the next projection", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    // The provider refuses. That is an ANSWER: re-asking on every later frame is
    // how one denied read becomes a stream of approval cards.
    await h.settleAll(false);
    const asked = h.of("readWindow").length;
    act(() => controller.current.ensureTranscript("res-1"));
    h.publish({ ...PROJECTION, notice: "又一帧" });
    h.publish({ ...PROJECTION, notice: "再一帧" });
    expect(h.of("readWindow")).toHaveLength(asked);
  });

  it("extends a too-short tail in visible units, and leaves a long one alone", async () => {
    const h = harness();
    mount(h);
    h.publish(PROJECTION);
    // Twelve folded tool calls read as ONE row, so this tail is too short even
    // though it holds twelve messages.
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 100,
          totalMessages: 112,
          messages: Array.from({ length: 12 }, () => ({
            role: "assistant",
            blocks: [{ type: "tool", tool: "Bash", output: "ok" }],
          })),
        },
      },
    });
    await h.settleAll();
    expect(h.of("readWindow")).toEqual(["readWindow:res-1:200:tail", "readWindow:res-1:100:0"]);
    await h.settleAll();

    const wide = harness();
    mount(wide);
    wide.publish(PROJECTION);
    wide.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 60, totalMessages: 260, messages: LONG_TAIL } },
    });
    await wide.settleAll();
    expect(wide.of("readWindow")).toHaveLength(1);
  });

  it("extends the resource that was read, not whichever roster row is selected", async () => {
    const h = harness();
    const controller = mount(h);
    const second = { ...SESSION, resourceId: "res-2" };
    h.publish({ ...PROJECTION, sessions: [SESSION, second] });
    await h.settleAll();

    h.publish({
      ...PROJECTION,
      sessions: [SESSION, second],
      transcript: {
        "res-1": { offset: 0, totalMessages: LONG_TAIL.length, messages: LONG_TAIL },
        "res-2": {
          offset: 80,
          totalMessages: 92,
          messages: Array.from({ length: 12 }, () => ({
            role: "assistant",
            blocks: [{ type: "tool", tool: "Bash", output: "ok" }],
          })),
        },
      },
    });
    expect(controller.current.selected).toBe("res-1");
    act(() => controller.current.read("res-2", 200));
    await h.settleAll();

    expect(h.of("readWindow")).toContain("readWindow:res-2:80:0");
    expect(h.of("readWindow").filter((call) => call.includes("res-1"))).toHaveLength(1);
    await h.settleAll();
  });

  it("allows two independent workspace lookups without re-asking on frames", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [SESSION, { ...SESSION, resourceId: "res-2", deviceId: "desktop" }],
      sources: [
        { kind: "runner", device: "laptop", online: true },
        { kind: "runner", device: "desktop", online: true },
      ],
    });
    // Both requested devices can progress; each still makes its own Gate call.
    expect(h.of("listWorkspaces")).toEqual(["listWorkspaces:desktop", "listWorkspaces:laptop"]);
    await h.settleAll();
    expect(h.of("listWorkspaces")).toEqual(["listWorkspaces:desktop", "listWorkspaces:laptop"]);
    await h.settleAll();

    // A projection update does not re-ask the machines that already answered.
    h.publish({ ...PROJECTION, notice: "又刷新了一次" });
    expect(h.of("listWorkspaces")).toHaveLength(2);
    // An explicit refresh does.
    act(() => controller.current.requestWorkspaces(true));
    expect(h.of("listWorkspaces")).toHaveLength(3);
    await h.settleAll();
  });

  it("does not retry workspace refusals on frames and can explicitly refresh one device", async () => {
    const h = harness();
    const controller = mount(h);
    const projection = { ...PROJECTION, sources: [
      { kind: "runner", device: "laptop" }, { kind: "runner", device: "desktop" },
    ] };
    h.publish(projection);
    await h.settleAll(false);
    h.publish({ ...projection, notice: "another frame" });
    expect(h.of("listWorkspaces")).toEqual(["listWorkspaces:desktop", "listWorkspaces:laptop"]);
    act(() => controller.current.requestWorkspaces(true, "desktop"));
    await h.settleAll();
    expect(h.of("listWorkspaces")).toEqual(["listWorkspaces:desktop", "listWorkspaces:laptop", "listWorkspaces:desktop"]);
    act(() => controller.current.requestWorkspaces(true, "unprojected-device"));
    expect(h.of("listWorkspaces")).toHaveLength(3);
  });

  it("re-reads once when a submission finishes, not on every later frame", async () => {
    const h = harness();
    mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    const before = h.of("readWindow").length;
    h.operation({ id: "op-1", status: "succeeded", operation: "append_session", message: "已完成" });
    await h.settleAll();
    h.operation({ id: "op-1", status: "succeeded", operation: "append_session", message: "已完成" });
    await h.settleAll();
    expect(h.of("readWindow")).toHaveLength(before + 1);
  });

  it("does not poll the roster while a session write is running", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      mount(h);
      h.publish(PROJECTION);
      await h.settleAll();
      const before = h.of("refreshSessions").length;

      h.operation({
        id: "op-waiting-for-agent-input",
        resourceId: "res-1",
        status: "running",
        operation: "append_session",
        message: "Claude 正在续跑这个会话",
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(h.of("refreshSessions")).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("proposes the lane the form is on, and says nothing when it is the plain one", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();

    act(() => {
      controller.current.setNewSession({
        device: "laptop",
        directory: "/srv/x",
        source: "claude",
        translatePrompt: false,
        model: "",
        effort: "high",
        prompt: "开始",
      });
    });
    await act(async () => { void controller.current.startNewSession(); });
    expect(h.starts[0]).toMatchObject({ source: "claude" });
    expect(h.starts[0]).not.toHaveProperty("translatePrompt");
    await h.settleOne("start:", { ok: true, message: "", result: { opId: "plain-lane-launch" } });
    h.operation({ id: "plain-lane-launch", status: "succeeded", operation: "start_session" });
    await h.settleAll();

    act(() => {
      controller.current.setNewSession({ translatePrompt: true, prompt: "开始" });
    });
    await act(async () => { void controller.current.startNewSession(); });
    // Still the claude provider — the lane is a launch option, not a fourth
    // kind of session for the roster to invent a row for.
    expect(h.starts[1]).toMatchObject({ source: "claude", translatePrompt: true });
    await h.settleAll();
  });

  it("defaults a new launch to Codex Sol at xhigh with full access", () => {
    const controller = mount(harness());
    expect(controller.current.newSession).toMatchObject({
      source: "codex",
      translatePrompt: false,
      model: "gpt-6-astra",
      effort: "xhigh",
      permissionProfile: AGENT_PERMISSION_PROFILES.fullAccess,
    });
  });

  // ── Ticket #191: a launch has to end somewhere the person can see ────────

  it("keeps the Host's refusal on the form instead of dropping the receipt", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => {
      controller.current.setNewSession({ device: "laptop", directory: "/srv/x", prompt: "开始" });
    });
    await act(async () => { void controller.current.startNewSession(); });
    expect(controller.current.launch).toMatchObject({ phase: "sending" });

    await h.settleOne("start:", { ok: false, message: "当前实例没有可用的 Runner 权限" });
    expect(controller.current.launch).toMatchObject({
      phase: "refused",
      message: "当前实例没有可用的 Runner 权限",
    });
    // A refused launch costs a retry, not a retype.
    expect(controller.current.newSession).toMatchObject({ directory: "/srv/x", prompt: "开始" });
  });

  it("follows an accepted start into the operation stream and reports the device's failure", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => {
      controller.current.setNewSession({ device: "laptop", directory: "/srv/x", prompt: "开始" });
    });
    await act(async () => { void controller.current.startNewSession(); });
    await h.settleOne("start:", { ok: true, result: { opId: "op-launch" }, message: "" });
    expect(controller.current.launch).toMatchObject({ phase: "submitted", opId: "op-launch" });

    h.operation({ id: "op-launch", status: "running", operation: "start_session" });
    await h.settleAll();
    expect(controller.current.launch).toMatchObject({ phase: "running" });

    // The whole point of the ticket: accepted then failed, minutes later, with
    // nothing on screen to say so.
    h.operation({ id: "op-launch", status: "failed", operation: "start_session", message: "目录不存在" });
    await h.settleAll();
    expect(controller.current.launch).toMatchObject({ phase: "failed", message: "目录不存在" });
    // Terminal, so the form is usable again — and the draft is still there.
    expect(controller.current.newSession).toMatchObject({ prompt: "开始" });
    act(() => controller.current.dismissLaunch());
    expect(controller.current.launch).toBeNull();
  });

  it("reports a start the device actually performed, and will not launch twice meanwhile", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => {
      controller.current.setNewSession({ device: "laptop", directory: "/srv/x", prompt: "开始" });
    });
    await act(async () => { void controller.current.startNewSession(); });
    const inFlight = h.of("start:").length;
    // A second click while the first is unanswered is the same question.
    await act(async () => {
      const second = await controller.current.startNewSession();
      expect(second.ok).toBe(false);
    });
    expect(h.of("start:")).toHaveLength(inFlight);
    // An in-flight launch cannot be dismissed away either.
    act(() => controller.current.dismissLaunch());
    expect(controller.current.launch).toMatchObject({ phase: "sending" });

    await h.settleOne("start:", { ok: true, result: { opId: "op-launch" }, message: "" });
    h.operation({
      id: "op-launch",
      status: "succeeded",
      operation: "start_session",
      message: "已启动",
      newResourceId: "res-new",
    });
    await h.settleAll();
    expect(controller.current.launch).toMatchObject({ phase: "succeeded", newResourceId: "res-new" });
  });

  it("clears only the instruction when a start succeeds, and refreshes the roster", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.current.setNewSession({ device: "laptop", directory: "/srv/x", prompt: "开始" }));
    const refreshes = h.of("refreshSessions").length;
    await act(async () => { void controller.current.startNewSession(); });
    await h.settleOne("start:", { ok: true, result: { opId: "op-2" }, message: "" });
    h.operation({ id: "op-2", status: "succeeded", operation: "start_session", message: "已完成" });
    await h.settleAll();
    expect(controller.current.newSession).toMatchObject({ device: "laptop", directory: "/srv/x", prompt: "" });
    expect(h.of("refreshSessions")).toHaveLength(refreshes + 1);
  });

  it("hydrates the new-Agent prompt and tombstones it before the launch receipt", async () => {
    let at = 1_000;
    const values = new Map<string, ComposerDraftRecord>([
      [NEW_SESSION_PROMPT_DRAFT_RESOURCE, { text: "刷新前的启动指令", updatedAt: at }],
    ]);
    const listeners = new Map<string, Set<(record: ComposerDraftRecord) => void>>();
    const persistence: ComposerDraftPersistence = {
      get: (key) => values.get(key) ?? { text: "", updatedAt: 0 },
      set: (key, text) => {
        const record = { text, updatedAt: ++at };
        values.set(key, record);
        for (const listener of listeners.get(key) ?? []) listener(record);
      },
      subscribe: (key, listener) => {
        const set = listeners.get(key) ?? new Set();
        set.add(listener);
        listeners.set(key, set);
        return () => { set.delete(listener); };
      },
    };
    const h = harness();
    const controller = mount(h, persistence);
    h.publish(PROJECTION);
    await h.settleAll();
    expect(controller.current.newSession.prompt).toBe("刷新前的启动指令");

    act(() => controller.current.setNewSession({ device: "laptop", directory: "/srv/x" }));
    await act(async () => { void controller.current.startNewSession(); });
    expect(values.get(NEW_SESSION_PROMPT_DRAFT_RESOURCE)?.text).toBe("");
    expect(controller.current.newSession.prompt).toBe("刷新前的启动指令");

    await h.settleOne("start:", { ok: false, code: "permission_denied", message: "拒绝" });
    expect(values.get(NEW_SESSION_PROMPT_DRAFT_RESOURCE)?.text).toBe("刷新前的启动指令");
  });

  it("appends to a live session and resumes an idle one", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({ ...PROJECTION, sessions: [{ ...SESSION, deviceId: "model-host", accountLabel: "b" }],
      placement: { devices: [{ device: "model-host", codexAccounts: [{ id: "b", label: "codexb",
        models: [{ value: "local-discovered-model", label: "Local" }] }] }] } });
    await h.settleAll();
    expect(sessionResourceSnapshot(controller.current, "res-1").models).toEqual([
      { value: "local-discovered-model", label: "Local" },
    ]);
    act(() => controller.current.send("res-1", "请继续"));
    expect(h.of("append:res-1")).toHaveLength(1);
    expect(h.turns.at(-1)).toEqual({ action: "append", resource: "res-1" });
    h.publish({ ...PROJECTION, sessions: [{ ...SESSION, status: "idle" }] });
    await h.settleAll();
    act(() => controller.current.setModel("res-1", "local-discovered-model"));
    act(() => controller.current.setEffort("res-1", "max"));
    expect(controller.current.modelOf("res-1")).toBe("local-discovered-model");
    expect(controller.current.effortOf("res-1")).toBe("max");
    act(() => controller.current.send("res-1", "恢复它"));
    expect(h.of("resume:res-1")).toHaveLength(1);
    expect(h.turns.at(-1)).toEqual({
      action: "resume",
      resource: "res-1",
      effort: "max",
      model: "local-discovered-model",
    });
    await h.settleAll();
  });

  it("never proposes direct input or control for a parent-owned child", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        inputMode: "parent_owned",
        parentResourceId: "res-parent",
        runtime: { capabilities: { takeover: true, interrupt: true } },
      }],
    });
    await h.settleAll();
    act(() => {
      controller.current.send("res-1", "直接发");
      controller.current.takeover("res-1", "接管发");
      controller.current.fallback("res-1", "分叉发");
      controller.current.interrupt("res-1");
    });
    expect(h.of("append:res-1")).toHaveLength(0);
    expect(h.of("resume:res-1")).toHaveLength(0);
    expect(h.of("takeover:res-1")).toHaveLength(0);
    expect(h.of("fallback:res-1")).toHaveLength(0);
    expect(h.of("interrupt:res-1")).toHaveLength(0);
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
  });

  it("submits takeover only through the explicit controller method", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        runtime: {
          process_state: "alive",
          turn_state: "working",
          capabilities: { takeover: true },
        },
      }],
    });
    await h.settleAll();
    act(() => controller.current.takeover("res-1", "从浏览器接手"));
    expect(h.of("takeover:res-1")).toHaveLength(1);
    await h.settleAll();
  });

  it("carries a chosen model/effort for an Agent started elsewhere only on the explicit takeover", async () => {
    // Ticket #767: a terminal TUI cannot change model through an ordinary
    // send (the device refuses that), but the takeover that stops the exact
    // CLI opens a managed turn where the choice is authoritative.
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        runtime: {
          process_state: "alive",
          turn_state: "idle",
          control_mode: "external_cli",
          attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" },
          capabilities: { terminal_append: true, takeover: true },
        },
      }],
    });
    await h.settleAll();
    act(() => {
      controller.current.setModel("res-1", "gpt-5.6-terra");
      controller.current.setEffort("res-1", "max");
    });
    act(() => controller.current.send("res-1", "普通发送"));
    expect(h.turns.at(-1)).toEqual({ action: "append", resource: "res-1" });
    await h.settleAll();
    act(() => controller.current.takeover("res-1", "交给托管"));
    expect(h.turns.at(-1)).toEqual({ action: "takeover", resource: "res-1", effort: "max", model: "gpt-5.6-terra" });
    await h.settleAll();
  });

  it("tracks an explicit account fallback and follows the new opaque session", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [{ ...SESSION, status: "idle", accountLabel: "a" }],
    });
    await h.settleAll();
    act(() => controller.current.fallback("res-1", "换账号继续"));
    expect(h.of("fallback:res-1")).toHaveLength(1);
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ kind: "fallback" }]);
    await h.settleOne("fallback:res-1", {
      ok: true,
      result: { opId: "op-fallback" },
      message: "",
    });
    h.operation({
      id: "op-fallback",
      operation: "fallback_session",
      status: "succeeded",
      newResourceId: "res-2",
    });
    expect(controller.current.selected).toBe("res-2");
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    expect(controller.current.pendingSendsOf("res-2")).toEqual([]);
    await h.settleAll();
  });

  it("follows a proven TUI rebound without carrying the origin echo's coordinates into it", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [{ ...SESSION, status: "idle" }],
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "从新会话继续"));
    await h.settleOne("resume:res-1", {
      ok: true,
      result: { opId: "op-resume-rebound" },
      message: "",
    });
    h.operation({
      id: "op-resume-rebound",
      operation: "append_session",
      status: "succeeded",
      newResourceId: "res-rebound",
    });
    expect(controller.current.selected).toBe("res-rebound");
    // The operation is authoritative evidence of the cross-resource handoff.
    // The old absolute cursor is never compared with the rebound transcript,
    // so no optimistic duplicate can survive beside its provider copy.
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    expect(controller.current.pendingSendsOf("res-rebound")).toEqual([]);
    expect(h.of("readWindow:res-rebound")).toHaveLength(1);
    await h.settleAll();
  });

  it("uploads a file above 8 MiB as ordered 256 KiB chunks and forwards the opaque receipt", async () => {
    const h = harness();
    const requests: AttachFileChunkRequest[] = [];
    h.port.attachFile = vi.fn(async (request) => {
      requests.push(request);
      return request.chunkIndex < 32
        ? {
            ok: true,
            result: { upload_id: "abcdefghijklmnopqrstuvwx", complete: false, received_bytes: (request.chunkIndex + 1) * 256 * 1024 },
            message: "",
          }
        : {
            ok: true,
            result: {
              upload_id: "abcdefghijklmnopqrstuvwx",
              complete: true,
              attachment: {
                label: "large.bin",
                path: "/tmp/octopus-session-test/large.bin",
                bytes: 8 * 1024 * 1024 + 1,
              },
            },
            message: "",
          };
    });
    const controller = mount(h);
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1).fill(65);
    const file = {
      size: bytes.length,
      name: "large.bin",
      type: "application/octet-stream",
      slice(start: number, end: number) {
        const chunk = bytes.slice(start, end);
        return { arrayBuffer: async () => chunk.buffer };
      },
    } as unknown as File;

    let result: unknown;
    const onProgress = vi.fn();
    await act(async () => {
      result = await controller.current.attachFile("res-1", file, onProgress);
    });

    expect(requests).toHaveLength(33);
    expect(requests[0]).toMatchObject({ chunkIndex: 0, chunkCount: 33, resource: "res-1" });
    expect(requests[0].uploadId).toBeUndefined();
    expect(requests[0].data).toHaveLength(Math.ceil((256 * 1024) / 3) * 4);
    expect(requests[32]).toMatchObject({
      chunkIndex: 32,
      chunkCount: 33,
      uploadId: "abcdefghijklmnopqrstuvwx",
      data: "QQ==",
    });
    expect(onProgress).toHaveBeenCalledTimes(33);
    expect(onProgress.mock.calls.at(-1)).toEqual([bytes.length, bytes.length]);
    expect(requests.every((request) => request.data.length <= Math.ceil((256 * 1024) / 3) * 4)).toBe(true);
    expect(result).toEqual({
      ok: true,
      attachment: {
        label: "large.bin",
        path: "/tmp/octopus-session-test/large.bin",
        bytes: 8 * 1024 * 1024 + 1,
      },
    });
  });

  it("submits native managed interrupt without inventing a prompt", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.current.interrupt("res-1"));
    expect(h.of("interrupt:res-1")).toHaveLength(1);
    await h.settleAll();
  });

  it("keeps one exact Codex release pending until its operation settles", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();

    act(() => controller.current.releaseControl("res-1"));
    expect(h.of("releaseControl:res-1")).toHaveLength(1);
    expect(controller.current.controlReleaseOf("res-1")).toMatchObject({ phase: "sending" });
    act(() => controller.current.releaseControl("res-1"));
    expect(h.of("releaseControl:res-1")).toHaveLength(1);

    await h.settleOne("releaseControl:res-1", {
      ok: true,
      result: { opId: "op-release" },
      message: "",
    });
    expect(controller.current.controlReleaseOf("res-1")).toMatchObject({
      phase: "submitted",
      opId: "op-release",
    });
    h.operation({ id: "op-release", status: "running", operation: "release_session_control" });
    expect(controller.current.controlReleaseOf("res-1")).toMatchObject({ phase: "running" });
    h.operation({ id: "op-release", status: "succeeded", operation: "release_session_control" });
    expect(controller.current.controlReleaseOf("res-1")).toMatchObject({
      phase: "done",
      message: expect.stringContaining("可以回到本机 Codex CLI"),
    });
    act(() => controller.current.dismissControlRelease("res-1"));
    expect(controller.current.controlReleaseOf("res-1")).toBeNull();
  });

  it("reads an unknown release outcome as uncertain, not as a failure, and leaves the retry to the person", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();

    act(() => controller.current.releaseControl("res-1"));
    await h.settleOne("releaseControl:res-1", { ok: true, result: { opId: "op-release" }, message: "" });
    h.operation({ id: "op-release", status: "unknown", operation: "release_session_control", message: "Runner 执行结果未知" });
    expect(controller.current.controlReleaseOf("res-1")).toMatchObject({ phase: "uncertain", message: "Runner 执行结果未知" });
    expect(h.of("releaseControl:res-1")).toHaveLength(1);
    act(() => controller.current.releaseControl("res-1"));
    expect(h.of("releaseControl:res-1")).toHaveLength(2);
    await h.settleAll();
  });

  it("keeps a selection the frame's roster lacks — absence is not deletion", async () => {
    // The old behaviour ("repair" to list[0]) WAS the focused-chat-jumps bug:
    // a device timing out of one fan-out, the row cap or a plane failure drops
    // rows for a frame without anything being deleted, and list[0] is the most
    // recently active session — so the person's chat followed other people's
    // activity. The discipline now: a data frame may fill an EMPTY selection,
    // and may never override the person's.
    const h = harness();
    const controller = mount(h);
    const namedProjection = {
      ...PROJECTION,
      sessions: [{ ...SESSION, title: "Provider 标题" }],
      customTitles: { [SESSION.resourceId]: "我的标题" },
    };
    h.publish(namedProjection);
    await h.settleAll();
    expect(controller.current.selected).toBe(SESSION.resourceId);
    expect(controller.current.selectedAbsent).toBe(false);
    expect(controller.current.current?.title).toBe("我的标题");
    // The selected row vanishes after naming. Cache/retention keep the raw
    // provider row; the account title is applied only when the row is rendered.
    h.publish({ ...namedProjection, sessions: [{ ...SESSION, resourceId: "res-9" }] });
    expect(controller.current.selected).toBe(SESSION.resourceId);
    expect(controller.current.selectedAbsent).toBe(true);
    expect(controller.current.current?.title).toBe("我的标题");
    await h.settleAll();
    // Clearing while still absent must reveal the cached provider title, not
    // the custom title that was active when the row disappeared.
    h.publish({ ...namedProjection, customTitles: {}, sessions: [] });
    expect(controller.current.selected).toBe(SESSION.resourceId);
    expect(controller.current.current?.title).toBe("Provider 标题");
    await h.settleAll();
    // The row returns: same selection, absence cleared, no jump anywhere.
    h.publish({ ...PROJECTION, sessions: [{ ...SESSION, title: "Provider 标题" }] });
    expect(controller.current.selected).toBe(SESSION.resourceId);
    expect(controller.current.selectedAbsent).toBe(false);
    await h.settleAll();
  });

  it("never calls a session absent on a loading frame — only a settled frame is authority", async () => {
    // The Host's progressive head/partial frames carry the fastest plane's
    // first rows while the other plane still answers. Judging absence on one
    // is what made the hint blink once per refresh (ticket #138).
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    expect(controller.current.selectedAbsent).toBe(false);
    h.publish({ ...PROJECTION, resourceState: "loading", sessions: [{ ...SESSION, resourceId: "res-9" }] });
    expect(controller.current.selectedAbsent).toBe(false);
    expect(controller.current.sessionAbsent(SESSION.resourceId)).toBe(false);
    await h.settleAll();
    // The settled frame that still lacks the row IS the honest answer.
    h.publish({ ...PROJECTION, resourceState: "ready", sessions: [{ ...SESSION, resourceId: "res-9" }] });
    expect(controller.current.selectedAbsent).toBe(true);
    expect(controller.current.sessionAbsent(SESSION.resourceId)).toBe(true);
    await h.settleAll();
    // A row present in ANY frame clears it: presence needs no debounce.
    h.publish({ ...PROJECTION, resourceState: "loading" });
    expect(controller.current.selectedAbsent).toBe(false);
    expect(controller.current.sessionAbsent(SESSION.resourceId)).toBe(false);
    await h.settleAll();
  });

  it("keeps the directory when prefilling from a row, and never invents one", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.current.prefillNewSession("", ""));
    // One device is known, so the global entry can fill it; the directory is
    // still the reader's to type.
    expect(controller.current.newSession).toMatchObject({ device: "laptop", directory: "" });
    act(() => controller.current.prefillNewSession("desktop", "~/p"));
    expect(controller.current.newSession).toMatchObject({ device: "desktop", directory: "~/p" });
  });

  it("pages backwards by explicit offset and stops at the beginning", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 60, totalMessages: 260, messages: LONG_TAIL } },
    });
    await h.settleAll();
    act(() => controller.current.loadOlder("res-1"));
    expect(h.of("readWindow")).toContain("readWindow:res-1:60:0");
    await h.settleAll();

    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 0, totalMessages: 260, messages: LONG_TAIL } },
    });
    const before = h.of("readWindow").length;
    act(() => controller.current.loadOlder("res-1"));
    expect(h.of("readWindow")).toHaveLength(before);
  });

  it("scrolls through successive 200-message pages beyond the automatic tail cap", async () => {
    const h = harness();
    let controller!: SessionsController;
    function Chat() {
      controller = useSessions();
      return <ChatTranscript
        resource="res-1"
        data={controller.windowOf("res-1")}
        busy={controller.transcriptRefreshing("res-1")}
        classes={SHARED_CHAT_CLASSES}
        onLoadOlder={() => controller.loadOlder("res-1")}
      />;
    }
    const page = (offset: number) => ({
      offset, totalMessages: 1_200,
      messages: LONG_TAIL.map((message, index) => ({
        ...message, blocks: [{ type: "text", text: `历史 ${offset + index}` }],
      })),
    });
    h.publish({ ...PROJECTION, transcript: { "res-1": page(1_000) } });
    const view = render(<SessionsProvider port={h.port}><Chat /></SessionsProvider>);
    await h.settleAll();
    const scroller = view.container.querySelector<HTMLDivElement>("[data-av-chat-transcript]")!;
    let scrollHeight = 1_600;
    let scrollTop = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { get: () => 600 },
      scrollHeight: { get: () => scrollHeight },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight - 600)); },
      },
    });
    fireEvent.scroll(scroller);
    const before = h.of("readWindow").length;
    for (const [index, offset] of [800, 600, 400, 200, 0].entries()) {
      scroller.scrollTop = 200;
      fireEvent.scroll(scroller);
      fireEvent.wheel(scroller, { deltaY: -100 });
      expect(h.of("readWindow")).toHaveLength(before + index + 1);
      expect(h.of("readWindow").at(-1)).toBe(`readWindow:res-1:200:${offset}`);
      expect(controller.transcriptRefreshing("res-1")).toBe(true);
      scrollHeight += 600;
      h.publish({ ...PROJECTION, transcript: { "res-1": page(offset) } });
      await h.settleAll();
      expect(controller.windowOf("res-1")?.offset).toBe(offset);
      expect(controller.windowOf("res-1")?.messages).toHaveLength(1_200 - offset);
      expect(scroller.scrollTop).toBe(800);
    }
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(h.of("readWindow")).toHaveLength(before + 5);
  });
});

describe("pending sends (action lifecycle)", () => {
  it("restores a fast operation rejection once when it arrives before its proposal receipt", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.current.send("res-1", "恢复被拒绝的输入"));
    h.operation({ id: "op-fast-refusal", status: "rejected", message: "设备拒绝" });
    await h.settleOne("append:res-1", { ok: true, result: { opId: "op-fast-refusal" }, message: "" });
    expect(controller.current.pendingSendsOf("res-1")[0]).toMatchObject({ phase: "refused", message: "设备拒绝" });
    expect(controller.current.draftOf("res-1")).toBe("恢复被拒绝的输入");
    act(() => controller.current.setDraft("res-1", ""));
    h.operation({ id: "op-fast-refusal", status: "rejected", message: "设备拒绝" });
    h.publish({ ...PROJECTION, notice: "另一个刷新" });
    expect(controller.current.draftOf("res-1")).toBe("");
    await h.settleAll();
  });

  it("reserves a manually hidden delivery so identical later input cannot consume its transcript copy", async () => {
    const h = harness();
    const controller = mount(h);
    const base: SessionsProjection = { ...PROJECTION, transcript: { "res-1": {
      offset: 0, totalMessages: 0, messages: [],
    } } };
    h.publish(base);
    await h.settleAll();
    act(() => controller.current.send("res-1", "继续"));
    await h.settleOne("append:res-1", { ok: true, result: { opId: "op-hidden" }, message: "" });
    h.operation({ id: "op-hidden", status: "succeeded" });
    const key = controller.current.pendingSendsOf("res-1")[0].key;
    act(() => controller.current.dismissSend(key));
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    act(() => controller.current.send("res-1", "继续"));
    h.publish({ ...base, transcript: { "res-1": {
      offset: 0, totalMessages: 1, messages: [{ role: "user", text: "继续" }],
    } } });
    expect(controller.current.pendingSendsOf("res-1")).toHaveLength(1);
    expect(controller.current.pendingSendsOf("res-1")[0].key).not.toBe(key);
    await h.settleAll();
  });

  it("keeps accepted input without an opId visible with a settled uncertainty receipt", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.current.send("res-1", "缺失回执仍可见"));
    await h.settleOne("append:res-1", { ok: true, result: null, message: "" });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([
      { phase: "uncertain", prompt: "缺失回执仍可见" },
    ]);
    expect(h.of("append:res-1")).toHaveLength(1);
  });

  it.each(["throw", "reject"])("settles a %s from send without leaking the exception or retrying", async (mode) => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    const append = vi.spyOn(h.port, "append").mockImplementation(() => {
      if (mode === "throw") throw new Error("private stack details");
      return Promise.reject(new Error("private stack details"));
    });
    await act(async () => controller.current.send("res-1", "可能已经送达"));
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([
      { phase: "uncertain", message: "连接中断，无法确认消息是否送达" },
    ]);
    expect(controller.current.draftOf("res-1")).toBe("");
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("drops a late refusal after the sending Provider unmounts", async () => {
    const h = harness();
    let controller: SessionsController;
    function Probe() { controller = useSessions(); return null; }
    const view = render(<SessionsProvider port={h.port}><Probe /></SessionsProvider>);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.send("res-1", "不要恢复到旧页面"));
    const draftOf = controller!.draftOf;
    view.unmount();
    await h.settleOne("append:res-1", { ok: false, result: null, message: "迟到的拒绝" });
    expect(draftOf("res-1")).toBe("");
  });

  it("separates approval and uncertain delivery and never persists an unknown prompt for replay", async () => {
    const h = harness();
    const persist = vi.fn();
    const controller = mount(h, {
      get: () => ({ text: "", updatedAt: 0 }),
      set: persist,
      subscribe: () => () => {},
    });
    h.publish({ ...PROJECTION, transcript: { "res-1": { offset: 1, totalMessages: 1, messages: [] } } });
    await h.settleAll();
    act(() => controller.current.send("res-1", "待核对的输入"));
    await h.settleOne("append:res-1", { ok: true, result: { opId: "op-state" }, message: "" });
    h.operation({ id: "op-state", status: "waiting_approval" });
    expect(controller.current.pendingSendsOf("res-1")[0].phase).toBe("waiting_approval");
    h.operation({ id: "op-state", status: "running" });
    expect(controller.current.pendingSendsOf("res-1")[0].phase).toBe("running");
    h.operation({ id: "op-state", status: "waiting_approval" });
    expect(controller.current.pendingSendsOf("res-1")[0].phase).toBe("running");
    h.operation({ id: "op-state", status: "unknown", message: "设备没有返回确认" });
    expect(controller.current.pendingSendsOf("res-1")[0].phase).toBe("uncertain");
    expect(controller.current.draftOf("res-1")).toBe("");
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(persist).not.toHaveBeenCalledWith("res-1", "待核对的输入");
    h.operation({ id: "op-state", status: "running", message: "旧帧" });
    expect(controller.current.pendingSendsOf("res-1")[0]).toMatchObject({
      phase: "uncertain", message: "设备没有返回确认",
    });
    h.operation({ id: "op-state", status: "succeeded" });
    expect(controller.current.pendingSendsOf("res-1")[0].phase).toBe("done");
    await h.settleAll();
  });

  it("echoes immediately, ignores unrelated transcript changes, and reconciles the exact later user message", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 40,
          totalMessages: 41,
          // The same words already existed before this click. Text equality
          // without an absolute baseline would consume the new echo at once.
          messages: [{ role: "user", blocks: [{ type: "text", text: "帮我跑测试" }] }],
        },
      },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "帮我跑测试"));
    // Same frame as the click: the bubble exists before any round trip.
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([
      { prompt: "帮我跑测试", kind: "append", phase: "sending" },
    ]);
    await h.settleOne("append:res-1", { ok: true, result: { opId: "op-1", status: "submitted" }, message: "" });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ phase: "submitted", opId: "op-1" }]);
    h.operation({ id: "op-1", status: "running", operation: "append_session" });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ phase: "running" }]);
    h.operation({ id: "op-1", status: "succeeded", operation: "append_session" });
    // Succeeded alone must NOT drop the bubble: the words are nowhere else yet.
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ phase: "done" }]);
    // A different authoritative message changes the window but says nothing
    // about this send, so the local words must remain visible.
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 40,
          totalMessages: 42,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "帮我跑测试" }] },
            { role: "assistant", blocks: [{ type: "text", text: "准备中" }] },
          ],
        },
      },
    } as SessionsProjection);
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ phase: "done" }]);
    // Only a user message with the same prompt at an absolute position after
    // the click consumes the optimistic echo.
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 40,
          totalMessages: 43,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "帮我跑测试" }] },
            { role: "assistant", blocks: [{ type: "text", text: "准备中" }] },
            { role: "user", blocks: [{ type: "text", text: "帮我跑测试" }] },
          ],
        },
      },
    } as SessionsProjection);
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("reconciles a terminal paste that came back wrapped and with tabs turned into spaces", async () => {
    // Claude Code 2.1.322 records a multi-line tmux paste this way; the echo
    // used to stay on screen below the delivered message (shown twice).
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 40, totalMessages: 41, messages: [{ role: "assistant", blocks: [{ type: "text", text: "好的" }] }] } },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "多行测试：第一行  \n\t第二行以 Tab 开头\n最后一行"));
    await h.settleOne("append:res-1", { ok: true, result: { opId: "op-1", status: "submitted" }, message: "" });
    h.operation({ id: "op-1", status: "succeeded", operation: "append_session" });
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 40,
          totalMessages: 42,
          messages: [
            { role: "assistant", blocks: [{ type: "text", text: "好的" }] },
            { role: "user", blocks: [{ type: "text",
              text: "<pasted_content id=\"c5ef\">\n多行测试：第一行  \n    第二行以 Tab 开头\n最后一行\n</pasted_content id=\"c5ef\">" }] },
          ],
        },
      },
    } as SessionsProjection);
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("reconciles a bilingual Claude message by the words the person typed", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({ ...PROJECTION, transcript: { "res-1": { offset: 0, totalMessages: 0, messages: [] } } });
    await h.settleAll();
    act(() => controller.current.send("res-1", "把第三节改短"));
    await h.settleOne("append:res-1", { ok: true, result: { opId: "op-1", status: "submitted" }, message: "" });
    h.operation({ id: "op-1", status: "succeeded", operation: "append_session" });
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 0, totalMessages: 1, messages: [{ role: "user", blocks: [{ type: "text",
        text: "Shorten section three.", bilingual: { zh: "把第三节改短", en: "Shorten section three." } }] }] } },
    } as SessionsProjection);
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("keeps one echo when the Host joins a repeated click to the live operation", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({ ...PROJECTION, transcript: { "res-1": { offset: 0, totalMessages: 0, messages: [] } } });
    await h.settleAll();
    act(() => controller.current.send("res-1", "继续"));
    await h.settleOne("append:res-1", { ok: true, result: { opId: "op-1", status: "submitted" }, message: "" });
    act(() => controller.current.send("res-1", "继续"));
    await h.settleOne("append:res-1", { ok: true, result: { opId: "op-1", status: "running" }, message: "" });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ opId: "op-1", prompt: "继续" }]);
    h.operation({ id: "op-1", status: "succeeded", operation: "append_session" });
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 0, totalMessages: 1, messages: [{ role: "user", blocks: [{ type: "text", text: "继续" }] }] } },
    } as SessionsProjection);
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("keeps confirmed tmux input visible until its transcript arrives even when the operation beats the receipt", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        runtime: {
          observed_at: "2026-08-30T19:00:00.000Z",
          control_mode: "external_cli",
          attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" },
          capabilities: { terminal_append: true },
        },
      }],
      transcript: {
        "res-1": { offset: 90, totalMessages: 90, messages: [] },
      },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "外加流程开销比偏高，这个也务必帮我优化掉"));
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{
      phase: "sending",
    }]);

    // Host operation frames and proposal results use separate MessagePort
    // messages. A quick tmux confirmation may therefore arrive first.
    h.operation({ id: "op-tmux-fast", status: "succeeded", operation: "append_session" });
    expect(controller.current.pendingSendsOf("res-1")).toHaveLength(1);
    await h.settleOne("append:res-1", {
      ok: true,
      result: { opId: "op-tmux-fast", status: "submitted" },
      message: "",
    });

    // Delivery settles the spinner, never the visibility of the person's words.
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ phase: "done" }]);
    h.operation({ id: "op-tmux-fast", status: "running", operation: "append_session" });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ phase: "done" }]);
    h.operation({ id: "op-tmux-fast", status: "unknown", operation: "append_session" });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ phase: "done" }]);
    expect(controller.current.draftOf("res-1")).toBe("");
    h.publish({ ...PROJECTION, transcript: {} });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ phase: "done" }]);
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 90, totalMessages: 92, messages: [
        { role: "user", text: "外加流程开销比偏高，这个也务必帮我优化掉" },
        { role: "assistant", text: "后续结果" },
      ] } },
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("retires an exact Codex /compact command on operation success without a transcript row", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": { offset: 12, totalMessages: 12, messages: [] },
      },
    });
    await h.settleAll();

    act(() => controller.current.send("res-1", "  /compact  "));
    expect(h.prompts.at(-1)).toEqual({
      action: "append",
      resource: "res-1",
      prompt: "  /compact  ",
    });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{
      prompt: "  /compact  ",
      phase: "sending",
      operationAcknowledges: true,
    }]);
    await h.settleOne("append:res-1", {
      ok: true,
      result: { opId: "op-compact", status: "submitted" },
      message: "",
    });
    h.operation({ id: "op-compact", status: "succeeded", operation: "append_session" });

    // Native compaction records a contextCompaction item, not a user message
    // containing the slash command, so this exact operation is the receipt.
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("keeps non-exact slash text on the ordinary transcript reconciliation path", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": { offset: 20, totalMessages: 20, messages: [] },
      },
    });
    await h.settleAll();

    act(() => controller.current.send("res-1", "/compact 后继续检查"));
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ phase: "sending" }]);
    expect(controller.current.pendingSendsOf("res-1")[0].operationAcknowledges).toBeUndefined();
    await h.settleOne("append:res-1", {
      ok: true,
      result: { opId: "op-text", status: "submitted" },
      message: "",
    });
    h.operation({ id: "op-text", status: "succeeded", operation: "append_session" });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{ phase: "done" }]);
    expect(controller.current.pendingSendsOf("res-1")[0].acknowledgedBy).toBeUndefined();
    await h.settleAll();
  });

  it("keeps a transcript-acknowledged echo hidden when the later proposal reply refuses", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 8, totalMessages: 8, messages: [] } },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "立刻显示一次"));
    expect(controller.current.pendingSendsOf("res-1")).toHaveLength(1);

    // The Runner transcript can beat the proposal receipt/operation stream.
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 8,
          totalMessages: 9,
          messages: [{ role: "user", blocks: [{ type: "text", text: "立刻显示一次" }] }],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    // A later refusal is lifecycle metadata; it cannot resurrect the consumed
    // echo or refill a composer whose words are already authoritative.
    await h.settleOne("append:res-1", {
      ok: false,
      code: "approval_required",
      result: null,
      message: "已经落盘，操作回执迟到",
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    expect(controller.current.draftOf("res-1")).toBe("");
    await h.settleAll();
  });

  it("canonicalizes only the whole prompt like Runner, preserving text-block boundaries", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 4, totalMessages: 4, messages: [] } },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "  x  "));
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 4,
          totalMessages: 5,
          messages: [{ role: "user", blocks: [{ type: "text", text: "x" }] }],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);

    act(() => controller.current.send("res-1", "a \n b"));
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 4,
          totalMessages: 6,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "x" }] },
            { role: "user", blocks: [{ type: "text", text: "a " }, { type: "text", text: " b" }] },
          ],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("ignores an assistant with the same text and accepts legacy message.text from a user", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 12, totalMessages: 12, messages: [] } },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "旧字段原文"));
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 12,
          totalMessages: 13,
          messages: [{ role: "assistant", text: "旧字段原文" }],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toHaveLength(1);
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 12,
          totalMessages: 14,
          messages: [
            { role: "assistant", text: "旧字段原文" },
            { role: "user", text: "旧字段原文" },
          ],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("requires one later authoritative occurrence for each identical click", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 20,
          totalMessages: 21,
          messages: [{ role: "user", blocks: [{ type: "text", text: "重复指令" }] }],
        },
      },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "重复指令"));
    act(() => controller.current.send("res-1", "重复指令"));
    expect(controller.current.pendingSendsOf("res-1")).toHaveLength(2);

    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 20,
          totalMessages: 22,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "重复指令" }] },
            { role: "user", blocks: [{ type: "text", text: "重复指令" }] },
          ],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toHaveLength(1);
    // The retained acknowledgement tombstone reserves message 21; publishing
    // the same frame again cannot let the second click reuse it.
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 20,
          totalMessages: 22,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "重复指令" }] },
            { role: "user", blocks: [{ type: "text", text: "重复指令" }] },
          ],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toHaveLength(1);

    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 20,
          totalMessages: 23,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "重复指令" }] },
            { role: "user", blocks: [{ type: "text", text: "重复指令" }] },
            { role: "user", blocks: [{ type: "text", text: "重复指令" }] },
          ],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("retains the echo for legacy windows without absolute offsets across prepend and tail slide", async () => {
    const h = harness();
    const controller = mount(h);
    const old = { role: "user", blocks: [{ type: "text", text: "旧协议同文" }] };
    h.publish({ ...PROJECTION, transcript: { "res-1": { messages: [old] } } });
    await h.settleAll();
    act(() => controller.current.send("res-1", "旧协议同文"));

    // Neither a later object nor a second occurrence is proof: without an
    // offset, a prepend or rotating tail can move old text between indices.
    h.publish({
      ...PROJECTION,
      notice: "legacy prepend",
      transcript: {
        "res-1": {
          messages: [{ role: "assistant", blocks: [{ type: "text", text: "更早" }] }, old],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toHaveLength(1);
    h.publish({
      ...PROJECTION,
      notice: "legacy tail slide",
      transcript: {
        "res-1": {
          messages: [old, { role: "user", blocks: [{ type: "text", text: "旧协议同文" }] }],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toHaveLength(1);
    await h.settleAll();
  });

  it("uses absolute positions across prepend and tail slide", async () => {
    const h = harness();
    const controller = mount(h);
    const prompt = { role: "user", blocks: [{ type: "text", text: "窗口同文" }] };
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 100,
          totalMessages: 103,
          messages: [
            { role: "assistant", blocks: [{ type: "text", text: "前" }] },
            prompt,
            { role: "assistant", blocks: [{ type: "text", text: "后" }] },
          ],
        },
      },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "窗口同文"));

    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 98,
          totalMessages: 103,
          messages: [
            { role: "assistant", blocks: [{ type: "text", text: "更早 1" }] },
            { role: "assistant", blocks: [{ type: "text", text: "更早 2" }] },
            { role: "assistant", blocks: [{ type: "text", text: "前" }] },
            prompt,
            { role: "assistant", blocks: [{ type: "text", text: "后" }] },
          ],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toHaveLength(1);

    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 101,
          totalMessages: 104,
          messages: [
            prompt,
            { role: "assistant", blocks: [{ type: "text", text: "后" }] },
            prompt,
          ],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("keeps a refused send with the sentence and restores the draft of THAT session only", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.current.setDraft("res-2", "别的会话的草稿"));
    act(() => controller.current.send("res-1", "被拒的话"));
    await h.settleOne("append:res-1", { ok: false, code: "approval_required", result: null, message: "需要批准" });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([
      { phase: "refused", message: "需要批准" },
    ]);
    // The words return to res-1's draft; res-2's draft is untouched.
    expect(controller.current.draftOf("res-1")).toBe("被拒的话");
    expect(controller.current.draftOf("res-2")).toBe("别的会话的草稿");
    // Dismiss clears the settled bubble.
    const key = controller.current.pendingSendsOf("res-1")[0].key;
    act(() => controller.current.dismissSend(key));
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });

  it("does not overwrite a draft the person already retyped when a refusal lands", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.current.send("res-1", "第一句"));
    act(() => controller.current.setDraft("res-1", "已经在写第二句"));
    await h.settleOne("append:res-1", { ok: false, code: "denied", result: null, message: "不行" });
    expect(controller.current.draftOf("res-1")).toBe("已经在写第二句");
    await h.settleAll();
  });

  it("keeps an operation failure hidden when its user message is already authoritative", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 50, totalMessages: 50, messages: [] } },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "权威消息先到"));
    await h.settleOne("append:res-1", {
      ok: true,
      result: { opId: "op-late-failure", status: "submitted" },
      message: "",
    });
    h.publish({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 50,
          totalMessages: 51,
          messages: [{ role: "user", blocks: [{ type: "text", text: "权威消息先到" }] }],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    h.operation({
      id: "op-late-failure",
      status: "failed",
      operation: "append_session",
      message: "迟到的失败状态",
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    expect(controller.current.draftOf("res-1")).toBe("");
    await h.settleAll();
  });

  it("retains and refills an operation rejection when no authoritative message exists", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 70, totalMessages: 70, messages: [] } },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "没有进入 transcript"));
    await h.settleOne("append:res-1", {
      ok: true,
      result: { opId: "op-rejected", status: "submitted" },
      message: "",
    });
    h.operation({
      id: "op-rejected",
      status: "rejected",
      operation: "append_session",
      message: "Gate 拒绝",
    });
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([
      { phase: "refused", message: "Gate 拒绝" },
    ]);
    expect(controller.current.draftOf("res-1")).toBe("没有进入 transcript");
    await h.settleAll();
  });

  it("ends an unknown tmux send while retaining its words without preparing a duplicate send", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { offset: 80, totalMessages: 80, messages: [] } },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "检查后再决定是否接管"));
    await h.settleOne("append:res-1", {
      ok: true,
      result: { opId: "op-unknown", status: "submitted" },
      message: "",
    });
    h.operation({
      id: "op-unknown",
      status: "unknown",
      operation: "append_session",
      message: "结果无法确认 — 不会自动重发；请到本机 CLI 核对，或确认未执行后显式接管",
    });

    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([{
      phase: "uncertain",
      message: expect.stringContaining("显式接管"),
    }]);
    expect(controller.current.draftOf("res-1")).toBe("");
    await h.settleAll();
  });

  it("reconciles resume, explicit takeover, and a live managed steer through their submission doors", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [{ ...SESSION, status: "idle" }],
      transcript: { "res-1": { offset: 30, totalMessages: 30, messages: [] } },
    });
    await h.settleAll();
    act(() => controller.current.send("res-1", "继续"));
    expect(h.of("resume:res-1")).toHaveLength(1);
    act(() => controller.current.takeover("res-1", "接管"));
    expect(h.of("takeover:res-1")).toHaveLength(1);
    expect(controller.current.pendingSendsOf("res-1")).toMatchObject([
      { kind: "resume" }, { kind: "takeover" },
    ]);
    h.publish({
      ...PROJECTION,
      sessions: [{ ...SESSION, status: "idle" }],
      transcript: {
        "res-1": {
          offset: 30,
          totalMessages: 32,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "继续" }] },
            { role: "user", blocks: [{ type: "text", text: "接管" }] },
          ],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);

    // A managed in-flight turn exposes `steer`; the View still submits through
    // append_session, and the same authoritative-message contract applies.
    h.publish({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        status: "live",
        runtime: {
          process_state: "alive",
          turn_state: "working",
          capabilities: { protocol_append: true, steer: true },
        },
      }],
      transcript: {
        "res-1": {
          offset: 30,
          totalMessages: 32,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "继续" }] },
            { role: "user", blocks: [{ type: "text", text: "接管" }] },
          ],
        },
      },
    });
    act(() => controller.current.send("res-1", "转向新的重点"));
    expect(h.of("append:res-1")).toHaveLength(1);
    h.publish({
      ...PROJECTION,
      sessions: [{ ...SESSION, status: "live" }],
      transcript: {
        "res-1": {
          offset: 30,
          totalMessages: 33,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "继续" }] },
            { role: "user", blocks: [{ type: "text", text: "接管" }] },
            { role: "user", blocks: [{ type: "text", text: "转向新的重点" }] },
          ],
        },
      },
    });
    expect(controller.current.pendingSendsOf("res-1")).toEqual([]);
    await h.settleAll();
  });
});

describe("navigation display subscriptions", () => {
  it("ignores transcript-only frames but follows navigation facts and latest commands", async () => {
    const h = harness();
    let navigation!: ReturnType<typeof useSessionNavigation>;
    let search!: ReturnType<typeof useSessionSearch>;
    let navigationRenders = 0;
    let searchRenders = 0;
    function Navigation() { navigation = useSessionNavigation(); navigationRenders += 1; return null; }
    function Search() { search = useSessionSearch(); searchRenders += 1; return null; }
    render(<SessionsProvider port={h.port}><Navigation /><Search /></SessionsProvider>);
    h.publish(PROJECTION);
    await h.settleAll();
    const before = { navigationRenders, searchRenders, navigation, search };
    const sessionOf = navigation.sessionOf;
    for (let frame = 0; frame < 100; frame += 1) {
      // Full transport frames decode fresh but equal roster branches.
      h.publish({ ...structuredClone(PROJECTION), transcript: {
        "res-1": { messages: [{ role: "assistant", text: `stream ${frame}` }] },
      } });
    }
    expect(navigationRenders).toBe(before.navigationRenders);
    expect(searchRenders).toBe(before.searchRenders);
    expect(navigation).toBe(before.navigation);
    expect(search).toBe(before.search);

    const changed: SessionsProjection = {
      ...PROJECTION,
      sessions: [{ ...SESSION, status: "idle", completedAt: "2026-09-16T07:00:00Z" }],
      pinned: ["res-1"], customTitles: { "res-1": "新标题" },
      rosterIndexPending: true,
    };
    h.publish(changed);
    expect(navigationRenders).toBeGreaterThan(before.navigationRenders);
    expect(navigation.roster[0]).toMatchObject({ status: "idle", needsReview: true, userNamed: true });
    expect(navigation.projection.pinned).toEqual(["res-1"]);
    expect(navigation.projection.rosterIndexPending).toBe(true);
    expect(navigation.sessionOf).toBe(sessionOf);
    expect(sessionOf("res-1")).toMatchObject({ title: "新标题", status: "idle" });

    act(() => navigation.revealWorkspace("res-1"));
    expect(navigation.workspaceReveal).toMatchObject({ resource: "res-1", phase: "pending" });
    const beforeSearch = navigation;
    h.publish({ ...changed, search: { query: "new", results: [{ snippet: "found" }] } });
    expect(navigation).toBe(beforeSearch);
    expect(search.projection.search?.results?.[0].snippet).toBe("found");
    h.publish({ ...changed, transcript: { "res-1": { messages: [], totalMessages: 42 } } });
    expect(navigation.roster[0].messageCount).toBe(42);
    await h.settleAll();
  });
});

describe("per-session interaction state", () => {
  it("does not rerender the shared provider for draft keystrokes", async () => {
    const h = harness();
    let renders = 0;
    let controller = null as SessionsController | null;
    function Probe() {
      renders += 1;
      controller = useSessions();
      return null;
    }
    render(<SessionsProvider port={h.port}><Probe /></SessionsProvider>);
    h.publish(PROJECTION);
    await h.settleAll();
    const beforeTyping = renders;

    act(() => controller!.setDraft("res-1", "一"));
    act(() => controller!.setDraft("res-1", "一段不会刷新 roster 的文字"));

    expect(renders).toBe(beforeTyping);
    expect(controller!.draftOf("res-1")).toBe("一段不会刷新 roster 的文字");
  });

  it("keys composer drafts by session, so focus changes cannot cross-post", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.current.setDraft("res-1", "给 1 的话"));
    act(() => controller.current.setDraft("res-9", "给 9 的话"));
    expect(controller.current.draftOf("res-1")).toBe("给 1 的话");
    expect(controller.current.draftOf("res-9")).toBe("给 9 的话");
    expect(controller.current.draftOf(null)).toBe("");
  });

  it("keeps fold overrides per session and per stable group key", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.current.setGroupOverride("res-1", "w:12.0", true));
    act(() => controller.current.setGroupOverride("res-1", "w:30.2", false));
    expect(controller.current.groupOverridesOf("res-1")).toEqual({ "w:12.0": true, "w:30.2": false });
    expect(controller.current.groupOverridesOf("res-9")).toEqual({});
  });

  it("re-allows a transcript request after upstream eviction, but never after a refusal", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      transcript: { "res-1": { messages: [], offset: 0 } },
    } as SessionsProjection);
    await h.settleAll();
    const before = h.of("readWindow:res-1").length;
    // Present → evicted upstream: the single-ask door re-opens.
    h.publish(PROJECTION);
    // The already-open tab keeps painting the last window while the ordinary
    // capability read refreshes the Host's smaller projection cache.
    expect(controller.current.windowOf("res-1")).toMatchObject({ messages: [], offset: 0 });
    act(() => controller.current.ensureTranscript("res-1"));
    expect(h.of("readWindow:res-1").length).toBe(before + 1);
    await h.settleAll(false); // that read is REFUSED
    // Refused (never observed present since): asking again stays a no-op.
    act(() => controller.current.ensureTranscript("res-1"));
    expect(h.of("readWindow:res-1").length).toBe(before + 1);
    await h.settleAll();
  });

  it("retains bounded display facts for an open session omitted by a later frame", async () => {
    const h = harness();
    const controller = mount(h);
    const second = { ...SESSION, resourceId: "res-2", cwdDisplay: "~/projects/y" };
    h.publish({
      ...PROJECTION,
      sessions: [SESSION, second],
      transcript: {
        "res-1": { messages: [], offset: 0 },
        "res-2": { messages: [{ role: "assistant", text: "缓存正文" }], offset: 0 },
      },
    });
    await h.settleAll();
    h.publish({
      ...PROJECTION,
      sessions: [SESSION],
      transcript: { "res-1": { messages: [], offset: 0 } },
    });
    expect(controller.current.sessionOf("res-2")?.cwdDisplay).toBe("~/projects/y");
    expect(controller.current.windowOf("res-2")?.messages?.[0]?.text).toBe("缓存正文");
    await h.settleAll();
  });
});


describe("resource lifecycle regressions", () => {
  it("refreshes the operation resource while another session is selected", async () => {
    const h = harness();
    mount(h);
    h.publish({ ...PROJECTION, sessions: [SESSION, { ...SESSION, resourceId: "res-2" }] });
    await h.settleAll();
    const before = h.of("readWindow:res-1").length;
    h.operation({ id: "op-background", status: "succeeded", operation: "append_session", resourceId: "res-2" });
    expect(h.of("readWindow:res-2")).toHaveLength(1);
    expect(h.of("readWindow:res-1")).toHaveLength(before);
    await h.settleAll();
  });

  it("keeps an unknown launch recoverable and accepts its later success without another start", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => controller.current.setNewSession({ device: "laptop", directory: "/srv/x", prompt: "original launch" }));
    await act(async () => { void controller.current.startNewSession(); });
    await h.settleOne("start:", { ok: true, result: { opId: "late-launch" }, message: "" });
    h.operation({ id: "late-launch", status: "unknown", operation: "start_session" });
    expect(controller.current.launch).toMatchObject({ phase: "uncertain", prompt: "original launch" });
    await act(async () => { expect((await controller.current.startNewSession()).ok).toBe(false); });
    expect(h.starts).toHaveLength(1);
    h.operation({ id: "late-launch", status: "succeeded", operation: "start_session", newResourceId: "late-resource" });
    expect(controller.current.launch).toMatchObject({ phase: "succeeded", newResourceId: "late-resource" });
    await h.settleAll();
  });

  it("samples the newer transcript runtime for model, effort and action selection", async () => {
    const h = harness();
    const controller = mount(h);
    h.publish({
      ...PROJECTION,
      sessions: [{ ...SESSION, runtime: {
        observed_at: "2026-09-14T00:00:00Z", process_state: "alive", turn_state: "working",
        capabilities: { protocol_append: true },
      } }],
      transcript: { "res-1": { offset: 0, messages: [], runtime: {
        observed_at: "2026-09-14T00:00:02Z", process_state: "alive", turn_state: "idle",
        capabilities: { managed_resume: true },
      } } },
    });
    await h.settleAll();
    act(() => { controller.current.setModel("res-1", "gpt-6-astra"); controller.current.setEffort("res-1", "xhigh"); });
    act(() => controller.current.send("res-1", "next turn"));
    expect(h.turns.at(-1)).toEqual({ action: "resume", resource: "res-1", model: "gpt-6-astra", effort: "xhigh" });
    await h.settleAll();
  });
});


describe("resource-local sessions subscriptions", () => {
  it("switches a mounted surface's resource without needing another projection", async () => {
    const h = harness();
    let view!: ReturnType<typeof useSessionResource>;
    function Probe({ resource }: { resource: string }) { view = useSessionResource(resource); return null; }
    const ui = (resource: string) => <SessionsProvider port={h.port}><Probe resource={resource} /></SessionsProvider>;
    const { rerender } = render(ui("a"));
    h.publish({
      ...PROJECTION,
      sessions: ["a", "b"].map((resourceId) => ({ ...SESSION, resourceId })),
      transcript: {
        a: { messages: [{ role: "assistant", text: "from A" }] },
        b: { messages: [{ role: "assistant", text: "from B" }] },
      },
    });
    await h.settleAll();
    const actions = view.actions;
    expect(view.transcript?.messages?.[0].text).toBe("from A");
    rerender(ui("b"));
    expect(view.resource).toBe("b");
    expect(view.transcript?.messages?.[0].text).toBe("from B");
    expect(view.actions).toBe(actions);
    rerender(ui("a"));
    expect(view.resource).toBe("a");
    expect(view.transcript?.messages?.[0].text).toBe("from A");
  });

  it("keeps B/C/D uncommitted through 100 independently decoded A frames and preserves mounted omitted windows", async () => {
    const h = harness();
    const counts: Record<string, number> = {};
    const views = new Map<string, ReturnType<typeof useSessionResource>>();
    function ChatProbe({ resource }: { resource: string }) {
      const chat = useSessionResource(resource);
      useEffect(() => chat.actions.retainTranscript(resource), [chat.actions, resource]);
      counts[resource] = (counts[resource] ?? 0) + 1;
      views.set(resource, chat);
      return <div data-testid={resource}>{chat.transcript?.messages?.length}</div>;
    }
    render(<SessionsProvider port={h.port}>
      {["a", "b", "c", "d"].map((resource) => <ChatProbe key={resource} resource={resource} />)}
    </SessionsProvider>);
    const frame: SessionsProjection = {
      ...PROJECTION,
      sessions: ["a", "b", "c", "d"].map((resourceId) => ({ ...SESSION, resourceId })),
      transcript: Object.fromEntries(["a", "b", "c", "d"].map((resourceId) => [
        resourceId, { resourceId, offset: 0, totalMessages: 200, messages: LONG_TAIL },
      ])),
    };
    h.publish(frame);
    await h.settleAll();
    const before = { ...counts };
    const beforeB = views.get("b")!.transcript;
    for (let i = 0; i < 100; i += 1) {
      const next = JSON.parse(JSON.stringify(frame)) as SessionsProjection;
      next.transcript!.a!.messages = [...LONG_TAIL, { role: "assistant", text: "new " + i }];
      next.transcript!.a!.totalMessages = 201;
      h.publish(next);
    }
    expect(counts.a).toBeGreaterThan(before.a!);
    expect([counts.b, counts.c, counts.d]).toEqual([before.b, before.c, before.d]);
    expect(views.get("b")!.transcript).toBe(beforeB);
    const reads = h.of("readWindow:b").length;
    h.publish({ ...frame, transcript: { a: frame.transcript!.a! } });
    expect(views.get("b")!.transcript).toBe(beforeB);
    expect(h.of("readWindow:b")).toHaveLength(reads);
  });

  it("resource commands sample later controller configuration without replacing command identity", async () => {
    const h = harness();
    const box = { current: null as unknown as ReturnType<typeof useSessionResource> };
    function Probe() { box.current = useSessionResource("res-1"); return null; }
    render(<SessionsProvider port={h.port}><Probe /></SessionsProvider>);
    h.publish({ ...PROJECTION, sessions: [{ ...SESSION, status: "idle" }] });
    await h.settleAll();
    const actions = box.current.actions;
    act(() => actions.setModel("res-1", "gpt-6-astra"));
    act(() => actions.send("res-1", "use current settings"));
    expect(box.current.actions).toBe(actions);
    expect(h.turns.at(-1)).toMatchObject({ resource: "res-1", model: "gpt-6-astra" });
    await h.settleAll();
  });
});


describe("input and stop receipts", () => {
  it("advances input evidence after operation success and ignores weaker delayed evidence", async () => {
    const h = harness();
    const box = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => box.current.send("res-1", "one input"));
    await h.settleOne("append:", { ok: true, message: "", result: { opId: "input-receipt" } });
    const op: SessionOperation = {
      id: "input-receipt", operation: "append_session", resourceId: "res-1", status: "succeeded",
      input: { phase: "dispatched", evidence: "terminal_write", at: "2026-09-14T12:00:00Z" },
    };
    h.operation(op);
    expect(box.current.pendingSendsOf("res-1")[0]).toMatchObject({ phase: "done", input: { phase: "dispatched" } });
    h.operation({ ...op, input: { phase: "input_observed", evidence: "native_hook", at: "2026-09-14T12:00:01Z" } });
    expect(box.current.pendingSendsOf("res-1")[0]?.input?.phase).toBe("input_observed");
    h.operation(op);
    expect(box.current.pendingSendsOf("res-1")[0]?.input?.phase).toBe("input_observed");
    expect(box.current.pendingSendsOf("res-1")).toHaveLength(1);
    await h.settleAll();
  });

  it("shows a stop refusal, prevents duplicate pending stops and reconciles unknown with late confirmation", async () => {
    const h = harness();
    const box = mount(h);
    h.publish(PROJECTION);
    await h.settleAll();
    act(() => { box.current.interrupt("res-1"); box.current.interrupt("res-1"); });
    expect(h.of("interrupt:")).toHaveLength(1);
    expect(box.current.interruptOf("res-1")?.phase).toBe("sending");
    await h.settleOne("interrupt:", { ok: false, message: "当前没有可用的停止权限" });
    expect(box.current.interruptOf("res-1")).toMatchObject({ phase: "refused", message: "当前没有可用的停止权限" });
    act(() => box.current.interrupt("res-1"));
    await h.settleOne("interrupt:", { ok: true, message: "", result: { opId: "stop-op" } });
    h.operation({ id: "stop-op", status: "unknown", operation: "interrupt_session", resourceId: "res-1" });
    expect(box.current.interruptOf("res-1")?.phase).toBe("uncertain");
    h.operation({ id: "stop-op", status: "succeeded", operation: "interrupt_session", resourceId: "res-1" });
    expect(box.current.interruptOf("res-1")).toMatchObject({ phase: "done", message: "停止请求已确认；正在等待运行态更新。" });
    await h.settleAll();
  });
});
