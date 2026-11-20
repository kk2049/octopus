import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { SessionObservationIndex } from "./session-observation.js";
import type { SessionSummary } from "@claude-bot/plugin-sessions/scan";
import { handleRpc } from "./core.js";
import type { AgentControlPlane } from "./agent-control-plane.js";
import { AgentRuntimeRegistry } from "./agent-runtime.js";
import { AgentProcessObservation, LiveSessionObserver } from "./live-session-observer.js";
import { LaunchJournal } from "./launch-journal.js";

const homes: string[] = [];
const observers: SessionObservationIndex[] = [];
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const message = (text: string) => JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(),
  payload: { type: "user_message", message: text } }) + "\n";
async function fixture(selectedOnly = false) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "session-observer-")); homes.push(home);
  const root = path.join(home, ".codex"); await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  const roots = { home, codexHome: root };
  const observer = new SessionObservationIndex({ home, roots: async () => roots, selectedOnly }); observers.push(observer);
  const seed = async (n: number, parent?: string) => {
    const file = path.join(root, "sessions", `rollout-${id(n)}.jsonl`);
    await fs.writeFile(file, JSON.stringify({ type: "session_meta", payload: { id: id(n), cwd: home,
      source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "cli",
      ...(parent ? { parent_thread_id: parent } : {}) } }) + "\n" + message(`task ${n}`)); return file;
  };
  return { home, root, observer, seed, roots };
}
const listing = async (observer: SessionObservationIndex) => await observer.list({ primary_window: true, limit: 200 }) as {
  sessions: SessionSummary[]; total_found: number; index_pending: boolean;
};
async function settle(observer: SessionObservationIndex): Promise<void> {
  await observer.start();
  for (let n = 0; n < 200; n++) {
    await observer.tick();
    if (!(await listing(observer)).index_pending) return;
  }
  throw new Error("inventory did not settle");
}
afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.close()));
  vi.restoreAllMocks(); await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

it("keeps historical changes stale until open and list performs no filesystem reads", async () => {
  const { observer, seed } = await fixture(); const file = await seed(1); await settle(observer);
  const before = (await listing(observer)).sessions[0];
  await fs.appendFile(file, message("new question"));
  await observer.notify({ source: "codex", id: id(1) }, file);
  const stat = vi.spyOn(fs, "stat"); const reads = observer.stats.fileReads;
  expect((await listing(observer)).sessions[0]).toEqual(before);
  expect(stat).not.toHaveBeenCalled(); expect(observer.stats.fileReads).toBe(reads); stat.mockRestore();
  await observer.read({ source: "codex", id: id(1), rich: true });
  expect((await listing(observer)).sessions[0].message_count).toBeGreaterThan(before.message_count!);
});

it("updates live sessions but ignores changes to other known files", async () => {
  const { observer, seed } = await fixture(); const a = await seed(1); const b = await seed(2); await settle(observer);
  observer.setLive([{ source: "codex", id: id(1) }]); await observer.refresh({ source: "codex", id: id(1) });
  const old = (await listing(observer)).sessions.find((row) => row.id === id(2))!;
  await fs.appendFile(a, message("live message")); await fs.appendFile(b, message("cold message"));
  await observer.notify({ source: "codex", id: id(1) }, a); await observer.notify({ source: "codex", id: id(2) }, b);
  const rows = (await listing(observer)).sessions;
  expect(rows[0].id).toBe(id(1)); expect(rows[0].message_count).toBe(2);
  expect(rows.find((row) => row.id === id(2))).toEqual(old);
});

it("registers new hook paths immediately and persists history across restart", async () => {
  const { observer, seed, home, roots } = await fixture(); await settle(observer);
  const file = await seed(1); await observer.notify({ source: "codex", id: id(1) }, file);
  expect((await listing(observer)).sessions.map((row) => row.id)).toEqual([id(1)]);
  await observer.close();
  const restored = new SessionObservationIndex({ home, roots: async () => roots }); observers.push(restored);
  expect((await listing(restored)).sessions.map((row) => row.id)).toEqual([id(1)]);
  expect(restored.stats.fileReads).toBe(0);
});

