import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
const root = resolve(import.meta.dirname, "../../../..");
const inventory = JSON.parse(readFileSync(resolve(root, "architecture/managed-agent-consumers.json"), "utf8")) as {
  consumers: Array<{ id: string; source: string | null; entry: string; agent?: string }>;
};
describe("production managed agent consumer inventory", () => {
  it("accounts for every agent declaration on the current native and declared App backends", () => {
    const manifests = ["packages/bot/src/session-plus/app/app.yaml", ...readdirSync(resolve(root, "packages"))
      .filter(name => name.endsWith("-view")).map(name => `packages/${name}/app/app.yaml`)
      .filter(entry => existsSync(resolve(root, entry)))];
    for (const entry of manifests) {
      const manifest = yaml.load(readFileSync(resolve(root, entry), "utf8")) as { agents: Record<string, unknown> };
      expect(inventory.consumers.filter(row => row.entry === entry).map(row => row.agent).sort()).toEqual(Object.keys(manifest.agents ?? {}).sort());
    }
    expect(new Set(inventory.consumers.map(row => row.id)).size).toBe(inventory.consumers.length);
    for (const row of inventory.consumers) expect(existsSync(resolve(root, row.entry)), row.id).toBe(true);
  });
  it("registers recovery as shared infrastructure rather than Bot composition", () => {
    const atlas = JSON.parse(readFileSync(resolve(root, "architecture/atlas.json"), "utf8")) as {
      modules: Array<{ id: string; pathPrefixes: string[]; docs?: string[] }>;
    };
    const module = atlas.modules.find(row => row.id === "managed-execution");
    expect(module?.pathPrefixes).toContain("packages/bot/src/managed-execution/");
    expect(module?.docs).toContain("packages/bot/src/managed-execution/README.md");
  });
  it("keeps executable sources separate from an execution grant or externally observed process", () => {
    expect([...new Set(inventory.consumers.map(row => row.source).filter(Boolean))].sort()).toEqual(
      ["ticket", "session", "research", "mcp-session", "app-agent", "discussion", "knowledge-chat", "research-canvas"].sort());
    expect(inventory.consumers.find(row => row.id === "mcp-execution-scope")?.source).toBeNull();
  });
});
