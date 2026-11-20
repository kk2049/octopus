import { describe, expect, it } from "vitest";
import { statementKey } from "./ids.js";
import { adrRefs, bullets, paragraphs, parseFrontmatter, repoPaths, sections, ticketRefs } from "./markdown.js";
import { matchExpression } from "./retrieval.js";
import { adrLifecycle } from "./sources/adr.js";
import { globPrefix, isGlobalGlob } from "./sources/rules.js";
import { diversify } from "./context-pack.js";
import type { KnowledgeNode } from "./model.js";

describe("markdown helpers", () => {
  it("parses the frontmatter subset used by rules and ADRs", () => {
    const text = `---\npaths:\n  - "packages/web/**/*"\n  - "scripts/**/*"\ndecision_status: accepted\ntickets: [5, 61]\n---\n# Title\n\nbody`;
    const fm = parseFrontmatter(text);
    expect(fm.data.paths).toEqual(["packages/web/**/*", "scripts/**/*"]);
    expect(fm.data.decision_status).toBe("accepted");
    expect(fm.data.tickets).toEqual(["5", "61"]);
    expect(fm.body.startsWith("# Title")).toBe(true);
    expect(fm.bodyLine).toBe(7);
  });

  it("splits sections, folds nested bullets and drops fenced code", () => {
    const text = [
      "# Doc",
      "",
      "## Rules",
      "",
      "- First rule that **matters**",
      "  continues here",
      "  - nested clause",
      "- Second `rule`",
      "",
      "```bash",
      "- not a bullet",
      "```",
      "",
      "A paragraph with 不得 in it.",
    ].join("\n");
    const secs = sections(text);
    expect(secs.map((section) => section.title)).toEqual(["", "Doc", "Rules"]);
    const rules = secs[2];
    expect(bullets(rules.lines).map((bullet) => bullet.text)).toEqual([
      "First rule that matters continues here nested clause",
      "Second rule",
    ]);
    expect(paragraphs(rules.lines).map((paragraph) => paragraph.text)).toEqual(["A paragraph with 不得 in it."]);
  });

  it("extracts repository paths, ticket and ADR references from prose", () => {
    const text = "见 `packages/agent-sessions-view/src/lib/file-link.ts` 与 doc/adr/0009-runner.md（工单 #243、#61，ticket 12）ADR 0009。";
    expect(repoPaths(text)).toEqual(["packages/agent-sessions-view/src/lib/file-link.ts", "doc/adr/0009-runner.md"]);
    expect(ticketRefs(text)).toEqual([243, 61, 12]);
    expect(adrRefs(text)).toEqual(["0009"]);
  });

  it("normalises statements for deduplication", () => {
    expect(statementKey("Menus open on click.")).toBe(statementKey("menus  open on CLICK"));
    expect(statementKey("手机端导航。")).toBe(statementKey("手机端 导航"));
  });
});

describe("rule globs", () => {
  it("derives prefixes, keeps exact files and recognises global globs", () => {
    expect(globPrefix("packages/dashboard-web/**/*")).toBe("packages/dashboard-web/");
    expect(globPrefix("packages/bot/src/bootstrap-v3.ts")).toBe("packages/bot/src/bootstrap-v3.ts");
    expect(globPrefix("packages/agent-*view*/**/*")).toBe("packages/");
    expect(globPrefix("**/*.ts")).toBeNull();
    expect(isGlobalGlob("**/*.{ts,tsx}")).toBe(true);
    expect(isGlobalGlob("packages/web/**/*")).toBe(false);
  });
});

describe("ADR lifecycle", () => {
  it("reads the dual-axis frontmatter when present", () => {
    const text = "---\ndecision_status: accepted\nrealization_status: planned\nsupersedes: [\"0002\"]\ntickets: [7]\n---\n# ADR 0003\n";
    expect(adrLifecycle(text)).toMatchObject({ decision_status: "accepted", realization_status: "planned", supersedes: ["0002"], tickets: [7], source: "frontmatter" });
  });

  it("interprets the legacy status bullet conservatively", () => {
    expect(adrLifecycle("# A\n\n- 状态：**已接受（架构决策）**，尚未实施（2026-08-07）\n")).toMatchObject({ decision_status: "accepted", realization_status: "planned", source: "legacy" });
    expect(adrLifecycle("# B\n\n- 状态：**已接受并实现**（2026-08-19）\n")).toMatchObject({ decision_status: "accepted", realization_status: "implemented" });
    expect(adrLifecycle("# C\n\n- 状态：**Proposed / 未接受**\n")).toMatchObject({ decision_status: "proposed" });
    expect(adrLifecycle("# D\n\nno status line\n")).toMatchObject({ decision_status: "proposed", realization_status: "not_applicable" });
  });
});

describe("retrieval primitives", () => {
  it("builds trigram windows for Chinese and keeps Latin identifiers", () => {
    const match = matchExpression("手机端从 chat 页面点导航 file-link.ts");
    expect(match).toContain('"手机端"');
    expect(match).toContain('"机端从"');
    expect(match).toContain('"chat"');
    expect(match).toContain('"file-link.ts"');
    expect(matchExpression("ab")).toBeNull();
  });

  it("round-robins principles across source documents", () => {
    const node = (id: string, source: string): KnowledgeNode => ({
      id,
      kind: "principle",
      statement: id,
      status: "active",
      authority: "path_rule",
      source_ref: `${source}#x`,
      source_sha: "s",
      method: "parsed",
      certainty: "exact",
    });
    const nodes = [node("a1", "a"), node("a2", "a"), node("a3", "a"), node("b1", "b"), node("c1", "c")];
    expect(diversify(nodes, 4, 2).map((item) => item.id)).toEqual(["a1", "b1", "c1", "a2"]);
  });
});