it("names cold oversized headers from the native index before any open or live proof", async () => {
  const { observer, seed, root } = await fixture();
  const file = await seed(1);
  const header = (await fs.readFile(file, "utf8")).split("\n")[0];
  await fs.writeFile(file, header + "\n" + JSON.stringify({ type: "response_item", payload: {
    type: "message", role: "developer", content: [{ type: "input_text", text: "x".repeat(70_000) }] } }) + "\n" + message("later question"));
  await fs.writeFile(path.join(root, "session_index.jsonl"), [1, 2].map((n) => JSON.stringify({ id: id(n), thread_name: `native ${n}` })).join("\n"));
  await settle(observer);
  expect((await listing(observer)).sessions).toMatchObject([{ id: id(1), title: "native 1" }]);
  expect((await listing(observer)).sessions[0].first_user_text).toBeUndefined();
  // The second identity appears later but shares the unchanged home index.
  const second = await seed(2); await observer.notify({ source: "codex", id: id(2) }, second);
  expect((await listing(observer)).sessions.find((row) => row.id === id(2))?.title).toBe("native 2");
  const reads = observer.stats.fileReads;
  const stat = vi.spyOn(fs, "stat");
  await listing(observer); expect(stat).not.toHaveBeenCalled(); stat.mockRestore();
  expect(observer.stats.fileReads).toBe(reads);
});

it("does not report a cold header's mid-conversation activity as the session's current state", async () => {
  const { observer, seed } = await fixture();
  const file = await seed(1);
  // The first 64 KiB end right after the user's prompt; the log itself ends idle.
  await fs.appendFile(file, JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer",
    content: [{ type: "input_text", text: "x".repeat(70_000) }] } }) + "\n"
    + JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "task_complete" } }) + "\n");
  await settle(observer);
  const cold = (await listing(observer)).sessions[0]!;
  expect(cold).toMatchObject({ id: id(1) });
  expect(cold.activity).toBeUndefined();
  await observer.refresh({ source: "codex", id: id(1) });
  expect((await listing(observer)).sessions[0]!.activity).toMatchObject({ state: "idle" });
});

it("dates a cold oversized log by its file, not by the last record its header shows, also from an old journal", async () => {
  const { home, observer, seed } = await fixture();
  const file = await seed(1);
  // A chat that began days ago and is still going: its first 64 KiB end long before its last record.
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/"timestamp":"[^"]+"/, '"timestamp":"2026-10-14T03:00:00.000Z"')
    + JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "x".repeat(70_000) }] } }) + "\n"
    + JSON.stringify({ type: "event_msg", timestamp: "2026-10-19T14:20:00.000Z", payload: { type: "task_complete" } }) + "\n");
  const written = new Date("2026-10-19T14:20:01.000Z");
  await fs.utimes(file, written, written);
  await settle(observer);
  const cold = (await listing(observer)).sessions[0]!;
  expect(cold).toMatchObject({ id: id(1), last_activity: written.toISOString() });
  expect(cold).not.toHaveProperty("sort_activity");
  expect(cold).not.toHaveProperty("completed_at");
  expect(cold).not.toHaveProperty("message_count");
  await observer.close();
  // A journal from before this rule restores the header's date until it is corrected.
  const journal = path.join(home, ".octopus", "session-observation-v1.jsonl");
  const rows = (await fs.readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const old = rows.map((row) => ({ ...row, summary: { ...row.summary, last_activity: "2026-10-14T03:00:00.000Z", sort_activity: "2026-10-14T03:00:00.000Z" } }));
  await fs.writeFile(journal, old.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const restored = new SessionObservationIndex({ home, roots: async () => ({ home, codexHome: path.join(home, ".codex") }) }); observers.push(restored);
  const back = (await listing(restored)).sessions[0]!;
  expect(back).toMatchObject({ id: id(1), last_activity: written.toISOString() });
  expect(back).not.toHaveProperty("sort_activity");
  expect(restored.stats.fileReads).toBe(0);
  // A full read still dates the log by its own last record.
  await restored.refresh({ source: "codex", id: id(1) });
  expect((await listing(restored)).sessions[0]).toMatchObject({ last_activity: "2026-10-19T14:20:00.000Z" });
});

