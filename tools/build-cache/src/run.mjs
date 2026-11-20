/**
 * The wrapper each package's `build` script runs through.
 *
 *   "build": "node ../../tools/build-cache/bin/octo-build.mjs -- '<real build>'"
 *
 * On a hit it restores the previous output and exits; on a miss it runs the
 * real command unchanged and stores the result. The wrapped command is never
 * modified, so a cache that is disabled, unavailable or wrong degrades to
 * exactly the build that would have run anyway.
 *
 * Every failure mode here is "just build it": no HOME, no workspace root, an
 * unreadable manifest, a corrupt entry, a full disk. A build tool must not
 * acquire new ways to fail in exchange for being faster.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildKey, findRepoRoot, globalInputHash, loadWorkspace, packageFingerprint } from "./fingerprint.mjs";
import { defaultCacheDir, pruneEntries, removeEntry, restoreEntry, saveEntry } from "./store.mjs";

/**
 * `OCTO_BUILD_CACHE`: `0`/`off`/`false` disables it entirely, `refresh`
 * rebuilds and re-stores (the way to prove the cache and a cold build agree),
 * anything else leaves it on.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {"on" | "off" | "refresh"}
 */
export function cacheMode(env) {
  const raw = String(env.OCTO_BUILD_CACHE ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return "off";
  if (raw === "refresh") return "refresh";
  return "on";
}

/**
 * Everything needed to look one build up, or null when this tree cannot be
 * keyed (outside the workspace, unnamed package, no cache directory).
 *
 * @param {{ cwd: string; command: string; outputs: readonly string[]; env: NodeJS.ProcessEnv }} input
 * @returns {{ cacheDir: string; packageName: string; key: string } | null}
 */
export function planFor(input) {
  const cacheDir = defaultCacheDir(input.env);
  if (!cacheDir) return null;
  const repoRoot = findRepoRoot(input.cwd);
  if (!repoRoot) return null;
  let packageName;
  try {
    packageName = JSON.parse(readFileSync(path.join(input.cwd, "package.json"), "utf8"))?.name;
  } catch {
    return null;
  }
  if (typeof packageName !== "string" || !packageName) return null;
  const workspace = loadWorkspace(repoRoot);
  if (!workspace.has(packageName)) return null;
  const packageHash = packageFingerprint(workspace, packageName, { globalHash: globalInputHash(repoRoot) });
  return { cacheDir, packageName, key: buildKey({ packageHash, command: input.command, outputs: input.outputs }) };
}

/**
 * @param {string} command
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
function defaultSpawn(command, cwd, env) {
  return new Promise((resolve) => {
    // `shell: true` keeps `&&` chains (tsup + prepare-package) working exactly
    // as they did as a plain npm script, and keeps `node_modules/.bin` on PATH.
    const child = spawn(command, { cwd, env, shell: true, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

/**
 * @typedef {object} CachedBuildResult
 * @property {"hit" | "built" | "failed"} status
 * @property {number} exitCode
 * @property {string | null} key
 * @property {boolean} stored
 * @property {number} ms
 */

/**
 * @param {{
 *   cwd?: string,
 *   command: string,
 *   outputs?: readonly string[],
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: (command: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<number>,
 *   log?: (line: string) => void,
 *   keep?: number,
 *   now?: () => number,
 * }} opts
 * @returns {Promise<CachedBuildResult>}
 */
export async function runCachedBuild(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const outputs = opts.outputs ?? ["dist"];
  const spawnFn = opts.spawn ?? defaultSpawn;
  const log = opts.log ?? ((line) => console.log(line));
  if (env.OCTOPUS_COMPUTE_ROLE === "control") {
    log("[build-cache] 控制节点不执行构建或缓存缺失回退；请由已登记执行 provider 提供完整发布产物");
    return { status: "failed", exitCode: 78, key: null, stored: false, ms: 0 };
  }
  const clock = opts.now ?? (() => Date.now());
  const mode = cacheMode(env);

  let plan = null;
  if (mode !== "off") {
    try {
      plan = planFor({ cwd, command: opts.command, outputs, env });
    } catch (err) {
      log(`[build-cache] 指纹计算失败,按正常构建继续: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const label = plan ? `${plan.packageName} ${plan.key.slice(0, 12)}` : path.basename(cwd);

  if (plan && mode === "on") {
    try {
      const restored = await restoreEntry({
        cacheDir: plan.cacheDir,
        packageName: plan.packageName,
        key: plan.key,
        pkgDir: cwd,
        outputs,
      });
      if (restored.ok) {
        log(`[build-cache] 命中 ${label} — 复用已构建产物 ${restored.files} 个文件 / ${Math.round(restored.bytes / 1024)} KB,跳过构建`);
        return { status: "hit", exitCode: 0, key: plan.key, stored: false, ms: 0 };
      }
      if (restored.reason !== "miss") log(`[build-cache] 缓存条目不可用(${restored.reason}),改为正常构建 ${label}`);
    } catch (err) {
      log(`[build-cache] 恢复失败,改为正常构建: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const started = clock();
  const exitCode = await spawnFn(opts.command, cwd, env);
  const ms = clock() - started;
  if (exitCode !== 0) return { status: "failed", exitCode, key: plan?.key ?? null, stored: false, ms };

  let stored = false;
  if (plan) {
    // `refresh` is the repair path for an entry whose bytes are internally
    // intact but semantically stale. `saveEntry` deliberately preserves an
    // entry won by another writer, so remove this exact key only after the
    // replacement build succeeds; otherwise refresh would rebuild and then
    // silently leave the bad entry in place forever.
    if (mode === "refresh") {
      await removeEntry({ cacheDir: plan.cacheDir, packageName: plan.packageName, key: plan.key });
    }
    stored = await saveEntry({
      cacheDir: plan.cacheDir,
      packageName: plan.packageName,
      key: plan.key,
      pkgDir: cwd,
      outputs,
      command: opts.command,
      buildMs: ms,
    });
    if (stored) {
      await pruneEntries({ cacheDir: plan.cacheDir, packageName: plan.packageName, ...(opts.keep ? { keep: opts.keep } : {}) });
      log(`[build-cache] 已存档 ${label}(构建 ${Math.round(ms / 1000)}s),下次同内容构建可直接复用`);
    }
  }
  return { status: "built", exitCode: 0, key: plan?.key ?? null, stored, ms };
}

/**
 * Parse the wrapper's own argv: `[--out <dir>]... [--check-only] -- <command>`.
 * Everything after `--` is the untouched build command; `--check-only`
 * declares a build with no artifacts (a `tsc --noEmit` style verification),
 * whose cached result means "this exact content already passed".
 *
 * @param {readonly string[]} argv
 * @returns {{ outputs: string[]; command: string }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const outputs = [];
  let checkOnly = false;
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      i += 1;
      break;
    }
    if (arg === "--check-only") {
      checkOnly = true;
      continue;
    }
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error("--out 需要一个目录参数");
      outputs.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      outputs.push(arg.slice("--out=".length));
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  const command = argv.slice(i).join(" ").trim();
  if (!command) throw new Error("缺少要执行的构建命令(用 -- 分隔)");
  if (checkOnly && outputs.length) throw new Error("--check-only 与 --out 互斥");
  return { outputs: checkOnly ? [] : outputs.length ? outputs : ["dist"], command };
}
