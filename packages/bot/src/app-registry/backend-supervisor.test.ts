import { fileURLToPath } from "node:url";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backendRelease } from "@claude-bot/app-runtime";
import { bundledAppDir } from "../app-core/app-path.js";
import {
  AppBackendCapacityExceeded,
  AppBackendRegistry,
  AppBackendSupervisor,
} from "./backend-supervisor.js";

const stateMain = fileURLToPath(new URL("../../../app-state/src/main.ts", import.meta.url));
const runtimeMain = fileURLToPath(new URL("../../../app-runtime/src/main.ts", import.meta.url));
const dirs: string[] = [];
const supervisors: AppBackendSupervisor[] = [];
const stateDirs = new WeakMap<AppBackendSupervisor, string>();

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function make(overrides: Partial<ConstructorParameters<typeof AppBackendSupervisor>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sp-supervisor-"));
  dirs.push(dir);
  const supervisor = new AppBackendSupervisor({
    stateDir: dir,
    appDir: bundledAppDir("session-plus"),
    stateModulePath: stateMain,
    runtimeModulePath: runtimeMain,
    execArgv: ["--import", "tsx"],
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
    restartDelaysMs: [20, 40],
    ...overrides,
  });
  supervisors.push(supervisor);
  stateDirs.set(supervisor, dir);
  return supervisor;
}

function dirFor(supervisor: AppBackendSupervisor): string {
  return stateDirs.get(supervisor) ?? "<missing-state-dir>";
}

function backendVariant(label: string): { appDir: string; digest: string } {
  const root = mkdtempSync(join(tmpdir(), "sp-runtime-variant-"));
  dirs.push(root);
  const appDir = join(root, "app");
  cpSync(bundledAppDir("session-plus"), appDir, { recursive: true });
  appendFileSync(join(appDir, "projection.ts"), `\n// runtime variant: ${label}\n`);
  return { appDir, digest: backendRelease(appDir).backendCodeDigest };
}

async function eventually(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition did not become true");
}

function listeningTcpSockets(pid: number): string[] {
  const sockets = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (match) sockets.add(match[1]!);
    } catch { /* descriptor raced with the inspection */ }
  }
  const listening: string[] = [];
  for (const table of ["tcp", "tcp6"]) {
    for (const line of readFileSync(`/proc/${pid}/net/${table}`, "utf8").trim().split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns[3] === "0A" && sockets.has(columns[9] ?? "")) listening.push(`${table}:${columns[1]}`);
    }
  }
  return listening.sort();
}

