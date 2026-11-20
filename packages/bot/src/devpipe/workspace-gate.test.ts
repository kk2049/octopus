import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspaceProviderGate } from "./workspace-gate.js";
import type { WorkspaceProvider, WorkspaceTask } from "./workspace-provider.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
it("reopens an interrupted gate using the same prepare and step identities", async () => {
  const stateDir = await fs.mkdtemp(path.join(tmpdir(), "workspace-gate-")); dirs.push(stateDir);
  const calls: WorkspaceTask[] = []; let fail = true;
  const provider = { target: { owner: "lht", device: "ci", workspaceId: `ws_${"1".repeat(24)}` },
    async wait(task: WorkspaceTask) {
      calls.push(task);
      if (!task.sourceDir && fail) throw new Error("offline; original task may continue");
      return { state: "succeeded", job_id: task.key, repo_sha: task.sha, exit_code: 0, log_bytes: 0 };
    }, async log() { return { text: "original log" }; },
  } as unknown as WorkspaceProvider;
  const first = workspaceProviderGate(provider, stateDir);
  await first.sync("/source", "a".repeat(40));
  await expect(first.run({ id: "tests", bin: "echo", args: ["test"] }, 1000)).rejects.toThrow("original task");
  await first.close();
  fail = false;
  const restored = workspaceProviderGate(provider, stateDir);
  await restored.sync("/source", "a".repeat(40));
  expect((await restored.run({ id: "tests", bin: "echo", args: ["test"] }, 1000)).ok).toBe(true);
  expect(calls[0].key).toBe(calls[2].key);
  expect(calls[1].key).toBe(calls[3].key);
  await restored.close();
  const nextExplicitCheck = workspaceProviderGate(provider, stateDir);
  await nextExplicitCheck.sync("/source", "a".repeat(40));
  expect(calls[4].key).not.toBe(calls[0].key);
  await nextExplicitCheck.close();
});

it.each([["failed", "deps_build"], ["timed_out", "timeout"], ["not_started", "remote_unavailable"]])("preparation %s preserves refusal %s", async (state, refusal) => {
  const stateDir = await fs.mkdtemp(path.join(tmpdir(), "workspace-gate-verdict-")); dirs.push(stateDir);
  const provider = { target: { owner: "lht", device: "ci", workspaceId: `ws_${"1".repeat(24)}` },
    async wait() { return { state, job_id: "original" }; },
  } as unknown as WorkspaceProvider;
  const session = workspaceProviderGate(provider, stateDir);
  expect(await session.sync("/source", "a".repeat(40))).toMatchObject({ ok: false, refusal });
  await session.close();
});
