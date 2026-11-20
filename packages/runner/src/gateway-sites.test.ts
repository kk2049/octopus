import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAdditionalSites, resolveRunnerSites, siteOperationId } from "./gateway-sites.js";
import { readInstalledConfig, writeInstalledConfig, writeRunnerSiteToken } from "./install-config.js";
import { ManagedRecoveryJournal } from "./managed-recovery.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const primary = { runnerUrl: "wss://bot.example.com/octopus-runner/v1", token: "private-primary-token" };
const secondary = { id: "octo", dashboard_url: "https://203.0.113.21:444", runner_url: "wss://203.0.113.21:444/octopus-runner/v1", token_file: "/private/octo.token" };

describe("Runner multi-site policy", () => {
  it("preserves the legacy site's authority and supports pinned updates during a mirror", () => {
    expect(resolveRunnerSites(primary)).toEqual([{ id: "primary", ...primary, controlsMachine: true, providesUpdates: true }]);
    expect(resolveRunnerSites(primary, { additional_sites: [secondary], update_site: "none" }))
      .toMatchObject([{ id: "primary", controlsMachine: true, providesUpdates: false }, { id: "octo", controlsMachine: false, providesUpdates: false }]);
  });
  it("moves control/update authority without changing durable site ids, and supports reverse migration", () => {
    const policy = { additional_sites: [secondary], control_site: "octo", update_site: "octo", primary_enabled: false };
    expect(resolveRunnerSites(primary, policy)).toMatchObject([{ id: "octo", controlsMachine: true, providesUpdates: true }]);
    expect(resolveRunnerSites(primary, { ...policy, primary_enabled: true, control_site: "primary", update_site: "primary" }))
      .toMatchObject([{ id: "primary", controlsMachine: true, providesUpdates: true }, { id: "octo", controlsMachine: false, providesUpdates: false }]);
  });
  it("refuses duplicate destinations, missing authorities, unsafe transports and credential-bearing URLs", () => {
    expect(() => resolveRunnerSites(primary, { control_site: "missing" })).toThrow();
    expect(() => resolveRunnerSites(primary, { additional_sites: [secondary, secondary] })).toThrow();
    expect(() => resolveRunnerSites({ runnerUrl: secondary.runner_url }, { additional_sites: [secondary] })).toThrow();
    for (const changes of [{ id: "../x" }, { id: "primary" }, { runner_url: "ws://203.0.113.21/runner" }, { runner_url: "wss://wrong.example/runner" }, { runner_url: "wss://secret@203.0.113.21:444/runner" }, { token_file: "relative" }]) {
      expect(() => parseAdditionalSites([{ ...secondary, ...changes }])).toThrow();
    }
  });
  it("scopes launch deduplication by site while keeping primary journal ids replayable", () => {
    expect(siteOperationId(undefined, "same-id")).toBe("same-id");
    expect(siteOperationId("primary", "same-id")).toBe("same-id");
    expect(siteOperationId("octo", "same-id")).not.toBe(siteOperationId("other", "same-id"));
    expect(siteOperationId("octo", "same-id")).toBe(siteOperationId("octo", "same-id"));
  });
  it("persists private site tokens separately and preserves the policy across config rewrites", () => {
    const home = mkdtempSync(path.join(tmpdir(), "runner-sites-")); roots.push(home);
    const token = `rt_${"a".repeat(32)}`;
    const tokenFile = writeRunnerSiteToken(home, "octo", token);
    const config = { version: 1 as const, dashboard_url: "https://bot.example.com", runner_url: primary.runnerUrl, device: "test", scan_home: home, codex_home: path.join(home, ".codex"), installed_at: new Date().toISOString(), additional_sites: [{ ...secondary, token_file: tokenFile }], update_site: "none" };
    const files = writeInstalledConfig(config);
    expect(readInstalledConfig(home)).toEqual(config);
    expect(readFileSync(files.config, "utf8")).not.toContain(token);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });
  it("retains the originating gateway for recovery without persisting gateway credentials", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "runner-site-recovery-")); roots.push(home);
    const stateFile = path.join(home, "recovery.json");
    const journal = new ManagedRecoveryJournal({ stateFile }); await journal.load();
    const session = { logicalId: "session-1", currentProviderId: "session-1", lineage: ["session-1"] };
    await journal.prepare({ provider: "codex", session, cwd: home, remotePlacement: { gatewaySite: "octo", executionDevice: "executor", workspaceId: `ws_${"a".repeat(24)}` } });
    await journal.activate("codex", session, "turn-1");
    const restored = new ManagedRecoveryJournal({ stateFile }); await restored.load();
    expect(await restored.claimInterrupted()).toMatchObject([{ remotePlacement: { gatewaySite: "octo" } }]);
    expect(readFileSync(stateFile, "utf8")).not.toContain(primary.token);
  });
});