it.each([["a", "b"], ["b", "c"], ["c", "d"], ["a", ""]])(
  "restores cached account %s as current local account %s without reading history",
  async (oldLabel, label) => {
    const { home, seed, observer: unused } = await fixture();
    await unused.close();
    const original = await seed(1);
    const codexHome = path.join(home, ".codex-accounts", label ? "account-" + label : "default");
    await fs.mkdir(path.join(codexHome, "sessions"), { recursive: true });
    await fs.rename(original, path.join(codexHome, "sessions", path.basename(original)));
    const roots = { home, codexHomes: [{ codexHome, label: oldLabel }] };
    const before = new SessionObservationIndex({ home, roots: async () => roots }); observers.push(before);
    await settle(before);
    await before.refresh({ source: "codex", id: id(1) });
    const old = (await listing(before)).sessions[0];
    expect(old.account_label).toBe(oldLabel);
    await before.close();

    const restored = new SessionObservationIndex({ home,
      roots: async () => ({ home, codexHomes: [{ codexHome, label }] }) }); observers.push(restored);
    const current = (await listing(restored)).sessions[0];
    const { account_label: _oldLabel, ...metadata } = old;
    expect(current).toEqual({ ...metadata, ...(label ? { account_label: label } : {}) });
    expect(restored.stats.fileReads).toBe(0);
    await restored.refresh({ source: "codex", id: id(1) });
    expect((await listing(restored)).sessions[0].account_label).toBe(label || undefined);
    expect(restored.stats.fileReads).toBe(0);
  },
);

it("relabels cached rows and retained file roots when the account map changes", async () => {
  const { home, root, seed, observer: unused } = await fixture(); await unused.close();
  const file = await seed(1);
  let roots = { home, codexHomes: [{ codexHome: root, label: "a" }] };
  const onChanged = vi.fn();
  const observer = new SessionObservationIndex({ home, roots: async () => roots, onChanged }); observers.push(observer);
  await settle(observer);
  const reads = observer.stats.fileReads;
  roots = { home, codexHomes: [{ codexHome: root, label: "b" }] };
  onChanged.mockClear(); await observer.tick();
  expect((await listing(observer)).sessions[0].account_label).toBe("b");
  expect(observer.stats.fileReads).toBe(reads);
  expect(onChanged).toHaveBeenCalled();
  await fs.appendFile(file, message("new activity"));
  await observer.refresh({ source: "codex", id: id(1) });
  expect((await listing(observer)).sessions[0].account_label).toBe("b");
});

it("never parses an unselected private transcript and rejects escaped locators", async () => {
  const { observer, seed, root } = await fixture(true); await seed(1); await seed(2);
  await observer.start(); for (let n = 0; n < 5; n++) await observer.tick();
  expect(observer.stats.fileReads).toBe(0);
  const result = await observer.list({}, [{ source: "codex", id: id(1) }]) as { sessions: SessionSummary[] };
  expect(result.sessions.map((row) => row.id)).toEqual([id(1)]); expect(observer.stats.fileReads).toBe(1);
  const outside = await fs.mkdtemp(path.join(tmpdir(), "outside-observer-")); homes.push(outside);
  const target = path.join(outside, "secret.jsonl"); await fs.writeFile(target, "secret");
  const alias = path.join(root, "sessions", "escape.jsonl"); await fs.symlink(target, alias);
  await expect(observer.register("codex", alias)).rejects.toThrow(/outside/);
});

it("keeps live chats ahead of a child flood without reading historical bodies on list", async () => {
  const { observer, seed } = await fixture(); await seed(1);
  for (let n = 2; n <= 320; n++) await seed(n, id(1));
  await settle(observer); observer.setLive([{ source: "codex", id: id(1) }]);
  const before = { ...observer.stats };
  for (let n = 0; n < 10; n++) {
    const result = await listing(observer); expect(result.sessions[0].id).toBe(id(1)); expect(result.sessions).toHaveLength(301);
  }
  expect(observer.stats.fileReads).toBe(before.fileReads);
  expect(observer.stats.directoryReads).toBe(before.directoryReads);
});

it("RPC lists use the observer without invoking the legacy discovery pipeline", async () => {
  const { observer, seed, home } = await fixture(); await seed(1); await settle(observer);
  const discover = vi.fn();
  const control = { discover, publicRuntime: vi.fn() } as unknown as AgentControlPlane;
  const result = await handleRpc(home, { id: "list", method: "list_recent_sessions", args: { primary_window: true } }, {
    sessionObservation: { ordinary: observer, split: observer }, agentControlPlane: control,
  });
  expect(result).toMatchObject({ ok: true, result: { sessions: [{ id: id(1) }] } });
  expect(discover).not.toHaveBeenCalled(); expect(control.publicRuntime).not.toHaveBeenCalled();
});

