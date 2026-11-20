import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputBuffer, runChild, stepLogTail, tailBytesFor } from "./child-output.js";
import { LandGate } from "./land-gate.js";
import { git, gitOrThrow } from "./worktree.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "child-output-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const node = (script: string) => [process.execPath, ["-e", script]] as const;
const MiB = 1024 * 1024;

describe("child output without a maxBuffer cliff", () => {
  it("keeps exit status, timeout and spawn failures in execFile's shape", async () => {
    const ok = await runChild(...node("process.stdout.write('hi')"), { cwd: tmpdir() });
    expect(ok.error).toBeNull();
    expect(ok.stdout.text()).toBe("hi");
    const red = await runChild(...node("process.stderr.write('bad'); process.exit(3)"), { cwd: tmpdir() });
    expect(red.error).toMatchObject({ code: 3, killed: false, signal: null });
    expect(red.stderr.text()).toBe("bad");
    const slow = await runChild(...node("setTimeout(() => {}, 60_000)"), { cwd: tmpdir(), timeoutMs: 200, killSignal: "SIGKILL" });
    expect(slow.error).toMatchObject({ code: null, killed: true, signal: "SIGKILL" });
    const missing = await runChild("definitely-not-a-binary-xyz", [], { cwd: tmpdir() });
    expect(missing.error?.code).toBe("ENOENT");
  });

  it("the gate tail matches the whole-string tail, multibyte included, and says when output was cut", async () => {
    const script = "process.stdout.write('前'.repeat(300000) + 'END-OUT'); process.stderr.write('错'.repeat(10) + 'END-ERR')";
    const run = await runChild(...node(script), { cwd: tmpdir(), tailBytes: tailBytesFor(4_000) });
    const whole = ("前".repeat(300000) + "END-OUT" + "\n" + "错".repeat(10) + "END-ERR").slice(-4_000);
    const log = stepLogTail(run, 4_000);
    expect(log.endsWith(whole)).toBe(true);
    expect(log).toContain("更早的输出未保留");
    expect(run.stdout.total).toBe(Buffer.byteLength("前".repeat(300000) + "END-OUT"));
    const small = await runChild(...node("process.stdout.write('short')"), { cwd: tmpdir(), tailBytes: tailBytesFor(4_000) });
    expect(stepLogTail(small, 4_000)).toBe("short\n");
  });

  it("a bounded buffer holds only its window", () => {
    const buffer = new OutputBuffer(5);
    for (const part of ["abc", "defg", "hi"]) buffer.push(Buffer.from(part));
    expect(buffer.text()).toBe("efghi");
    expect(buffer.dropped).toBe(4);
  });

  it("a gate step that prints 20 MiB passes on its exit status", { timeout: 60_000 }, async () => {
    const dir = tmp();
    const chatty = { id: "typecheck" as const, bin: process.execPath, args: ["-e", `const line = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 20 * 1024; i++) process.stdout.write(line); process.stdout.write('GATE-DONE')`] };
    const gate = new LandGate({ repoDir: dir, worktreesDir: join(dir, "wt"), stepsFor: async () => [chatty] });
    const passed = await gate.check(dir);
    expect(passed.ok).toBe(true);
    expect(passed.log).toContain("GATE-DONE");
    const red = new LandGate({ repoDir: dir, worktreesDir: join(dir, "wt2"), stepsFor: async () => [{ ...chatty, args: ["-e", `${chatty.args[1]}; process.exit(2)`] }] });
    const refused = await red.check(dir);
    expect(refused).toMatchObject({ ok: false, refusal: "typecheck" });
  });

  it("git returns a 10 MiB blob whole instead of reporting git as failed", { timeout: 60_000 }, async () => {
    const repo = tmp();
    await gitOrThrow(repo, ["init", "-b", "v4"]);
    await gitOrThrow(repo, ["config", "user.email", "t@t"]);
    await gitOrThrow(repo, ["config", "user.name", "t"]);
    const content = "y".repeat(10 * MiB) + "\nlast-line";
    writeFileSync(join(repo, "big.txt"), content);
    await gitOrThrow(repo, ["add", "big.txt"]);
    await gitOrThrow(repo, ["commit", "-m", "big"]);
    const shown = await git(repo, ["show", "HEAD:big.txt"]);
    expect(shown.ok).toBe(true);
    expect(shown.stdout.length).toBe(content.length);
    expect(shown.stdout.endsWith("last-line")).toBe(true);
    const failed = await git(repo, ["show", "HEAD:absent.txt"]);
    expect(failed).toMatchObject({ ok: false, code: 128 });
  });
});
