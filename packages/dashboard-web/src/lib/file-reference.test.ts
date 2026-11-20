import { describe, expect, it } from "vitest";
import { fileReference } from "./file-reference.js";
const origin = "https://bot.example.org";
describe("ticket file references", () => {
  it.each([
    ["/home/ubuntu/lht/octopus/packages/dashboard-web/src/pages/knowledge/CapabilityView.tsx:48", "/home/ubuntu/lht/octopus/packages/dashboard-web/src/pages/knowledge/CapabilityView.tsx", 48],
    ["https://bot.example.org/home/ubuntu/lht/octopus/packages/dashboard-web/src/pages/knowledge/CapabilityView.tsx:48", "/home/ubuntu/lht/octopus/packages/dashboard-web/src/pages/knowledge/CapabilityView.tsx", 48],
    ["src/a.ts#L48", "src/a.ts", 48],
    ["src/a.ts:48:7", "src/a.ts", 48],
    ["./docs/a%20b.md", "./docs/a b.md", undefined],
  ])("recognizes %s", (raw, path, line) => { expect(fileReference(raw, origin)).toEqual({ path, ...(line ? { line } : {}) }); });
  it.each(["https://evil.example/src/a.ts", "https://bot.example.org.evil.test/src/a.ts", "javascript:alert(1)", "data:text/plain,/a.ts", "mailto:x@y.com", "#heading", "https://bot.example.org/src/a.ts?token=x"])("keeps non-file links out: %s", (raw) => { expect(fileReference(raw, origin)).toBeNull(); });
});
