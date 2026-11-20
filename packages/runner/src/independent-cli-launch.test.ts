import { describe, expect, it, vi } from "vitest";
import { AGENT_PERMISSION_PROFILES } from "./agent-permissions.js";
import {
  independentCliCommand,
  launchIndependentCliInTmux,
  sessionIdFromOmpScreen,
  type IndependentCliLaunchInput,
} from "./independent-cli-launch.js";

const BASE: IndependentCliLaunchInput = {
  source: "claude",
  cwd: "/work/project",
  prompt: "keep $() and `ticks` and 'quotes'",
  model: "",
  effort: "",
  permissionProfile: AGENT_PERMISSION_PROFILES.fullAccess,
  requestId: "op_independent1234",
  claudeSessionId: "11111111-2222-4333-8444-555555555555",
  supervisionMs: 500,
};

describe("independent CLI command selection", () => {
  it("uses only provider CLIs and keeps manual Claude on an interactive permission TUI", () => {
    expect(independentCliCommand(BASE)).toMatchObject({
      bin: "claude",
      args: expect.arrayContaining(["-p", "--session-id", BASE.claudeSessionId]),
    });
    const manual = independentCliCommand({
      ...BASE,
      permissionProfile: AGENT_PERMISSION_PROFILES.manual,
    });
    expect(manual.args).toContain("manual");
    expect(manual.args).not.toContain("-p");
    expect(JSON.stringify(manual)).not.toMatch(/agent-sdk|app-server/);

    const codex = independentCliCommand({
      ...BASE,
      source: "codex",
      claudeSessionId: undefined,
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });
    expect(codex).toMatchObject({ bin: "codex", args: expect.arrayContaining(["exec", "--json"]) });
    expect(JSON.stringify(codex)).not.toContain("app-server");

    const omp = independentCliCommand({ ...BASE, source: "omp", claudeSessionId: undefined, effort: "high" });
    expect(omp).toMatchObject({
      bin: "omp",
      args: expect.arrayContaining(["-p", "--mode", "json", "--auto-approve"]),
    });
    expect(JSON.stringify(omp)).not.toContain("rpc");
  });

  it("reads only an omp session header, not arbitrary JSON", () => {
    expect(sessionIdFromOmpScreen([
      "typed shell command",
      '{"type":"message","id":"message_123456"}',
      '{"type":"session","version":3,"id":"01a00ed4-db09-7000-b549-ac372c282cfa"}',
    ].join("\n"))).toBe("01a00ed4-db09-7000-b549-ac372c282cfa");
    expect(sessionIdFromOmpScreen('{"type":"session","id":"x"}')).toBeNull();
  });
});

describe("tmux-owned independent CLI launch", () => {
  it("creates one durable pane, pastes a safely quoted command, and returns the exact Codex id", async () => {
    const calls: Array<{ bin: string; args: string[]; input?: string }> = [];
    const run = vi.fn(async (bin: string, args: string[], input?: string): Promise<{ stdout: string }> => {
      calls.push({ bin, args, ...(input !== undefined ? { input } : {}) });
      if (args[0] === "new-session") return { stdout: "%7\t321\n" };
      if (args[0] === "capture-pane") {
        return { stdout: '{"type":"thread.started","thread_id":"019f0000-1111-7000-8000-000000000123"}\n' };
      }
      if (args[0] === "display-message") return { stdout: "0\t\n" };
      return { stdout: "" };
    });
    const result = await launchIndependentCliInTmux({
      ...BASE,
      source: "codex",
      claudeSessionId: undefined,
      codexHome: "/srv/codex/account-b",
    }, { run, wait: async () => {} });

    expect(result).toEqual({
      kind: "started",
      sessionId: "019f0000-1111-7000-8000-000000000123",
      pid: 321,
    });
    expect(calls.some((call) => call.args[0] === "new-session" && call.args.includes("/work/project"))).toBe(true);
    expect(calls.some((call) => call.args[0] === "set-option" && call.args.includes("remain-on-exit"))).toBe(true);
    const loaded = calls.find((call) => call.args[0] === "load-buffer")?.input ?? "";
    expect(loaded).toContain("exec 'env' 'CODEX_HOME=/srv/codex/account-b' 'codex' 'exec' '--json'");
    expect(loaded).toContain("'keep $() and `ticks` and '\"'\"'quotes'\"'\"''");
  });

  it("falls back only when tmux is unusable before any prompt is submitted", async () => {
    const run = vi.fn(async () => { throw new Error("tmux could not start"); });
    await expect(launchIndependentCliInTmux(BASE, { run })).resolves.toEqual({ kind: "unavailable" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("extracts the omp header from the pane before reporting success", async () => {
    const run = vi.fn(async (_bin: string, args: string[]): Promise<{ stdout: string }> => {
      if (args[0] === "new-session") return { stdout: "%9\t654\n" };
      if (args[0] === "capture-pane") {
        return { stdout: '{"type":"session","version":3,"id":"01a00ed4-db09-7000-b549-ac372c282cfa"}\n' };
      }
      if (args[0] === "display-message") return { stdout: "0\t\n" };
      return { stdout: "" };
    });
    await expect(launchIndependentCliInTmux({
      ...BASE,
      source: "omp",
      claudeSessionId: undefined,
    }, { run, wait: async () => {} })).resolves.toEqual({
      kind: "started",
      sessionId: "01a00ed4-db09-7000-b549-ac372c282cfa",
      pid: 654,
    });
  });
});
