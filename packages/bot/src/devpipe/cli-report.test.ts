import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { SPECIFICATIONS_SCHEMA } from "../knowledge/specifications.js";
import {
  cliAcceptanceSpec,
  isCliReportPath,
  parseCliDeliveryReport,
  renderCliDeliveryReport,
} from "./cli-report.js";

const path = "doc/cli-reports/2026-08-13-clickable-architecture.json";
const raw = JSON.stringify({
  version: 1,
  title: "架构详情上线",
  summary: "架构页默认展示可点击的前后端模组。",
  requester: "alice",
  verification: ["web tests: 通过"],
  acceptance: ["点击 View 节点可看到语义预览", "上线后工单状态可验收"],
});

describe("CLI delivery report", () => {
  it("keeps shell preflight and the editor schema compatible with structured v3 specifications", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../../doc/cli-reports/schema.json", import.meta.url), "utf8"));
    expect(schema.properties.specifications).toEqual(SPECIFICATIONS_SCHEMA);
    const shell = readFileSync(new URL("../../../../scripts/ops/land-head.sh", import.meta.url), "utf8");
    const validator = /jq -e --arg base "\$base" '\n([\s\S]+?)\n' <<<"\$report_json"/.exec(shell)?.[1];
    expect(validator).toBeTruthy();
    const base = "a".repeat(40);
    const report = {
      ...JSON.parse(raw), version: 3, base_sha: base,
      requirements: ["keep CLI and server report fields compatible"], decisions: ["validate evidence at the existing landing door"],
      non_goals: [], risks: [], supersedes: [],
      retrieval: { traces: [], context_keys: [], feedback: [{ code: "not_run" }] },
      specifications: [
        ["requirement", "keep CLI and server report fields compatible"],
        ["decision", "validate evidence at the existing landing door"],
      ].map(([kind, statement]) => ({
        kind, statement, strength: "agent_inferred",
        provenance: { author: { kind: "agent", name: "test", model: null, ref: "test:cli-preflight" }, basis: ["scripts/ops/land.sh"], events: [] },
        realized_by: ["scripts/ops/land.sh"], verified_by: ["packages/bot/src/devpipe/cli-report.test.ts"],
      })),
    };
    expect(parseCliDeliveryReport(JSON.stringify(report), path)).toMatchObject({ specifications: report.specifications });
    const check = (value: unknown) => spawnSync("jq", ["-e", "--arg", "base", base, validator!], { input: JSON.stringify(value), encoding: "utf8" });
    const accepted = check(report);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(check({ ...report, native_ticket_id: 7 }).status).toBe(0);
    expect(check({ ...report, native_ticket_id: -1 }).status).not.toBe(0);
    expect(check({ ...report, unauthorized_field: true }).status).not.toBe(0);
    expect(check({ ...report, specifications: [] }).status).not.toBe(0);
    // Specifications are optional; a report without them still passes both doors.
    const { specifications: _omitted, ...withoutSpecifications } = report;
    expect(check(withoutSpecifications).status).toBe(0);
    expect(parseCliDeliveryReport(JSON.stringify(withoutSpecifications), path)).not.toHaveProperty("specifications");
  });

  it("accepts the bounded v1 shape and renders the two distinct check lists", () => {
    const report = parseCliDeliveryReport(raw, path);
    expect(report).toMatchObject({ version: 1, requester: "alice", verification: ["web tests: 通过"] });
    expect(renderCliDeliveryReport({ path, report })).toContain("## 开发侧验证\n\n- web tests: 通过");
    expect(cliAcceptanceSpec(report)).toContain("## 验收标准\n- 点击 View 节点");
  });
  it("accepts v2 only with an exact base and explicit lifecycle knowledge", () => {
    const report = parseCliDeliveryReport(JSON.stringify({
      version: 2,
      base_sha: "a".repeat(40),
      title: "知识落地",
      summary: "CLI landing records decisions with its exact range.",
      requester: "alice",
      requirements: ["preserve the exact base"],
      decisions: ["use the checked-in report as crash recovery"],
      non_goals: [],
      risks: ["the base can move before landing"],
      supersedes: [],
      verification: ["focused tests passed"],
      acceptance: ["the landing appears in the knowledge ledger"],
    }), path);
    expect(report).toMatchObject({ version: 2, base_sha: "a".repeat(40), decisions: [expect.any(String)] });
    expect(() => parseCliDeliveryReport(JSON.stringify({
      version: 2,
      base_sha: "short",
      title: "x",
      summary: "y",
      requester: "alice",
      requirements: ["r"],
      decisions: ["d"],
      non_goals: [],
      risks: [],
      supersedes: [],
      verification: ["v"],
      acceptance: ["a"],
    }), path)).toThrow(/base_sha/);
  });

  it("accepts v3 exact receipt references and rejects invented cross-references", () => {
    const base = {
      version: 3,
      base_sha: "a".repeat(40),
      title: "retrieval-aware landing",
      summary: "The exact context use and receipt are reported.",
      requester: "alice",
      requirements: ["retain exact evidence"],
      decisions: ["land only the cited context keys"],
      non_goals: [],
      risks: [],
      supersedes: [],
      verification: ["focused checks passed"],
      acceptance: ["review shows the trace"],
    };
    const traceId = `kr_${"b".repeat(32)}`;
    expect(parseCliDeliveryReport(JSON.stringify({
      ...base,
      retrieval: {
        traces: [{ id: traceId, receipt_sha256: "c".repeat(64) }],
        context_keys: ["statement:menu"],
        feedback: [{ trace_id: traceId, code: "helpful" }],
      },
    }), path)).toMatchObject({ version: 3, retrieval: { context_keys: ["statement:menu"] } });

    expect(() => parseCliDeliveryReport(JSON.stringify({
      ...base,
      retrieval: {
        traces: [{ id: traceId, receipt_sha256: "c".repeat(64) }],
        context_keys: [],
        feedback: [{ trace_id: `kr_${"d".repeat(32)}`, code: "helpful" }],
      },
    }), path)).toThrow(/必须引用 retrieval\.traces/);
    expect(() => parseCliDeliveryReport(JSON.stringify({
      ...base,
      retrieval: { traces: [], context_keys: [], feedback: [] },
    }), path)).toThrow(/not_run/);
  });


  it("requires a dated immutable report path and refuses coercion/empty lists", () => {
    expect(isCliReportPath("doc/cli-reports/schema.json")).toBe(false);
    expect(isCliReportPath(path)).toBe(true);
    expect(() => parseCliDeliveryReport(raw, "report.json")).toThrow(/路径/);
    expect(() => parseCliDeliveryReport(JSON.stringify({
      version: 1,
      title: "x",
      summary: "y",
      requester: "alice",
      verification: "passed",
      acceptance: [],
    }), path)).toThrow(/verification/);
  });
});
