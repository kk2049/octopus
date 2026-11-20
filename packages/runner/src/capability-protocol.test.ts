import { describe, expect, it } from "vitest";
import { publicCapabilityAdvertisement, publicCapabilityTool, CAPABILITY_LIMITS } from "./capability-protocol.js";
const provider = { id: "demo", title: "Demo", version: "1", revision: "a".repeat(32), status: "ready",
  command: "/private/bin", env: { SECRET: "hidden" }, tools: [{ name: "tool", inputSchema: { type: "object" } }] };
describe("public capability catalogue boundary", () => {
  it("reconstructs public fields and omits private launch configuration", () => {
    const value = publicCapabilityAdvertisement({ protocol: "runner-capabilities/v1", providers: [provider] });
    expect(value?.providers[0]?.tools[0]).toMatchObject({ name: "tool", description: "" });
    expect(JSON.stringify(value)).not.toMatch(/private|SECRET|hidden/);
  });
  it("refuses duplicate identities, inactive callable tools and unknown statuses", () => {
    for (const providers of [[provider, provider], [{ ...provider, status: "disabled" }], [{ ...provider, status: "maybe" }]]) {
      expect(publicCapabilityAdvertisement({ protocol: "runner-capabilities/v1", providers })).toBeUndefined();
    }
  });
  it("accepts nested local schemas and refuses remote references and UTF-8 oversize", () => {
    expect(publicCapabilityTool({ name: "nested", inputSchema: { type: "object", properties: { nested: { $ref: "#/$defs/item" } }, $defs: { item: { type: "object" } } } }).name).toBe("nested");
    expect(() => publicCapabilityTool({ name: "remote", inputSchema: { type: "object", $ref: "https://example.invalid/schema" } })).toThrow();
    expect(() => publicCapabilityTool({ name: "large", inputSchema: { type: "object", description: "界".repeat(CAPABILITY_LIMITS.schemaBytes / 2) } })).toThrow();
  });
});
