import { describe, expect, it } from "vitest";
import { knowledgeIndexRunnerTarget } from "./placement.js";

describe("trusted knowledge provider placement", () => {
  const ci = { owner: "alice", device: "ci", checkout_dir: "/work/octopus" };
  const knowledge = { owner: "bob", device: "knowledge", checkout_dir: "/work/source" };
  it("inherits the existing CI target when no separate binding was configured", () => {
    expect(knowledgeIndexRunnerTarget({ ci_machine: ci })).toEqual(ci);
    expect(knowledgeIndexRunnerTarget({})).toBeNull();
  });
  it("supports a separate owner/device with or without CI and snapshots placement", () => {
    const config = { ci_machine: ci, knowledge_index: { runner: { ...knowledge } } };
    const target = knowledgeIndexRunnerTarget(config);
    config.knowledge_index.runner.device = "replacement";
    expect(target).toEqual(knowledge);
    expect(knowledgeIndexRunnerTarget({ knowledge_index: { runner: knowledge } })).toEqual(knowledge);
  });
  it("explicitly disables both independent and inherited targets", () => {
    expect(knowledgeIndexRunnerTarget({ ci_machine: ci, knowledge_index: { enabled: false } })).toBeNull();
    expect(knowledgeIndexRunnerTarget({ ci_machine: ci, knowledge_index: { enabled: false, runner: knowledge } })).toBeNull();
  });
});
