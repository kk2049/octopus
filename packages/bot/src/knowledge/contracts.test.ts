import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { assembleSnapshot } from "./build.js";
import { GraphDb } from "./graph-db.js";
import type { KnowledgeNode, LandingInput } from "./model.js";
import {
  contractsSource,
  validateCapabilityContract,
  type ContractCodeIndexResolver,
  type ContractValidationContext,
} from "./sources/contracts.js";
import type { SourceContext } from "./sources/context.js";
import { deliveriesSource } from "./sources/deliveries.js";
import { cliReportsSource } from "./sources/cli-reports.js";
import { landingsSource } from "./sources/landings.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const AT = "2026-08-23T12:00:00.000Z";
const CONTRACT_FILE = "architecture/knowledge/contracts/test-parity.md";
const SYMBOL_PATH = "packages/runner/src/actions.ts";
const TEST_PATH = "packages/runner/src/actions.test.ts";

function validBlock(): Record<string, unknown> {
  return {
    dimensions: {
      providers: ["omp"],
      launch_modes: ["managed"],
      states: ["working"],
      actions: ["append"],
    },
    sources: [{ key: "ticket-source", type: "ticket_body", ref: "ticket:227" }],
    principles: [{
      key: "provider-parity",
      statement: "Applicable session actions have the same product semantics for every provider.",
      source_keys: ["ticket-source"],
      status: "active",
      effective_from: "2026-08-23",
      supersedes: [],
      reaffirms: [],
    }],
    obligations: [{
      key: "append-current-turn",
      statement: "Append MUST target the current managed turn through the provider-neutral operation.",
      strength: "must",
      principle_refs: ["provider-parity"],
      source_refs: ["ticket-source"],
      status: "active",
      effective_from: "2026-08-23",
      supersedes: [],
      reaffirms: [],
    }],
    scenarios: [{
      key: "managed-append",
      actor: "Sessions+ user",
      trigger: "The user appends to a working managed session.",
      preconditions: ["The managed attachment is current."],
      action: "Dispatch the append through the current attachment.",
      expected_outcome: "The current turn receives the message once.",
      failure_semantics: "A stale attachment rejects without replay or fallback.",
      source_refs: ["ticket-source"],
      status: "active",
      effective_from: "2026-08-23",
      supersedes: [],
      reaffirms: [],
    }],
    exceptions: [],
    desired: [{
      key: "omp-managed-append",
      scenario: "managed-append",
      provider: "omp",
      launch_mode: "managed",
      state: "working",
      action: "append",
      desired: "required",
      obligation_refs: ["append-current-turn"],
      expected_ux: "The append remains in the same visible session.",
      trust_semantics: "The current attachment is authoritative.",
      failure_semantics: "A stale attachment rejects before dispatch.",
      source_refs: ["ticket-source"],
    }],
    artifacts: [
      { key: "append-handler", kind: "symbol", repo: "octopus", path: SYMBOL_PATH, symbol: "Actions.append" },
      { key: "append-test", kind: "test", repo: "octopus", path: TEST_PATH, test_name: "appends to the current turn once" },
    ],
    realizations: [
      { target: "scenario:managed-append", artifact: "append-handler", role: "handler", source_refs: ["ticket-source"] },
      { target: "scenario:managed-append", artifact: "append-test", role: "test", source_refs: ["ticket-source"] },
    ],
  };
}
function scopedWaiverBlock(): Record<string, unknown> {
  const block = validBlock();
  block.exceptions = [{
    key: "temporary-gap",
    kind: "waiver",
    targets: ["obligation:append-current-turn", "constraint:temporary-rollout", "desired:omp-managed-append"],
    reason: "Temporary implementation gap under review.",
    owner: "session-platform",
    created_at: "2026-08-23",
    expires_at: "2026-12-31",
    source_refs: ["ticket-source"],
    status: "active",
    effective_from: "2026-08-23",
    supersedes: [],
    reaffirms: [],
  }];
  block.desired = [{
    ...(block.desired as Array<Record<string, unknown>>)[0],
    desired: "degraded",
    exception_ref: "temporary-gap",
  }];
  return block;
}


