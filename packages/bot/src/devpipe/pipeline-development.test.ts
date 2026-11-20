import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { DevPipeline } from "./pipeline.js";
import { DevelopmentWorkspaceService, type DevelopmentTurnBinding } from "./development-workspace.js";
import { BundleHandoff } from "./bundle-handoff.js";
import type { TicketRunnerAccess } from "./runner-ticket.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
it.each(["own", "shared", "own-default"])("launches an unstarted ticket in its managed child, placement=%s", async (placement) => {
  const shared = placement === "shared";
  const root = mkdtempSync(join(tmpdir(), "pipeline-development-"));
  const store = new Store(join(root, "store.db")); cleanups.push(async () => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: root, created_at: new Date().toISOString() });
  const pipe = new DevPipeline({ store, repoDir: root, worktreesDir: root, baseBranch: "v4", buildWarmEnabled: false, knowledgeCaptureEnabled: false, pushRemote: null });
  cleanups.push(() => pipe.stop());
  const parent = "ws_" + "a".repeat(24), child = "ws_" + "b".repeat(24);
  const requester = shared ? "bob" : "alice";
  if (shared) store.saveUser({ username: "bob", uid: 2, home_dir: root, created_at: "now" });
  let allowed = true;
  const runner = { owner: "alice", ...(shared ? { requester, parentWorkspaceId: parent } : {}), device: "model", executionDevice: "execution", workspaceId: parent, source: "codex" as const };
  vi.spyOn(DevelopmentWorkspaceService.prototype, "prepare").mockImplementation(async (ticketId) => {
    const development = { ticketId, owner: "alice", ...(shared ? { requester } : {}), device: "execution", parentWorkspaceId: parent, worktreeWorkspaceId: child,
      repositoryId: "octopus", developmentId: "development-one", baseSha: "a".repeat(40) };
    store.devTickets.development.bind(development); return development;
  });
  const release = vi.fn(); let issued: DevelopmentTurnBinding | null = null;
  pipe.setDevelopmentWorkspaces({ stateDir: join(root, "state"), repositoryId: "octopus", publicUrl: "https://head.example.test", bundles: new BundleHandoff(),
    available: () => true, call: async () => { throw new Error("unexpected development RPC"); } }, (binding) => {
    expect(pipe.isCurrentDevelopmentTurn(binding)).toBe(true); issued = binding;
    return { token: "mcp_test-private", endpoint: "https://head.example.test/api/mcp", expiresAt: Date.now() + 60000, release };
  });
  let started = false;
  let steered = false;
  const prepareAttachments = vi.fn(async (_bound: unknown, prompt: string) => prompt);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  pipe.setRunnerTickets({ config: { targets: { alice: { device: "model", workspace_id: parent, workspaces: [{ device: "execution", workspace_id: parent }] } } }, resourceOwner: () => "alice", authorized: () => allowed, target: () => ({ device: "model", workspace_id: parent }), resolve: () => runner, prepareAttachments,
    call: async (_bound: unknown, method: string, args: Record<string, unknown>) => {
      calls.push({ method, args });
      if (method === "start_session") {
        expect(args.workspace_id).toBe(child);
        const trusted = pipe.developmentDispatchArgs("alice", method, { ...args, device: "model" });
        expect(trusted).toMatchObject({ _octopus_development_id: "development-one", _octopus_development_mcp_token: "mcp_test-private" });
        expect(pipe.developmentDispatchArgs("other-owner", method, { ...args, device: "model" })).toEqual({});
        allowed = false;
        expect(pipe.isCurrentDevelopmentTurn(issued!)).toBe(false);
        allowed = true;
        started = true;
      }
      const input = String(args.operation_id).startsWith("ticket-input-");
      if (method === "append_session") {
        expect(args).toMatchObject({ id: "native-same", steer_only: true });
        expect(pipe.developmentDispatchArgs("alice", method, { ...args, device: "model" }))
          .toMatchObject({ _octopus_development_id: "development-one", _octopus_development_mcp_token: "mcp_test-private" });
        expect(pipe.developmentDispatchArgs("other-owner", method, { ...args, device: "model" })).toEqual({});
        expect(pipe.developmentDispatchArgs("alice", method, { ...args, device: "other-model" })).toEqual({});
        steered = true;
      }
      return { protocol: "runner-session-operation/v1", live_input: "steer-only/v1", operation_id: String(args.operation_id),
        state: input ? steered ? "succeeded" : "missing" : started ? steered ? "succeeded" : "running" : "missing",
        ...(started ? { session_id: "native-same", input: { phase: "provider_accepted", evidence: "provider_ack", at: new Date().toISOString() },
          ...(steered ? { result: { result_text: "done" } } : {}) } : {}) };
    },
  } as unknown as TicketRunnerAccess);
  const ticket = pipe.createTicket({ requester, title: "new selected", body: "implement", model: "codex-gpt-6-astra", ...(placement === "own-default" ? {} : { agent_source: "selected", workspace: parent }) });
  store.devTickets.updateDevTicket(ticket.id, { worktree: root, branch: "ticket/test" });
  pipe.start();
  await vi.waitFor(() => expect(store.devTickets.getDevTicket(ticket.id)?.session_id).toBe("native-same"));
  pipe.postMessage(ticket.id, "alice", "web", "live change");
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce(), { timeout: 3000 });
  expect(calls.filter((row) => row.method === "start_session")).toHaveLength(1);
  expect(calls.filter((row) => row.method === "append_session")).toHaveLength(1);
  expect(store.devTickets.runner.binding(ticket.id)?.workspaceId).toBe(child);
  expect(prepareAttachments).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: child }), expect.any(String), expect.any(Array), `ticket-${ticket.id}`);
  expect(JSON.stringify(store.devTickets.runner.latest(ticket.id))).not.toContain("mcp_test-private");
  expect(JSON.stringify(store.devTickets.runner.latest(ticket.id))).not.toContain("_octopus_development");
  expect(pipe.isCurrentDevelopmentTurn(issued!)).toBe(false);
});
