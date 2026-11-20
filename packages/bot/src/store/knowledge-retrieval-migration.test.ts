import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRetrievalTraceEnvelope,
  traceEvent,
  type RetrievalPlanAudit,
  type RetrievalTraceReceiptV1,
} from "../knowledge/retrieval-trace.js";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

const AT = new Date().toISOString();
const REPO_SHA = "a".repeat(40);
const GRAPH_SHA = "b".repeat(64);
const HMAC_KEY = Buffer.alloc(32, 5);
const DAY_MS = 24 * 60 * 60 * 1_000;

function missPlan(): RetrievalPlanAudit {
  return {
    classifications: [{
      dimension: "capability",
      value: "web.navigation",
      certainty: "inferred",
      score: 0.8,
      reason_codes: ["lexical"],
    }],
    indexes: [],
    candidates: [{
      record_id: "statement:menu",
      kind: "statement",
      source_ref: "knowledge/current/menu.md:12",
      source_sha: REPO_SHA,
      fused_rank: 1,
      fused_score: 0.5,
      signals: [],
      rerank: [],
      dropped: "slot_full",
    }],
    slots: [],
    context_keys: [],
    unknown: [{ code: "missing_slot", slot: "tests_evidence" }],
    budget: { limit_chars: 4_000, used_chars: 0, dropped_records: 1 },
    performance: { total_ms: 4 },
  };
}

function seedErrorTrace(store: Store, subjectRef: RetrievalTraceReceiptV1["envelope"]["subject_ref"], startedAt = AT): string {
  const envelope = createRetrievalTraceEnvelope({
    lane: "ticket",
    purpose: "startup",
    subject_ref: subjectRef,
    query: `query for ${subjectRef}`,
    repo_sha: REPO_SHA,
    graph_input_fingerprint: GRAPH_SHA,
    started_at: startedAt,
  }, HMAC_KEY);
  store.knowledgeRetrieval.beginTrace(envelope);
  store.knowledgeRetrieval.appendError(envelope.trace_id, "vector", "provider_unavailable");
  return envelope.trace_id;
}