describe("AppBackendSupervisor", () => {
  it("allows full State recovery beyond the former 60 second cutoff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delayed-state-"));
    dirs.push(dir);
    const entry = join(dir, "delayed.mjs");
    writeFileSync(entry, `setTimeout(() => process.send({v:1,t:'ready'}), 60_500);
      process.on('message', m => { if(m.t==='stop') process.exit(0);
        if(m.t==='request') process.send({v:1,t:'response',id:m.id,ok:true,result:{ok:true}}); });`);
    const supervisor = make({ stateModulePath: entry, stateExecArgv: [] });
    await supervisor.start({ runtime: false });
    expect(supervisor.status.state).toBe("ready");
  }, 75_000);

  it("records the last recovery phase and kills a child that never becomes ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stuck-state-"));
    dirs.push(dir);
    const entry = join(dir, "stuck.mjs");
    const pidFile = join(dir, "pid");
    writeFileSync(entry, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
      process.stderr.write('app-state-startup {"phase":"recovery","elapsedMs":1}'); setInterval(()=>{},1000);`);
    const failures: unknown[] = [];
    const supervisor = make({ stateModulePath: entry, stateExecArgv: [], stateReadyTimeoutMs: 1000, onStartupFailure: (failure) => failures.push(failure) });
    await expect(supervisor.start({ runtime: false })).rejects.toMatchObject({ code: "child_not_ready" });
    expect(failures).toEqual([expect.objectContaining({ service: "state", phase: "recovery", code: "child_not_ready" })]);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    expect(supervisor.status).toMatchObject({ state: "down", runtime: "down" });
  });

  it("starts two independent child services and exposes stable facades", async () => {
    const supervisor = make();
    await supervisor.start();
    expect(supervisor.status).toMatchObject({ state: "ready", runtime: "ready" });
    expect(supervisor.status.statePid).not.toBe(process.pid);
    expect(supervisor.status.runtimePid).not.toBe(process.pid);
    expect(supervisor.status.statePid).not.toBe(supervisor.status.runtimePid);
    expect((await supervisor.state.health()).ok).toBe(true);
    expect((await supervisor.runtime.health()).ok).toBe(true);
    expect(listeningTcpSockets(supervisor.status.statePid!)).toEqual([]);
    expect(listeningTcpSockets(supervisor.status.runtimePid!)).toEqual([]);
    const runtimeEnv = readFileSync(`/proc/${supervisor.status.runtimePid}/environ`, "utf8");
    const runtimeArgs = readFileSync(`/proc/${supervisor.status.runtimePid}/cmdline`, "utf8");
    expect(runtimeEnv).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|CONFIG_PATH|DATA_DIR|APP_STATE_DIR/);
    expect(runtimeArgs).not.toContain(dirFor(supervisor));
  });

  it("restarts a crashed runtime while keeping the facade object stable", async () => {
    const supervisor = make();
    await supervisor.start();
    const facade = supervisor.runtime;
    const before = supervisor.status.runtimePid!;
    const statePid = supervisor.status.statePid;
    process.kill(before, "SIGKILL");
    await eventually(() => supervisor.status.runtime === "ready" && supervisor.status.runtimePid !== before);
    expect(supervisor.runtime).toBe(facade);
    expect(supervisor.status.statePid).toBe(statePid);
    expect((await facade.health()).ok).toBe(true);
  }, 20_000);

  it("restarts a crashed state service and recovers immutable history without restarting runtime", async () => {
    const supervisor = make();
    await supervisor.start();
    const facade = supervisor.state;
    const before = supervisor.status.statePid!;
    const runtimePid = supervisor.status.runtimePid;
    const stream = await facade.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    expect(await facade.commit({
      streamId: stream.streamId,
      expectedRevision: 0,
      dispatchId: "restart-proof",
      actor: "session-plus",
      action: "pin_session",
      paramsHash: "p".repeat(64),
      backendCodeDigest: "b".repeat(64),
      contractDigest: "c".repeat(64),
      events: [{
        type: "session_pinned",
        data: { session: "demo-codex" },
        at: "2026-08-04T00:00:00.000Z",
        by: "session-plus",
      }],
    })).toMatchObject({ ok: true, revision: 1 });
    process.kill(before, "SIGKILL");
    await eventually(() => supervisor.status.state === "ready" && supervisor.status.statePid !== before);
    expect(supervisor.state).toBe(facade);
    expect(supervisor.status.runtimePid).toBe(runtimePid);
    expect(await facade.readSince(stream.streamId, 0, 16)).toMatchObject({
      head: 1,
      events: [{ type: "session_pinned", data: { session: "demo-codex" } }],
    });
    expect(await facade.readCommits(stream.streamId, 0, 10)).toMatchObject({
      head: 1,
      commits: [{
        seqFrom: 1,
        seqTo: 1,
        dispatchId: "restart-proof",
        actor: "session-plus",
        action: "pin_session",
        eventCount: 1,
      }],
    });
  }, 20_000);

  it("reuses an identical backend and routes active and retained digests independently", async () => {
    const supervisor = make({ retainedLingerMs: 60_000 });
    await supervisor.start();
    const originalDir = bundledAppDir("session-plus");
    const originalDigest = backendRelease(originalDir).backendCodeDigest;
    const originalPid = supervisor.status.runtimePid;

    const reused = await supervisor.prepareRuntime(originalDir, originalDigest);
    supervisor.commitRuntime(reused, "retain");
    expect(supervisor.runtimeVersions()).toMatchObject([{
      backendCodeDigest: originalDigest,
      role: "active",
      pid: originalPid,
    }]);

    expect(supervisor.addRuntimeReference(originalDigest)).toBe(true);
    const next = backendVariant("retain-routing");
    const candidate = await supervisor.prepareRuntime(next.appDir, next.digest);
    supervisor.commitRuntime(candidate, "retain");

    expect(supervisor.runtimeVersions()).toMatchObject([
      { backendCodeDigest: next.digest, role: "active" },
      { backendCodeDigest: originalDigest, role: "retained", pid: originalPid, references: 1 },
    ]);
    await expect(supervisor.runtime.project({ backendCodeDigest: originalDigest, events: [] })).resolves.toMatchObject({
      pinned: [],
    });
    await expect(supervisor.runtime.project({ backendCodeDigest: next.digest, events: [] })).resolves.toMatchObject({
      pinned: [],
    });
    await expect(supervisor.runtime.project({
      backendCodeDigest: "f".repeat(64),
      events: [],
    })).rejects.toMatchObject({ service: "runtime", reason: "version_retired" });
  }, 30_000);

  it("retires a retained version after its third crash without disturbing active", async () => {
    const supervisor = make({
      retainedRestartDelaysMs: [20, 40],
      retainedLingerMs: 60_000,
    });
    await supervisor.start();
    const originalDigest = backendRelease(bundledAppDir("session-plus")).backendCodeDigest;
    expect(supervisor.addRuntimeReference(originalDigest)).toBe(true);
    const next = backendVariant("retained-crash");
    const candidate = await supervisor.prepareRuntime(next.appDir, next.digest);
    supervisor.commitRuntime(candidate, "retain");
    const activePid = supervisor.status.runtimePid;

    for (let crash = 1; crash <= 3; crash += 1) {
      const retained = supervisor.runtimeVersions().find((row) => row.backendCodeDigest === originalDigest);
      expect(retained?.role).toBe("retained");
      expect(retained?.pid).toBeTypeOf("number");
      process.kill(retained!.pid!, "SIGKILL");
      if (crash < 3) {
        await eventually(() => {
          const restarted = supervisor.runtimeVersions().find((row) => row.backendCodeDigest === originalDigest);
          return Boolean(restarted?.pid && restarted.pid !== retained?.pid && restarted.crashCount === crash);
        });
      } else {
        await eventually(() => !supervisor.runtimeVersions().some((row) => row.backendCodeDigest === originalDigest));
      }
      expect(supervisor.status.runtimePid).toBe(activePid);
      expect((await supervisor.runtime.health()).backendCodeDigest).toBe(next.digest);
    }

    await expect(supervisor.runtime.project({ backendCodeDigest: originalDigest, events: [] }))
      .rejects.toMatchObject({ reason: "version_retired" });
  }, 30_000);

  it("enforces the per-App retained limit by evicting the oldest cohort", async () => {
    const supervisor = make({ maxRetainedRuntimes: 1, retainedLingerMs: 60_000 });
    await supervisor.start();
    const originalDigest = backendRelease(bundledAppDir("session-plus")).backendCodeDigest;
    expect(supervisor.addRuntimeReference(originalDigest)).toBe(true);
    const second = backendVariant("limit-second");
    const secondCandidate = await supervisor.prepareRuntime(second.appDir, second.digest);
    supervisor.commitRuntime(secondCandidate, "retain");
    expect(supervisor.addRuntimeReference(second.digest)).toBe(true);

    const third = backendVariant("limit-third");
    const thirdCandidate = await supervisor.prepareRuntime(third.appDir, third.digest);
    supervisor.commitRuntime(thirdCandidate, "retain");

    expect(supervisor.runtimeVersions().map((row) => [row.backendCodeDigest, row.role])).toEqual([
      [third.digest, "active"],
      [second.digest, "retained"],
    ]);
    await expect(supervisor.runtime.project({ backendCodeDigest: originalDigest, events: [] }))
      .rejects.toMatchObject({ reason: "version_retired" });
    await expect(supervisor.runtime.project({ backendCodeDigest: second.digest, events: [] })).resolves.toBeTruthy();
  }, 30_000);

  it("deactivates every Runtime version, keeps State ready, and can adopt a release again", async () => {
    const supervisor = make();
    await supervisor.start();
    const statePid = supervisor.status.statePid;
    const oldRuntimePid = supervisor.status.runtimePid!;

    supervisor.deactivateRuntime();
    expect(supervisor.status).toMatchObject({ state: "ready", runtime: "stopped", statePid });
    await expect(supervisor.runtime.health()).rejects.toThrow(/runtime service is unavailable/);
    expect((await supervisor.state.health()).ok).toBe(true);
    await eventually(() => {
      try { process.kill(oldRuntimePid, 0); return false; } catch { return true; }
    });

    const appDir = bundledAppDir("session-plus");
    const candidate = await supervisor.prepareRuntime(appDir, backendRelease(appDir).backendCodeDigest);
    supervisor.commitRuntime(candidate, "swap");
    expect(supervisor.status).toMatchObject({ state: "ready", runtime: "ready", statePid });
    expect(supervisor.status.runtimePid).not.toBe(oldRuntimePid);
    expect((await supervisor.runtime.health()).ok).toBe(true);

    const retainedDigest = backendRelease(appDir).backendCodeDigest;
    expect(supervisor.addRuntimeReference(retainedDigest)).toBe(true);
    const next = backendVariant("deactivate-all");
    const nextCandidate = await supervisor.prepareRuntime(next.appDir, next.digest);
    supervisor.commitRuntime(nextCandidate, "retain");
    const runtimePids = supervisor.runtimeVersions().map((row) => row.pid).filter((pid): pid is number => Boolean(pid));
    expect(runtimePids).toHaveLength(2);

    supervisor.deactivateRuntime();
    expect(supervisor.runtimeVersions()).toEqual([]);
    expect(supervisor.status).toMatchObject({ state: "ready", runtime: "stopped", statePid });
    await eventually(() => runtimePids.every((pid) => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }));
    expect((await supervisor.state.health()).ok).toBe(true);
  }, 20_000);

  it("unwinds the state child when runtime startup fails", async () => {
    const supervisor = make({ runtimeModulePath: `${runtimeMain}.missing` });
    await expect(supervisor.start()).rejects.toThrow();
    expect(supervisor.status).toMatchObject({ state: "down", runtime: "down" });
    expect(supervisor.status.statePid).toBeUndefined();
  });
});

/**
 * One pair of children per app.
 *
 * The registry is thin, so what is asserted is the three things it exists to
 * make structural: every app gets its OWN state directory (two apps sharing one
 * would interleave their commit files, and no later check could separate them
 * again), an id that is about to become a directory name is checked before it
 * is used as one, and a duplicate registration is a loud composition error
 * rather than a second supervisor nobody can reach.
 */
describe("AppBackendRegistry", () => {
  function registry(overrides: Partial<ConstructorParameters<typeof AppBackendRegistry>[0]> = {}) {
    const root = mkdtempSync(join(tmpdir(), "app-backends-"));
    dirs.push(root);
    return {
      root,
      registry: new AppBackendRegistry({
        stateRoot: root,
        stateModulePath: stateMain,
        runtimeModulePath: runtimeMain,
        execArgv: ["--import", "tsx"],
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
        restartDelaysMs: [20, 40],
        retainedRestartDelaysMs: [20, 40],
        ...overrides,
      }),
    };
  }

  it("gives each app its own state directory", async () => {
    const { root, registry: apps } = registry();
    const first = apps.register("session-plus", { appDir: bundledAppDir("session-plus") });
    const second = apps.register("demo-app", { appDir: bundledAppDir("session-plus") });
    supervisors.push(first, second);
    expect(apps.ids()).toEqual(["session-plus", "demo-app"]);
    expect(apps.get("session-plus")).toBe(first);
    expect(apps.get("nobody")).toBeNull();
    expect(first).not.toBe(second);

    // Proven by starting one: the directory it commits into is named by its id,
    // not shared with the sibling that has not started.
    await first.start({ runtime: false });
    expect(existsSync(join(root, "session-plus"))).toBe(true);
    expect(existsSync(join(root, "demo-app"))).toBe(false);
    await apps.stopAll();
    expect(first.status).toMatchObject({ state: "stopped", runtime: "stopped" });
  }, 20_000);

  it("refuses an id it cannot use as a directory name, and a duplicate", () => {
    const { registry: apps } = registry();
    for (const bad of ["../escape", "Session-Plus", "", "a/b", "x".repeat(80)]) {
      expect(() => apps.register(bad, { appDir: bundledAppDir("session-plus") }), bad).toThrow();
    }
    supervisors.push(apps.register("session-plus", { appDir: bundledAppDir("session-plus") }));
    expect(() => apps.register("session-plus", { appDir: bundledAppDir("session-plus") })).toThrow(/already has/);
  });

  it("refuses excess hosted Apps with a stable bounded reason", () => {
    const { registry: apps } = registry({ maxHostedApps: 2 });
    supervisors.push(
      apps.register("session-plus", { appDir: bundledAppDir("session-plus") }),
      apps.register("demo-app", { appDir: bundledAppDir("session-plus") }),
    );

    let refusal: unknown;
    try {
      apps.register("third-app", { appDir: bundledAppDir("session-plus") });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AppBackendCapacityExceeded);
    expect(refusal).toMatchObject({ code: "app_backend_capacity", limit: 2 });
    expect(String((refusal as Error).message).length).toBeLessThanOrEqual(120);
    expect(apps.ids()).toEqual(["session-plus", "demo-app"]);
  });

  it("enforces the process-wide retained limit across App supervisors", async () => {
    const { registry: apps } = registry({
      maxRetainedRuntimes: 1,
      maxRetainedRuntimesGlobal: 1,
      retainedLingerMs: 60_000,
    });
    const first = apps.register("first-app", { appDir: bundledAppDir("session-plus") });
    const second = apps.register("second-app", { appDir: bundledAppDir("session-plus") });
    supervisors.push(first, second);
    await Promise.all([first.start(), second.start()]);
    const originalDigest = backendRelease(bundledAppDir("session-plus")).backendCodeDigest;
    expect(first.addRuntimeReference(originalDigest)).toBe(true);
    expect(second.addRuntimeReference(originalDigest)).toBe(true);

    const firstNext = backendVariant("global-first");
    const firstCandidate = await first.prepareRuntime(firstNext.appDir, firstNext.digest);
    first.commitRuntime(firstCandidate, "retain");
    expect(first.runtimeVersions().some((row) => row.role === "retained")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const secondNext = backendVariant("global-second");
    const secondCandidate = await second.prepareRuntime(secondNext.appDir, secondNext.digest);
    second.commitRuntime(secondCandidate, "retain");

    expect(first.runtimeVersions()).toMatchObject([{ backendCodeDigest: firstNext.digest, role: "active" }]);
    expect(second.runtimeVersions()).toMatchObject([
      { backendCodeDigest: secondNext.digest, role: "active" },
      { backendCodeDigest: originalDigest, role: "retained" },
    ]);
    await expect(first.runtime.project({ backendCodeDigest: originalDigest, events: [] }))
      .rejects.toMatchObject({ reason: "version_retired" });
    expect((await first.runtime.health()).backendCodeDigest).toBe(firstNext.digest);
    expect((await second.runtime.health()).backendCodeDigest).toBe(secondNext.digest);
  }, 40_000);
});
