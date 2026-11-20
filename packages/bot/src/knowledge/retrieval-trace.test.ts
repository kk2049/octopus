import { describe, expect, it } from "vitest";
import {
  RetrievalTraceCollector,
  createRetrievalTraceEnvelope,
  hashRetrievalQuery,
  traceEvent,
  validateRetrievalPlan,
  validateRetrievalTraceEvent,
  type RetrievalPlanAudit,
} from "./retrieval-trace.js";

const HMAC_KEY = Buffer.alloc(32, 7);
const REPO_SHA = "a".repeat(40);
const GRAPH_SHA = "b".repeat(64);
const AT = "2026-08-23T00:00:00.000Z";

function emptyPlan(): RetrievalPlanAudit {
  return {
    classifications: [],
    indexes: [],
    candidates: [],
    slots: [],
    context_keys: [],
    unknown: [],
    budget: { limit_chars: 4_000, used_chars: 0, dropped_records: 0 },
    performance: { total_ms: 1 },
  };
}

function planWithSource(source_ref: string): RetrievalPlanAudit {
  return {
    ...emptyPlan(),
    candidates: [{
      record_id: "statement:source",
      kind: "statement",
      source_ref,
      source_sha: REPO_SHA,
      fused_rank: 1,
      fused_score: 1,
      signals: [],
      rerank: [],
    }],
  };
}

describe("retrieval trace contract", () => {
  it("normalizes and HMACs the query without retaining its text", () => {
    const query = "  私密工单\n正文  ";
    const envelope = createRetrievalTraceEnvelope({
      lane: "ticket",
      purpose: "startup",
      subject_ref: "ticket:42",
      turn: 3,
      query,
      repo_sha: REPO_SHA,
      graph_input_fingerprint: GRAPH_SHA,
      started_at: AT,
    }, HMAC_KEY);

    expect(envelope.query_hash).toBe(hashRetrievalQuery("私密工单 正文", HMAC_KEY));
    expect(envelope.query_chars).toBe(7);
    expect(JSON.stringify(envelope)).not.toContain("私密工单");

    const collector = new RetrievalTraceCollector(envelope);
    collector.addClassification({
      dimension: "capability",
      value: "web.navigation",
      certainty: "exact",
      score: 1,
      reason_codes: ["explicit_typed"],
    });
    collector.setBudget({ limit_chars: 4_000, used_chars: 0, dropped_records: 0 });
    collector.setPerformance({ total_ms: 2 });
    expect(collector.assemble().outcome.event).toBe("assembled");
  });

  it("fails closed on non-allowlisted or content-bearing payload fields", () => {
    const envelope = createRetrievalTraceEnvelope({
      lane: "cli",
      purpose: "path_refinement",
      subject_ref: "cli-scope:repo",
      query: "menu",
      repo_sha: REPO_SHA,
      graph_input_fingerprint: GRAPH_SHA,
      started_at: AT,
    }, HMAC_KEY);
    const plan = emptyPlan();

    expect(() => validateRetrievalTraceEvent({
      ...traceEvent(envelope.trace_id, "result", { event: "assembled", payload: plan }, AT),
      payload: { ...plan, summary: "private ticket body" },
    } as never)).toThrow(/unknown fields/);
    expect(() => validateRetrievalTraceEvent({
      ...traceEvent(envelope.trace_id, "feedback:helpful:none:none", { event: "feedback", payload: { code: "helpful" } }, AT),
      payload: { code: "helpful", text: "raw transcript" },
    } as never)).toThrow(/forbidden|unknown fields/);
    expect(() => validateRetrievalTraceEvent({
      ...traceEvent(envelope.trace_id, "result", { event: "assembled", payload: plan }, AT),
      event_key: "result-custom",
    })).toThrow(/canonical event key/);
    expect(() => validateRetrievalTraceEvent({
      ...traceEvent(envelope.trace_id, "delivery:cli_stdout", { event: "delivered", payload: { channel: "cli_stdout" } }, AT),
      event_key: "delivery:mcp_response",
    })).toThrow(/canonical event key/);
  });

  it("accepts only canonical graph and code source coordinates", () => {
    const valid = [
      "packages/bot/src/knowledge/retrieval.ts:990",
      ".claude/rules/frontend.md#state:12",
      "doc/deliveries/menu.md#没改什么:20",
      "bot-ctl",
      REPO_SHA,
      "ticket:6#message:30",
      "ticket:#1",
      "ticket:288/landing:9#non_goals",
      "ticket:227/message:849#decision",
      "ticket:6:landing:9",
      "landing:1",
      "atlas:module:dashboard",
      "knowledge:source:menu",
      `knowledge-source:ks_${"a".repeat(32)}#confirmation:${"b".repeat(32)}`,
      "knowledge/source:3",
      "runtime tickets #5, #6",
      "runtime-ticket:5",
    ];
    for (const sourceRef of valid) {
      expect(validateRetrievalPlan(planWithSource(sourceRef)).candidates[0]?.source_ref).toBe(sourceRef);
    }
  });

  it("rejects prose, private paths, controls and secret-shaped source coordinates", () => {
    const invalid = [
      "../../home/alice/private.md",
      "a".repeat(39),
      "A".repeat(40),
      "packages/.env",
      "ordinary prose copied from a ticket",
      "/home/alice/private.md",
      "transcript:session-1",
      "packages/bot/src/\nprivate.ts",
      "api_key=sk-proj-abcdefghijklmnop",
      "sk-proj-abcdefghijklmnop",
      "https://internal.example/knowledge",
    ];
    for (const sourceRef of invalid) {
      expect(() => validateRetrievalPlan(planWithSource(sourceRef)), sourceRef).toThrow(/source_ref/);
    }
  });

  it("enforces bounded exact audit rows", () => {
    const plan = emptyPlan();
    plan.candidates = Array.from({ length: 33 }, (_, index) => ({
      record_id: `record:${index}`,
      kind: "statement",
      source_ref: `knowledge/source:${index}`,
      source_sha: REPO_SHA,
      fused_rank: index + 1,
      fused_score: 1 / (index + 1),
      signals: [],
      rerank: [],
    }));
    expect(() => validateRetrievalPlan(plan)).toThrow(/too many candidates/);

    expect(() => validateRetrievalPlan({
      ...emptyPlan(),
      unknown: [{ code: "made_up_code" }],
    } as never)).toThrow(/unknown code/);
  });
});

it("accepts all 27 bounded context lines and still rejects unbounded slot telemetry",()=>{
  const plan=emptyPlan();
  plan.slots=Array.from({length:27},(_,index)=>({slot:"actions_symbols",ordinal:index+1,record_id:`path:file-${index}`,candidate_rank:index+1,final_score:1,chars:20,reason_codes:["exact"]}));
  expect(validateRetrievalPlan(plan).slots).toHaveLength(27);
  plan.slots.push(...plan.slots.slice(0,6));
  expect(()=>validateRetrievalPlan(plan)).toThrow(/too many slot/);
});
