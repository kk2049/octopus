import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { handleRpc } from "@claude-bot/runner/core";
import { addWorkspace } from "@claude-bot/runner/workspaces";
import { drainResourceStream } from "@claude-bot/resource-stream-contract";
import { resourceId } from "../sessionhub/core.js";
import { ownerFileSessionTarget } from "./owner-file-target.js";
import { RunnerWorkspaceFilesBackend } from "./runner-backend.js";
import { WorkspaceFilesService } from "./service.js";
import type { WorkspaceFilesAuthority } from "./types.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ref = resourceId({ owner: "alice", device: "current", cliKind: "codex", sessionId: "test-thread" });

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "owner-file-link-")); dirs.push(home);
  const cwd = join(home, "unregistered"); mkdirSync(cwd);
  const sessions = join(home, ".codex", "sessions"); mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-test-thread.jsonl"), JSON.stringify({ type: "session_meta",
    payload: { id: "test-thread", cwd, timestamp: "2026-10-09T00:00:00Z" } }) + "\n");
  writeFileSync(join(cwd, "z-report.md"), "hello\n");
  const calls: Array<{ device: string; operation: string; args: Record<string, unknown> }> = [];
  let denied = false;
  const authority: WorkspaceFilesAuthority = {
    devices: async () => [{ device: "offline-first", label: "offline" }, { device: "current", label: "current" }],
    call: async (device, operation, args) => {
      calls.push({ device, operation, args });
      if (denied) return { status: "denied" };
      if (device === "offline-first") return { status: "failed" };
      if (operation === "list_session_workspaces") return { status: "succeeded", result: {
        workspaces: Array.from({ length: 80 }, (_, i) => ({ id: `ws_${String(i).padStart(24, "0")}`, label: `project-${i}`, display: `~/project-${i}` })),
        session_directories: [],
      } };
      const reply = await handleRpc(home, { id: String(calls.length), method: operation, args }, { allowMachineOps: true });
      return reply.ok ? { status: "succeeded", result: reply.result } : { status: "failed", reason: reply.error };
    },
  };
  const backend = new RunnerWorkspaceFilesBackend(authority, { ownerFiles: true });
  const service = new WorkspaceFilesService();
  const port = service.open({ owner: "alice", scope: "owner", backend, contract: "workspace-files/v4",
    ownerFileTarget: (value) => ownerFileSessionTarget("alice", value, () => null) });
  return { home, cwd, calls, authority, backend, service, port, revoke: () => { denied = true; } };
}

it("opens the session's unregistered file after 64 roots and 500 siblings, with no directory walk or device fallback", async () => {
  const f = await fixture();
  for (let i = 0; i < 501; i++) writeFileSync(join(f.cwd, `a-${i}.txt`), "");
  const roots = await f.port.refreshRoots();
  expect(roots).toMatchObject({ ok: true, value: { truncated: true } });
  f.calls.length = 0;
  const resolved = await f.port.resolveFileLink({ sessionRef: ref, href: join(f.cwd, "z-report.md") });
  expect(resolved).toMatchObject({ ok: true, value: { entry: { label: "z-report.md", kind: "file" } } });
  if (!resolved.ok) return;
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ device: "current", operation: "access_owner_files", args: { mode: "resolve" } });
  const opened = await f.port.openText(resolved.value.entry.ref);
  expect(opened.ok).toBe(true);
  if (opened.ok) expect(await drainResourceStream(opened.value.stream)).toMatchObject({ chunks: [{ text: "hello\n" }] });
  expect(f.calls.every((call) => call.device === "current" && call.operation === "access_owner_files")).toBe(true);
});

it("resolves relative session/Markdown/image paths and owner symlinks without listing parents", async () => {
  const f = await fixture();
  writeFileSync(join(f.home, "sibling.md"), "sibling\n");
  symlinkSync(join(f.home, "sibling.md"), join(f.cwd, "linked.md"));
  const first = await f.port.resolveFileLink({ sessionRef: ref, href: "z-report.md" });
  expect(first.ok).toBe(true); if (!first.ok) return;
  expect(await f.port.resolveFileLink({ fileRef: first.value.entry.ref, href: "../sibling.md" })).toMatchObject({ ok: true });
  expect(await f.port.resolvePath(first.value.entry.base, [...first.value.entry.path.split("/").slice(0, -1), "linked.md"]))
    .toMatchObject({ ok: true, value: { label: "linked.md" } });
  expect(f.calls.map((call) => call.args.mode)).toEqual(["resolve", "stat", "stat"]);
});

it("binds split sessions to their execution device/workspace and rejects foreign owners", async () => {
  const f = await fixture();
  const workspace = await addWorkspace(f.home, f.cwd, "Execution");
  const target = ownerFileSessionTarget("alice", ref, () => ({ device: "current", workspaceId: workspace.id }));
  expect(target).toMatchObject({ device: "current", workspaceId: workspace.id });
  expect(await f.backend.resolveOwnerFile(target!, "z-report.md")).toMatchObject({ ok: true });
  expect(f.calls[0]!.args).toMatchObject({ workspace_id: workspace.id, mode: "resolve" });
  const foreign = resourceId({ owner: "bob", device: "current", cliKind: "codex", sessionId: "test-thread" });
  const before = f.calls.length;
  expect(await f.port.resolveFileLink({ sessionRef: foreign, href: "/secret" })).toMatchObject({ ok: false, code: "denied" });
  expect(f.calls).toHaveLength(before);
  expect(ownerFileSessionTarget("alice", ref, () => ({ device: "execution-device", workspaceId: workspace.id })))
    .toMatchObject({ device: "execution-device" });
});

it("does not enable owner resolution in shared scopes and rechecks access on reads after resolution", async () => {
  const f = await fixture();
  const shared = f.service.open({ owner: "alice", scope: "shared", backend: new RunnerWorkspaceFilesBackend(f.authority) });
  expect(await shared.resolveFileLink({ sessionRef: ref, href: "z-report.md" })).toMatchObject({ ok: false, code: "denied" });
  expect(f.calls).toEqual([]);
  const resolved = await f.port.resolveFileLink({ sessionRef: ref, href: "z-report.md" });
  expect(resolved.ok).toBe(true); if (!resolved.ok) return;
  expect(await shared.openText(resolved.value.entry.ref)).toMatchObject({ ok: false });
  f.revoke();
  expect(await f.port.openText(resolved.value.entry.ref)).toMatchObject({ ok: false, code: "denied" });
  await f.service.closeScope("owner");
  expect(await f.port.resolveFileLink({ sessionRef: ref, href: "z-report.md" })).toMatchObject({ ok: false, code: "scope_closed" });
});
