import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexProbeCachePath, probeCodex, type ProbeCommand } from "./probe.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-probe-"));
  dirs.push(home);
  return home;
}

describe("probeCodex", () => {
  it("checks the executable contract once per exact version and persists only the verdict", async () => {
    const home = fixture();
    const calls: string[] = [];
    const run: ProbeCommand = async (_bin, args) => {
      calls.push(args.join(" "));
      return args[0] === "--version"
        ? { stdout: "codex-cli 0.146.0", stderr: "" }
        : { stdout: "Options:\n  --json  Print events as JSONL", stderr: "" };
    };
    expect(await probeCodex(home, run)).toEqual({ supported: true, version: "0.146.0" });
    expect(await probeCodex(home, run)).toEqual({ supported: true, version: "0.146.0" });
    expect(calls).toEqual(["--version", "exec --help", "--version"]);
    expect(statSync(codexProbeCachePath(home)).mode & 0o777).toBe(0o600);
  });

  it("fails closed for an old version without trusting a help flag", async () => {
    const home = fixture();
    const calls: string[] = [];
    const run: ProbeCommand = async (_bin, args) => {
      calls.push(args.join(" "));
      return { stdout: args[0] === "--version" ? "codex 0.19.9" : "--json", stderr: "" };
    };
    expect(await probeCodex(home, run)).toEqual({
      supported: false,
      version: "0.19.9",
      reason: "version_too_old",
    });
    expect(calls).toEqual(["--version"]);
  });

  it("reprobes help after an upgrade and rejects a missing JSONL contract", async () => {
    const home = fixture();
    let version = "0.145.0";
    let helpCalls = 0;
    const run: ProbeCommand = async (_bin, args) => {
      if (args[0] === "--version") return { stdout: `codex-cli ${version}`, stderr: "" };
      helpCalls += 1;
      return { stdout: helpCalls === 1 ? "--json" : "ordinary help", stderr: "" };
    };
    expect((await probeCodex(home, run)).supported).toBe(true);
    version = "0.146.0";
    expect(await probeCodex(home, run)).toEqual({
      supported: false,
      version: "0.146.0",
      reason: "json_flag_missing",
    });
    expect(helpCalls).toBe(2);
  });
});