it("anchors a snapshot in the log read_session shows when Codex continued the thread in a file named for another id", async () => {
  const { observer, root, home } = await fixture();
  const thread = id(1);
  const meta = JSON.stringify({ type: "session_meta", payload: { id: thread, cwd: home, source: "vscode" } }) + "\n";
  const done = (turn: string, at: string) => JSON.stringify({ type: "event_msg", timestamp: at, payload: { type: "task_complete", turn_id: turn } }) + "\n";
  const original = path.join(root, "sessions", `rollout-2026-10-15T12-19-02-${thread}.jsonl`);
  const continued = path.join(root, "sessions", `rollout-2026-10-16T14-04-04-${thread}_${id(9)}.jsonl`);
  await fs.writeFile(original, meta + message("first") + done("01a13f80-0000-7000-8000-000000000001", "2026-10-16T14:02:00.000Z"));
  await fs.writeFile(continued, meta + message("later") + done("01a13f80-0000-7000-8000-000000000002", "2026-10-19T11:45:31.241Z"));
  await fs.utimes(original, new Date("2026-10-16T14:02:01Z"), new Date("2026-10-16T14:02:01Z"));
  await settle(observer);
  const anchor = await handleRpc(home, { id: "anchor", method: "session_anchor", args: { source: "codex", id: thread } }, {
    sessionObservation: { ordinary: observer, split: observer },
  });
  expect(anchor).toMatchObject({ ok: true, result: { anchor: "01a13f80-0000-7000-8000-000000000002", at: "2026-10-19T11:45:31.241Z" } });
  // By its name the continuation belongs to another id: the old lookup anchored in the first file.
  expect(await handleRpc(home, { id: "unindexed", method: "session_anchor", args: { source: "codex", id: thread } }, {}))
    .toMatchObject({ ok: true, result: { anchor: "01a13f80-0000-7000-8000-000000000001" } });
});

it("observes an opened cold chat only while retained and rejects a repointed private root", async () => {
  const { observer, seed, root, home } = await fixture(); const file = await seed(1); await settle(observer);
  const release = observer.retain({ source: "codex", id: id(1) });
  await fs.appendFile(file, message("viewing")); await observer.notify({ source: "codex", id: id(1) }, file);
  expect((await listing(observer)).sessions[0].message_count).toBe(2);
  release(); await fs.appendFile(file, message("no longer viewing")); await observer.notify({ source: "codex", id: id(1) }, file);
  expect((await listing(observer)).sessions[0].message_count).toBe(2);
  const isolated = path.join(home, ".octopus", "codex-split-home"); await fs.mkdir(isolated, { recursive: true });
  await fs.rename(path.join(root, "sessions"), path.join(isolated, "sessions"));
  await fs.symlink(path.join(isolated, "sessions"), path.join(root, "sessions"));
  expect(await observer.resolve({ source: "codex", id: id(1) })).toBeUndefined();
});

it("observes exact native file changes without process proof or a historical scan", async () => {
  const { observer, seed } = await fixture(); const original = await seed(1); await settle(observer);
  const before = observer.stats.fileReads;
  await fs.appendFile(original, message("working without a visible process")); await seed(2);
  await vi.waitFor(async () => {
    await observer.tick();
    const result = await listing(observer);
    expect(result.total_found).toBe(2);
    expect(result.sessions.find((row) => row.id === id(1))?.message_count).toBe(2);
  });
  expect(observer.stats.fileReads - before).toBeLessThanOrEqual(3);
  const stat = vi.spyOn(fs, "stat"); await listing(observer); expect(stat).not.toHaveBeenCalled();
});

it("never turns private filesystem notifications into permission to parse a split log", async () => {
  const { observer, seed } = await fixture(true); const file = await seed(1); await settle(observer);
  await fs.appendFile(file, message("private change"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  await observer.tick();
  expect(observer.stats.fileReads).toBe(0);
  expect((await listing(observer)).sessions).toEqual([]);
});

it("recovers a partial first record when its native writer completes it", async () => {
  const { observer, seed } = await fixture(); const file = await seed(1);
  const text = await fs.readFile(file, "utf8");
  await fs.writeFile(file, text.slice(0, 20)); await settle(observer);
  await fs.appendFile(file, text.slice(20));
  await vi.waitFor(async () => {
    await observer.tick();
    expect((await listing(observer)).sessions[0]).toMatchObject({ id: id(1), message_count: 1, cwd: expect.any(String) });
  });
});

it("rebinds a directory watcher after its inode is replaced", async () => {
  const { observer, root, seed } = await fixture(); await seed(1); await settle(observer);
  await fs.rename(path.join(root, "sessions"), path.join(root, "old-sessions"));
  await fs.mkdir(path.join(root, "sessions"));
  const file = await seed(2);
  // Force the existing bounded directory reconciliation, not a new observer.
  await vi.waitFor(async () => { await observer.tick(); expect((await listing(observer)).total_found).toBe(2); }, { timeout: 4_000 });
  await fs.appendFile(file, message("after directory replacement"));
  await vi.waitFor(async () => {
    await observer.tick();
    expect((await listing(observer)).sessions.find((row) => row.id === id(2))?.message_count).toBe(2);
  });
});

it("drops an in-flight observation after its account registration is removed", async () => {
  const { home, seed, root, observer: unused } = await fixture(); await unused.close();
  const file = await seed(1);
  let roots = { home, codexHome: root };
  const observer = new SessionObservationIndex({ home, roots: async () => roots }); observers.push(observer);
  await settle(observer);
  const tick = observer.tick.bind(observer); vi.spyOn(observer, "tick").mockResolvedValue();
  const realStat = fs.stat.bind(fs);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(fs, "stat").mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
    if (args[0] === file) { entered(); await barrier; }
    return realStat(...args);
  });
  const reading = observer.refresh({ source: "codex", id: id(1) });
  await ready;
  roots = { home, codexHome: path.join(home, "removed-account") };
  await tick(); release(); await reading;
  expect((await listing(observer)).sessions).toEqual([]);
});

