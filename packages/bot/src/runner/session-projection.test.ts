import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUNNER_SESSION_PROJECTION_SCHEMA,
  type RunnerSessionProjection,
  type RunnerSessionProjectionCommand,
} from "@claude-bot/runner/session-projection";
import type { RunnerDeviceStatus, RunnerSessionProjectionTransport } from "./gateway.js";
import { RunnerSessionProjectionService } from "./session-projection.js";

class ProjectionTransport implements RunnerSessionProjectionTransport {
  readonly commands: Array<{ owner: string; device: string; command: RunnerSessionProjectionCommand }> = [];
  devices: RunnerDeviceStatus[] = [{
    device: "laptop",
    online: true,
    created_at: "2026-08-23T00:00:00.000Z",
    last_seen_at: "2026-08-23T00:00:00.000Z",
  }];
  private projectionListener: ((owner: string, device: string, projection: RunnerSessionProjection) => boolean) | null = null;
  private invalidationListener: ((owner: string, device: string) => void) | null = null;
  private presenceListener: ((owner: string, device: string, online: boolean) => void) | null = null;

  subscribe(listener: (owner: string, device: string, projection: RunnerSessionProjection) => boolean): () => void {
    this.projectionListener = listener;
    return () => { if (this.projectionListener === listener) this.projectionListener = null; };
  }

  subscribeInvalidations(listener: (owner: string, device: string) => void): () => void {
    this.invalidationListener = listener;
    return () => { if (this.invalidationListener === listener) this.invalidationListener = null; };
  }

  subscribePresence(listener: (owner: string, device: string, online: boolean) => void): () => void {
    this.presenceListener = listener;
    return () => { if (this.presenceListener === listener) this.presenceListener = null; };
  }

  send(owner: string, device: string, command: RunnerSessionProjectionCommand): boolean {
    this.commands.push({ owner, device, command });
    return this.devices.some((row) => row.device === device && row.online);
  }

  listDevices(): RunnerDeviceStatus[] {
    return this.devices;
  }

  emit(projection: RunnerSessionProjection, device = "laptop"): boolean {
    return this.projectionListener?.("alice", device, projection) ?? false;
  }

  invalidate(): void {
    this.invalidationListener?.("alice", "laptop");
  }

  reconnect(): void {
    this.presenceListener?.("alice", "laptop", true);
  }
}

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function roster(epoch: string, sequence: number, sessionId: string): RunnerSessionProjection {
  return {
    schema: RUNNER_SESSION_PROJECTION_SCHEMA,
    kind: "roster_full",
    epoch,
    sequence,
    observed_at: "2026-08-23T00:00:00.000Z",
    total_found: 1,
    sessions: [{ id: sessionId, source: "claude", title: sessionId, last_activity: "2026-08-23T00:00:00.000Z" }],
  };
}

