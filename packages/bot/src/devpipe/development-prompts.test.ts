import { expect, it } from "vitest";
import type { DevTicketRow } from "../store/repositories/dev-tickets.js";
import { buildIntroPrompt, formatInbox } from "./prompts.js";

const ticket = { id: 7, title: "development", requester: "alice", branch: "ticket/7", kind: "simple", lane: "direct", model: "codex-gpt-6-astra" } as DevTicketRow;
it.each(["direct", "review"] as const)("describes real Runner custody and configured CI in the %s development lane", (lane) => {
  const prompt = buildIntroPrompt({ ...ticket, lane }, [], { baseBranch: "v4", toolsAvailable: true, runnerExecution: true,
    developmentWorkspace: { ciDevice: "compute-big", ciWorkspaceId: "ws_" + "c".repeat(24) },
    machine: { device: "old-head", checkoutDir: "/old-head-tree", syncedTo: "a".repeat(40) } });
  expect(prompt).toContain("octopus_devpipe MCP");
  expect(prompt).toContain("Runner 上本票持久开发树");
  expect(prompt).toContain("compute-big");
  expect(prompt).toContain("devpipe_ci_sync");
  expect(prompt).toContain("devpipe_ci_job start");
  expect(prompt).toContain("--maxWorkers=1");
  expect(prompt).toContain("install、编译和代码测试只在配置的隔离 CI Runner 运行");
  expect(prompt).toContain("octopus-browser doctor");
  expect(prompt).toContain("doc/runbooks/browser-acceptance.md");
  expect(prompt).toContain("不把代码测试冒充 GUI 验收");
  expect(prompt).toContain("base_moved");
  expect(prompt).toContain("git rebase refs/remotes/octopus/head");
  expect(prompt).toContain("dirty 会要求先 commit");
  expect(prompt).toContain("不得 push/merge/force-update");
  for (const legacy of ["SSH", "call-mcp", ".mcp-devpipe.json", "本轮凭据文件", "devpipe:call", "base_changed_review", "/old-head-tree", "machine_exec"]) expect(prompt).not.toContain(legacy);
  expect(prompt).toContain(lane === "review" ? "**不会**合入 v4" : "唯一合入锁内 ff 合入 v4");
});

it("keeps missing CI explicit and does not authorize model-head compute as a fallback", () => {
  const prompt = buildIntroPrompt(ticket, [], { baseBranch: "v4", toolsAvailable: true, runnerExecution: true, developmentWorkspace: {} });
  expect(prompt).toContain("当前没有可用的隔离 CI provider");
  expect(prompt).toContain("不转到服务节点或模型来源节点执行");
});

it("retains the existing service-file instructions for legacy Runner tickets", () => {
  const prompt = buildIntroPrompt(ticket, [], { baseBranch: "v4", toolsAvailable: true, runnerExecution: true });
  expect(prompt).toContain("服务端 worktree 调用本轮凭据文件");
  expect(prompt).toContain("base_changed_review");
  expect(prompt).not.toContain("octopus_devpipe MCP");
});

it("frames a person-named inbox row that the person did not type with its actor kind", () => {
  const row = (author: string, via: string, actor_kind?: "browser" | "token" | "mcp" | "system" | null) =>
    ({ id: 1, ticket_id: 7, author, via, body: "b", delivered_turn: null, created_at: "t", ...(actor_kind !== undefined ? { actor_kind } : {}) });
  expect(formatInbox([row("lht", "web", "token")])).toBe("[lht via web, actor_kind=token]: b");
  expect(formatInbox([row("lht", "web", "mcp")])).toBe("[lht via web, actor_kind=mcp]: b");
  expect(formatInbox([row("lht", "gitlab-ci", "system")])).toBe("[lht via gitlab-ci, actor_kind=system]: b");
  // A person's own typing, an older row and the Head's own authors keep the historical frame.
  expect(formatInbox([row("lht", "web", "browser")])).toBe("[lht via web]: b");
  expect(formatInbox([row("lht", "web", null)])).toBe("[lht via web]: b");
  expect(formatInbox([row("lht", "web")])).toBe("[lht via web]: b");
  expect(formatInbox([row("pipeline", "pipeline", "system")])).toBe("[pipeline via pipeline]: b");
  expect(formatInbox([row("agent", "agent", "system")])).toBe("[agent via agent]: b");
});
