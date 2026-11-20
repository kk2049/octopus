/**
 * The landing gate's steps, executed on the CI machine through its Runner
 * (2026-08-21).
 *
 * ── Why the gate left this node ────────────────────────────────────────────
 *
 * `land-gate.ts` was written for the 2-core bot host and sized accordingly:
 * install ≈3 s, dist-typed builds ≈15 s, warm tsc ≈8 s. Under real load the
 * numbers stopped being small. Ticket #285 (2026-08-21) measured, on this
 * host, typecheck 30–47 s, `pnpm -r build` up to 97 s and the knowledge
 * regression tests 147–234 s — while the ticket agent ran its own vitest next
 * door on the same two cores, and a Codex turn paid a model round trip for
 * every minute of waiting. The same steps inside the lht-val15 CI container
 * (48 cores, the suite's own image) measured install 3 s, cached build 3 s,
 * tsc 8 s warm / 26 s cold, a browser-project spec 7 s.
 *
 * So the gate keeps its contract — exact candidate tree, same commands, refuse
 * on red or timeout — and only changes WHERE the commands run. The machine is
 * reached the same way a ticket's draft workspace is (`runner-machine-sync.ts`):
 * a per-gate `exec` grant over the CI device's Runner, a one-shot bundle for
 * the bytes, and a pipeline-owned detached worktree (`<work>/land`, sibling of
 * the tickets) that no agent is told about. `_land` on this node stays the
 * serialisation point and the fallback: when the Runner is offline or the sync
 * fails, `LandGate.check` runs the very same step list locally.
 *
 * ── Detached steps ─────────────────────────────────────────────────────────
 *
 * A Runner `exec` is capped at five minutes per call and returns nothing until
 * the command ends. A cold `pnpm -r build` or a browser vitest batch can pass
 * that, and a gate that would be refused by the transport's ceiling rather than
 * by the code is not a gate. Each step is therefore started detached under
 * `setsid`, writes its output and exit code to files in the machine's gate
 * cache dir, and is polled with short `exec` calls until the rc file appears
 * or the step's deadline passes — at which point its whole process group is
 * killed and the step is reported as timed out, exactly like the local
 * `execFile` path. The transport failing mid-poll is a different kind of
 * event (the machine stopped answering): `RemoteGateUnavailable`, which the
 * caller turns into a local rerun, never into a pass.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import { createLogger } from "../logger.js";
import type { BundleHandoff } from "./bundle-handoff.js";
import { shellQuote, syncWorkspaceViaRunner, type MachineExec, type MachineExecResult } from "./runner-machine-sync.js";
import { gitOrThrow } from "./worktree.js";

const log = createLogger("remote-gate");

/** How often a running step is asked whether it finished. */
export const REMOTE_GATE_POLL_MS = 3_000;
const START_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
/** How much of a step's output is fetched back; the gate trims further. */
const TAIL_BYTES = 12_000;
/**
 * How long a running step's polls may keep failing before the machine is
 * declared unreachable. The Runner's WebSocket crosses the public internet
 * and its keepalive (15 s interval, 5 s ping budget) trips about once or
 * twice a day on this link; the runner is back within a minute or a few. The
 * step itself is detached and does not notice — so neither should the gate,
 * as long as it is still inside its own deadline. First measured on ticket
 * #288, 2026-08-21: three steps done on the machine, then one keepalive blip
 * during `pnpm -r build` threw the whole run back to this node.
 */
export const POLL_GRACE_MS = 180_000;

/** The machine stopped answering (grant closed, Runner offline, transport error). */
export class RemoteGateUnavailable extends Error {
  constructor(message: string, readonly kind: "offline" | "unknown" = "unknown") {
    super(message);
    this.name = "RemoteGateUnavailable";
  }
}

export interface RemoteStepResult {
  ok: boolean;
  timedOut: boolean;
  /** `$ bin args` + the output tail, with the workspace path rewritten to `.`. */
  log: string;
}

/**
 * One gate run's handle on the machine. Opened by the composition root per
 * `LandGate.check`, closed by the gate whatever the outcome.
 */
