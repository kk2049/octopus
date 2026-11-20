import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { WORKSPACE_JOB_WORKER } from "./workspace-job-worker.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const ioError = (code: string) => Object.assign(new Error("private path must not be logged"), { code });
const stat = (pid: number) => pid + " (command) " + [...Array(19).fill("0"), String(pid * 100)].join(" ");

class Child extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  alive = true;
  exitCode: number | null = null;
  signalCode: string | null = null;
  constructor(readonly pid: number) { super(); }
  close(signal: string | null = null) {
    this.alive = false;
    this.exitCode = signal ? null : 0;
    this.signalCode = signal;
    this.emit("close", this.exitCode, signal);
  }
}

/** Execute the delivered worker program with controlled I/O and child exits.
 * Actual OS execution/cancellation stays covered by workspace-jobs.test.ts. */
function worker(options: {
  readIdentity?: (child: Child) => Promise<string>;
  writeIdentity?: () => Promise<void>;
  keepFirstAlive?: boolean;
} = {}) {
  const sha = "a".repeat(40);
  const spec = { cwd: "/repo", job_dir: "/job", lock_dir: "/lock", lock_token: "owner", repo_sha: sha, command: "pack-app", timeout_ms: 5000 };
  const files = new Map<string, string>([["/repo/.git/HEAD", sha], ["/lock/job-id", "owner"]]);
  const children: Child[] = [];
  const kill = vi.fn((pid: number, signal: string | number) => {
    const child = children.find((row) => row.pid === Math.abs(pid));
    if (!child || !child.alive) throw ioError("ESRCH");
    if (signal !== 0) child.close(String(signal));
  });
  const fs = {
    async stat(name: string) { if (name !== "/repo" && !files.has(name)) throw ioError("ENOENT"); return {}; },
    async readFile(name: string) {
      const match = /^\/proc\/(\d+)\/stat$/.exec(name);
      if (match) {
        const pid = Number(match[1]), child = children.find((row) => row.pid === pid);
        if (child === children[0] && child && options.readIdentity) return options.readIdentity(child);
        return stat(pid);
      }
      if (!files.has(name)) throw ioError("ENOENT");
      return files.get(name)!;
    },
    async open(name: string) {
      return {
        async writeFile(value: string) { files.set(name, value); },
        async write(value: Buffer) { files.set(name, (files.get(name) ?? "") + value.toString()); },
        async sync() {},
        async close() {},
      };
    },
    async rename(from: string, to: string) {
      if (to === "/job/child.json" && !files.has(to)) await options.writeIdentity?.();
      if (!files.has(from)) throw ioError("ENOENT");
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    async unlink(name: string) { files.delete(name); },
    async rmdir() {},
    async mkdir() {},
  };
  const spawn = vi.fn(() => {
    const child = new Child(100 + children.length);
    children.push(child);
    queueMicrotask(() => {
      child.emit("spawn");
      if (children[0] !== child || !options.keepFirstAlive) child.close();
    });
    return child;
  });
  const completed = runInNewContext("(async () => {\n" + WORKSPACE_JOB_WORKER.replace(/^import .+;\n/gm, "") + "\n})()", {
    fs, path, spawn, createHash, Buffer,
    process: { pid: 1, env: {}, kill, stdin: (async function* () { yield Buffer.from(JSON.stringify(spec)); })() },
    setInterval: () => 1, clearInterval() {},
    setTimeout: () => ({ unref() {} }),
  }) as Promise<void>;
  return {
    completed, spawn, children, files, kill,
    result: () => JSON.parse(files.get("/job/result.json")!),
    log: () => files.get("/job/output.log") ?? "",
  };
}

// All worker fake I/O resolves through microtasks, so advancing this queue is
// deterministic and does not depend on a fast real process or wall-clock sleep.
async function drain() { for (let i = 0; i < 100; i++) await Promise.resolve(); }

describe("workspace worker child identity lifetime", () => {
  it.each(["ENOENT", "ESRCH"])("accepts /proc %s only after the short child has exited", async (code) => {
    const identity = deferred<string>();
    const run = worker({ readIdentity: () => identity.promise });
    await drain();
    expect(run.children).toHaveLength(1);
    expect(run.children[0]!.exitCode).toBe(0);
    expect(run.files.has("/job/result.json")).toBe(false);
    identity.reject(ioError(code));
    await run.completed;
    expect(run.result()).toMatchObject({ state: "succeeded", exit_code: 0, error: null });
    expect(run.spawn).toHaveBeenCalledTimes(3); // exact Git check, SHA check, requested command
    expect(run.log()).not.toContain("control_io");
  });

  it.each(["ENOENT", "ESRCH"])("accepts %s from a reaped process before Node delivers its close event", async (code) => {
    const identity = deferred<string>();
    const run = worker({ readIdentity: () => identity.promise, keepFirstAlive: true });
    await drain();
    const child = run.children[0]!;
    child.alive = false;
    identity.reject(ioError(code));
    await drain();
    expect(run.kill).toHaveBeenCalledWith(child.pid, 0);
    expect(run.spawn).toHaveBeenCalledTimes(1);
    expect(run.files.has("/job/result.json")).toBe(false);
    child.close();
    await run.completed;
    expect(run.result().state).toBe("succeeded");
    expect(run.log()).not.toContain("control_io");
  });

  it("finishes the previous identity write before a later command can replace child.json", async () => {
    const persisted = deferred<void>();
    const run = worker({ writeIdentity: () => persisted.promise });
    await drain();
    expect(run.spawn).toHaveBeenCalledTimes(1);
    expect(run.files.has("/job/result.json")).toBe(false);
    persisted.resolve();
    await run.completed;
    expect(run.result().state).toBe("succeeded");
    expect(run.spawn).toHaveBeenCalledTimes(3);
    expect(JSON.parse(run.files.get("/job/child.json")!)).toEqual({ pid: 102, start_ticks: "10200" });
    expect(run.files.has("/lock/job-id")).toBe(false);
  });

  it("fails a late real write error before it can affect a subsequent command", async () => {
    const persisted = deferred<void>();
    const run = worker({ writeIdentity: () => persisted.promise });
    await drain();
    expect(run.spawn).toHaveBeenCalledTimes(1);
    persisted.reject(ioError("EIO"));
    await run.completed;
    expect(run.result()).toMatchObject({ state: "failed", error: "control_io" });
    expect(run.spawn).toHaveBeenCalledTimes(1);
    expect(run.kill).not.toHaveBeenCalled(); // the first process already exited
    expect(run.log()).toContain("control_io child_identity_write EIO");
    expect(run.log()).not.toContain("private path");
  });

  it.each(["ENOENT", "ESRCH", "EACCES"])("does not excuse %s when the child is still live", async (code) => {
    const run = worker({ readIdentity: async () => { throw ioError(code); }, keepFirstAlive: true });
    await run.completed;
    expect(run.result()).toMatchObject({ state: "failed", error: "control_io" });
    expect(run.spawn).toHaveBeenCalledTimes(1);
    expect(run.kill).toHaveBeenCalledWith(-100, "SIGTERM");
    expect(run.log()).toContain("control_io child_identity_read " + code);
  });
});
