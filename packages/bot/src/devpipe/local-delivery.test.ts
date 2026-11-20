import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createRetrievalTraceEnvelope, traceEvent, type RetrievalPlanAudit } from "../knowledge/retrieval-trace.js";
import { localDelivery } from "./local-delivery.js";
let repo: string, base: string, parent: string, receiptFile: string;
const reportPath = "doc/cli-reports/2026-10-08-local-test.json";
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "local-delivery-"));
  git("init", "-b", "dev/test"); git("config", "user.name", "Test"); git("config", "user.email", "test@localhost");
  mkdirSync(path.join(repo, "architecture")); writeFileSync(path.join(repo, "architecture/atlas.json"), JSON.stringify({ modules: [], constraints: [] }));
  writeFileSync(path.join(repo, "architecture/capabilities.json"), JSON.stringify({ version: 1, capabilities: [] }));
  writeFileSync(path.join(repo, "AGENTS.md"), "# Test rules\n");
  writeFileSync(path.join(repo, "README.md"), "base"); git("add", "."); git("commit", "-m", "base"); base = git("rev-parse", "HEAD");
  writeFileSync(path.join(repo, "feature.ts"), "implementation"); writeFileSync(path.join(repo, "feature.test.ts"), "focused verification");
  git("add", "."); git("commit", "-m", "feature"); parent = git("rev-parse", "HEAD");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));
function candidate(receiptSha = parent, query = "feature.ts", patch: Record<string, unknown> = {}) {
  const envelope = createRetrievalTraceEnvelope({ lane: "cli", purpose: "path_refinement", subject_ref: "cli-scope:fixture",
    query, repo_sha: receiptSha, graph_input_fingerprint: "b".repeat(64), started_at: new Date().toISOString() }, Buffer.alloc(32, 7));
  const plan: RetrievalPlanAudit = { classifications: [{ dimension: "path", value: query, certainty: "exact", score: 1, reason_codes: ["explicit_path"] }],
    indexes: [], candidates: [], slots: [], context_keys: [], unknown: [], budget: { limit_chars: 4000, used_chars: 0, dropped_records: 0 }, performance: { total_ms: 1 } };
  const receipt = { schema_version: 1, envelope, events: [traceEvent(envelope.trace_id, "started", { event: "started", payload: {} }),
    traceEvent(envelope.trace_id, "result", { event: "assembled", payload: plan }),
    traceEvent(envelope.trace_id, "delivery:cli_stdout", { event: "delivered", payload: { channel: "cli_stdout" } })] };
  const bytes = `${JSON.stringify(receipt)}\n`;
  receiptFile = path.join(repo, ".git/octopus/knowledge-retrieval", `${envelope.trace_id}.json`);
  mkdirSync(path.dirname(receiptFile), { recursive: true }); writeFileSync(receiptFile, bytes, { mode: 0o600 });
  const report = { version: 3, title: "Feature", summary: "Local checked delivery", requester: "alice", base_sha: base,
    requirements: ["Keep local checks"], decisions: ["Validate the exact commit"], non_goals: [], risks: [], supersedes: [], verification: ["focused tests"], acceptance: ["works"],
    retrieval: { traces: [{ id: envelope.trace_id, receipt_sha256: createHash("sha256").update(bytes).digest("hex") }], context_keys: [], feedback: [{ trace_id: envelope.trace_id, code: "helpful" }] },
    specifications: [["requirement", "Keep local checks"], ["decision", "Validate the exact commit"]].map(([kind, statement]) => ({ kind, statement,
      strength: "agent_inferred", provenance: { author: { kind: "agent", name: "test", model: null, ref: "test:local" }, basis: ["test:local"], events: [] },
      realized_by: ["feature.ts"], verified_by: ["feature.test.ts"] })), ...patch };
  for (const [key, value] of Object.entries(report)) if (value === undefined) delete (report as Record<string, unknown>)[key];
  mkdirSync(path.join(repo, "doc/cli-reports"), { recursive: true }); writeFileSync(path.join(repo, reportPath), JSON.stringify(report));
  git("add", reportPath); git("commit", "-m", "delivery report"); return git("rev-parse", "HEAD");
}
const notRun = { traces: [], context_keys: [], feedback: [{ code: "not_run" }] };
it("admits exact committed delivery evidence without the application", async () => {
  const head = candidate(); expect(await localDelivery(repo, base, head)).toMatchObject({ path: reportPath, requiredTests: ["feature.test.ts"] });
});
it("admits a report without specifications or retrieval, and never refuses for stale, partial or missing receipts", async () => {
  expect(await localDelivery(repo, base, candidate(parent, "feature.ts", { specifications: undefined, retrieval: notRun })))
    .toMatchObject({ path: reportPath, requiredTests: [] });
  for (const receipt of [base, parent]) {
    git("reset", "--hard", parent);
    const query = receipt === base ? "feature.ts" : "other.ts"; // stale implementation, then uncovered code
    expect(await localDelivery(repo, base, candidate(receipt, query))).toMatchObject({ path: reportPath });
  }
  const head = candidate(); chmodSync(receiptFile, 0o644); writeFileSync(receiptFile, "tampered");
  expect(await localDelivery(repo, base, head)).toMatchObject({ path: reportPath });
  rmSync(receiptFile);
  expect(await localDelivery(repo, base, head)).toMatchObject({ path: reportPath });
});
it("still validates specifications that are present", async () => {
  const one = (patch: Record<string, unknown>) => [{ kind: "requirement", statement: "Keep local checks", strength: "agent_inferred",
    provenance: { author: { kind: "agent", name: "test", model: null, ref: "test:local" }, basis: ["test:local"], events: [] },
    realized_by: ["feature.ts"], verified_by: ["feature.test.ts"], ...patch }];
  // Covering only some requirements/decisions is fine.
  expect(await localDelivery(repo, base, candidate(parent, "feature.ts", { specifications: one({}) }))).toMatchObject({ requiredTests: ["feature.test.ts"] });
  git("reset", "--hard", parent);
  await expect(localDelivery(repo, base, candidate(parent, "feature.ts", { specifications: one({ realized_by: ["missing.ts"] }) }))).rejects.toThrow(/普通文件/);
  git("reset", "--hard", parent);
  await expect(localDelivery(repo, base, candidate(parent, "feature.ts", { specifications: [] }))).rejects.toThrow(/specifications/);
});
it("refuses a report written before the current integration base", async () => {
  await expect(localDelivery(repo, base, candidate(parent, "feature.ts", { base_sha: parent }))).rejects.toThrow(/current integration base/);
});
it("refuses code added after the report", async () => {
  candidate(); writeFileSync(path.join(repo, "feature.ts"), "changed again"); git("commit", "-am", "late change");
  await expect(localDelivery(repo, base, git("rev-parse", "HEAD"))).rejects.toThrow(/final commit/);
});
