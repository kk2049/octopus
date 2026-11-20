import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildAccSeedPlan, type AccSeedManifest } from "./acc-seed.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "acc-seed-"));
const fixturePath = join(fixtureRoot, "INITIAL-TASK.md");
writeFileSync(fixturePath, "ACC seed fixture\n");
const options = { allowedRoots: [fixtureRoot] };
const manifest: AccSeedManifest = {
  version: 1,
  project: "ACC recycle",
  instance: "research-v2-acc",
  sources: [{ id: "intent", path: fixturePath, display: "paper-review/INITIAL-TASK.md", purpose: "intent" }],
  nodes: [{ key: "wg", type: "workgroup", title: "论文工作群", summary: "A/B/C", phase: "present", sourceIds: ["intent"], meta: { role: "paper", read_only: true } }],
  edges: [],
};

describe("ACC canvas seed", () => {
  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  it("creates source receipts, metadata-only node boundaries, and source edges", () => {
    const plan = buildAccSeedPlan(manifest, options);
    expect(plan.receipts[0]).toMatchObject({ id: "intent", metadataOnly: false });
    expect(plan.nodes.map((node) => node.key)).toEqual(["source-intent", "wg"]);
    expect(plan.edges).toEqual([{ source: "source-intent", target: "wg", label: "来源" }]);
    expect(plan.nodes[1]?.data.data.meta).toMatchObject({ source_ids: "intent", read_only: true });
  });

  it("uses the agent contract's instructions field", () => {
    const plan = buildAccSeedPlan({
      ...manifest,
      nodes: [{ key: "agent", type: "agent", title: "审查 Agent", summary: "只读历史会话", phase: "past", sourceIds: ["intent"] }],
    }, options);
    expect(plan.nodes[1]?.data.data).toMatchObject({ instructions: "只读历史会话" });
    expect(plan.nodes[1]?.data.data).not.toHaveProperty("text");
  });

  it("rejects unknown source and node references before any remote action", () => {
    expect(() => buildAccSeedPlan({ ...manifest, nodes: [{ ...manifest.nodes[0]!, sourceIds: ["missing"] }] }, options)).toThrow("unknown source");
    expect(() => buildAccSeedPlan({ ...manifest, edges: [["wg", "missing", "关联"]] }, options)).toThrow("unknown node");
  });
  it("rejects duplicate keys, self edges and duplicate edges before planning", () => {
    expect(() => buildAccSeedPlan({ ...manifest, sources: [manifest.sources[0]!, manifest.sources[0]!] }, options)).toThrow("duplicate");
    expect(() => buildAccSeedPlan({ ...manifest, nodes: [manifest.nodes[0]!, manifest.nodes[0]!] }, options)).toThrow("duplicate");
    expect(() => buildAccSeedPlan({ ...manifest, edges: [["wg", "wg", "来源"]] }, options)).toThrow("self edge");
    expect(() => buildAccSeedPlan({ ...manifest, nodes: [manifest.nodes[0]!, { key: "wg2", type: "note", title: "第二", summary: "", phase: "present" }], edges: [["wg", "wg2", "来源"], ["wg", "wg2", "来源"]] }, options)).toThrow("duplicate edge");
  });
});
