import { describe, expect, it } from "vitest";
import { parseResearchReference, readResearchLocation, researchLocationUrl } from "./navigation.js";
const base = "https://octopus.test/apps/research-v2/open?instance=shared-123";
describe("research node addresses", () => {
  it("preserves the platform instance while round-tripping graph identity and scope", () => {
    const address = researchLocationUrl(base, "project-a", { scope: "target-A", node: "evidence.1" });
    expect(new URL(address).searchParams.get("instance")).toBe("shared-123");
    expect(readResearchLocation(address)).toEqual({ scope: "target-A", node: "evidence.1" });
    expect(parseResearchReference(address, base, "project-a")).toEqual({ scope: "target-A", node: "evidence.1" });
    expect(readResearchLocation(researchLocationUrl(address, "project-a", { scope: "", node: "" }))).toEqual({ scope: "", node: "" });
  });
  it("never treats prose, foreign projects, instances, hosts or malformed node IDs as a paste", () => {
    const address = researchLocationUrl(base, "project-a", { scope: "A", node: "n" });
    for (const input of ["ordinary text", "open " + address, address.replace("project-a", "project-b"), address.replace("shared-123", "shared-456"), address.replace("octopus.test", "foreign.test"), address.replace("researchNode=n", "researchNode=..%2Ffile")]) expect(parseResearchReference(input, base, "project-a")).toBeNull();
  });
});