describe("RunnerSessionProjectionService", () => {
  it("requires snapshots only from declared or legacy session sources while preserving execution inventory", () => {
    const transport = new ProjectionTransport();
    const inventory = {
      schema: "runner-inventory/v1" as const,
      session_roster: false,
      agent_backends: (["claude", "codex", "omp"] as const).map((kind) => ({
        kind, available: false, split_execution: false,
      })),
      execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true,
        workspace_count: 1, codex_exec_server: false },
    };
    transport.devices.push({ ...transport.devices[0]!, device: "execution", inventory });
    const service = new RunnerSessionProjectionService(":memory:", transport);
    try {
      transport.emit(roster("epoch-roster", 1, "readable"));
      expect(service.read("alice", "list_recent_sessions", {})).toMatchObject({
        hit: true, result: { devices: ["laptop", "execution"], total_found: 1,
          sessions: [{ id: "readable", device: "laptop" }],
          runner_inventory: [{ device: "execution", inventory: { session_roster: false } }] },
      });
      // Lack of a provider binary cannot stand in for the explicit marker.
      delete (inventory as { session_roster?: boolean }).session_roster;
      expect(service.read("alice", "list_recent_sessions", {}).hit).toBe(false);
      inventory.session_roster = true;
      expect(service.read("alice", "list_recent_sessions", {}).hit).toBe(false);
      inventory.session_roster = false;
      expect(service.read("alice", "list_recent_sessions", { device: "execution" }).hit).toBe(false);
      expect(service.read("alice", "list_recent_sessions", { cursor: "" }).hit).toBe(false);
      transport.invalidate();
      expect(service.read("alice", "list_recent_sessions", {}).hit).toBe(false);
      transport.emit(roster("epoch-roster", 2, "fresh"));
      service.purgeDevice("alice", "laptop");
      expect(service.read("alice", "list_recent_sessions", {}).hit).toBe(false);
    } finally { service.close(); }
  });

  it("retains old foreground terminals when multiple device windows are merged and read from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreground-roster-"));
    temps.push(dir);
    const transport = new ProjectionTransport();
    transport.devices.push({ ...transport.devices[0], device: "desktop" });
    const dbPath = join(dir, "projection.db");
    const clock = () => Date.parse("2026-08-23T00:01:00.000Z");
    const service = new RunnerSessionProjectionService(dbPath, transport, clock);
    for (const device of ["laptop", "desktop"]) {
      transport.emit({ ...roster(`epoch-${device}`, 1, "unused"), kind: "roster_full", primary_window: true,
        total_found: 800,
        sessions: [
          ...Array.from({ length: 199 }, (_, i) => ({ id: `${device}-${i}`, source: "codex" as const,
            last_activity: "2026-08-23T00:00:00Z" })),
          { id: `${device}-terminal`, source: "codex", last_activity: "2020-01-01T00:00:00Z",
            runtime: { process_state: "alive", attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } } },
        ],
      }, device);
    }
    service.close();
    const restarted = new RunnerSessionProjectionService(dbPath, transport, clock);
    const result = restarted.read("alice", "list_recent_sessions", { primary_window: true, limit: 2 });
    expect(result).toMatchObject({ hit: true, result: { returned: 2, sessions: [
      { id: "laptop-terminal" }, { id: "desktop-terminal" },
    ] } });
    restarted.close();
  });
  it("preserves the effective-chat quota and coverage marker across a durable cache restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "primary-roster-"));
    temps.push(dir);
    const dbPath = join(dir, "projection.db");
    const transport = new ProjectionTransport();
    const clock = () => Date.parse("2026-08-23T00:01:00.000Z");
    const service = new RunnerSessionProjectionService(dbPath, transport, clock);
    transport.emit(roster("epoch-primary", 1, "legacy"));
    expect(service.read("alice", "list_recent_sessions", { primary_window: true, limit: 200 }).hit).toBe(false);
    transport.emit({ ...roster("epoch-primary", 2, "unused"), kind: "roster_full", total_found: 20_000,
      primary_window: true, index_pending: true,
      sessions: [
        ...Array.from({ length: 300 }, (_, i) => ({ id: "child-" + i, source: "codex" as const,
          is_subagent: true as const, parent_session_id: "root-0", last_activity: "2026-08-23T00:00:00Z" })),
        ...Array.from({ length: 150 }, (_, i) => ({ id: "run-" + i, source: "codex" as const,
          execution_mode: "exec" as const, last_activity: "2026-08-21T00:00:00Z" })),
        ...Array.from({ length: 200 }, (_, i) => ({ id: "root-" + i, source: "codex" as const,
          last_activity: "2026-08-20T00:00:00Z" })),
      ],
    });
    service.close();
    const restarted = new RunnerSessionProjectionService(dbPath, new ProjectionTransport(), clock);
    const result = restarted.read("alice", "list_recent_sessions", { primary_window: true, limit: 200 });
    expect(result.hit).toBe(true);
    if (result.hit) {
      const value = result.result as { sessions: Array<{ is_subagent?: boolean; execution_mode?: string }>; index_pending: boolean };
      // Newer exec runs keep their own allowance; they do not take the chats' quota.
      expect(value.sessions.filter((row) => !row.is_subagent && !row.execution_mode)).toHaveLength(200);
      expect(value.sessions.filter((row) => row.execution_mode === "exec")).toHaveLength(100);
      expect(value.sessions.filter((row) => row.is_subagent)).toHaveLength(300);
      expect(value.index_pending).toBe(true);
    }
    expect(restarted.read("alice", "list_recent_sessions", { primary_window: true, source: "claude", limit: 200 }).hit).toBe(false);
    restarted.close();
  });
  it("serves and persists bounded rosters, rejects old sequence, invalidates, and revokes", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-projection-"));
    temps.push(dir);
    const dbPath = join(dir, "projection.db");
    const transport = new ProjectionTransport();
    const service = new RunnerSessionProjectionService(dbPath, transport, () => Date.parse("2026-08-23T00:01:00.000Z"));

    expect(service.read("alice", "list_recent_sessions", { source: "all", limit: 200 }).hit).toBe(false);
    expect(transport.emit(roster("epoch-one", 2, "fresh"))).toBe(true);
    expect(transport.emit(roster("epoch-one", 1, "old"))).toBe(false);
    const projected = service.read("alice", "list_recent_sessions", { source: "all", limit: 200 });
    expect(projected).toMatchObject({
      hit: true,
      result: { devices: ["laptop"], total_found: 1, sessions: [{ id: "fresh", device: "laptop" }] },
    });
    expect(service.read("alice", "list_recent_sessions", { cursor: "", device: "laptop", limit: 100 }).hit).toBe(false);
    expect(service.read("alice", "list_recent_sessions", { cursor: '["claude","fresh"]', device: "laptop", limit: 100 }).hit).toBe(false);
    // An exact selector names chats outside the materialized window.
    expect(service.read("alice", "list_recent_sessions", { ids: "codex:fresh", limit: 1 }).hit).toBe(false);
    expect(service.readRosterDevice("alice", "laptop", { ids: "codex:fresh", limit: 1 }).hit).toBe(false);
    service.close();

    const restartedTransport = new ProjectionTransport();
    const restarted = new RunnerSessionProjectionService(dbPath, restartedTransport, () => Date.parse("2026-08-23T00:02:00.000Z"));
    expect(restarted.read("alice", "list_recent_sessions", { limit: 200 })).toMatchObject({
      hit: true,
      result: { sessions: [{ id: "fresh" }] },
    });
    restartedTransport.invalidate();
    expect(restarted.read("alice", "list_recent_sessions", { limit: 200 }).hit).toBe(false);
    expect(restartedTransport.emit(roster("epoch-two", 1, "reconciled"))).toBe(true);
    expect(restarted.read("alice", "list_recent_sessions", { limit: 200 })).toMatchObject({
      hit: true,
      result: { sessions: [{ id: "reconciled" }] },
    });
    expect(restartedTransport.emit(roster("epoch-one", 999, "retired-revival"))).toBe(false);
    expect(restarted.read("alice", "list_recent_sessions", { limit: 200 })).toMatchObject({
      hit: true,
      result: { sessions: [{ id: "reconciled" }] },
    });
    restarted.purgeDevice("alice", "laptop");
    expect(restarted.read("alice", "list_recent_sessions", { limit: 200 }).hit).toBe(false);
    restarted.close();
  });

  it("applies stable user-or-completion activity before the requested limit", () => {
    const transport = new ProjectionTransport();
    const service = new RunnerSessionProjectionService(
      ":memory:",
      transport,
      () => Date.parse("2026-08-25T10:31:00.000Z"),
    );
    expect(transport.emit({
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "roster_full",
      epoch: "epoch-sort-1234",
      sequence: 1,
      observed_at: "2026-08-25T10:30:00.000Z",
      total_found: 2,
      sessions: [
        {
          id: "noisy-output",
          source: "omp",
          last_activity: "2026-08-25T10:30:00.000Z",
          sort_activity: "2026-08-25T10:00:00.000Z",
        },
        {
          id: "new-user-prompt",
          source: "codex",
          last_activity: "2026-08-25T10:20:00.000Z",
          sort_activity: "2026-08-25T10:20:00.000Z",
          completed_at: "2026-08-25T09:00:00.000Z",
        },
      ],
    })).toBe(true);

    expect(service.read("alice", "list_recent_sessions", { source: "all", limit: 1 })).toMatchObject({
      hit: true,
      result: {
        returned: 1,
        sessions: [{
          id: "new-user-prompt",
          sort_activity: "2026-08-25T10:20:00.000Z",
          completed_at: "2026-08-25T09:00:00.000Z",
        }],
      },
    });
    service.close();
  });

  it("pushes only demanded transcripts and slices cached windows", () => {
    const transport = new ProjectionTransport();
    const service = new RunnerSessionProjectionService(":memory:", transport);
    expect(transport.emit(roster("epoch-one", 1, "s-1"))).toBe(true);
    const listener = vi.fn();
    const close = service.watchTranscript("alice", "laptop", "claude", "s-1", 3, listener);
    expect(close).not.toBeNull();
    expect(transport.commands.at(-1)?.command).toMatchObject({
      kind: "transcript_subscribe",
      source: "claude",
      session_id: "s-1",
      max_messages: 3,
    });

    expect(transport.emit({
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "transcript",
      epoch: "epoch-one",
      sequence: 2,
      observed_at: "2026-08-23T00:00:01.000Z",
      source: "claude",
      session_id: "s-1",
      transcript: {
        rich: true,
        offset: 7,
        total_messages: 10,
        meta: { id: "s-1", source: "claude" },
        messages: [{ n: 7 }, { n: 8 }, { n: 9 }],
      },
    })).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.read("alice", "read_session", {
      device: "laptop", source: "claude", id: "s-1", rich: true, max_messages: 2,
    })).toMatchObject({
      hit: true,
      result: {
        projection_version: { epoch: "epoch-one", sequence: 2 },
        offset: 8,
        total_messages: 10,
        messages: [{ n: 8 }, { n: 9 }],
      },
    });
    expect(transport.emit({
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "transcript",
      epoch: "epoch-one",
      sequence: 3,
      observed_at: "2026-08-23T00:00:02.000Z",
      source: "claude",
      session_id: "s-1",
      transcript: {
        rich: true,
        offset: 0,
        total_messages: 2,
        messages: [{ n: 0 }, { n: 1 }],
      },
    })).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.read("alice", "read_session", {
      device: "laptop", source: "claude", id: "s-1", rich: true, max_messages: 2,
    })).toMatchObject({
      hit: true,
      result: {
        projection_version: { epoch: "epoch-one", sequence: 2 },
        offset: 8,
        total_messages: 10,
      },
    });

    service.remember("alice", "read_session", {
      device: "laptop", source: "claude", id: "s-1", rich: true, max_messages: 2, offset: 0,
    }, {
      rich: true,
      offset: 0,
      total_messages: 10,
      messages: [{ n: 0 }, { n: 1 }],
    });
    service.remember("alice", "read_session", {
      device: "laptop", source: "claude", id: "s-1", rich: true, max_messages: 2,
    }, {
      rich: true,
      offset: 0,
      total_messages: 2,
      messages: [{ n: 0 }, { n: 1 }],
    });
    expect(service.read("alice", "read_session", {
      device: "laptop", source: "claude", id: "s-1", rich: true, max_messages: 2,
    })).toMatchObject({
      hit: true,
      result: {
        projection_version: { epoch: "epoch-one", sequence: 2 },
        offset: 8,
        total_messages: 10,
        messages: [{ n: 8 }, { n: 9 }],
      },
    });
    expect(service.read("alice", "read_session", {
      device: "laptop", source: "claude", id: "s-1", rich: true, max_messages: 2, offset: 7,
    })).toMatchObject({ hit: true, result: { offset: 7, messages: [{ n: 7 }, { n: 8 }] } });
    expect(service.read("alice", "read_session", {
      device: "laptop", source: "claude", id: "s-1", rich: true, max_messages: 2, offset: 5,
    }).hit).toBe(false);
    // A complete-block read and a `before` window are never answered by a cached tail slice.
    expect(service.read("alice", "read_session", {
      device: "laptop", source: "claude", id: "s-1", rich: true, offset: 8, block: 0, field: "output",
    }).hit).toBe(false);
    expect(service.read("alice", "read_session", {
      device: "laptop", source: "claude", id: "s-1", rich: true, max_messages: 2, before: 9,
    }).hit).toBe(false);

    close?.();
    expect(transport.commands.at(-1)?.command).toMatchObject({ kind: "transcript_unsubscribe", session_id: "s-1" });
    service.close();
  });

  it("keeps an unversioned fallback tail monotonic", () => {
    const service = new RunnerSessionProjectionService(":memory:", new ProjectionTransport());
    const args = { device: "laptop", source: "codex", id: "legacy", rich: true, max_messages: 2 } as const;
    service.remember("alice", "read_session", args, {
      rich: true,
      offset: 8,
      total_messages: 10,
      messages: [{ n: 8 }, { n: 9 }],
    });
    service.remember("alice", "read_session", args, {
      rich: true,
      offset: 0,
      total_messages: 2,
      messages: [{ n: 0 }, { n: 1 }],
    });
    expect(service.read("alice", "read_session", args)).toMatchObject({
      hit: true,
      result: { offset: 8, total_messages: 10, messages: [{ n: 8 }, { n: 9 }] },
    });
    service.close();
  });

  it("bounds simultaneous transcript demand and resubscribes it on reconnect", () => {
    const transport = new ProjectionTransport();
    const service = new RunnerSessionProjectionService(":memory:", transport);
    const closes = Array.from({ length: 32 }, (_, index) =>
      service.watchTranscript("alice", "laptop", "claude", `s-${index}`, 20, () => {}));
    expect(closes.every(Boolean)).toBe(true);
    expect(service.watchTranscript("alice", "laptop", "claude", "overflow", 20, () => {})).toBeNull();
    expect(transport.commands.filter((row) => row.command.kind === "transcript_subscribe")).toHaveLength(32);
    transport.reconnect();
    expect(transport.commands.filter((row) => row.command.kind === "transcript_subscribe")).toHaveLength(64);
    for (const close of closes) close?.();
    service.close();
  });
});

