import { expect, it } from "vitest";
import { Store } from "../store.js";
import { createRetrievalTraceEnvelope, type RetrievalPlanAudit } from "../../knowledge/retrieval-trace.js";

it("counts retained ticket queries, delivery, distinct citations and feedback without hiding zero-query tickets", () => {
  const store = new Store(":memory:");
  const at = new Date().toISOString();
  try {
    store.saveUser({ username: "alice", uid: 1, home_dir: "/fixture", created_at: at });
    const ticket = (kind: "simple" | "cli") => store.devTickets.createDevTicket({ title: "query audit", body: "private prompt", requester: "alice", kind, app_id: null, model: "fixture", effort: "medium" });
    const active = ticket("simple"), empty = ticket("simple");
    ticket("cli");
    const plan: RetrievalPlanAudit = { classifications: [], indexes: [], candidates: [], slots: [], context_keys: [], unknown: [], budget: { limit_chars: 4000, used_chars: 0, dropped_records: 0 }, performance: { total_ms: 1 } };
    const start = (purpose: "startup" | "path_refinement" | "submit_check", state: "pending" | "delivered" | "error" = "delivered") => {
      const envelope = createRetrievalTraceEnvelope({ lane: "ticket", purpose, subject_ref: `ticket:${active.id}`, turn: 1, query: "private prompt", repo_sha: "a".repeat(40), graph_input_fingerprint: "b".repeat(64), started_at: at }, Buffer.alloc(32, 1));
      store.knowledgeRetrieval.beginTrace(envelope);
      if (state === "error") {
        store.knowledgeRetrieval.appendError(envelope.trace_id, "assemble", "pack_failed");
        store.knowledgeRetrieval.markDeliveredError(envelope.trace_id, "mcp_response", "pack_failed");
      } else {
        store.knowledgeRetrieval.appendAssembled(envelope.trace_id, plan);
        if (state === "delivered") store.knowledgeRetrieval.markDelivered(envelope.trace_id, "mcp_response");
      }
      return envelope.trace_id;
    };
    start("startup"); start("path_refinement"); start("path_refinement", "pending"); start("path_refinement", "error");
    const submit = start("submit_check");
    store.knowledgeRetrieval.recordReportedUse(submit, "ticket:first", ["record:a", "record:b"]);
    store.knowledgeRetrieval.recordReportedUse(submit, "ticket:second", ["record:a"]);
    store.knowledgeRetrieval.recordFeedback(submit, "helpful");
    store.knowledgeRetrieval.recordFeedback(submit, "vector_unavailable");
    const first = store.knowledgeRetrieval.listTickets({ limit: 1 });
    expect(first).toMatchObject({ has_more: true, next_before: empty.id, items: [{ ticket_id: empty.id, startup: 0, path_queries: 0, delivered_queries: 0, submit_checks: 0, cited_records: 0, feedback: 0, last_query_at: null }] });
    const second = store.knowledgeRetrieval.listTickets({ before: first.next_before, limit: 1 });
    expect(second).toMatchObject({ has_more: false, items: [{ ticket_id: active.id, startup: 1, path_queries: 3, delivered_queries: 1, submit_checks: 1, cited_records: 2, feedback: 2, last_query_at: at }] });
    expect(JSON.stringify(second)).not.toMatch(/private prompt|query_hash/);
    expect(store.knowledgeRetrieval.listForReview({ ticket_id: empty.id, outcome: "all" }).items).toEqual([]);
    expect(store.knowledgeRetrieval.listForReview({ ticket_id: active.id, outcome: "all" }).items).toHaveLength(5);
    expect(store.knowledgeRetrieval.listForReview({ ticket_id: active.id }).items).toHaveLength(2);
  } finally { store.close(); }
});