describe("migration v56 (bounded retrieval evidence)", () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it("requires delivered path context for the same ticket and turn, not a startup pack or pending call", () => {
    const store = new Store(":memory:");
    try {
      const start = (purpose: "startup" | "path_refinement", turn: number) => {
        const envelope = createRetrievalTraceEnvelope({ lane: "ticket", purpose, subject_ref: "ticket:522", turn,
          query: "knowledge paths", repo_sha: REPO_SHA, graph_input_fingerprint: GRAPH_SHA, started_at: AT }, HMAC_KEY);
        store.knowledgeRetrieval.beginTrace(envelope);
        store.knowledgeRetrieval.appendAssembled(envelope.trace_id, { ...missPlan(), classifications: [{ dimension: "path", value: "packages/bot/src/knowledge", certainty: "exact", score: 1, reason_codes: ["explicit_path"] }], unknown: [] });
        return envelope.trace_id;
      };
      store.knowledgeRetrieval.markDelivered(start("startup", 2), "ticket_prompt");
      store.knowledgeRetrieval.markDelivered(start("path_refinement", 1), "mcp_response");
      const pending = start("path_refinement", 2);
      expect(store.knowledgeRetrieval.hasDeliveredPathContext("ticket:522", 2)).toBe(false);
      store.knowledgeRetrieval.markDelivered(pending, "mcp_response");
      expect(store.knowledgeRetrieval.hasDeliveredPathContext("ticket:522", 2)).toBe(true);
      expect(store.knowledgeRetrieval.hasDeliveredPathContext("ticket:522", 2, ["packages/bot/src/knowledge/build.ts"])).toBe(true);
      expect(store.knowledgeRetrieval.hasDeliveredPathContext("ticket:522", 2, ["packages/bot/src/knowledge-other/build.ts"])).toBe(false);
      expect(store.knowledgeRetrieval.hasDeliveredPathContext("ticket:522", 2, [], new Date(Date.parse(AT) + 1).toISOString())).toBe(false);
      expect(store.knowledgeRetrieval.hasDeliveredPathContext("ticket:523", 2)).toBe(false);
      expect(store.knowledgeRetrieval.hasDeliveredPathContext("ticket:522", 3)).toBe(false);
    } finally { store.close(); }
  });

  it("does not count an error delivered to an agent as successful path retrieval", () => {
    const store = new Store(":memory:");
    try {
      const envelope = createRetrievalTraceEnvelope({ lane: "ticket", purpose: "path_refinement", subject_ref: "ticket:522", turn: 2,
        query: "knowledge paths", repo_sha: REPO_SHA, graph_input_fingerprint: GRAPH_SHA, started_at: AT }, HMAC_KEY);
      store.knowledgeRetrieval.beginTrace(envelope);
      store.knowledgeRetrieval.appendError(envelope.trace_id, "assemble", "pack_failed");
      store.knowledgeRetrieval.appendEvent(traceEvent(envelope.trace_id, "delivery:mcp_response", { event: "delivered_error", payload: { stage: "delivery", code: "pack_failed" } }));
      expect(store.knowledgeRetrieval.hasDeliveredPathContext("ticket:522", 2)).toBe(false);
    } finally { store.close(); }
  });

  it("upgrades v55 without disturbing durable resource waiters", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-retrieval-v55-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 55);
    oldDb.prepare(`
      INSERT INTO resource_waiters (scope, resource, detail, count, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("ticket:7", "val15", "offline", 2, AT, AT);
    oldDb.close();

    const store = new Store(dbPath);
    store.close();

    const upgraded = new Database(dbPath, { readonly: true });
    expect(upgraded.prepare("SELECT 1 AS present FROM schema_version WHERE version = 56").get()).toEqual({ present: 1 });
    expect(upgraded.prepare("SELECT scope, resource, count FROM resource_waiters").get()).toEqual({ scope: "ticket:7", resource: "val15", count: 2 });
    const tableNames = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'knowledge_retrieval_%' ORDER BY name").all() as Array<{ name: string }>;
    expect(tableNames.map((row) => row.name)).toEqual(["knowledge_retrieval_events", "knowledge_retrieval_traces"]);
    upgraded.close();
  });

  it("imports a receipt idempotently, preserves compact miss evidence, and expires it at 90 days", () => {
    const store = new Store(":memory:");
    const envelope = createRetrievalTraceEnvelope({
      lane: "cli",
      purpose: "path_refinement",
      subject_ref: "cli-scope:octopus",
      query: "private menu request",
      repo_sha: REPO_SHA,
      graph_input_fingerprint: GRAPH_SHA,
      started_at: AT,
    }, HMAC_KEY);
    const plan = missPlan();
    const receipt: RetrievalTraceReceiptV1 = {
      schema_version: 1,
      envelope,
      events: [
        traceEvent(envelope.trace_id, "started", { event: "started", payload: {} }, AT),
        traceEvent(envelope.trace_id, "result", { event: "miss", payload: plan }, AT),
        traceEvent(envelope.trace_id, "delivery:cli_stdout", {
          event: "delivered_error",
          payload: { stage: "delivery", code: "missing_slot" },
        }, AT),
      ],
    };
    const digest = createHash("sha256").update(`${JSON.stringify(receipt)}\n`, "utf8").digest("hex");

    const binding = {
      landing_ref: `cli:ticket-7@${"c".repeat(40)}`,
      repo_sha: REPO_SHA,
      context_keys: ["statement:manual"],
    };
    expect(store.knowledgeRetrieval.getTrace(envelope.trace_id)).toBeNull();
    expect(store.knowledgeRetrieval.importCliReceiptsForLanding(
      [{ receipt, receipt_sha256: digest }],
      binding,
    )).toEqual([{ state: "imported", trace_id: envelope.trace_id }]);
    expect(store.knowledgeRetrieval.importCliReceiptsForLanding(
      [{ receipt, receipt_sha256: digest }],
      binding,
    )).toEqual([{ state: "already_imported", trace_id: envelope.trace_id }]);
    store.knowledgeRetrieval.recordFeedback(envelope.trace_id, "missing_slot", "tests_evidence", "statement:test");

    const detailed = store.knowledgeRetrieval.getTrace(envelope.trace_id)!;
    expect(detailed.outcome).toBe("miss");
    expect(JSON.stringify(detailed)).not.toMatch(/private menu request|query_hash|transcript|stack/);
    expect((detailed.events.find((event) => event.event === "miss")?.payload as RetrievalPlanAudit).candidates).toHaveLength(1);
    expect(detailed.events.filter((event) => event.event === "reported_use")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          landing_ref: binding.landing_ref,
          repo_sha: REPO_SHA,
          receipt_bindings: [{ trace_id: envelope.trace_id, receipt_sha256: digest }],
        }),
      }),
    ]);

    const compacted = store.knowledgeRetrieval.prune(new Date(Date.parse(AT) + 32 * DAY_MS).toISOString());
    expect(compacted.details).toBe(1);
    const compact = store.knowledgeRetrieval.getTrace(envelope.trace_id)!;
    expect(compact.outcome).toBe("miss");
    expect((compact.events.find((event) => event.event === "miss")?.payload as RetrievalPlanAudit)).toMatchObject({
      candidates: [],
      unknown: [{ code: "missing_slot", slot: "tests_evidence" }],
    });

    expect(store.knowledgeRetrieval.prune(new Date(Date.parse(AT) + 91 * DAY_MS).toISOString()).traces).toBe(1);
    expect(store.knowledgeRetrieval.getTrace(envelope.trace_id)).toBeNull();
    store.close();
  });

  it("rejects non-CLI, wrong-input, cross-subject, and second-landing receipt credit", () => {
    const store = new Store(":memory:");
    const makeReceipt = (
      lane: "cli" | "ticket",
      subjectRef: `cli-scope:${string}` | `ticket:${number}`,
      repoSha = REPO_SHA,
    ) => {
      const envelope = createRetrievalTraceEnvelope({
        lane,
        purpose: "path_refinement",
        subject_ref: subjectRef,
        query: `private ${subjectRef}`,
        repo_sha: repoSha,
        graph_input_fingerprint: GRAPH_SHA,
        started_at: AT,
      }, HMAC_KEY);
      const receipt: RetrievalTraceReceiptV1 = {
        schema_version: 1,
        envelope,
        events: [
          traceEvent(envelope.trace_id, "started", { event: "started", payload: {} }, AT),
          traceEvent(envelope.trace_id, "result", { event: "miss", payload: missPlan() }, AT),
          traceEvent(envelope.trace_id, "delivery:cli_stdout", {
            event: "delivered_error",
            payload: { stage: "delivery", code: "missing_slot" },
          }, AT),
        ],
      };
      return {
        receipt,
        receipt_sha256: createHash("sha256").update(`${JSON.stringify(receipt)}\n`, "utf8").digest("hex"),
      };
    };
    const ticketReceipt = makeReceipt("ticket", "ticket:7");
    const cliReceipt = makeReceipt("cli", "cli-scope:octopus");
    const otherSubject = makeReceipt("cli", "cli-scope:other");
    const firstLanding = {
      landing_ref: `cli:ticket-8@${"c".repeat(40)}`,
      repo_sha: REPO_SHA,
      context_keys: ["statement:manual"],
    };

    expect(() => store.knowledgeRetrieval.importCliReceiptsForLanding([ticketReceipt], firstLanding)).toThrow(/CLI lane/);
    expect(() => store.knowledgeRetrieval.importCliReceiptsForLanding(
      [cliReceipt],
      { ...firstLanding, repo_sha: "d".repeat(40) },
    )).toThrow(/repo sha/);
    expect(() => store.knowledgeRetrieval.importCliReceiptsForLanding(
      [cliReceipt, otherSubject],
      firstLanding,
    )).toThrow(/one subject/);

    expect(store.knowledgeRetrieval.importCliReceiptsForLanding([cliReceipt], firstLanding))
      .toEqual([{ state: "imported", trace_id: cliReceipt.receipt.envelope.trace_id }]);
    expect(store.knowledgeRetrieval.importCliReceiptsForLanding([cliReceipt], firstLanding))
      .toEqual([{ state: "already_imported", trace_id: cliReceipt.receipt.envelope.trace_id }]);
    expect(() => store.knowledgeRetrieval.importCliReceiptsForLanding(
      [cliReceipt],
      { ...firstLanding, landing_ref: `cli:ticket-9@${"e".repeat(40)}` },
    )).toThrow(/another landing/);

    const detail = store.knowledgeRetrieval.getTrace(cliReceipt.receipt.envelope.trace_id)!;
    expect(detail.events.filter((event) => event.event === "reported_use")).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain("private cli-scope");
    store.close();
  });
});

describe("retrieval review projection", () => {
  it("pages equal-timestamp traces by the opaque timestamp and trace-id cursor without gaps", () => {
    const store = new Store(":memory:");
    const seeded = [
      seedErrorTrace(store, "ticket:101"),
      seedErrorTrace(store, "ticket:102"),
      seedErrorTrace(store, "ticket:103"),
    ];
    const expected = store.knowledgeRetrieval.listForReview({ limit: 10 }).items.map((item) => item.trace_id);

    const first = store.knowledgeRetrieval.listForReview({ limit: 1 });
    expect(first).toMatchObject({ limit: 1, has_more: true });
    expect(first.next_before).toBeTruthy();
    const second = store.knowledgeRetrieval.listForReview({ limit: 1, before: first.next_before });
    expect(second).toMatchObject({ limit: 1, has_more: true });
    expect(second.next_before).toBeTruthy();
    const third = store.knowledgeRetrieval.listForReview({ limit: 1, before: second.next_before });
    expect(third).toMatchObject({ limit: 1, has_more: false });
    expect(third.next_before).toBeUndefined();

    const paged = [...first.items, ...second.items, ...third.items].map((item) => item.trace_id);
    expect(paged).toEqual(expected);
    expect(new Set(paged).size).toBe(seeded.length);
    expect(() => store.knowledgeRetrieval.listForReview({ before: AT })).toThrow(/cursor/);
    store.close();
  });

  it("keeps canonical lifecycle evidence on every bounded page of later review events", () => {
    const store = new Store(":memory:");
    const envelope = createRetrievalTraceEnvelope({
      lane: "cli",
      purpose: "submit_check",
      subject_ref: "cli-scope:pagination",
      query: "content that must remain hashed",
      repo_sha: REPO_SHA,
      graph_input_fingerprint: GRAPH_SHA,
      started_at: AT,
    }, HMAC_KEY);
    store.knowledgeRetrieval.beginTrace(envelope);
    store.knowledgeRetrieval.appendAssembled(envelope.trace_id, missPlan());
    store.knowledgeRetrieval.markDelivered(envelope.trace_id, "cli_stdout");
    for (let index = 0; index < 15; index += 1) {
      store.knowledgeRetrieval.recordReportedUse(envelope.trace_id, `landing:${index}`, [`statement:manual-${index}`]);
      store.knowledgeRetrieval.recordFeedback(envelope.trace_id, "helpful", undefined, `statement:expected-${index}`);
    }

    const seenReviewEvents = new Set<string>();
    let before: string | undefined;
    let finished = false;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const detail = store.knowledgeRetrieval.getTrace(envelope.trace_id, {
        ...(before ? { before } : {}),
        limit: 7,
      })!;
      const lifecycle = detail.events.filter((event) => event.event !== "feedback" && event.event !== "reported_use");
      const reviewEvents = detail.events.filter((event) => event.event === "feedback" || event.event === "reported_use");
      expect(lifecycle.map((event) => event.event)).toEqual(["started", "assembled", "delivered"]);
      expect(reviewEvents.length).toBeLessThanOrEqual(7);
      expect(detail.events_total).toBe(33);
      for (const event of reviewEvents) {
        expect(seenReviewEvents.has(event.event_key)).toBe(false);
        seenReviewEvents.add(event.event_key);
      }
      if (!detail.events_has_more) {
        expect(detail.events_next_before).toBeUndefined();
        finished = true;
        break;
      }
      expect(detail.events_next_before).toBeTruthy();
      before = detail.events_next_before;
    }
    expect(finished).toBe(true);
    expect(seenReviewEvents.size).toBe(30);
    const wire = JSON.stringify(store.knowledgeRetrieval.getTrace(envelope.trace_id, { limit: 25 }));
    expect(wire).not.toMatch(/content that must remain hashed|query_hash|transcript|stack|\"body\"/);
    store.close();
  });
});
