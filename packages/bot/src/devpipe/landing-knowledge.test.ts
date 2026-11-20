import { describe, expect, it } from "vitest";
import {
  formatKnowledgeContext,
  knowledgeTestFiles,
  parseLandingKnowledge,
  unacknowledgedKnowledge,
} from "./landing-knowledge.js";
import type { KnowledgeSearchHit } from "../store/repositories/knowledge.js";

function hit(overrides: Partial<KnowledgeSearchHit> = {}): KnowledgeSearchHit {
  return {
    id: 1,
    record_key: "architecture:constraint:TRUST-001",
    kind: "constraint",
    status: "active",
    authority: "declared",
    title: "不可信 View 不得可达 Dashboard",
    body: "跨 origin 和依赖闭包必须分离",
    source_type: "architecture_constraint",
    source_ref: "architecture/atlas.json",
    source_sha: "a".repeat(40),
    ticket_id: null,
    confidence: 1,
    metadata: JSON.stringify({ evidence: [{ source: { path: "packages/bot/src/session-plus/browser.e2e.test.ts" } }] }),
    content_hash: "h",
    created_at: "t",
    updated_at: "t",
    rank: -1,
    ...overrides,
  };
}

const VALID = {
  summary: "保持浏览器信任边界",
  requirements: ["View 只能提议"],
  decisions: ["继续使用 MessagePort"],
  non_goals: [],
  risks: ["bundle 依赖可能倒灌"],
  verification: ["browser.e2e.test.ts passed"],
  context_keys: ["architecture:constraint:TRUST-001"],
  supersedes: [],
};

describe("landing knowledge contract", () => {
  it("parses a complete lifecycle record and rejects missing decisions", () => {
    expect(parseLandingKnowledge(VALID)).toEqual(VALID);
    expect(() => parseLandingKnowledge({ ...VALID, decisions: [] })).toThrow(/decisions/);
  });

  it("requires acknowledgement of active high-authority context", () => {
    expect(unacknowledgedKnowledge([hit()], parseLandingKnowledge(VALID))).toEqual([]);
    expect(unacknowledgedKnowledge([hit()], parseLandingKnowledge({ ...VALID, context_keys: [] })))
      .toEqual([expect.objectContaining({ record_key: "architecture:constraint:TRUST-001" })]);
  });

  it("projects provenance labels and extracts only declared test evidence", () => {
    expect(formatKnowledgeContext([hit()])).toContain("constraint/active/declared/confidence=1");
    expect(formatKnowledgeContext([hit()])).toContain("architecture/atlas.json");
    expect(knowledgeTestFiles([hit()])).toEqual(["packages/bot/src/session-plus/browser.e2e.test.ts"]);
    expect(knowledgeTestFiles([hit({ status: "superseded" })])).toEqual([]);
  });

  it("keeps historical patterns as context and never as gate evidence", () => {
    const historical = hit({
      record_key: "historical:pattern:file-open",
      kind: "risk",
      authority: "historical",
      source_type: "historical_pattern",
      metadata: JSON.stringify({
        tests: ["packages/agent-sessions-view/src/lib/file-link.test.ts", "rm -rf /"],
      }),
    });
    expect(knowledgeTestFiles([historical])).toEqual([]);
  });

  it("clips long records and skips only the item that does not fit, not the rest of the pack", () => {
    const long = hit({ record_key: "repo:package_contract:long", body: "x".repeat(20_000) });
    const short = hit({ record_key: "architecture:module:short", body: "短记录" });
    const pack = formatKnowledgeContext([long, short], 2_400);
    expect(pack).toContain("已截断");
    expect(pack).toContain("architecture:module:short");
    expect(pack).not.toContain("x".repeat(1_501));

    const tiny = formatKnowledgeContext([long, short], 300);
    expect(tiny).toContain("architecture:module:short");
    expect(tiny).toContain("超出上下文预算");
  });
});
