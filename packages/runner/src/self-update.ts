/**
 * Runner self-update: the device keeps itself on the build the bot serves.
 *
 * Most Runners sit behind NAT on machines nobody can ssh into; the only
 * channel the bot has to them is the WebSocket they dialled. So the update
 * travels on that socket (gateway `bundle` frame: sha256 + base64 of the
 * standalone bundle) and is applied here in two steps that never overlap with
 * the running code:
 *
 *   1. stage — verify size and sha256, write `<scan home>/.octopus/runner/
 *      standalone.js` (the MANAGED PATH) atomically, keep the previous file
 *      as `standalone.prev.js` for rollback;
 *   2. hand over — an internal shim child exits with UPDATE_EXIT_CODE; other
 *      processes (including OS-supervised installs) become that shim:
 *      release every local resource,
 *      spawn `node <managed path>` with the same argv/env, and wait. The
 *      shim respawns on UPDATE_EXIT_CODE (the child staged a newer file) and
 *      restores the previous running file when a newly updated child dies
 *      within FAST_FAILURE_MS. The fallback skips only that broken digest,
 *      so a later corrected active build can update it normally.
 *
 * The Runner's identity on the wire is the sha256 of its own entry file. A
 * chunked `dist/index.js` never matches the standalone bundle's sha, which is
 * exactly the migration: the first update moves every install onto the
 * single-file managed path, and from then on the sha either matches or a new
 * bundle is pending.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** EX_TEMPFAIL: "restart me from the managed path; the file is already in place". */
export const UPDATE_EXIT_CODE = 75;
/** An updated child that dies this quickly is blamed on the bundle, not on the world. */
export const FAST_FAILURE_MS = 30_000;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{64}$/;

export interface SelfUpdateSettings {
  /** `RUNNER_SELF_UPDATE=0` keeps a device on whatever it runs. Default on. */
  enabled: boolean;
  /**
   * `OCTOPUS_RUNNER_SUPERVISED=1` — something restarts us when we exit (the
   * shim below sets it for its child; a container entrypoint or a systemd
   * unit may too). index.ts also requires the internal UPDATE_SHIM marker
   * before relying on exit 75; OS supervision alone cannot roll back a build.
   */
  supervised: boolean;
}