it("expires an unwatched empty ticket transcript before the next SSE poll", () => {
  let now = 0;
  const service = new RunnerSessionProjectionService(":memory:", new ProjectionTransport(), () => now);
  const args = { device: "laptop", source: "codex", id: "ticket-571", rich: true, max_messages: 20 };
  try {
    service.remember("alice", "read_session", args, { rich: true, offset: 0, total_messages: 0, messages: [] });
    expect(service.read("alice", "read_session", args)).toMatchObject({ hit: true, result: { messages: [] } });
    now = 4_000;
    expect(service.read("alice", "read_session", args)).toEqual({ hit: false });
    const messages = [{ role: "assistant", blocks: [{ type: "text", text: "live progress" }] }];
    service.remember("alice", "read_session", args, { rich: true, offset: 0, total_messages: 1, messages });
    expect(service.read("alice", "read_session", args)).toMatchObject({ hit: true, result: { messages } });
    expect(service.read("bob", "read_session", args)).toEqual({ hit: false });
    now = 8_000;
    expect(service.read("alice", "read_session", args)).toEqual({ hit: false });
  } finally { service.close(); }
});

it("bounds watched cache freshness and expires sooner after its push subscription closes", () => {
  let now = 0;
  const transport = new ProjectionTransport();
  const service = new RunnerSessionProjectionService(":memory:", transport, () => now);
  const args = { device: "laptop", source: "codex", id: "observed", rich: true };
  try {
    const close = service.watchTranscript("alice", "laptop", "codex", "observed", 20, () => {});
    transport.emit({ schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript", epoch: "watch-epoch", sequence: 1,
      source: "codex", session_id: "observed", observed_at: "2026-09-14T08:00:00Z",
      transcript: { rich: true, offset: 0, total_messages: 1, messages: [{ role: "user", blocks: [] }] } });
    now = 4_000;
    expect(service.read("alice", "read_session", args).hit).toBe(true);
    now = 6_000;
    expect(service.read("alice", "read_session", args).hit).toBe(false);
    now = 4_000;
    close?.();
    expect(service.read("alice", "read_session", args).hit).toBe(false);
  } finally { service.close(); }
});

