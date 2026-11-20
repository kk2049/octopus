/**
 * A synthetic Sessions+ projection workload for stream byte budgets.
 *
 * Shapes follow `session-resource/projection.ts` and the Session Plus
 * coordinator: a roster of public session rows (previews included), up to
 * eight transcript windows in an LRU map, per-resource statuses, and a capped
 * operation mirror. Successive projections are derived the way the coordinator
 * derives them: top-level spreads, the touched transcript moved to the end of
 * its map, a re-read tail of messages that arrives as fresh (deep-equal)
 * objects, a roster refresh that rebuilds every row, and operations prepended
 * to a list capped at 100.
 */

import type { RuntimeJson } from "@claude-bot/app-runtime";

type Json = RuntimeJson;
type Row = Record<string, Json>;

export interface WorkloadEmission {
  atMs: number;
  projection: Json;
}

export interface SessionsPlusWorkload {
  initial: Json;
  emissions: WorkloadEmission[];
}

export interface WorkloadOptions {
  sessions?: number;
  windows?: number;
  messages?: number;
  seconds?: number;
  /** One live transcript event per this many milliseconds. */
  transcriptEveryMs?: number;
  rosterEveryMs?: number;
  operationEveryMs?: number;
}

function text(seed: number, length: number): string {
  const words = ["会话", "transcript", "工具调用", "result", "测试通过", "patch", "部署", "review", "上下文", "diff"];
  let out = "";
  for (let index = 0; out.length < length; index += 1) out += words[(seed + index * 7) % words.length] + " ";
  return out.slice(0, length);
}

function sessionRow(index: number, minute = 0): Row {
  return {
    directoryKey: `dir-${index % 12}`,
    resourceId: `res-${index.toString(36)}-${"x".repeat(24)}`,
    deviceId: `dev-${index % 3}`,
    deviceLabel: `workstation-${index % 3}`,
    cliKind: index % 2 ? "codex" : "claude",
    sessionId: `0199${index.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-${index.toString(16).padStart(12, "0")}`,
    projectLabel: `project-${index % 9}`,
    cwdDisplay: `~/work/project-${index % 9}`,
    lastActivity: `2026-10-15T08:${String(minute % 60).padStart(2, "0")}:00Z`,
    sortActivity: `2026-10-15T08:${String(minute % 60).padStart(2, "0")}:00Z`,
    completedAt: "",
    status: "idle",
    resumable: true,
    activity: { state: "idle", tool: "", since: "", observed_at: `2026-10-15T08:00:${String(minute % 60).padStart(2, "0")}Z`, degraded: false },
    runtime: { process_state: "exited", capabilities: { append: true, interrupt: false }, turn: { state: "idle" } },
    messageCount: 40 + index,
    title: text(index, 60),
    preview: text(index + 1, 900),
    firstUserText: text(index + 2, 600),
  };
}

function message(index: number, kind: "user" | "assistant" | "tool"): Row {
  if (kind === "user") return { role: "user", timestamp: `t-${index}`, blocks: [{ type: "text", text: text(index, 300) }] };
  if (kind === "assistant") return { role: "assistant", timestamp: `t-${index}`, blocks: [{ type: "text", text: text(index, 1_200) }] };
  return {
    role: "assistant",
    timestamp: `t-${index}`,
    blocks: [{ type: "tool", name: "Bash", input: { command: text(index, 160) }, output: text(index + 3, 1_400) }],
  };
}

function transcriptWindow(resource: string, messages: number, sequence: number): Row {
  return {
    sessionId: resource,
    cliKind: "claude",
    deviceLabel: "workstation-0",
    rich: true,
    messages: Array.from({ length: messages }, (_, index) => message(index, (["user", "assistant", "tool"] as const)[index % 3])),
    activity: { state: "running", tool: "Bash", since: "t-0", observed_at: `obs-${sequence}`, degraded: false },
    offset: 0,
    nextOffset: messages,
    totalMessages: messages,
    hasMore: false,
    truncated: false,
    version: { epoch: "epoch-aaaaaaaa", sequence },
  };
}

function operation(index: number): Row {
  return {
    id: `op-${index}`,
    operation: "append_session",
    status: "succeeded",
    message: text(index, 120),
    resource: `res-0-${"x".repeat(24)}`,
    updatedAt: `2026-10-15T08:00:${String(index % 60).padStart(2, "0")}Z`,
  };
}