export function selfUpdateSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SelfUpdateSettings {
  return {
    enabled: env.RUNNER_SELF_UPDATE !== "0",
    supervised: env.OCTOPUS_RUNNER_SUPERVISED === "1",
  };
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 of a file, or null when it cannot be read (then no sha is reported). */
export function fileSha256(file: string): string | null {
  try {
    return sha256Hex(readFileSync(file));
  } catch {
    return null;
  }
}

export function managedRunnerDir(scanHome: string): string {
  return path.join(scanHome, ".octopus", "runner");
}

export function managedBundlePath(scanHome: string): string {
  return path.join(managedRunnerDir(scanHome), "standalone.js");
}

export function previousBundlePath(scanHome: string): string {
  return path.join(managedRunnerDir(scanHome), "standalone.prev.js");
}

export interface BundleFrame {
  sha: string;
  size: number;
  /** base64 of the bundle bytes. */
  data: string;
}

export function bundleFrameFrom(value: Record<string, unknown>): BundleFrame | null {
  const sha = typeof value.sha === "string" ? value.sha : "";
  const size = typeof value.size === "number" ? value.size : -1;
  const data = typeof value.data === "string" ? value.data : "";
  if (!SHA_RE.test(sha) || !Number.isInteger(size) || size <= 0 || size > MAX_BUNDLE_BYTES || !data) return null;
  return { sha, size, data };
}

export interface StagedBundle {
  path: string;
  sha: string;
  bytes: number;
  fallback?: string;
}

/**
 * Verify and install a bundle at the managed path. Throws on any mismatch and
 * leaves the managed path untouched in that case: the temp file is written
 * beside the target and only renamed once the bytes are proven.
 */
export function stageBundle(
  scanHome: string,
  frame: BundleFrame,
  running?: { file: string; sha: string | null },
): StagedBundle {
  const bytes = Buffer.from(frame.data, "base64");
  if (bytes.length !== frame.size) {
    throw new Error(`bundle size mismatch: announced ${frame.size}, received ${bytes.length}`);
  }
  const sha = sha256Hex(bytes);
  if (sha !== frame.sha) {
    throw new Error(`bundle sha mismatch: announced ${frame.sha.slice(0, 12)}, received ${sha.slice(0, 12)}`);
  }
  const dir = managedRunnerDir(scanHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = managedBundlePath(scanHome);
  const current = running?.file ?? target;
  const currentBytes = existsSync(current) ? readFileSync(current) : null;
  if (running && !currentBytes) throw new Error("running bundle is unreadable; cannot preserve rollback");
  if (running?.sha && (!currentBytes || sha256Hex(currentBytes) !== running.sha)) {
    throw new Error("running bundle changed on disk; cannot prove a safe rollback");
  }
  const tmp = path.join(dir, `standalone.${sha.slice(0, 12)}.${process.pid}.tmp`);
  writeFileSync(tmp, bytes, { mode: 0o644 });
  let fallback: string | undefined;
  if (currentBytes) {
    // Preserve the RUNNING bytes, including a process already on the previous
    // file. Never move target away before its atomic replacement is ready.
    const previous = previousBundlePath(scanHome);
    const backup = `${previous}.${process.pid}.tmp`;
    writeFileSync(backup, currentBytes, { mode: 0o644 });
    renameSync(backup, previous);
    // A chunked legacy entry must retain its relative imports at its old path.
    fallback = path.resolve(current) === target || path.resolve(current) === previous ? previous : current;
  }
  renameSync(tmp, target);
  return { path: target, sha, bytes: bytes.length, ...(fallback ? { fallback } : {}) };
}

export interface ShimOptions {
  /** The managed bundle to run. */
  managed: string;
  /** This process's own entry file — the last-known-good code. */
  fallback: string;
  /** argv after the entry file, forwarded verbatim. */
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  log: (msg: string) => void;
  /** Test seams. */
  execPath?: string;
  fastFailureMs?: number;
  spawnImpl?: typeof spawn;
  signalSource?: Pick<NodeJS.EventEmitter, "once" | "removeListener">;
}

function runOnce(
  entry: string,
  opts: ShimOptions,
  extraEnv: Record<string, string>,
): Promise<{ code: number; ms: number; stopped: boolean }> {
  const started = Date.now();
  const child = (opts.spawnImpl ?? spawn)(opts.execPath ?? process.execPath, [entry, ...opts.argv], {
    // Linux servers keep the supervisor's journal; Windows/macOS keep no log.
    stdio: process.platform === "linux" ? "inherit" : "ignore",
    windowsHide: true,
    env: { ...opts.env, OCTOPUS_RUNNER_SUPERVISED: "1", OCTOPUS_RUNNER_UPDATE_SHIM: "1", ...extraEnv },
  });
  return new Promise((resolve) => {
    const signals = opts.signalSource ?? process;
    let stopped = false;
    let stopTimer: NodeJS.Timeout | undefined;
    const stop = (signal: NodeJS.Signals) => {
      if (stopped) return;
      stopped = true;
      // Installed services use KillMode=process to preserve detached agents.
      // Forward only to the Runner we own, never its whole process group.
      stopTimer = setTimeout(() => { child.kill("SIGKILL"); }, 14_000);
      stopTimer.unref();
      child.kill(signal);
    };
    const term = () => stop("SIGTERM");
    const interrupt = () => stop("SIGINT");
    signals.once("SIGTERM", term);
    signals.once("SIGINT", interrupt);
    const finish = (code: number) => {
      if (stopTimer) clearTimeout(stopTimer);
      signals.removeListener("SIGTERM", term);
      signals.removeListener("SIGINT", interrupt);
      resolve({ code, ms: Date.now() - started, stopped });
    };
    child.once("exit", (code, signal) => {
      finish(code ?? (signal ? 128 : 1));
    });
    child.once("error", (err) => {
      opts.log(`cannot spawn ${entry}: ${err.message}`);
      finish(127);
    });
  });
}

/**
 * Become the supervisor of the managed bundle. Resolves with the exit code
 * this process should exit with. Never throws.
 */
export async function superviseManagedRunner(opts: ShimOptions): Promise<number> {
  const fastFailureMs = opts.fastFailureMs ?? FAST_FAILURE_MS;
  let fallbackEntry = opts.fallback;
  const previous = path.join(path.dirname(opts.managed), "standalone.prev.js");
  for (;;) {
    const attemptedSha = fileSha256(opts.managed);
    const fallbackSha = fileSha256(fallbackEntry);
    opts.log(`handing over to ${opts.managed}`);
    const { code, ms, stopped } = await runOnce(opts.managed, opts, {});
    if (stopped) return 0;
    if (code === UPDATE_EXIT_CODE) {
      opts.log("managed runner staged a newer bundle; restarting it");
      if (existsSync(previous)) fallbackEntry = previous;
      continue;
    }
    if (code !== 0 && ms < fastFailureMs) {
      opts.log(
        `managed runner exited ${code} after ${Math.round(ms / 1000)}s — treating the bundle as broken; ` +
          `running the previous build from ${fallbackEntry}; quarantining ${attemptedSha?.slice(0, 12) ?? "unknown digest"}`,
      );
      if (fallbackEntry === previous && fallbackSha && fileSha256(fallbackEntry) === fallbackSha
        && fileSha256(opts.managed) === attemptedSha) {
        try {
          const restored = `${opts.managed}.${process.pid}.rollback`;
          writeFileSync(restored, readFileSync(fallbackEntry), { mode: 0o644 });
          renameSync(restored, opts.managed);
        } catch (error) {
          opts.log(`cannot restore managed path: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const fallback = await runOnce(fallbackEntry, opts, {
        RUNNER_SELF_UPDATE_REJECTED_SHA: attemptedSha ?? "",
        // Without a digest there is no safe way to distinguish another build.
        ...(!attemptedSha ? { RUNNER_SELF_UPDATE: "0" } : {}),
      });
      if (fallback.stopped) return 0;
      if (fallback.code === UPDATE_EXIT_CODE) {
        if (existsSync(previous)) fallbackEntry = previous;
        continue;
      }
      return fallback.code;
    }
    return code;
  }
}