it("renews only the referenced content version without notifying watchers or resurrecting purged data", () => {
  let now = 0;
  const transport = new ProjectionTransport();
  const service = new RunnerSessionProjectionService(":memory:", transport, () => now);
  const listener = vi.fn();
  const args = { device: "laptop", source: "codex", id: "one", rich: true };
  const frame = { schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript" as const, epoch: "epoch-one", sequence: 1,
    source: "codex" as const, session_id: "one", observed_at: "2026-09-17T08:00:00Z",
    transcript: { rich: true, offset: 0, total_messages: 0, messages: [] } };
  try {
    service.watchTranscript("alice", "laptop", "codex", "one", 20, listener);
    expect(transport.emit(frame)).toBe(true);
    now = 4_000;
    expect(transport.emit({ ...frame, kind: "transcript_checked", sequence: 2, content_sequence: 1 })).toBe(true);
    now = 6_000;
    expect(service.read("alice", "read_session", args)).toMatchObject({ hit: true,
      result: { projection_version: { epoch: "epoch-one", sequence: 1 } } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(transport.emit({ ...frame, kind: "transcript_checked", sequence: 3, content_sequence: 2 })).toBe(false);
    now = 10_000;
    expect(service.read("alice", "read_session", args).hit).toBe(false);
    service.purgeDevice("alice", "laptop");
    expect(transport.emit({ ...frame, kind: "transcript_checked", sequence: 4, content_sequence: 1 })).toBe(false);
    expect(service.read("alice", "read_session", args).hit).toBe(false);
  } finally { service.close(); }
});
