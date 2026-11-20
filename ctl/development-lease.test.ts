import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { LinuxProcessReader, type ProcessReader, type ProcSnapshot } from "../packages/runner/src/agent-runtime.js";
import { DEFAULT_HOLD_MINUTES, MAX_HOLD_MINUTES, holdDeadline, keepRenewing, leaseOwner, leaseOwnerAlive } from "./development-lease.js";

/** pid → [argv, ppid]; the first entry is the command's own parent. */
function tree(rows: Array<[number, string[], number]>): ProcessReader {
  const byPid = new Map(rows.map(([pid, argv, ppid]): [number, ProcSnapshot] => [pid, {
    pid, ppid, pgid: pid, tty: 0, startTicks: `${pid}00`, bootId: "boot", command: argv[0]!.split("/").pop()!, argv,
  }]));
  return { read: async (pid) => byPid.get(pid) ?? null, signal: () => {} };
}
const wrappers: Array<[number, string[], number]> = [
  [40, ["node", "node_modules/.bin/../tsx/dist/cli.mjs", "ctl/development.ts", "acquire"], 30],
  [30, ["node", "/usr/local/bin/corepack", "pnpm", "--dir", "/repo", "exec"], 20],
  [20, ["flock", "-w", "60", "/repo/.git/octopus-development/command.lock", "corepack"], 10],
];

describe("CLI integration hold", () => {
  it("follows the agent CLI that ran the command, skipping transient wrappers and shells", async () => {
    const claude = tree([...wrappers, [10, ["/bin/bash", "-c", "scripts/ops/development.sh acquire"], 9],
      [9, ["timeout", "600", "bash"], 8], [8, ["bash", "-lc", "x"], 7], [7, ["claude", "--dangerously-skip-permissions"], 6], [6, ["fish"], 1]]);
    expect(await leaseOwner(claude, 40)).toMatchObject({ pid: 7, startTicks: "700", command: "claude" });
    const codex = tree([...wrappers, [10, ["bash", "-lc", "scripts/ops/land.sh"], 5],
      [5, ["/home/u/.local/bin/codex"], 4], [4, ["node", "/usr/local/bin/codex"], 3], [3, ["-bash"], 1]]);
    expect(await leaseOwner(codex, 40)).toMatchObject({ pid: 5, command: "codex" });
  });

  it("follows an interactive or script shell when no agent ran the command, and proves nothing otherwise", async () => {
    expect(await leaseOwner(tree([...wrappers, [10, ["-bash"], 2], [2, ["tmux"], 1]]), 40)).toMatchObject({ pid: 10 });
    expect(await leaseOwner(tree([...wrappers, [10, ["bash", "./land-all.sh"], 2], [2, ["fish"], 1]]), 40)).toMatchObject({ pid: 10 });
    // A managed Codex app-server is provider infrastructure, never a person's hold.
    expect(await leaseOwner(tree([...wrappers, [10, ["sh", "-c", "x"], 9], [9, ["codex", "app-server"], 1]]), 40)).toBeNull();
    expect(await leaseOwner(tree(wrappers), 40)).toBeNull();
  });

  it("renews only the same lease, inside its hold, while the exact owner process lives", async () => {
    const reader = tree([[7, ["claude"], 1]]);
    const owner = { pid: 7, startTicks: "700", bootId: "boot", command: "claude" };
    const state = { lease: { epoch: "e1" }, deadline: 10_000, owner };
    expect(await keepRenewing(state, "e1", 9_999, reader)).toBe(true);
    expect(await keepRenewing(state, "e2", 9_999, reader)).toBe(false);
    expect(await keepRenewing(state, "e1", 10_000, reader)).toBe(false);
    expect(await keepRenewing({ ...state, owner: { ...owner, startTicks: "701" } }, "e1", 9_999, reader)).toBe(false);
    expect(await keepRenewing({ ...state, owner: { ...owner, pid: 8 } }, "e1", 9_999, reader)).toBe(false);
    expect(await keepRenewing({ lease: { epoch: "e1" }, deadline: 10_000 }, "e1", 9_999, reader)).toBe(true);
    expect(await keepRenewing(null, "e1", 0, reader)).toBe(false);
  });

  it("keeps the documented hold choice: an hour by default, 1–480 minutes on request", () => {
    expect([DEFAULT_HOLD_MINUTES, MAX_HOLD_MINUTES]).toEqual([60, 480]);
    expect(holdDeadline(undefined, 0)).toBe(60 * 60_000);
    expect(holdDeadline("480", 0)).toBe(480 * 60_000);
    expect(holdDeadline("10", 0)).toBe(10 * 60_000);
    expect(() => holdDeadline("481", 0)).toThrow(/hold-minutes/);
    expect(() => holdDeadline("0", 0)).toThrow(/hold-minutes/);
    expect(() => holdDeadline("soon", 0)).toThrow(/hold-minutes/);
  });

  it.runIf(process.platform === "linux")("detects a real exited owner by pid and start time", async () => {
    const reader = new LinuxProcessReader();
    const self = await reader.read(process.pid);
    expect(self).not.toBeNull();
    expect(await leaseOwnerAlive({ pid: process.pid, startTicks: self!.startTicks, bootId: self!.bootId, command: self!.command }, reader)).toBe(true);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const snapshot = (await reader.read(child.pid!))!;
    const owner = { pid: snapshot.pid, startTicks: snapshot.startTicks, bootId: snapshot.bootId, command: snapshot.command };
    expect(await leaseOwnerAlive(owner, reader)).toBe(true);
    child.kill("SIGTERM");
    await once(child, "exit");
    expect(await leaseOwnerAlive(owner, reader)).toBe(false);
  });
});
