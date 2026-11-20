import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRpc } from "@claude-bot/runner/core";
import { composeDashboardServices } from "./bootstrap-v3.js";
import { RunnerCapabilities } from "./runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "./runner/gateway.js";
import { Store } from "./store/store.js";
import type { WorkspaceFilesCapabilities } from "./workspace-files/capability.js";
import type { ExecutionWorkspaceCapabilities } from "./execution-workspace/capability.js";

it("carries an authorized ticket opt-in through the real bootstrap preparer to the exact Runner split transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-read-bootstrap-"));
  const store = new Store(join(dir, "store.db"));
  const now = new Date().toISOString();
  const id = "01a0a3e3-6ca2-7541-b2a6-4f1af6106586";
  const split = join(dir, "split-codex-home");
  const sessions = join(split, "sessions", "2026", "09", "15");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-2026-09-15T03-26-23-" + id + ".jsonl"), [
    { type: "session_meta", payload: { id, cwd: dir } },
    { type: "event_msg", payload: { type: "user_message", message: "ticket request" } },
    { type: "event_msg", payload: { type: "agent_message", message: "native progress" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  // The existing v1 durable placement format, as written by LaunchJournal.
  const placements = join(dir, ".octopus-runner", "session-placements");
  mkdirSync(placements, { recursive: true });
  writeFileSync(join(placements, createHash("sha256").update(id).digest("hex") + ".json"), JSON.stringify({
    version: 1, session_id: id, source: "codex", execution_device: "worker",
    workspace_id: "ws_0123456789abcdef01234567",
  }));
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: now });
  store.saveRunnerToken(hashRunnerToken("rt_runtime"), "alice", "runtime", now);
  const frames: Array<{ owner: string; method: string; args: Record<string, unknown> }> = [];
  const cacheRead = vi.fn(() => ({ hit: false as const }));
  const cacheRemember = vi.fn();
  const caps = new RunnerCapabilities(store, {
    dispatch: async (owner: string, method: string, args: Record<string, unknown>) => {
      frames.push({ owner, method, args });
      const reply = await handleRpc(dir, { id: "read-ticket", method, args }, {
        sessionScanRoot: { home: dir, codexHome: join(dir, "ordinary-codex-home") },
        sessionPlusSessionScanRoot: { home: dir, codexHome: split },
      });
      if (!reply.ok) throw new Error(reply.error);
      return reply.result;
    },
    listDevices: () => [{ device: "runtime", online: true }],
    isOnline: () => true,
  } as unknown as RunnerTransport, { projectionReadCache: { read: cacheRead, remember: cacheRemember } });
  caps.ensureAccount("alice");
  const workspaceFiles = { service: caps.service, attachToRunnerLifecycle: () => () => {},
    open: () => null, accountOperations: () => [] } as unknown as WorkspaceFilesCapabilities;
  const composition = composeDashboardServices(store, caps, { port: 0, workspaceFiles,
    executionWorkspace: {} as ExecutionWorkspaceCapabilities });
  const grant = caps.open({ username: "alice", purpose: "ticket-read", kind: "job", device: "runtime",
    rights: ["read_session"], autoAllow: ["read_session"] })!;
  try {
    const args = { device: "runtime", id, source: "codex", rich: true, max_messages: 1 };
    await expect(grant.call("read_session", args)).rejects.toThrow("session not found");
    // An ordinary same-id cache entry cannot substitute for this split read.
    const cacheReads = cacheRead.mock.calls.length;
    const cacheWrites = cacheRemember.mock.calls.length;
    await expect(grant.call("read_session", { ...args, _octopus_include_session_plus: true }))
      .resolves.toMatchObject({ total_messages: 2, offset: 1,
        messages: [{ role: "assistant", blocks: [{ text: "native progress" }] }] });
    expect(cacheRead).toHaveBeenCalledTimes(cacheReads);
    expect(cacheRemember).toHaveBeenCalledTimes(cacheWrites);
    expect(frames.at(-1)).toMatchObject({ owner: "alice", method: "read_session",
      args: { id, source: "codex", _octopus_include_session_plus: true } });
    const before = frames.length;
    grant.destroy();
    await expect(grant.call("read_session", { ...args, _octopus_include_session_plus: true })).rejects.toThrow();
    expect(frames).toHaveLength(before);
  } finally {
    grant.destroy();
    await composition.close();
    caps.service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