/** Deterministic: the same options always produce the same projections. */
export function sessionsPlusWorkload(options: WorkloadOptions = {}): SessionsPlusWorkload {
  const sessions = options.sessions ?? 300;
  const windows = options.windows ?? 8;
  const messages = options.messages ?? 150;
  const seconds = options.seconds ?? 60;
  const transcriptEveryMs = options.transcriptEveryMs ?? 250;
  const rosterEveryMs = options.rosterEveryMs ?? 2_000;
  const operationEveryMs = options.operationEveryMs ?? 15_000;
  const live = (index: number): string => `res-${index.toString(36)}-${"x".repeat(24)}`;

  const transcript: Record<string, Json> = {};
  const statuses: Record<string, Json> = {};
  for (let index = windows - 1; index >= 0; index -= 1) {
    transcript[live(index)] = transcriptWindow(live(index), messages, 1);
    statuses[live(index)] = { resource: live(index), state: "live", message: "" };
  }
  let projection: Record<string, Json> = {
    pinned: [live(0), live(5)],
    customTitles: { [live(3)]: "renamed" },
    reviewedAt: { [live(1)]: "2026-10-14T00:00:00Z" },
    sessions: Array.from({ length: sessions }, (_, index) => sessionRow(index)),
    sources: [{ device: "dev-0", label: "workstation-0" }],
    workspaces: [{ device: "dev-0", workspaces: [{ id: "w1", label: "work", display: "~/work" }] }],
    transcript,
    transcriptStatuses: statuses,
    transcriptStatus: { resource: live(0), state: "live", message: "" },
    operations: Array.from({ length: 100 }, (_, index) => operation(100 - index)),
    notice: "",
  };
  const initial = projection;
  const emissions: WorkloadEmission[] = [];
  let sequence = 1;
  let appended = messages;
  let operations = 100;
  for (let atMs = transcriptEveryMs; atMs <= seconds * 1_000; atMs += transcriptEveryMs) {
    // One live transcript event on the session the agent is working in.
    sequence += 1;
    const resource = live(0);
    const window = projection.transcript as Record<string, Row>;
    const current = window[resource] as Row;
    const old = current.messages as Row[];
    // The Runner re-reads the recent tail: fresh, mostly deep-equal objects.
    const tail = old.slice(-20).map((entry) => structuredClone(entry));
    const roll = sequence % 10;
    if (roll < 2) tail.push(message(appended++, "assistant"));
    else if (roll < 3) tail.push(message(appended++, "tool"));
    const merged = [...old.slice(0, old.length - 20), ...tail];
    const others = Object.entries(window).filter(([key]) => key !== resource);
    const nextWindow: Row = {
      ...current,
      messages: merged,
      activity: { ...(current.activity as Row), observed_at: `obs-${sequence}` },
      nextOffset: merged.length,
      totalMessages: merged.length,
      version: { epoch: "epoch-aaaaaaaa", sequence },
    };
    const status = { resource, state: "live", message: "" };
    projection = {
      ...projection,
      transcript: Object.fromEntries([...others, [resource, nextWindow]]),
      transcriptStatuses: Object.fromEntries([
        ...Object.entries(projection.transcriptStatuses as Record<string, Json>).filter(([key]) => key !== resource),
        [resource, status],
      ]),
      transcriptStatus: status,
    };
    emissions.push({ atMs, projection });
    if (atMs % rosterEveryMs === 0) {
      // A wake-driven roster refresh rebuilds every row; one session moved on.
      const minute = Math.floor(atMs / 1_000);
      projection = {
        ...projection,
        sessions: (projection.sessions as Row[]).map((row, index) => (index === 0
          ? { ...sessionRow(0, minute), status: "running", activity: { state: "running", tool: "Bash", since: "t-0", observed_at: `obs-${sequence}`, degraded: false } }
          : structuredClone(row))),
      };
      emissions.push({ atMs, projection });
    }
    if (atMs % operationEveryMs === 0) {
      operations += 1;
      projection = { ...projection, operations: [operation(operations), ...(projection.operations as Json[])].slice(0, 100) };
      emissions.push({ atMs, projection });
    }
  }
  return { initial, emissions };
}
