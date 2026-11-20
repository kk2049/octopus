import { describe, expect, it } from "vitest";
import { nodeTypes, pluginFor } from "./plugins.js";

describe("research canvas ACC vocabulary", () => {
  it("offers a local workgroup node separately from an external Feishu group", () => {
    expect(nodeTypes.map((plugin) => plugin.type)).toContain("workgroup");
    expect(pluginFor("workgroup")).toMatchObject({ title: "研究工作群", window: "text" });
    expect(pluginFor("group")).toMatchObject({ title: "飞书群", window: "group" });
  });
});
