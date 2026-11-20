import { describe, expect, it } from "vitest";
import { BuildWarmer, buildWarmSummary, type BuildWarmStep } from "./build-warm.js";

/**
 * A warmer whose worktree parking and step execution are stubbed. Everything
 * these tests care about — ordering, supersession, failure containment — is
 * scheduling behaviour, not process behaviour.
 */
function warmer(opts: {
  enabled?: boolean;
  fail?: BuildWarmStep["id"];
  timedOut?: boolean;
  parkError?: string;
  onStep?: (step: BuildWarmStep, sha: string) => void | Promise<void>;
  timeoutMs?: number;
  joinTimeoutMs?: number;
}) {
  const parked: string[] = [];
  const steps: Array<{ id: string; sha: string }> = [];
  let sha = "";
  const w = new BuildWarmer({
    repoDir: "/repo",
    worktreesDir: "/wt",
    ...(opts.enabled != null ? { enabled: opts.enabled } : {}),
    ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.joinTimeoutMs != null ? { joinTimeoutMs: opts.joinTimeoutMs } : {}),
    park: async (dir, ref) => {
      if (opts.parkError) throw new Error(opts.parkError);
      sha = ref;
      parked.push(`${dir}@${ref}`);
      return dir;
    },
    exec: async (step) => {
      steps.push({ id: step.id, sha });
      await opts.onStep?.(step, sha);
      if (opts.fail === step.id) return { ok: false, timedOut: Boolean(opts.timedOut), log: `$ boom\n/wt/_warm failed` };
      return { ok: true, timedOut: false, log: `$ ok` };
    },
  });
  return { w, parked, steps };
}