it("discovers a daemon-owned vscode transcript through the live path without a history scan", async () => {
  const ordinary = await fixture(); const split = await fixture(true);
  const file = await ordinary.seed(1);
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace('"source":"cli"', '"source":"vscode"'));
  await fs.writeFile(path.join(ordinary.root, "session_index.jsonl"), JSON.stringify({ id: id(1), thread_name: "daemon native title" }));
  for (const index of [ordinary.observer, split.observer]) vi.spyOn(index, "tick").mockResolvedValue();
  const processes = new AgentProcessObservation(); vi.spyOn(processes, "snapshot").mockResolvedValue([]);
  const control = { observedTerminalTtys: async () => new Set<string>(), managedSessions: () => [],
    codexDaemon: { refresh: async (_home: string, _rows: unknown, _ttys: unknown, accept: (file: string) => Promise<boolean>) =>
      await accept(file) ? [{ id: id(1), path: file }] : [] },
  } as unknown as AgentControlPlane;
  const live = new LiveSessionObserver({ home: ordinary.home, processes, runtime: new AgentRuntimeRegistry(),
    control, ordinary: ordinary.observer, split: split.observer });
  try {
    await live.tick();
    expect((await listing(ordinary.observer)).sessions).toMatchObject([{ id: id(1), title: "daemon native title", message_count: 1 }]);
    expect(ordinary.observer.stats.directoryReads).toBe(0);
    expect((await listing(split.observer)).sessions).toEqual([]);
    expect(split.observer.stats.fileReads).toBe(0);
  } finally { await live.close(); }
});

it("managed events refresh their own cached row without reading cold history", async () => {
  const { observer, seed, home } = await fixture(); const file = await seed(1); await seed(2); await settle(observer);
  const processes = new AgentProcessObservation(); vi.spyOn(processes, "snapshot").mockResolvedValue([]);
  let event!: (source: "codex", id: string) => void;
  const control = { observedTerminalTtys: async () => new Set<string>(),
    managedSessions: () => [{ source: "codex", id: id(1) }],
    onManagedTranscriptActivity: (listener: typeof event) => { event = listener; return () => {}; },
  } as unknown as AgentControlPlane;
  const live = new LiveSessionObserver({ home, processes, runtime: new AgentRuntimeRegistry(), control, ordinary: observer, split: observer });
  live.start();
  try {
    await live.tick(); const before = observer.stats.fileReads;
    await fs.appendFile(file, message("managed delta"));
    for (let n = 0; n < 50; n++) event("codex", id(1));
    await live.tick();
    expect(observer.stats.fileReads - before).toBe(1);
    expect((await listing(observer)).sessions[0]).toMatchObject({ id: id(1), message_count: 2 });
  } finally { await live.close(); }
});

