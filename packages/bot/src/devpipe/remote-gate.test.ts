/**
 * `runnerGateSession` against a real local "device": the exec callback runs
 * each command in bash on this host, exactly as the Runner's `machineExec`
 * does inside the container. What is under test is the detached-step
 * contract — start, poll, rc, log tail, kill on deadline, transport loss —
 * not pnpm or git (the sync half is covered by runner-machine-sync.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BundleHandoff } from "./bundle-handoff.js";
import { RemoteGateUnavailable, landGateCacheDir, landWorkspacePath, runnerGateSession } from "./remote-gate.js";
import type { MachineExec } from "./runner-machine-sync.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function localExec(log: string[]): MachineExec {
  return async ({ command, timeout_ms }) => {
    log.push(command);
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", command], { timeout: timeout_ms ?? 60_000, maxBuffer: 4 * 1024 * 1024 });
      return { ok: true, stdout: String(stdout), stderr: String(stderr), exit_code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), exit_code: typeof e.code === "number" ? e.code : null };
    }
  };
}

/** A fake `<work>/octopus` so the session's derived paths land in a temp dir. */
function work(): { checkoutDir: string; workspace: string; cacheDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "remote-gate-"));
  dirs.push(dir);
  const checkoutDir = join(dir, "octopus");
  const workspace = landWorkspacePath(checkoutDir);
  execFileAsync("mkdir", ["-p", workspace, checkoutDir]);
  return { checkoutDir, workspace, cacheDir: landGateCacheDir(checkoutDir) };
}

describe("runnerGateSession: detached steps", () => {
  it("derives the pipeline-owned landing workspace beside the tickets", () => {
    expect(landWorkspacePath("/work/octopus")).toBe("/work/land");
    expect(landGateCacheDir("/work/octopus")).toBe("/work/land-gate-cache");
  });

  it("runs a step to completion, returns its rc and output tail with the workspace rewritten out", async () => {
    const w = work();
    await execFileAsync("mkdir", ["-p", w.workspace]);
    const log: string[] = [];
    const session = runnerGateSession({
      device: "ci-1", checkoutDir: w.checkoutDir, publicUrl: "http://127.0.0.1:1", bundles: new BundleHandoff(), exec: localExec(log), pollMs: 50,
    });
    const r = await session.run({ bin: "bash", args: ["-c", `echo hello from $PWD; echo warn >&2; exit 0`] }, 10_000);
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.log).toContain("$ bash -c");
    expect(r.log).toContain("hello from .");
    expect(r.log).toContain("warn");
    expect(r.log).not.toContain(w.workspace);
    // Step files are cleaned up after the verdict.
    expect(readdirSync(w.cacheDir).filter((f) => f.startsWith("step-"))).toEqual([]);
    session.close();
  });

  it("a non-zero exit is a failed step, never a transport error", async () => {
    const w = work();
    await execFileAsync("mkdir", ["-p", w.workspace]);
    const session = runnerGateSession({
      device: "ci-1", checkoutDir: w.checkoutDir, publicUrl: "http://127.0.0.1:1", bundles: new BundleHandoff(), exec: localExec([]), pollMs: 50,
    });
    const r = await session.run({ bin: "bash", args: ["-c", "echo TS2322 oops; exit 2"] }, 10_000);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.log).toContain("TS2322");
  });

  it("kills a step that outlives its deadline and reports timedOut — never a pass", async () => {
    const w = work();
    await execFileAsync("mkdir", ["-p", w.workspace]);
    const marker = join(w.workspace, "still-running");
    const session = runnerGateSession({
      device: "ci-1", checkoutDir: w.checkoutDir, publicUrl: "http://127.0.0.1:1", bundles: new BundleHandoff(), exec: localExec([]), pollMs: 50,
    });
    const started = Date.now();
    const r = await session.run(
      { bin: "bash", args: ["-c", `echo started; sleep 30; touch ${JSON.stringify(marker)}`] },
      1_000,
    );
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.log).toContain("started");
    expect(Date.now() - started).toBeLessThan(10_000);
    // The process group was killed: the post-sleep side effect never happens.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(marker)).toBe(false);
  });

  it("a transport that stays silent past the grace period is RemoteGateUnavailable, not a verdict", async () => {
    const w = work();
    await execFileAsync("mkdir", ["-p", w.workspace]);
    let calls = 0;
    const dying: MachineExec = async (args) => {
      calls += 1;
      if (calls === 1) return await localExec([])(args); // the start succeeds
      throw new Error("runner offline");
    };
    const session = runnerGateSession({
      device: "ci-1", checkoutDir: w.checkoutDir, publicUrl: "http://127.0.0.1:1", bundles: new BundleHandoff(), exec: dying, pollMs: 20, pollGraceMs: 200,
    });
    const started = Date.now();
    await expect(session.run({ bin: "bash", args: ["-c", "sleep 5"] }, 5_000)).rejects.toBeInstanceOf(RemoteGateUnavailable);
    // It waited out the grace period (not three polls) and gave up well before the step deadline.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("a Runner keepalive blip during a step is ridden out: the detached step keeps running and its verdict is read once the machine answers again", async () => {
    const w = work();
    await execFileAsync("mkdir", ["-p", w.workspace]);
    const real = localExec([]);
    let calls = 0;
    const blipping: MachineExec = async (args) => {
      calls += 1;
      // Start succeeds; polls 2..6 see "device offline" (the gateway's words); then the Runner is back.
      if (calls >= 2 && calls <= 6) throw new Error("设备 ci-1 不在线或不属于你。当前在线: dev-laptop");
      return await real(args);
    };
    const session = runnerGateSession({
      device: "ci-1", checkoutDir: w.checkoutDir, publicUrl: "http://127.0.0.1:1", bundles: new BundleHandoff(), exec: blipping, pollMs: 30, pollGraceMs: 10_000,
    });
    const r = await session.run({ bin: "bash", args: ["-c", "sleep 0.4; echo survived; exit 0"] }, 10_000);
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.log).toContain("survived");
    expect(calls).toBeGreaterThan(6);
  });

  it("a closed session refuses further work", async () => {
    const w = work();
    const session = runnerGateSession({
      device: "ci-1", checkoutDir: w.checkoutDir, publicUrl: "http://127.0.0.1:1", bundles: new BundleHandoff(), exec: localExec([]), pollMs: 20,
    });
    session.close();
    await expect(session.run({ bin: "true", args: [] }, 1_000)).rejects.toBeInstanceOf(RemoteGateUnavailable);
  });
});
