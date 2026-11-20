import { describe, expect, it } from "vitest";
import { codexModelsForDevice, modelChoices } from "./cli.js";

const models = [{value:"local-model",label:"Local"}];
describe("local Codex choices", () => {
  it("prefers discovery, preserves a selected missing model, and falls back on absence/empty", () => {
    expect(modelChoices("codex", "old-choice", models).map(row => row.value)).toEqual(["", "local-model", "old-choice"]);
    for (const missing of [undefined, []]) expect(modelChoices("codex", "", missing).map(row => row.value)).toContain("gpt-6-astra");
    expect(modelChoices("claude", "", models).map(row => row.value)).not.toContain("local-model");
  });
  it("uses the selected runtime/account, retaining automatic routing and unknown-account fallback", () => {
    const device = {codexAccounts:[{id:"a",label:"codexa",models},{id:"b",label:"codexb",models:[{value:"second",label:"Second"}]}]};
    expect(codexModelsForDevice(device, {id:"a"})).toEqual(models);
    expect(codexModelsForDevice(device, {label:"b"})?.[0]?.value).toBe("second");
    expect(codexModelsForDevice(device)?.length).toBe(2);
    expect(codexModelsForDevice(device, {label:"missing"})).toBeUndefined();
    expect(codexModelsForDevice(undefined)).toBeUndefined();
  });
});