it.each(["active", "completed", "private"] as const)(
  "discovers a %s managed transcript before any history scan without crossing corpora",
  async (mode) => {
    const ordinary = await fixture(); const split = await fixture(true);
    const target = mode === "private" ? split : ordinary;
    const file = await target.seed(1); await target.seed(2);
    // An exhausted watcher budget or a startup backlog must not delay this row.
    for (const index of [ordinary.observer, split.observer]) vi.spyOn(index, "tick").mockResolvedValue();
    const processes = new AgentProcessObservation(); vi.spyOn(processes, "snapshot").mockResolvedValue([]);
    let event!: (source: "codex", id: string, path?: string) => void;
    const identity = { source: "codex" as const, id: id(1), path: file };
    const control = { observedTerminalTtys: async () => new Set<string>(),
      managedSessions: () => mode === "completed" ? [] : [identity],
      onManagedTranscriptActivity: (listener: typeof event) => { event = listener; return () => {}; },
    } as unknown as AgentControlPlane;
    const live = new LiveSessionObserver({ home: ordinary.home, processes, runtime: new AgentRuntimeRegistry(),
      control, ordinary: ordinary.observer, split: split.observer });
    live.start();
    try {
      event("codex", id(1), file);
      event("codex", id(1)); // A later content-free event must not erase the locator.
      await live.tick();
      expect((await listing(target.observer)).sessions).toMatchObject([{ id: id(1), message_count: 1 }]);
      const other = mode === "private" ? ordinary : split;
      expect((await listing(other.observer)).sessions).toEqual([]);
      expect(other.observer.stats.fileReads).toBe(0);
      expect(target.observer.stats.fileReads).toBe(1);
      expect(target.observer.stats.directoryReads).toBe(0);
      if (mode === "private") {
        expect(await split.observer.list({}, [{ source: "codex", id: id(2) }])).toMatchObject({ sessions: [] });
      }
    } finally { await live.close(); }
  },
);

it("rejects a managed transcript symlink outside its current root and keeps observing valid sessions", async () => {
  const ordinary = await fixture(); const split = await fixture(true);
  const file = await ordinary.seed(1); const outside = await split.seed(2);
  const alias = path.join(ordinary.root, "sessions", `rollout-${id(2)}.jsonl`);
  await fs.symlink(outside, alias);
  for (const index of [ordinary.observer, split.observer]) vi.spyOn(index, "tick").mockResolvedValue();
  const processes = new AgentProcessObservation(); vi.spyOn(processes, "snapshot").mockResolvedValue([]);
  const control = { observedTerminalTtys: async () => new Set<string>(), managedSessions: () => [
    { source: "codex", id: id(2), path: alias }, { source: "codex", id: id(1), path: file },
  ] } as unknown as AgentControlPlane;
  const live = new LiveSessionObserver({ home: ordinary.home, processes, runtime: new AgentRuntimeRegistry(),
    control, ordinary: ordinary.observer, split: split.observer });
  try {
    await live.tick();
    expect((await listing(ordinary.observer)).sessions.map((row) => row.id)).toEqual([id(1)]);
    expect((await listing(split.observer)).sessions).toEqual([]);
  } finally { await live.close(); }
});

it("refreshes native names on active chats even when the transcript does not change", async () => {
  const { observer, seed, root } = await fixture(); await seed(1); await settle(observer);
  observer.setLive([{ source: "codex", id: id(1) }]); await observer.refresh({ source: "codex", id: id(1) });
  const titleIndex = path.join(root, "session_index.jsonl");
  await fs.writeFile(titleIndex, JSON.stringify({ id: id(1), thread_name: "renamed" }) + "\n");
  await observer.refresh({ source: "codex", id: id(1) });
  expect((await listing(observer)).sessions[0].title).toBe("renamed");
});

it("announces a new log with an oversized first record without reading its whole body", async () => {
  const { observer, seed } = await fixture(); const file = await seed(1);
  await fs.writeFile(file, message("x".repeat(128 * 1024)));
  await settle(observer);
  expect((await listing(observer)).sessions[0]).toMatchObject({ id: id(1), source: "codex" });
  expect((await listing(observer)).sessions[0].message_count).toBeUndefined();
});

it("discovers app-server homes without treating infrastructure as terminal ownership", async () => {
  const processes = new AgentProcessObservation();
  vi.spyOn(processes, "snapshot").mockResolvedValue([{ pid: 12345, ppid: 1, pgid: 12345, tty: 0,
    startTicks: "1", bootId: "boot", command: "codex", argv: ["/opt/bin/codex", "app-server"] }]);
  vi.spyOn(fs, "readFile").mockResolvedValue("CODEX_HOME=/home/user/custom\0");
  expect(await processes.codexHomes("/home/user")).toEqual(["/home/user/custom"]);
});