export interface RemoteGateSession {
  device: string;
  /** The landing workspace on the machine; every step's cwd. */
  workspace: string;
  /** Outside the workspace, on the machine: tsc buildinfo and step logs. */
  cacheDir: string;
  /** Bring the workspace to `HEAD` of `sourceDir` (which must be `sha`). */
  sync(sourceDir: string, sha: string): Promise<{ ok: boolean; detail: string; refusal?: "deps_build" | "timeout" | "remote_unavailable" }>;
  run(step: { id?: string; bin: string; args: readonly string[] }, timeoutMs: number): Promise<RemoteStepResult>;
  close(): void | Promise<void>;
}

/** Opens a session, or null when the machine cannot be used right now. */
export type RemoteGateOpener = () => RemoteGateSession | null;

export interface RunnerGateSessionInput {
  device: string;
  /** Object-store checkout on the machine, e.g. `/work/octopus`. */
  checkoutDir: string;
  publicUrl: string;
  bundles: BundleHandoff;
  exec: MachineExec;
  /** Revokes the grant behind `exec`. */
  close?: () => void;
  /** Test hooks. */
  pollMs?: number;
  pollGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The pipeline-owned landing workspace: `<work>/land`, beside `<work>/tickets`. */
export function landWorkspacePath(checkoutDir: string): string {
  return path.posix.join(path.posix.dirname(checkoutDir), "land");
}

/** Where the machine keeps the gate's incremental state, outside any tree. */
export function landGateCacheDir(checkoutDir: string): string {
  return path.posix.join(path.posix.dirname(checkoutDir), "land-gate-cache");
}

function describeExecFailure(res: MachineExecResult): string {
  return (res.stderr || res.stdout || String(res.exit_code ?? "")).slice(-300);
}

/** A session over a Runner `exec` capability. */
export function runnerGateSession(input: RunnerGateSessionInput): RemoteGateSession {
  const workspace = landWorkspacePath(input.checkoutDir);
  const cacheDir = landGateCacheDir(input.checkoutDir);
  const pollMs = input.pollMs ?? REMOTE_GATE_POLL_MS;
  const pollGraceMs = input.pollGraceMs ?? POLL_GRACE_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const q = shellQuote;
  let closed = false;

  const exec = async (command: string, timeoutMs: number): Promise<MachineExecResult> => {
    if (closed) throw new RemoteGateUnavailable("gate session already closed");
    try {
      return await input.exec({ command, timeout_ms: timeoutMs });
    } catch (err) {
      throw new RemoteGateUnavailable(err instanceof Error ? err.message : String(err));
    }
  };

  return {
    device: input.device,
    workspace,
    cacheDir,
    async sync(sourceDir, sha) {
      const head = await gitOrThrow(sourceDir, ["rev-parse", "HEAD"]);
      if (head !== sha) return { ok: false, detail: `候选树 HEAD ${head.slice(0, 12)} 不是要门禁的 ${sha.slice(0, 12)}` };
      // Step files a run abandoned (machine lost for longer than the grace
      // period, bot restarted mid-gate) are not worth a separate janitor.
      await exec(`mkdir -p ${q(cacheDir)} && find ${q(cacheDir)} -maxdepth 1 -name 'step-*' -mmin +180 -delete; true`, POLL_TIMEOUT_MS).catch(() => undefined);
      const synced = await syncWorkspaceViaRunner({
        sourceDir,
        ref: "HEAD",
        key: "land",
        workspace,
        checkoutDir: input.checkoutDir,
        publicUrl: input.publicUrl,
        bundles: input.bundles,
        exec: (args) => exec(args.command, args.timeout_ms ?? START_TIMEOUT_MS),
        install: false,
        buildFilters: [],
      });
      return { ok: synced.ok, detail: synced.detail };
    },
    async run(step, timeoutMs) {
      const id = randomBytes(6).toString("hex");
      const logFile = path.posix.join(cacheDir, `step-${id}.log`);
      const rcFile = `${logFile}.rc`;
      const pidFile = `${logFile}.pid`;
      const command = [step.bin, ...step.args].map(q).join(" ");
      const header = `$ ${step.bin} ${step.args.join(" ")}`;
      const rewrite = (text: string): string => text.split(workspace).join(".");
      const started = Date.now();
      const deadline = started + Math.max(1_000, timeoutMs);

      // Start detached: its own session so the whole tree can be killed on
      // timeout, stdio to files so the 5-minute exec ceiling never applies.
      const inner = `echo $$ > ${q(pidFile)}; ( ${command} ) > ${q(logFile)} 2>&1; echo $? > ${q(rcFile)}`;
      // Below the Runner and sshd in priority (nice 5), above the ticket
      // syncs (nice 10): a landing is the one thing somebody is waiting on.
      const start = await exec(
        `mkdir -p ${q(cacheDir)} && cd ${q(workspace)} && rm -f ${q(logFile)} ${q(rcFile)} ${q(pidFile)}`
          + ` && (setsid nice -n 5 bash -c ${q(inner)} </dev/null >/dev/null 2>&1 &) && echo started`,
        START_TIMEOUT_MS,
      );
      if (!start.ok || !/started/.test(start.stdout)) {
        throw new RemoteGateUnavailable(`无法在 ${input.device} 启动门禁步骤:${describeExecFailure(start)}`);
      }

      // Polls that fail are tolerated for POLL_GRACE_MS, measured from the
      // first failure, and only within the step's own deadline: the step is
      // running on the machine whether or not the Runner is reachable.
      let failingSince: number | null = null;
      let lastFailure = "";
      let tail = "";
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(pollMs, remaining));
        let poll: MachineExecResult | null = null;
        try {
          poll = await exec(
            `if [ -f ${q(rcFile)} ]; then echo "__RC=$(cat ${q(rcFile)})"; fi; tail -c ${TAIL_BYTES} ${q(logFile)} 2>/dev/null; true`,
            POLL_TIMEOUT_MS,
          );
        } catch (err) {
          if (closed) throw err;
          lastFailure = err instanceof Error ? err.message : String(err);
        }
        if (!poll?.ok) {
          if (poll) lastFailure = describeExecFailure(poll);
          failingSince ??= Date.now();
          if (Date.now() - failingSince >= pollGraceMs) {
            throw new RemoteGateUnavailable(`${input.device} 超过 ${Math.round(pollGraceMs / 1000)}s 不应答门禁轮询:${lastFailure}`);
          }
          continue;
        }
        if (failingSince !== null) {
          log.info({ device: input.device, step: step.id ?? step.bin, ms: Date.now() - failingSince }, "remote gate: machine answering again; step kept running meanwhile");
          failingSince = null;
        }
        const m = /^__RC=(-?\d+)\s*$/m.exec(poll.stdout);
        tail = poll.stdout.replace(/^__RC=-?\d+\s*$/m, "").replace(/^\n/, "");
        if (m) {
          const rc = Number(m[1]);
          log.info({ device: input.device, step: step.id ?? step.bin, rc, ms: Date.now() - started }, "remote gate step finished");
          await exec(`rm -f ${q(logFile)} ${q(rcFile)} ${q(pidFile)}`, POLL_TIMEOUT_MS).catch(() => undefined);
          return { ok: rc === 0, timedOut: false, log: `${header}\n${rewrite(tail)}` };
        }
      }
      // Deadline: kill the step's whole session, report it the way execFile's
      // SIGKILL path does, and never read a late rc as a verdict.
      await exec(
        `pid=$(cat ${q(pidFile)} 2>/dev/null); if [ -n "$pid" ]; then kill -KILL -- -"$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; fi;`
          + ` rm -f ${q(rcFile)} ${q(pidFile)}; tail -c ${TAIL_BYTES} ${q(logFile)} 2>/dev/null; rm -f ${q(logFile)}; true`,
        POLL_TIMEOUT_MS,
      ).then((r) => { if (r.ok && r.stdout) tail = r.stdout; }).catch(() => undefined);
      log.warn({ device: input.device, step: step.id ?? step.bin, ms: Date.now() - started }, "remote gate step timed out; killed");
      return { ok: false, timedOut: true, log: `${header}\n${rewrite(tail)}\n(超时,已终止)` };
    },
    close() {
      if (closed) return;
      closed = true;
      input.close?.();
    },
  };
}
