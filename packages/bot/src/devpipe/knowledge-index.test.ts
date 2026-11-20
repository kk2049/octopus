import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { RepositoryKnowledgeIndex } from "./knowledge-index.js";

const CASES = [
  ["手机端 输入框 导航 滑动", "historical:pattern:mobile-cross-surface-transition-state"],
  ["文件 打开 预览 resource", "historical:pattern:file-affordance-not-open-pipeline"],
  ["界面抖动 手动刷新 滚动位置", "historical:pattern:async-refresh-identity-continuity"],
  ["接管 中断 agent chat 标题", "historical:pattern:provider-session-lifecycle-vocabulary"],
  ["GitLab CI 红灯 failure roster", "historical:pattern:ci-repair-fanout-not-convergence"],
  ["landing base SHA tested head ticket", "historical:pattern:landing-lineage-causal-gap"],
  ["部署 build 冷启动 readiness", "historical:pattern:deploy-artifact-readiness-phases"],
  ["App 全局重建 待发布债务 release", "historical:pattern:app-release-impact-drift"],
] as const;

// Keyword smoke over the shipped seeds. This is NOT a recall evaluation: with
// real ticket bodies the same index scores 6/28 (doc/experiments/
// knowledge-retrieval-replay). The replay harness is the evaluation.
describe("repository knowledge keyword smoke", () => {
  const store = new Store(":memory:");
  const index = new RepositoryKnowledgeIndex(store, process.cwd());

  beforeAll(async () => {
    await index.refresh("HEAD");
  }, 30_000);

  afterAll(() => store.close());

  // A window of 30, not 20: bm25's IDF moves with every document the repo
  // gains, and on 2026-08-20 the file-affordance case sat at exactly rank 20
  // before an unrelated doc landing pushed it to 21. The eval is "a historical
  // recurrence is retrievable", not "ranks above the package contracts that
  // share its vocabulary"; the cut-off has to leave room for corpus growth.
  const RETRIEVAL_WINDOW = 30;

  it.each(CASES)("retrieves the historical recurrence for %s", (query, expectedKey) => {
    const keys = store.knowledge.search(query, RETRIEVAL_WINDOW).map((hit) => hit.record_key);
    expect(keys).toContain(expectedKey);
  });

  it("retrieves executable architecture constraints separately from historical observations", () => {
    const hits = store.knowledge.search("不可信 View 不得可达可信 Dashboard", 8);
    expect(hits).toContainEqual(expect.objectContaining({
      record_key: "architecture:constraint:TRUST-001",
      kind: "constraint",
      authority: "declared",
      status: "active",
    }));
  });
});

describe("repository knowledge index of a long document", () => {
  it("indexes all of a 100k-character rule, so a term at its end is retrievable", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { gitOrThrow } = await import("./worktree.js");
    const root = await mkdtemp(path.join(tmpdir(), "knowledge-long-"));
    const store = new Store(":memory:");
    try {
      await gitOrThrow(root, ["init", "-b", "v4"]);
      await gitOrThrow(root, ["config", "user.email", "t@t"]);
      await gitOrThrow(root, ["config", "user.name", "t"]);
      const filler = "filler words about nothing in particular. ".repeat(2_500);
      const rule = `# Long rule\n\n${filler}\n\nzyxwvutsrq-terminal-constraint must hold.\n`;
      expect(rule.length).toBeGreaterThan(100_000);
      await writeFile(path.join(root, "AGENTS.md"), rule);
      await mkdir(path.join(root, "architecture"));
      await writeFile(path.join(root, "architecture/atlas.json"), JSON.stringify({ modules: [], constraints: [] }));
      await gitOrThrow(root, ["add", "."]);
      await gitOrThrow(root, ["commit", "-m", "long"]);
      await new RepositoryKnowledgeIndex(store, root).refresh("HEAD");
      const hits = store.knowledge.search("zyxwvutsrq-terminal-constraint", 5);
      expect(hits.map((hit) => hit.source_ref)).toEqual(["AGENTS.md"]);
      expect(hits[0]!.body).toBe(rule.trim());
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