it("RPC scoped catalogs authorize before indexed reads and cannot project another managed row", async () => {
  const { observer, seed, home, roots } = await fixture(true); await seed(1); await seed(2); await settle(observer);
  const catalogId = `spc_${"a".repeat(64)}`; const workspaceId = "ws_0123456789abcdef01234567";
  const journal = new LaunchJournal(home);
  await journal.begin({ client_request_id: "op_index_authority", workspace_id: workspaceId, source: "codex",
    remote_execution: true, execution_device: "worker", prompt_hash: "b".repeat(64) });
  await journal.markManagedStarted("op_index_authority", id(1), "app-server", catalogId);
  const catalog = [1, 2].map((n) => ({ id: id(n), catalog_id: catalogId, execution_device: "worker", workspace_id: workspaceId }));
  const opts = { allowMachineOps: false, sessionPlusSessionScanRoot: roots,
    sessionObservation: { ordinary: observer, split: observer } };
  const result = await handleRpc(home, { id: "scoped-list", method: "session_plus_list_sessions",
    args: { source: "codex", _octopus_session_catalog: catalog } }, opts);
  expect(result).toMatchObject({ ok: true, result: { returned: 1, sessions: [{ id: id(1) }] } });
  expect(observer.stats.fileReads).toBe(1);
  observer.setLive([{ source: "codex", id: id(2) }]); await observer.refresh({ source: "codex", id: id(2) });
  const reads = observer.stats.fileReads;
  expect(await handleRpc(home, { id: "denied", method: "session_plus_read_session",
    args: { source: "codex", id: id(2), _octopus_session_catalog: catalog } }, opts)).toMatchObject({ ok: false });
  expect(observer.stats.fileReads).toBe(reads);
  expect(await observer.list({}, [{ source: "codex", id: id(1) }])).toMatchObject({ returned: 1, sessions: [{ id: id(1) }] });
});


it("append resolves an indexed target without walking thousands of unrelated homes or trusting caller paths", async () => {
  const { observer, seed, home, root } = await fixture();
  const file = await seed(1); const other = await seed(2); await settle(observer);
  const directoryReads = vi.spyOn(fs, "readdir");
  const continueSession = vi.fn(async () => ({ ok: true, transport: "codex-queue" }));
  const result = await handleRpc(home, { id: "indexed-append", method: "append_session", args: {
    source: "codex", id: id(1), prompt: "continue", path: other, codexHome: "/untrusted", input_receipt: true,
  } }, { allowMachineOps: true, sessionScanRoot: { home, codexHomes: Array.from({ length: 5000 }, (_, n) =>
    ({ codexHome: path.join(home, `old-worker-${n}`), label: "" })) },
    sessionObservation: { ordinary: observer, split: observer },
    agentControlPlane: { continueSession } as unknown as AgentControlPlane });
  expect(result).toMatchObject({ ok: true, result: { ok: true, transport: "codex-queue" } });
  expect(directoryReads).not.toHaveBeenCalled();
  expect(continueSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    sessionId: id(1), sessionPath: file, codexHome: root,
  }));
});

it("append falls back for an unindexed session but refuses a changed indexed identity", async () => {
  const { observer, seed, home, roots } = await fixture(); await settle(observer);
  const file = await seed(1);
  const resolve = vi.spyOn(observer, "resolve").mockResolvedValue(undefined);
  const continueSession = vi.fn(async () => ({ ok: true }));
  const opts = { allowMachineOps: true, sessionScanRoot: roots,
    sessionObservation: { ordinary: observer, split: observer },
    agentControlPlane: { continueSession } as unknown as AgentControlPlane };
  const req = { id: "fallback", method: "append_session", args: { source: "codex", id: id(1), prompt: "hello" } };
  expect(await handleRpc(home, req, opts)).toMatchObject({ ok: true });
  expect(continueSession).toHaveBeenCalledOnce(); continueSession.mockClear();
  resolve.mockRestore(); await observer.register("codex", file); await observer.refresh({ source: "codex", id: id(1) });
  await fs.writeFile(file, JSON.stringify({ type: "session_meta", payload: { id: id(2), cwd: home } }) + "\n");
  expect(await handleRpc(home, req, opts)).toMatchObject({ ok: false, error: expect.stringContaining("identity changed") });
  expect(continueSession).not.toHaveBeenCalled();
});

