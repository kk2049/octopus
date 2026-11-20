/** Schema 4 is the explicit shared-agent role contract. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSessionPlusManifest } from "./manifest.js";

const dirs: string[] = [];

function appDirWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "manifest4-"));
  dirs.push(dir);
  writeFileSync(join(dir, "app.yaml"), yaml);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SHARED_AGENT = `
id: research_board
schema: 4
state: { scope: shared }
roles:
  lead: { max: 1 }
  researcher: { max: 4 }
  viewer: { max: 32, observer: true }
actions:
  ask:
    binding: agent
    agent: scout
    human_only: true
    roles: [lead]
    params:
      prompt: { type: string, required: true, max: 2000 }
  publish:
    binding: runtime
    handler: publish
    agent_only: true
    roles: [researcher]
    params:
      text: { type: string, required: true, max: 2000 }
agents:
  scout:
    adapter: openai-loop
    prompt: Research carefully.
    role: researcher
view:
  page: pages/main.yaml
`;

describe("app.yaml schema 4 shared agents", () => {
  it("binds every shared agent to one declared role and permits an agent action", () => {
    const manifest = loadSessionPlusManifest(appDirWith(SHARED_AGENT), { appId: "research_board" });
    expect(manifest).toMatchObject({ schema: 4, stateScope: "shared" });
    expect(manifest.agents.scout).toMatchObject({ name: "scout", role: "researcher" });
    expect(manifest.actions.ask).toMatchObject({ binding: "agent", agent: "scout", humanOnly: true });
  });

  it("refuses absent or unknown shared roles instead of inheriting a human seat", () => {
    expect(() => loadSessionPlusManifest(
      appDirWith(SHARED_AGENT.replace("    role: researcher\n", "")),
      { appId: "research_board" },
    )).toThrow(/must name a declared role/);
    expect(() => loadSessionPlusManifest(
      appDirWith(SHARED_AGENT.replace("role: researcher", "role: administrator")),
      { appId: "research_board" },
    )).toThrow(/must name a declared role/);
  });

  it("keeps schema 3 dormant and rejects the schema-4 field there", () => {
    expect(() => loadSessionPlusManifest(
      appDirWith(SHARED_AGENT.replace("schema: 4", "schema: 3")),
      { appId: "research_board" },
    )).toThrow(/unknown key\(s\): role/);
  });

  it("does not give account-scoped agents a meaningless shared role", () => {
    const account = SHARED_AGENT
      .replace("state: { scope: shared }", "state: { scope: account }")
      .replace(/roles:\n(?: {2}.*\n){3}/, "")
      .replace("    roles: [lead]\n", "")
      .replace("    roles: [researcher]\n", "");
    expect(() => loadSessionPlusManifest(appDirWith(account), { appId: "research_board" }))
      .toThrow(/must not declare a role/);
  });
});