function contractMarkdown(block: Record<string, unknown> = validBlock()): string {
  return `---\nschema: octopus-capability-contract/v1\nid: test-parity\ntitle: Test parity\nstatus: active\ncapabilities: [sessions-plus.agent-lifecycle]\neffective_from: 2026-08-23\nsupersedes: []\nreaffirms: []\n---\n\n# Test parity\n\nHuman explanation is not a second truth.\n\n\`\`\`octopus-contract\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
}

function validationContext(): ContractValidationContext {
  return {
    sourceRef: CONTRACT_FILE,
    sourceSha: SHA,
    evaluationAsOf: "2026-08-23",
    capabilities: new Set(["sessions-plus.agent-lifecycle"]),
    existingPaths: new Set([CONTRACT_FILE, SYMBOL_PATH, TEST_PATH]),
  };
}

function sourceContext(files: Record<string, string>): SourceContext {
  const allPaths = [...new Set(["architecture/capabilities.json", ...Object.keys(files)])];
  return {
    repoDir: "/repo",
    sha: SHA,
    historyRef: "HEAD",
    observedAt: AT,
    evaluationAsOf: "2026-08-23",
    git: async (args) => {
      if (args[0] === "log") return SHA;
      if (args[0] === "diff") return "packages/a/a.ts\npackages/b/b.ts";
      return "";
    },
    atlas: {},
    modules: [
      { id: "module-a", label: "A", zone: "backend", pathPrefixes: ["packages/a/"] },
      { id: "module-b", label: "B", zone: "backend", pathPrefixes: ["packages/b/"] },
    ],
    list: async (patterns) => {
      if (!patterns.length) return allPaths;
      if (patterns.some((pattern) => pattern.includes("contracts"))) return allPaths.filter((file) => file.startsWith("architecture/knowledge/contracts/"));
      if (patterns.some((pattern) => pattern.includes("deliveries"))) return allPaths.filter((file) => file.startsWith("doc/deliveries/"));
      if (patterns.some((pattern) => pattern.includes("cli-reports"))) return allPaths.filter((file) => file.startsWith("doc/cli-reports/"));
      return [];
    },
    read: async (file) => {
      if (file === "architecture/capabilities.json") {
        return JSON.stringify({
          version: 1,
          capabilities: [{
            id: "sessions-plus.agent-lifecycle",
            kind: "product",
            label: "Agent lifecycle",
            description: "Lifecycle actions",
            aliases: ["agent lifecycle"],
            modules: [],
          }],
        });
      }
      const value = files[file];
      if (value === undefined) throw new Error(`missing fixture ${file}`);
      return value;
    },
    moduleForPath: (file) => file.startsWith("packages/a/") ? "module-a" : file.startsWith("packages/b/") ? "module-b" : "unmapped",
  };
}

function resolver(gitSha: string, resolve = true): ContractCodeIndexResolver {
  return {
    gitSha,
    manifestDigest: "manifest-digest",
    resolveArtifact: (selector) => resolve ? {
      kind: selector.kind,
      path: selector.path,
      qualifiedName: selector.qualifiedName,
      testName: selector.testName,
      line: 1,
    } : null,
  };
}

describe("capability contract validation and projection", () => {
  it("parses one strict block and preserves explicit local identity", () => {
    const document = validateCapabilityContract(contractMarkdown(), validationContext());
    expect(document.id).toBe("test-parity");
    expect(document.block.desired[0].key).toBe("omp-managed-append");
  });

  it("rejects duplicate blocks, unknown fields and unscoped degraded cells", () => {
    const duplicate = `${contractMarkdown()}\n\`\`\`octopus-contract\n{}\n\`\`\``;
    expect(() => validateCapabilityContract(duplicate, validationContext())).toThrow(/exactly one/);

    const unknown = validBlock();
    unknown.extra = true;
    expect(() => validateCapabilityContract(contractMarkdown(unknown), validationContext())).toThrow(/unknown field extra/);

    const unscoped = validBlock();
    unscoped.desired = [{ ...(unscoped.desired as Array<Record<string, unknown>>)[0], desired: "degraded" }];
    expect(() => validateCapabilityContract(contractMarkdown(unscoped), validationContext())).toThrow(/requires a scoped exception/);
  });

  it("rejects expired waivers and duplicate dimension tuples", () => {
    const expired = validBlock();
    expired.exceptions = [{
      key: "temporary-gap",
      kind: "waiver",
      targets: ["desired:omp-managed-append"],
      reason: "Temporary implementation gap under review.",
      owner: "session-platform",
      created_at: "2026-01-01",
      expires_at: "2026-08-22",
      source_refs: ["ticket-source"],
      status: "active",
      effective_from: "2026-01-01",
      supersedes: [],
      reaffirms: [],
    }];
    expired.desired = [{
      ...(expired.desired as Array<Record<string, unknown>>)[0],
      desired: "degraded",
      exception_ref: "temporary-gap",
    }];
    expect(() => validateCapabilityContract(contractMarkdown(expired), validationContext())).toThrow(/expired before evaluation_as_of/);

    const duplicate = validBlock();
    duplicate.desired = [
      ...(duplicate.desired as unknown[]),
      { ...(duplicate.desired as Array<Record<string, unknown>>)[0], key: "same-tuple" },
    ];
    expect(() => validateCapabilityContract(contractMarkdown(duplicate), validationContext())).toThrow(/duplicate provider\/launch_mode\/state\/action tuple/);
  });
  it("rejects an active exception whose obligation and constraint targets omit desired-cell scope", () => {
    const block = scopedWaiverBlock();
    (block.exceptions as Array<Record<string, unknown>>)[0].targets = [
      "obligation:append-current-turn",
      "constraint:temporary-rollout",
    ];
    expect(() => validateCapabilityContract(contractMarkdown(block), validationContext())).toThrow(
      /active exceptions must resolve to at least one expanded desired-conformance cell/,
    );
  });


  it("rejects every future-active lifecycle entity before its effective date", () => {
    const futureContract = contractMarkdown().replace(
      "effective_from: 2026-08-23",
      "effective_from: 2026-08-24",
    );
    expect(() => validateCapabilityContract(futureContract, validationContext())).toThrow(
      /frontmatter is active before effective_from 2026-08-24/,
    );

    const futurePrinciple = validBlock();
    (futurePrinciple.principles as Array<Record<string, unknown>>)[0].effective_from = "2026-08-24";
    const futureObligation = validBlock();
    (futureObligation.obligations as Array<Record<string, unknown>>)[0].effective_from = "2026-08-24";
    const futureScenario = validBlock();
    (futureScenario.scenarios as Array<Record<string, unknown>>)[0].effective_from = "2026-08-24";
    const futureException = validBlock();
    futureException.exceptions = [{
      key: "future-waiver",
      kind: "waiver",
      targets: ["constraint:future-rollout", "desired:omp-managed-append"],
      reason: "The rollout waiver starts tomorrow.",
      owner: "session-platform",
      created_at: "2026-08-23",
      expires_at: "2026-12-31",
      source_refs: ["ticket-source"],
      status: "active",
      effective_from: "2026-08-24",
      supersedes: [],
      reaffirms: [],
    }];
    futureException.desired = [{
      ...(futureException.desired as Array<Record<string, unknown>>)[0],
      desired: "degraded",
      exception_ref: "future-waiver",
    }];

    for (const [label, block] of [
      ["principles[0]", futurePrinciple],
      ["obligations[0]", futureObligation],
      ["scenarios[0]", futureScenario],
      ["exceptions[0]", futureException],
    ] as const) {
      expect(() => validateCapabilityContract(contractMarkdown(block), validationContext())).toThrow(
        new RegExp(`${label.replace("[", "\\[").replace("]", "\\]")} is active before effective_from 2026-08-24`),
      );
    }
  });

  it("accepts active lifecycle entities on their effective date", () => {
    const block = validBlock();
    block.exceptions = [{
      key: "effective-today",
      kind: "waiver",
      targets: ["constraint:boundary", "desired:omp-managed-append"],
      reason: "This waiver takes effect on the evaluation date.",
      owner: "session-platform",
      created_at: "2026-08-23",
      expires_at: "2026-12-31",
      source_refs: ["ticket-source"],
      status: "active",
      effective_from: "2026-08-23",
      supersedes: [],
      reaffirms: [],
    }];
    block.desired = [{
      ...(block.desired as Array<Record<string, unknown>>)[0],
      desired: "degraded",
      exception_ref: "effective-today",
    }];

    const document = validateCapabilityContract(contractMarkdown(block), validationContext());
    expect(document.status).toBe("active");
    expect(document.block.principles[0].status).toBe("active");
    expect(document.block.obligations[0].status).toBe("active");
    expect(document.block.scenarios[0].status).toBe("active");
    expect(document.block.exceptions[0].status).toBe("active");
  });

  it("projects every resolved waiver cell and its four dimensions onto the exception", async () => {
    const block = scopedWaiverBlock();
    const out = await contractsSource(sourceContext({ [CONTRACT_FILE]: contractMarkdown(block), [SYMBOL_PATH]: "", [TEST_PATH]: "" }));
    const exception = out.nodes.find((node) => node.id === "exception:test-parity/temporary-gap");
    expect(exception?.metadata).toMatchObject({
      scoped_cell_ids: ["desired_conformance:test-parity/omp-managed-append"],
      providers: ["omp"],
      launch_modes: ["managed"],
      states: ["working"],
      actions: ["append"],
    });
    expect(out.cells[0]).toMatchObject({
      provider: "omp",
      launch_mode: "managed",
      state: "working",
      action: "append",
      exception_id: exception?.id,
    });
  });

  it("emits unverified, stale and SHA-bound conformant observations", async () => {
    const ctx = sourceContext({ [CONTRACT_FILE]: contractMarkdown(), [SYMBOL_PATH]: "", [TEST_PATH]: "" });
    const missing = await contractsSource(ctx);
    expect(missing.cells.map((cell) => cell.id)).toEqual(["desired_conformance:test-parity/omp-managed-append"]);
    expect(missing.observations[0]).toMatchObject({ status: "unverified" });
    expect(missing.observations[0]).not.toHaveProperty("code_index_sha");
    expect(missing.observationArtifacts).toEqual([]);

    const stale = await contractsSource(ctx, { codeIndex: resolver(OTHER_SHA) });
    expect(stale.observations[0]).toMatchObject({ status: "stale", code_index_sha: OTHER_SHA });
    expect(stale.edges.some((edge) => edge.relation === "realized_by" || edge.relation === "verified_by")).toBe(false);

    const current = await contractsSource(ctx, { codeIndex: resolver(SHA) });
    expect(current.observations[0]).toMatchObject({ status: "conformant", baseline_sha: SHA, code_index_sha: SHA, verified_sha: SHA });
    expect(current.observationArtifacts.map((item) => item.role).sort()).toEqual(["handler", "test"]);
    expect(current.nodes.some((node) => node.id === "artifact:octopus/symbol/append-handler")).toBe(true);
    expect(current.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_id: "scenario:test-parity/managed-append", relation: "realized_by", to_id: "artifact:octopus/symbol/append-handler" }),
      expect.objectContaining({ from_id: "scenario:test-parity/managed-append", relation: "verified_by", to_id: "artifact:octopus/test/append-test" }),
    ]));
  });

  it("keeps stable IDs and semantic digest when set-like contract arrays reorder", async () => {
    const reordered = validBlock();
    for (const field of ["sources", "artifacts", "realizations"] as const) {
      reordered[field] = [...(reordered[field] as unknown[])].reverse();
    }
    const first = await contractsSource(sourceContext({ [CONTRACT_FILE]: contractMarkdown(), [SYMBOL_PATH]: "", [TEST_PATH]: "" }));
    const second = await contractsSource(sourceContext({ [CONTRACT_FILE]: contractMarkdown(reordered), [SYMBOL_PATH]: "", [TEST_PATH]: "" }));
    const capability: KnowledgeNode = {
      id: "capability:sessions-plus.agent-lifecycle",
      kind: "capability",
      statement: "Agent lifecycle",
      status: "active",
      authority: "declared",
      source_ref: "architecture/capabilities.json",
      source_sha: SHA,
      method: "declared",
      certainty: "exact",
    };
    const digest = (projection: typeof first) => assembleSnapshot(
      { ...projection, nodes: [capability, ...projection.nodes] },
      {
        sha: SHA,
        observedAt: AT,
        evaluationAsOf: "2026-08-23",
        existingPaths: new Set([SYMBOL_PATH, TEST_PATH]),
        inputsFingerprint: "fixture",
        cells: projection.cells,
        observations: projection.observations,
        observationArtifacts: projection.observationArtifacts,
      },
    );
    const firstSnapshot = digest(first);
    const secondSnapshot = digest(second);
    expect(secondSnapshot.nodes.map((node) => node.id)).toEqual(firstSnapshot.nodes.map((node) => node.id));
    expect(secondSnapshot.meta.projection_digest).toBe(firstSnapshot.meta.projection_digest);
  });
});