it("append chooses the split index from launch provenance and still requires execution credentials", async () => {
  const ordinary = await fixture(); const split = await fixture(true);
  await ordinary.seed(1); const file = await split.seed(1);
  await settle(ordinary.observer); await split.observer.start(); await split.observer.register("codex", file);
  const journal = new LaunchJournal(ordinary.home);
  await journal.begin({ client_request_id: "op_split_index", workspace_id: "ws_0123456789abcdef01234567",
    source: "codex", remote_execution: true, execution_device: "worker", prompt_hash: "b".repeat(64) });
  await journal.markManagedStarted("op_split_index", id(1), "app-server", `spc_${"a".repeat(64)}`);
  const publicResolve = vi.spyOn(ordinary.observer, "resolve"); const privateResolve = vi.spyOn(split.observer, "resolve");
  const continueSession = vi.fn();
  const response = await handleRpc(ordinary.home, { id: "split", method: "append_session",
    args: { source: "codex", id: id(1), prompt: "hello" } }, { allowMachineOps: true,
    sessionScanRoot: ordinary.roots, sessionPlusSessionScanRoot: split.roots,
    sessionObservation: { ordinary: ordinary.observer, split: split.observer },
    agentControlPlane: { continueSession } as unknown as AgentControlPlane });
  expect(response).toMatchObject({ ok: false, error: expect.stringContaining("执行凭证") });
  expect(publicResolve).not.toHaveBeenCalled(); expect(privateResolve).toHaveBeenCalledOnce();
  expect(continueSession).not.toHaveBeenCalled();
});

async function seedMeta(root: string, home: string, n: number, payload: Record<string, unknown>): Promise<string> {
  const file = path.join(root, "sessions", `rollout-${id(n)}.jsonl`);
  await fs.writeFile(file, JSON.stringify({ type: "session_meta", payload: { id: id(n), cwd: home, ...payload } }) + "\n"
    + message(`task ${n}`));
  return file;
}

it("gives exec runs and their harness forks their own allowance instead of the chats' window", async () => {
  const { observer, root, home, seed } = await fixture();
  // Chats first, then a newer burst: by activity alone the burst fills the window.
  for (let n = 1; n <= 210; n++) await seed(n);
  for (let n = 211; n <= 330; n++) await seedMeta(root, home, n, { source: "exec", originator: "codex_exec" });
  for (let n = 331; n <= 420; n++) await seedMeta(root, home, n, { source: "vscode", originator: "codex_exec", forked_from_id: id(211) });
  await settle(observer);
  const rows = (await listing(observer)).sessions;
  expect(rows.filter((row) => row.execution_mode !== "exec")).toHaveLength(200);
  expect(rows.filter((row) => row.execution_mode === "exec")).toHaveLength(100);
  expect(rows.find((row) => row.id === id(400))).toMatchObject({ execution_mode: "exec" });
});

it("reclassifies journal rows from an older parser by their first record only, once", async () => {
  const { observer, root, home, roots } = await fixture();
  await seedMeta(root, home, 1, { source: "vscode", originator: "codex_exec", forked_from_id: id(9) });
  await seedMeta(root, home, 2, { source: "vscode", originator: "octopus_runner" });
  await settle(observer);
  await observer.refresh({ source: "codex", id: id(1) });
  const full = (await listing(observer)).sessions.find((row) => row.id === id(1))!;
  expect(full).toMatchObject({ execution_mode: "exec", message_count: 1 });
  await observer.close();
  // A journal written before the originator rule: no mark, no classification.
  const journal = path.join(home, ".octopus", "session-observation-v1.jsonl");
  const rows = (await fs.readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const legacy = rows.map(({ classified: _mark, ...row }) => {
    const { execution_mode: _mode, ...summary } = row.summary; return { ...row, summary };
  });
  await fs.writeFile(journal, legacy.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const restored = new SessionObservationIndex({ home, roots: async () => roots }); observers.push(restored);
  await settle(restored);
  const after = (await listing(restored)).sessions;
  expect(after.find((row) => row.id === id(1))).toEqual(full);
  expect(after.find((row) => row.id === id(2))).not.toHaveProperty("execution_mode");
  expect(restored.stats).toMatchObject({ fileReads: 0, classifyReads: 2 });
  await restored.close();

  const again = new SessionObservationIndex({ home, roots: async () => roots }); observers.push(again);
  await settle(again);
  expect((await listing(again)).sessions.find((row) => row.id === id(1))).toEqual(full);
  expect(again.stats).toMatchObject({ fileReads: 0, classifyReads: 0 });
});

it("answers an exact id selector from the device catalog, including chats outside the recent window", async () => {
  const { observer, seed, home } = await fixture();
  for (let n = 1; n <= 3; n++) await seed(n);
  await settle(observer);
  const result = await handleRpc(home, { id: "ids", method: "list_recent_sessions",
    args: { limit: 1, ids: `codex:${id(2)},codex:missing,claude:${id(3)}` } }, {
    sessionObservation: { ordinary: observer, split: observer },
  });
  expect(result).toMatchObject({ ok: true });
  expect((result.result as { sessions: SessionSummary[] }).sessions.map((row) => row.id)).toEqual([id(2)]);
});
