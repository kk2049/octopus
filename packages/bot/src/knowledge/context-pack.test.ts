import { describe, expect, it } from "vitest";
import { assembleContextPack, formatStatement, submitDigest } from "./context-pack.js";
import type { RankedCandidate } from "./retrieval.js";
import type { KnowledgeNode } from "./model.js";

function node(overrides: Partial<KnowledgeNode> & Pick<KnowledgeNode, "id" | "kind" | "statement">): KnowledgeNode {
  return {
    status: "active",
    authority: "curated",
    source_ref: "ticket:5",
    source_sha: "f".repeat(40),
    method: "curated",
    certainty: "exact",
    ...overrides,
  };
}

describe("context pack statements", () => {
  it("delivers a matched rule file as one citable document reference, not its bullets", () => {
    const bullet = (line: number, statement: string, heading: string) => {
      const principle = node({
        id: `principle:agentic-app.md:${line}`,
        kind: "principle",
        statement,
        authority: "path_rule",
        source_ref: `.claude/rules/agentic-app.md#agentic-apps:${line}`,
        metadata: { heading },
      });
      return {
        id: principle.id,
        node: principle,
        slot: "contract_principle",
        grounding: "expanded",
        signals: [],
        edgePath: [],
        rrfScore: 0,
        finalScore: 1,
        rerank: [],
      } satisfies RankedCandidate;
    };
    const assembly = assembleContextPack([
      bullet(17, "Keep the four layers distinct.", "Agentic Apps and untrusted Views"),
      bullet(20, "A module emits layout intents.", "Agentic Apps and untrusted Views"),
    ], []);
    // One line for the file, naming the whole-file obligation and its path.
    expect(assembly.text).toContain("- [doc/path_rule] 路径规则整体适用，动工前读全文（命中 2 条：Agentic Apps and untrusted Views） ← .claude/rules/agentic-app.md ⟨doc:.claude/rules/agentic-app.md⟩");
    expect(assembly.text).not.toContain("Keep the four layers distinct.");
    // The bullets stay first-class records for the trace and the qrels.
    expect(assembly.included).toEqual(["principle:agentic-app.md:17", "principle:agentic-app.md:20"]);
    expect(assembly.slots.contract_principle).toHaveLength(2);
  });

  it("spends one contract seat per rule file so other obligations keep theirs", () => {
    const rule = (file: string, line: number) => {
      const principle = node({
        id: `principle:${file}:${line}`,
        kind: "principle",
        statement: `rule bullet ${file} ${line}`,
        authority: "path_rule",
        source_ref: `.claude/rules/${file}:${line}`,
      });
      return {
        id: principle.id, node: principle, slot: "contract_principle", grounding: "expanded",
        signals: [], edgePath: [], rrfScore: 0, finalScore: 1, rerank: [],
      } satisfies RankedCandidate;
    };
    const obligation = node({
      id: "obligation:parity/port",
      kind: "obligation",
      statement: "Use the provider-neutral operation port.",
      authority: "declared",
      source_ref: "architecture/knowledge/contracts/agent-loop-parity.md",
    });
    const assembly = assembleContextPack([
      rule("agentic-app.md", 17), rule("agentic-app.md", 20), rule("agentic-app.md", 22),
      rule("crdt.md", 10), rule("crdt.md", 12),
      {
        id: obligation.id, node: obligation, slot: "contract_principle", grounding: "expanded",
        signals: [], edgePath: [], rrfScore: 0, finalScore: 1, rerank: [],
      } satisfies RankedCandidate,
    ], []);
    expect(assembly.text).toContain("⟨doc:.claude/rules/agentic-app.md⟩");
    expect(assembly.text).toContain("⟨doc:.claude/rules/crdt.md⟩");
    expect(assembly.text).toContain("Use the provider-neutral operation port.");
  });

  it("renders the id every statement line so an agent can cite it", () => {
    const line = formatStatement(node({ id: "decision:cur:b01:6:1", kind: "decision", statement: "菜单只在点击时打开。", source_ref: "ticket:6#message:30" }), "web");
    expect(line).toBe("- [curated/decision] 菜单只在点击时打开。 ← ticket:6:30（经 web） ⟨decision:cur:b01:6:1⟩");
  });

  it("reports only standing non-goals the submitted requirements overlap, and none that were named", () => {
    const ack = {
      principles: [node({ id: "principle:p1", kind: "principle", statement: "Key state by stable identity." })],
      constraints: [],
      nonGoals: [
        node({ id: "non_goal:alias", kind: "non_goal", statement: "不在顶部状态栏显示 Codex 账户别名。" }),
        node({ id: "non_goal:unrelated", kind: "non_goal", statement: "不给飞书卡片增加审批按钮。" }),
        node({ id: "non_goal:named", kind: "non_goal", statement: "顶部状态栏不展示每个 Codex 账户的名字。" }),
        node({ id: "non_goal:old", kind: "non_goal", statement: "顶部状态栏不显示 Codex 账户别名与头像。", status: "superseded" }),
        node({ id: "landing:9:non_goal:1", kind: "non_goal", statement: "顶部状态栏不显示 Codex 账户别名。", authority: "user", source_ref: "ticket:288/landing:9#non_goals", metadata: { ticket_id: 288 } }),
      ],
    };
    const digest = submitDigest(ack, {
      text: "顶部状态栏显示 Codex 账户别名与各自的重置倒计时。\n按用户要求在顶部状态栏展示两个 Codex 账户。",
      acknowledged: new Set(["non_goal:named"]),
      ticket: 288,
    });
    expect(digest.nonGoals.map((item) => item.id)).toEqual(["non_goal:alias"]);
    expect(digest.principles).toBe(1);
    expect(digest.constraints).toBe(0);
    expect(submitDigest(ack, { text: "修复 CRDT 合并顺序。", acknowledged: new Set() }).nonGoals).toEqual([]);
  });
});
