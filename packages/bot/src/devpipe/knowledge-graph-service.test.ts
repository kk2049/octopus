import { DevPipeline } from "./pipeline.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { parseContextualRecordInput } from "../knowledge/contextual-record.js";
import { GraphDb } from "../knowledge/graph-db.js";
import { normalizeDevTicketInput } from "./ticket-models.js";
import { KnowledgeGraphService } from "./knowledge-graph-service.js";

/**
 * Builds the real repository's graph from the working tree into a temp dir
 * and checks the three devpipe entry points. This is the one test that reads
 * the whole repository; the fixture-based tests live in packages/bot/src/knowledge.
 */
describe("knowledge graph service", () => {
  const store = new Store(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-graph-service-"));
  let service: KnowledgeGraphService;

  beforeAll(async () => {
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x", created_at: "2026-08-20T00:00:00.000Z" });
    const ticket = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "手机端会话导航跳转",
      body: "手机端从 chat 页面点导航，没有回到导航，而是跳到了文件面板。",
      requester: "alice",
    }));
    store.knowledge.recordLanding({
      ticket_id: ticket.id,
      from_sha: "a".repeat(40),
      to_sha: "b".repeat(40),
      base_before: "a".repeat(40),
      tip_sha: "b".repeat(40),
      source: "devpipe",
      changed_files: ["packages/session-plus-view/src/App.tsx"],
      changed_modules: ["session-plus-view"],
      acceptance: ["手机端导航可达"],
      knowledge: {
        summary: "手机端导航不再被文件面板抢占",
        requirements: ["手机端选择会话后必须进入会话"],
        decisions: ["路由身份与文件面板选择分开保存"],
        non_goals: [],
        risks: [],
        verification: ["App.test.tsx passed"],
        context_keys: [],
        supersedes: [],
      },
    });
    service = new KnowledgeGraphService({ store, repoDir: process.cwd(), baseBranch: "HEAD", dir, ref: "HEAD" });
    expect(service.available()).toBe(false);
    expect(await service.refresh()).toBe(true);
  }, 60_000);

  afterAll(() => {
    service?.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds once per input key and serves a startup pack with a mandatory unknown section", async () => {
    expect(service.available()).toBe(true);
    expect(await service.refresh()).toBe(false);
    const pack = await service.startupPack(
      { title: "修正手机端会话导航", body: "手机端从 chat 页面点导航跳到了文件" },
      { lane: "ticket", subject_ref: "ticket:1", turn: 1 },
    );
    expect(pack).not.toBeNull();
    expect(pack!.text).toContain("### 未知、冲突与陈旧性（禁止省略）");
    expect(pack!.capabilities.map((match) => match.id)).toContain("sessions-plus.mobile");
    expect(pack!.chars).toBeLessThanOrEqual(7_000);
    expect(pack!.text).not.toContain("Land through");
  });

  it("exports only privacy-filtered contextual records for remote embedding", async () => {
    const artifact = await service.artifactInput();
    expect(artifact).not.toBeNull();
    const source = fs.readFileSync(artifact!.file, "utf8");
    expect(source.startsWith("SQLite format 3")).toBe(false);
    expect(Buffer.byteLength(source)).toBe(artifact!.bytes);
    const records = parseContextualRecordInput(source).records;
    expect(artifact!.recordSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(records.some((record) => record.kind === "ticket")).toBe(false);
    expect(source).not.toContain('"metadata"');
    expect(source).not.toContain("手机端从 chat 页面点导航，没有回到导航，而是跳到了文件面板。");
    const digest = artifact!.recordSetSha256;
    fs.chmodSync(artifact!.file, 0o600);
    fs.writeFileSync(artifact!.file, "x".repeat(artifact!.bytes));
    const repaired = await service.artifactInput();
    expect(repaired?.recordSetSha256).toBe(digest);
    expect(fs.readFileSync(repaired!.file, "utf8")).toBe(source);
    fs.rmSync(artifact!.file);
    const rebuilt = await service.artifactInput();
    expect(rebuilt?.recordSetSha256).toBe(digest);
    expect(fs.statSync(rebuilt!.file).mode & 0o777).toBe(0o400);
    // Builds the contextual record set for the whole repository graph three
    // times, like the 60s beforeAll above; the default 20s budget flakes
    // whenever this host is also running an index job or a CI batch.
  }, 60_000);

  it("keeps the exact runtime inputs inside the graph that they produced", () => {
    const graph = GraphDb.openReadonly(service.file);
    expect(graph).not.toBeNull();
    try {
      const runtime = graph!.runtimeInputs();
      expect(runtime?.landings.map((landing) => landing.id)).toEqual([1]);
      expect(runtime?.tickets.map((ticket) => ticket.id)).toEqual([1]);
    } finally {
      graph?.close();
    }
    expect(fs.existsSync(path.join(dir, "runtime-inputs.json"))).toBe(false);
    expect(fs.statSync(service.file).mode & 0o777).toBe(0o600);
  });

  it("does not rebuild or invalidate artifact input when only a new ticket row appears", async () => {
    const before = await service.artifactInput();
    store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "Unlanded operational ticket",
      body: "This ticket is runtime routing context, not a landed knowledge source.",
      requester: "alice",
    }));
    expect(await service.refresh()).toBe(false);
    const after = await service.artifactInput();
    expect(after).toMatchObject({
      repoSha: before?.repoSha,
      sha256: before?.sha256,
      recordSetSha256: before?.recordSetSha256,
    });
  });

  it("answers path context with module ownership and the landing ledger", async () => {
    const context = await service.pathContext(
      ["packages/session-plus-view/src/App.tsx"],
      undefined,
      { lane: "ticket", subject_ref: "ticket:1", turn: 2 },
    );
    expect(context!.text).toContain("Session Plus View（session-plus-view）");
    expect(context!.text).toContain("路由身份与文件面板选择分开保存");
    // Every statement line ends with the id that knowledge.context_keys / supersedes accept.
    expect(context!.text).toContain("⟨landing:1:decision:2⟩");
    expect(service.hasNode("landing:1:decision:2")).toBe(true);
  });


  it("ticket context operation returns graph feedback and a durable delivery receipt", async () => {
    // Only the live-turn registry is a fixture; the ticket method, graph query,
    // context assembly and delivery ledger below are the production implementations.
    const token = "fixture-ticket-query";
    const turn = 73;
    const context = Object.assign(Object.create(DevPipeline.prototype), {
      turnTokens: new Map([[token, { ticketId: 1, turn }]]), knowledgeGraph: service, store, developmentWorkspaces: null,
    }) as DevPipeline;
    const paths = ["packages/session-plus-view/src/App.tsx"];
    const since = new Date(Date.now() - 1000).toISOString();
    const reply = await DevPipeline.prototype.toolContext.call(context, token, paths, "手机端会话导航");
    expect(reply.ok).toBe(true);
    expect(reply.records).toBeGreaterThan(0);
    expect(reply.trace_id).toMatch(/^kr_[0-9a-f]{32}$/);
    expect(reply.message).toContain("检索追踪：");
    expect(store.knowledgeRetrieval.hasDeliveredPathContext("ticket:1", turn, paths, since)).toBe(true);
    expect((await DevPipeline.prototype.toolContext.call(context, "expired-token", paths)).ok).toBe(false);
  });

  it("derives the submit-time acknowledgement set from exact edges", () => {
    const ack = service.acknowledgement(["packages/dashboard-web/src/pages/TicketsPage.tsx"]);
    expect(ack).not.toBeNull();
    expect(ack!.principles.length).toBeGreaterThan(0);
    expect(ack!.principles.every((node) => node.authority !== "always_on" && node.certainty === "exact")).toBe(true);
    expect(ack!.principles.some((node) => node.source_ref.startsWith(".claude/rules/frontend-stability.md"))).toBe(true);
    // Rules scoped to other packages by a wildcard segment (`packages/agent-*`, `packages/*-contract`) do not reach a dashboard file.
    expect(ack!.principles.some((node) => node.source_ref.startsWith(".claude/rules/agentic-app.md"))).toBe(false);
    expect(ack!.principles.some((node) => node.source_ref.startsWith(".claude/rules/resource-bindings.md"))).toBe(false);
  });

  it("preserves vector and code bindings when reopen sees the same exact record set", async () => {
    const active = path.join(dir, "test-active-generation");
    fs.mkdirSync(active, { recursive: true });
    const closeCode = vi.fn();
    const closeProvider = vi.fn(async () => undefined);
    const internal = service as unknown as {
      builtKey: string | null;
      codeIndex: { gitSha: string; close(): void } | null;
      vectorProvider: { close(): Promise<void> } | null;
      vectorIndex: { name: string; version: string; search(): Promise<unknown> } | null;
      activeArtifactGeneration: string | null;
      retriever: { similarity: { names: string[] } } | null;
    };
    const repoSha = service.commit()!;
    internal.codeIndex = { gitSha: service.commit()!, close: closeCode };
    internal.vectorProvider = { close: closeProvider };
    internal.vectorIndex = {
      name: "vector-test",
      version: "test-v1",
      search: async () => ({
        hits: [],
        trace: {
          index: "vector-test",
          version: "test-v1",
          kind: "vector",
          sourceGitSha: repoSha,
          artifactSha256: "f".repeat(64),
          recordCount: 0,
          status: "ok",
          latencyMs: 0,
          hits: [],
        },
      }),
    };
    internal.activeArtifactGeneration = fs.realpathSync(active);

    const old = new Date(0);
    const orphanNames = [
      "graph.db.build-999.deadbeef",
      `contextual-input.json.artifact-${"a".repeat(40)}.999.deadbeef`,
      `runtime-inputs.artifact-${"a".repeat(40)}.999.deadbeef.json`,
    ];
    for (const name of orphanNames) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, "orphan");
      fs.utimesSync(file, old, old);
    }
    const unrelated = path.join(dir, "do-not-remove.tmp");
    fs.writeFileSync(unrelated, "keep");
    fs.utimesSync(unrelated, old, old);

    // Force the defensive reopen path; ticket-only runtime rows remain absent
    // from the contextual record set, so the active hybrid indexes stay valid.
    internal.builtKey = null;
    expect(await service.refresh()).toBe(true);
    expect(internal.retriever?.similarity.names).toEqual(["lexical", "vector-test"]);
    const context = await service.pathContext(
      ["packages/bot/src/devpipe/knowledge-graph-service.ts"],
      "artifact lifecycle",
      { lane: "ticket", subject_ref: "ticket:1", turn: 3 },
    );
    expect(context).not.toBeNull();
    if (!context || context.trace.outcome.event === "error") throw new Error("hybrid retrieval did not run");
    expect(context.trace.outcome.plan.indexes).toContainEqual(expect.objectContaining({
      index: expect.objectContaining({ id: "vector-test", freshness: "exact" }),
      status: "ok",
    }));
    expect(closeCode).not.toHaveBeenCalled();
    expect(closeProvider).not.toHaveBeenCalled();
    for (const name of orphanNames) expect(fs.existsSync(path.join(dir, name))).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  }, 60_000);

  it("rebuilds in a child process and survives close() mid-build", async () => {
    const other = new KnowledgeGraphService({ store, repoDir: process.cwd(), baseBranch: "HEAD", dir: fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-graph-kill-")), ref: "WORKTREE" });
    const pending = other.refresh();
    other.close();
    // A killed build is reported, never thrown into the pipeline.
    expect(await pending).toBe(false);
    expect(other.available()).toBe(false);
  });
});
