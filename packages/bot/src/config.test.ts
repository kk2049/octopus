import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitlabCiToken, loadConfig } from "./config.js";

let dir: string;

function writeConfig(dashboardExtra: string, rootExtra = ""): string {
  const p = join(dir, "config.yaml");
  writeFileSync(
    p,
    `instance:\n`
      + `  name: config-test\n`
      + `  data_dir: ${dir}\n`
      + `dashboard:\n`
      + `  enabled: true\n`
      + `  port: 0\n`
      + `  host: 127.0.0.1\n`
      + `  auth_token: test-admin-token\n`
      + dashboardExtra
      + rootExtra,
    "utf8",
  );
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "octopus-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig dashboard.runner_public_url validation", () => {
  it("accepts wss:// URLs unchanged", () => {
    const cfg = loadConfig(
      writeConfig(`  runner_public_url: "wss://octopus.example.com/runner"\n`),
    );
    expect(cfg.dashboard?.runner_public_url).toBe("wss://octopus.example.com/runner");
  });

  it.each([
    ["127.0.0.1", "ws://127.0.0.1:9910/runner"],
    ["localhost", "ws://localhost:9910/runner"],
    ["[::1]", "ws://[::1]:9910/runner"],
  ])("accepts loopback ws:// on %s", (_label, url) => {
    const cfg = loadConfig(
      writeConfig(`  runner_public_url: "${url}"\n`),
    );
    expect(cfg.dashboard?.runner_public_url).toBe(url);
  });

  it("rejects ws:// on a non-loopback host", () => {
    expect(() =>
      loadConfig(writeConfig(`  runner_public_url: "ws://octopus.example.com/runner"\n`)),
    ).toThrow(/runner_public_url rejects ws:\/\/ on non-loopback host/);
  });

  it("rejects http:// scheme", () => {
    expect(() =>
      loadConfig(writeConfig(`  runner_public_url: "http://octopus.example.com/runner"\n`)),
    ).toThrow(/runner_public_url must use wss:\/\//);
  });

  it("rejects https:// scheme", () => {
    expect(() =>
      loadConfig(writeConfig(`  runner_public_url: "https://octopus.example.com/runner"\n`)),
    ).toThrow(/runner_public_url must use wss:\/\//);
  });

  it("rejects a malformed URL", () => {
    expect(() =>
      loadConfig(writeConfig(`  runner_public_url: "not a url"\n`)),
    ).toThrow(/runner_public_url is not a valid URL/);
  });

  it("leaves the field undefined when omitted (existing behavior preserved)", () => {
    const cfg = loadConfig(writeConfig(""));
    expect(cfg.dashboard?.runner_public_url).toBeUndefined();
  });
});

describe("loadConfig selfhosting.ci_machine authority", () => {
  it("requires and preserves an explicit owner/device pair", () => {
    const config = loadConfig(writeConfig("", [
      "selfhosting:",
      "  enabled: true",
      "  ci_machine:",
      "    owner: alice",
      "    device: lht-val15-ci",
      "    checkout_dir: /work/octopus",
      "",
    ].join("\n")));
    expect(config.selfhosting?.ci_machine).toMatchObject({ owner: "alice", device: "lht-val15-ci" });
  });

  it("rejects a CI device label without its trusted owner", () => {
    expect(() => loadConfig(writeConfig("", [
      "selfhosting:",
      "  enabled: true",
      "  ci_machine:",
      "    device: lht-val15-ci",
      "    checkout_dir: /work/octopus",
      "",
    ].join("\n")))).toThrow(/ci_machine\.owner/);
  });
});

describe("independent knowledge Runner placement", () => {
  const configFor = (runner: Record<string, unknown>) => writeConfig("", [
    "selfhosting:", "  enabled: true", "  knowledge_index:", "    enabled: true",
    `    runner: ${JSON.stringify(runner)}`, "",
  ].join("\n"));

  it("accepts an explicit knowledge target with no CI machine", () => {
    const runner = { owner: "alice", device: "knowledge-compute", checkout_dir: "/work/octopus" };
    const config = loadConfig(configFor(runner));
    expect(config.selfhosting?.knowledge_index?.runner).toEqual(runner);
    expect(config.selfhosting?.ci_machine).toBeUndefined();
  });

  it.each([
    { device: "compute", checkout_dir: "/work/octopus" },
    { owner: "alice", checkout_dir: "/work/octopus" },
    { owner: "alice", device: "compute", checkout_dir: "relative/path" },
    { owner: "alice", device: "compute", checkout_dir: "/work/../private" },
    { owner: "alice", device: "compute", checkout_dir: "/" },
    { owner: " alice", device: "compute", checkout_dir: "/work/octopus" },
    { owner: "alice", device: "compute\n", checkout_dir: "/work/octopus" },
  ])("rejects malformed explicit targets without inheriting another device: %j", (runner) => {
    expect(() => loadConfig(configFor(runner))).toThrow(/knowledge_index\.runner/);
  });
});

it("registered CI workspace ids enable the strict gate and reject paths or disabling the gate", () => {
  const base = "selfhosting:\n  ci_machine:\n    owner: alice\n    device: dedicated\n    checkout_dir: /work/octopus\n";
  const id = `ws_${"1".repeat(24)}`;
  expect(loadConfig(writeConfig("", base + `    workspace_id: ${id}\n`)).selfhosting?.ci_machine?.workspace_id).toBe(id);
  expect(() => loadConfig(writeConfig("", base + "    workspace_id: /work\n"))).toThrow("registered workspace id");
  expect(() => loadConfig(writeConfig("", base + `    workspace_id: ${id}\n    gate: false\n`))).toThrow("cannot be disabled");
  expect(() => loadConfig(writeConfig("", base + "    remote_required: true\n    gate: false\n"))).toThrow("cannot be disabled");
});

describe("gitlabCiToken", () => {
  const base = { api_url: "https://gitlab.example/api/v4", project: "group/repo", repair_requester: "lht" };

  it("prefers the inline token", () => {
    expect(gitlabCiToken({ ...base, token: "inline", token_file: join(dir, "missing") })).toBe("inline");
  });

  it("reads token_file when no inline token is configured", () => {
    const file = join(dir, "gitlab-token");
    writeFileSync(file, "from-file\n", { mode: 0o600 });
    expect(gitlabCiToken({ ...base, token_file: file })).toBe("from-file");
  });

  it("refuses a configuration without any token", () => {
    expect(() => gitlabCiToken(base)).toThrow(/token or token_file/);
  });
});

describe("loadConfig unknown top-level keys", () => {
  it("warns about a misspelled block but still loads and keeps it", () => {
    const warnings: string[] = [];
    const config = loadConfig(writeConfig("", "selfhostng:\n  enabled: true\nrunner:\n  enabled: true\n"), (message) => warnings.push(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("selfhostng");
    expect(warnings[0]).not.toContain("runner");
    expect((config as unknown as Record<string, unknown>).selfhostng).toEqual({ enabled: true });
  });

  it("stays quiet for keys of retired features that old configs still carry", () => {
    const warnings: string[] = [];
    loadConfig(writeConfig("", "plugins: {}\nskills:\n  global_dirs: []\ngroup_mode: personal\nsecurity:\n  allow_legacy_remote_mcp: false\nfleet:\n  enabled: false\n"), (message) => warnings.push(message));
    expect(warnings).toEqual([]);
  });

  it("stays quiet for the shipped example's keys", () => {
    const warnings: string[] = [];
    loadConfig(fileURLToPath(new URL("../../../config.yaml.example", import.meta.url)), (message) => warnings.push(message));
    expect(warnings).toEqual([]);
  });
});

describe("ticket workspace defaults are configuration", () => {
  const runnerTickets = (marks: [boolean, boolean]) => [
    "selfhosting:",
    "  enabled: true",
    "  runner_tickets:",
    "    targets:",
    "      alice:",
    "        device: source-host",
    "        workspace_id: ws_aaaaaaaaaaaaaaaaaaaaaaaa",
    "        workspaces:",
    "          - device: build-host",
    "            workspace_id: ws_bbbbbbbbbbbbbbbbbbbbbbbb",
    `            default: ${marks[0]}`,
    "          - device: source-host",
    "            workspace_id: ws_aaaaaaaaaaaaaaaaaaaaaaaa",
    `            default: ${marks[1]}`,
    "",
  ].join("\n");

  it("keeps one explicit default", () => {
    const config = loadConfig(writeConfig("", runnerTickets([true, false])));
    expect(config.selfhosting?.runner_tickets?.targets.alice?.workspaces?.[0]).toMatchObject({ device: "build-host", default: true });
  });

  it("refuses two defaults for one target", () => {
    expect(() => loadConfig(writeConfig("", runnerTickets([true, true])))).toThrow(/more than one default workspace/);
  });
});