describe("BuildWarmer", () => {
  it("parks the landed sha and runs install then build", async () => {
    const { w, parked, steps } = warmer({});
    const outcome = await w.warm("abc1234def");
    expect(outcome.ok).toBe(true);
    expect(parked).toEqual(["/wt/_warm@abc1234def"]);
    expect(steps.map((s) => s.id)).toEqual(["install", "build"]);
  });

  it("uses its own worktree, never the landing gate's", () => {
    const { w } = warmer({});
    expect(w.warmDir()).toBe("/wt/_warm");
    expect(w.warmDir()).not.toContain("_land");
  });

  it("skips a sha it already warmed", async () => {
    const { w, steps } = warmer({});
    await w.warm("sha-1");
    expect(await w.warm("sha-1")).toEqual({ ok: false, sha: "sha-1", skipped: "already_warm" });
    expect(steps).toHaveLength(2);
  });

  it("shares one in-flight run between callers for the same sha", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { w, steps } = warmer({
      onStep: async (step) => {
        if (step.id !== "install") return;
        started();
        await gate;
      },
    });

    const first = w.warm("sha-1");
    await running;
    const second = w.warm("sha-1");
    release();

    expect(await first).toMatchObject({ ok: true, sha: "sha-1" });
    expect(await second).toMatchObject({ ok: true, sha: "sha-1" });
    expect(steps.map((step) => step.id)).toEqual(["install", "build"]);
  });

  it("treats a repeated pending sha as the newest warm request", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { w, steps } = warmer({
      onStep: async (step) => {
        if (step.id !== "install") return;
        started();
        await gate;
      },
    });

    const first = w.warm("sha-1");
    await running;
    const superseded = w.warm("sha-2");
    const repeated = w.warm("sha-1");
    release();

    expect(await first).toMatchObject({ ok: true, sha: "sha-1" });
    expect(await repeated).toMatchObject({ ok: true, sha: "sha-1" });
    expect(await superseded).toEqual({ ok: false, sha: "sha-2", skipped: "superseded" });
    expect(steps.map((step) => step.sha)).toEqual(["sha-1", "sha-1"]);
  });

  it("lets an immediate deploy join the scheduled exact sha without starting work", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { w, steps } = warmer({
      onStep: async (step) => {
        if (step.id !== "install") return;
        started();
        await gate;
      },
    });

    w.schedule("sha-1");
    await running;
    const joined = w.join("sha-1");
    release();

    expect(await joined).toMatchObject({ sha: "sha-1", ready: true, joined: true });
    expect(steps.map((step) => step.id)).toEqual(["install", "build"]);
  });

  it("does not start an unscheduled warm on the deployment path", async () => {
    const { w, steps } = warmer({});
    expect(await w.join("sha-1")).toEqual({
      sha: "sha-1",
      ready: false,
      joined: false,
      waitedMs: 0,
      outcome: null,
    });
    expect(steps).toHaveLength(0);
  });

  it("bounds how long deployment joins optional warming", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { w } = warmer({
      joinTimeoutMs: 1,
      onStep: async (step) => {
        if (step.id !== "install") return;
        started();
        await gate;
      },
    });

    const warming = w.warm("sha-1");
    await running;
    expect(await w.join("sha-1")).toMatchObject({ ready: false, joined: true, outcome: null });
    release();
    await warming;
  });

  it("supersedes a queued warm when a newer landing arrives", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { w, steps } = warmer({
      onStep: async (step) => {
        if (step.id !== "install") return;
        started();
        await gate;
      },
    });

    const first = w.warm("sha-old");
    await running; // the first warm is genuinely in flight, not just queued
    const second = w.warm("sha-mid");
    const third = w.warm("sha-new");
    release();

    expect(await first).toMatchObject({ ok: true, sha: "sha-old" });
    expect(await second).toEqual({ ok: false, sha: "sha-mid", skipped: "superseded" });
    expect(await third).toMatchObject({ ok: true, sha: "sha-new" });
    // A warm already in flight finishes; the queued middle sha is dropped,
    // because only the newest landing is what a deploy will ask for.
    expect(steps.map((s) => s.sha)).toEqual(["sha-old", "sha-old", "sha-new", "sha-new"]);
  });

  it("reports a failing step without throwing", async () => {
    const { w } = warmer({ fail: "build" });
    const outcome = await w.warm("sha-1");
    expect(outcome).toMatchObject({ ok: false, sha: "sha-1", failed: "build" });
    // The staging path is rewritten out of the tail, like the gate's logs.
    expect("log" in outcome && outcome.log).not.toContain("/wt/_warm");
  });

  it("reports a killed step as a timeout", async () => {
    const { w } = warmer({ fail: "install", timedOut: true });
    expect(await w.warm("sha-1")).toMatchObject({ failed: "timeout" });
  });

  it("reports an unusable worktree instead of crashing the caller", async () => {
    const { w, steps } = warmer({ parkError: "worktree busy" });
    expect(await w.warm("sha-1")).toMatchObject({ ok: false, failed: "worktree" });
    expect(steps).toHaveLength(0);
  });

  it("retries a sha whose previous warm failed", async () => {
    const { w, steps } = warmer({ fail: "build" });
    await w.warm("sha-1");
    await w.warm("sha-1");
    expect(steps.map((s) => s.id)).toEqual(["install", "build", "install", "build"]);
  });

  it("does nothing at all when disabled", async () => {
    const { w, steps, parked } = warmer({ enabled: false });
    expect(await w.warm("sha-1")).toEqual({ ok: false, sha: "sha-1", skipped: "disabled" });
    expect(steps).toHaveLength(0);
    expect(parked).toHaveLength(0);
    expect(w.status()).toEqual({ state: "off" });
  });

  it("refuses to start work after stop()", async () => {
    const { w, steps } = warmer({});
    w.stop();
    expect(await w.warm("sha-1")).toEqual({ ok: false, sha: "sha-1", skipped: "stopped" });
    expect(steps).toHaveLength(0);
  });

  it("schedule() never rejects and never blocks the landing door", async () => {
    const { w } = warmer({ fail: "install" });
    expect(() => w.schedule("sha-1")).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("refuses to run past its deadline", async () => {
    let clock = 0;
    const w = new BuildWarmer({
      repoDir: "/repo",
      worktreesDir: "/wt",
      timeoutMs: 10,
      now: () => clock,
      park: async (dir) => dir,
      exec: async () => {
        clock += 100;
        return { ok: true, timedOut: false, log: "" };
      },
    });
    expect(await w.warm("sha-1")).toMatchObject({ ok: false, failed: "timeout" });
  });

  it("exposes what a deploy can expect", async () => {
    const { w } = warmer({});
    expect(w.status()).toEqual({ state: "idle" });
    await w.warm("abcdef1234567890");
    const status = w.status();
    expect(status).toMatchObject({ state: "done", ok: true, sha: "abcdef1234567890" });
    expect(buildWarmSummary(status)).toContain("abcdef1234");
    expect(buildWarmSummary(status)).toContain("命中缓存");
  });
});

describe("buildWarmSummary", () => {
  it("tells the reader whether a deploy will have to build", () => {
    expect(buildWarmSummary({ state: "off" })).toContain("完整构建");
    expect(buildWarmSummary({ state: "idle" })).toContain("还没有落地");
    expect(buildWarmSummary({ state: "running", sha: "abcdef1234", since: "t" })).toContain("正在为 abcdef1234");
    expect(
      buildWarmSummary({ state: "done", sha: "abcdef1234", ok: false, ms: 1, at: "t", detail: "预热失败(build)" }),
    ).toContain("照常完整构建");
  });
});
