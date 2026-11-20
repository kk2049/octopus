import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildClaudeTurn,
  buildCodexTurn,
  claudeTranscriptDir,
  codexMcpOverrides,
  codexMcpServerOverrides,
  decideSession,
  findCodexRollout,
} from "./cli.js";
import { mintShimToken, resolveShimToken, revokeShimToken } from "./shim-registry.js";

describe("buildClaudeTurn", () => {
  it("fresh sessions pre-mint --session-id; resumes use --resume; devpipe parity flags present", () => {
    const fresh = buildClaudeTurn({ prompt: "你好", sessionId: "id-1", resume: false, mcpConfigPath: "/tmp/m.json" });
    expect(fresh.bin).toBe("claude");
    expect(fresh.args).toEqual([
      "-p",
      "你好",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--disallowed-tools",
      "Skill",
      "--disable-slash-commands",
      "--session-id",
      "id-1",
      "--mcp-config",
      "/tmp/m.json",
      "--strict-mcp-config",
    ]);
    const resumed = buildClaudeTurn({ prompt: "继续", sessionId: "id-1", resume: true, model: "claude-opus-5", effort: "high" });
    expect(resumed.args).toContain("--resume");
    expect(resumed.args).not.toContain("--session-id");
    expect(resumed.args.join(" ")).toContain("--model claude-opus-5");
    expect(resumed.args.join(" ")).toContain("--effort high");
  });
});

describe("buildCodexTurn", () => {
  it("first turn has no resume; later turns resume by id; effort rides -c", () => {
    const mcpArgs = ["-c", "x=1"];
    const fresh = buildCodexTurn({ prompt: "hi", mcpArgs });
    expect(fresh.args.slice(0, 2)).toEqual(["exec", "hi"]);
    expect(fresh.args).toContain("--skip-git-repo-check");
    const resumed = buildCodexTurn({ prompt: "again", sessionId: "sid-9", effort: "high", mcpArgs });
    expect(resumed.args.slice(0, 4)).toEqual(["exec", "resume", "sid-9", "again"]);
    expect(resumed.args).toContain(`model_reasoning_effort="high"`);
  });

  it("can request JSONL before a new or resumed turn", () => {
    const fresh = buildCodexTurn({ prompt: "p", mcpArgs: [], json: true });
    const resumed = buildCodexTurn({ prompt: "p", sessionId: "sid-1", mcpArgs: [], json: true });
    expect(fresh.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(resumed.args.slice(0, 4)).toEqual(["exec", "--json", "resume", "sid-1"]);
  });

  it("keeps the privileged-host decision explicit", () => {
    expect(buildCodexTurn({ prompt: "p", mcpArgs: [] }).args)
      .not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(buildCodexTurn({ prompt: "p", mcpArgs: [], dangerouslyBypassPermissions: true }).args)
      .toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("lets a trusted Host exclude ambient config explicitly", () => {
    expect(buildCodexTurn({ prompt: "p", mcpArgs: [] }).args).not.toContain("--ignore-user-config");
    expect(buildCodexTurn({ prompt: "p", mcpArgs: [], ignoreUserConfig: true }).args)
      .toContain("--ignore-user-config");
  });
});

describe("codexMcpOverrides", () => {
  it("emits three -c TOML overrides with the shim wiring", () => {
    const args = codexMcpOverrides({ shimPath: "/x/shim.ts", url: "http://127.0.0.1:1", token: "t", toolsFile: "/x/t.json" });
    expect(args.filter((a) => a === "-c")).toHaveLength(3);
    const joined = args.join("\n");
    expect(joined).toContain(`mcp_servers.v3.command="npx"`);
    expect(joined).toContain(`mcp_servers.v3.args=["tsx","/x/shim.ts"]`);
    expect(joined).toContain(`V3_SHIM_TOOLS_FILE = "/x/t.json"`);
  });

  it("adapts an ordinary trusted MCP server without Engine-specific env names", () => {
    const args = codexMcpServerOverrides("devpipe", {
      command: "node",
      args: ["/x/mcp-server.js"],
      env: { DEVPIPE_API: "http://127.0.0.1:9820", DEVPIPE_TOKEN: 'a"b' },
    });
    const joined = args.join("\n");
    expect(joined).toContain('mcp_servers.devpipe.command="node"');
    expect(joined).toContain('mcp_servers.devpipe.args=["/x/mcp-server.js"]');
    expect(joined).toContain('DEVPIPE_TOKEN = "a\\"b"');
  });

  it("refuses names that could escape the TOML key or inline environment table", () => {
    expect(() => codexMcpServerOverrides("devpipe.bad", { command: "node" })).toThrow(/server name/);
    expect(() =>
      codexMcpServerOverrides("devpipe", { command: "node", env: { "BAD-NAME": "x" } }),
    ).toThrow(/environment name/);
  });
});

describe("decideSession / claudeTranscriptDir", () => {
  it("reuses a session only for the same adapter kind", () => {
    expect(decideSession(null, "codex").fresh).toBe(true);
    expect(decideSession({ kind: "claude-code", sessionId: "s" }, "codex").fresh).toBe(true);
    expect(decideSession({ kind: "codex", sessionId: "s" }, "codex")).toEqual({ fresh: false, sessionId: "s" });
  });
  it("encodes cwd the way Claude Code does", () => {
    expect(claudeTranscriptDir("/a/b c")).toBe(path.join(os.homedir(), ".claude", "projects", "-a-b-c"));
  });
});

describe("findCodexRollout", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sessions-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds the newest rollout written after the turn started, extracting the uuid", () => {
    const day = path.join(root, "2026", "07", "27");
    fs.mkdirSync(day, { recursive: true });
    const oldFile = path.join(day, "rollout-2026-07-27T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    fs.writeFileSync(oldFile, "{}\n");
    fs.utimesSync(oldFile, 1_000_000, 1_000_000);
    const newFile = path.join(day, "rollout-2026-07-27T18-00-00-11111111-2222-3333-4444-555555555555.jsonl");
    fs.writeFileSync(newFile, "{}\n");

    const found = findCodexRollout(Date.now() - 60_000, root);
    expect(found?.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(found?.file).toBe(newFile);
    expect(findCodexRollout(Date.now() + 60_000, root)).toBeNull();
  });
});

describe("shim registry", () => {
  it("mint → resolve → call; revoke and expiry both kill the capability", async () => {
    const token = mintShimToken(async (name) => `ran:${name}`);
    const h = resolveShimToken(token);
    expect(h).not.toBeNull();
    expect(await h!("add", {})).toBe("ran:add");
    revokeShimToken(token);
    expect(resolveShimToken(token)).toBeNull();

    const shortLived = mintShimToken(async () => "x", 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(resolveShimToken(shortLived)).toBeNull();
  });
});