describe("precise source fanout", () => {
  it("keeps landing touches and implements without statement-to-all-files fanout", () => {
    const ctx = sourceContext({});
    const landing: LandingInput = {
      id: 7,
      ticket_id: 227,
      from_sha: OTHER_SHA,
      to_sha: SHA,
      landed_at: AT,
      source: "ticket",
      report_path: null,
      summary: "landed",
      changed_files: ["packages/a/a.ts", "packages/b/b.ts"],
      changed_modules: ["module-a", "module-b"],
      knowledge: {
        summary: "landed",
        requirements: ["Append targets only the exact current session."],
        decisions: [],
        non_goals: [],
        risks: [],
        verification: [],
        context_keys: [],
        supersedes: [],
      },
    };
    const out = landingsSource(ctx, {
      landings: [landing],
      tickets: [{ id: 227, title: "Parity", requester: "user", kind: "feature", dev_status: "landed", created_at: AT, landed_at: AT, commit_sha: SHA, parent_ticket_id: null }],
    });
    const statement = out.nodes.find((node) => node.kind === "requirement")!;
    expect(out.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_id: "landing:7", relation: "touches", to_id: "path:packages/a/a.ts" }),
      expect.objectContaining({ from_id: "landing:7", relation: "touches", to_id: "path:packages/b/b.ts" }),
      expect.objectContaining({ from_id: "landing:7", relation: "implements", to_id: statement.id }),
    ]));
    expect(out.edges.some((edge) => edge.from_id === statement.id && (edge.to_id.startsWith("path:") || edge.to_id.startsWith("module:")))).toBe(false);
  });

  it("keeps delivery document touches without negative-to-key-file fanout", async () => {
    const file = "doc/deliveries/2026-08-23-precise.md";
    const markdown = "# Precise delivery\n\n## 关键文件\n\n- `packages/a/a.ts`\n- `packages/b/b.ts`\n\n## 不做\n\n- This delivery deliberately does not widen runtime authority.\n";
    const out = await deliveriesSource(sourceContext({ [file]: markdown }));
    const statement = out.nodes.find((node) => node.kind === "non_goal")!;
    expect(out.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_id: `doc:${file}`, relation: "touches", to_id: "path:packages/a/a.ts" }),
      expect.objectContaining({ from_id: `doc:${file}`, relation: "touches", to_id: "path:packages/b/b.ts" }),
    ]));
    expect(out.edges.some((edge) => edge.from_id === statement.id && (edge.to_id.startsWith("path:") || edge.to_id.startsWith("module:")))).toBe(false);
  });

  it("keeps CLI landing touches without statement-to-range fanout", async () => {
    const file = "doc/cli-reports/2026-08-23-precise.json";
    const report = JSON.stringify({
      version: 2,
      base_sha: OTHER_SHA,
      title: "Precise CLI landing",
      summary: "Precise projection",
      requester: "user",
      requirements: ["Append targets only the exact current session."],
      decisions: [],
      non_goals: [],
      risks: [],
      verification: [],
      acceptance: [],
    });
    const out = await cliReportsSource(sourceContext({ [file]: report }));
    const statement = out.nodes.find((node) => node.kind === "requirement")!;
    const landing = out.nodes.find((node) => node.kind === "landing")!;
    expect(out.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_id: landing.id, relation: "touches", to_id: "path:packages/a/a.ts" }),
      expect.objectContaining({ from_id: landing.id, relation: "implements", to_id: statement.id }),
    ]));
    expect(out.edges.some((edge) => edge.from_id === statement.id && (edge.to_id.startsWith("path:") || edge.to_id.startsWith("module:")))).toBe(false);
  });
});

describe("graph schema lifecycle", () => {
  it("rejects a disposable schema-v1 graph so the owner rebuilds it", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-v1-"));
    const file = join(dir, "graph.db");
    const database = new Database(file);
    database.exec("CREATE TABLE build_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;");
    database.close();
    expect(GraphDb.openReadonly(file)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
