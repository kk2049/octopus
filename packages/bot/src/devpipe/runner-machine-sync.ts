/**
 * Sync an exact commit into a workspace on a machine reached ONLY through its
 * Runner (2026-08-20, generalised 2026-08-21).
 *
 * `ops/ci-container/sync-workspace.sh` does the same job over ssh for the
 * lht-val15 CI box, and it was the transport every development turn paid for:
 * ten serial ssh round trips through a bastion that intermittently stalls,
 * with one 240 s timeout per failure (ticket #285 lost four of them, twenty
 * minutes, to a sync that never finished). The Runner is already connected
 * the other way round — it dialled the bot — so the same five steps run as
 * `exec` calls on that channel and the bytes travel as a one-shot bundle URL
 * (`bundle-handoff.ts`) the machine downloads, instead of the bot host scp-ing
 * a file in. A contributor's laptop has no ssh from the bot host at all, which
 * is what this transport was first written for; the CI box now uses it too.
 *
 * What travels: a git bundle of the commits the machine lacks — never a
 * remote, never a credential. What the machine keeps: the shared object-store
 * checkout (`/work/octopus`) plus one detached worktree per workspace key
 * with its own node_modules: `/work/tickets/ticket-<id>` for a ticket's own
 * draft space, and the pipeline-owned landing workspace the gate uses
 * (`remote-gate.ts`). Same layout as the ssh script, so the agent's
 * instructions are the same whichever transport prepared the tree.
 *
 * Every step is bounded by the Runner's `exec` ceiling (5 min). The cold
 * install of a brand-new workspace may not fit in one step on a slow network;
 * the sync reports which step failed and the next sync resumes warm.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../logger.js";
import { git, gitOrThrow } from "./worktree.js";
import type { BundleHandoff } from "./bundle-handoff.js";

const log = createLogger("runner-machine-sync");

/** Per-step ceiling; the Runner refuses anything above `execTimeoutMaxMs`. */
const STEP_TIMEOUT_MS = 300_000;
const FETCH_TIMEOUT_MS = 120_000;
/** How many of the machine's known tips are offered as bundle exclusions. */
const MAX_BASIS_REFS = 64;
/**
 * The install and the builds run at CPU nice 10 and idle IO priority (when
 * `ionice` exists — a contributor's laptop may be macOS). They share the box
 * with the Runner that carries them, with sshd, and with other tickets; none
 * of those should wait behind a workspace build (2026-08-22).
 */
const LOW_PRIORITY = "nice -n 10 $(command -v ionice >/dev/null 2>&1 && echo ionice -c 3)";

/**
 * The workspace packages a ticket workspace builds after every sync so the
 * agent's first `tsc`/vitest in there is about the candidate, not about a
 * missing `dist/` (same three `ops/ci-container/sync-workspace.sh` builds).
 */
export const TEST_READY_BUILD_FILTERS: readonly string[] = [
  "@claude-bot/runner",
  "@claude-bot/plugin-sessions",
  "@claude-bot/dashboard-web",
];

export interface MachineExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code?: number | string | null;
  timed_out?: boolean;
}

/** The one capability this module needs: run a shell command on the device. */
export type MachineExec = (args: { command: string; cwd?: string; timeout_ms?: number }) => Promise<MachineExecResult>;

export interface RunnerWorkspaceSyncInput {
  /** The worktree on the bot host whose `ref` is shipped. */
  sourceDir: string;
  ref: string;
  /**
   * Names the workspace on the machine: `ticket-<id>` for a ticket's draft
   * space, `land` for the pipeline-owned gate tree. Also names the transfer
   * ref and the bundle file, so concurrent syncs never share either.
   */
  key: string;
  /** Absolute path of the detached worktree on the machine. */
  workspace: string;
  /** Object-store checkout on the machine, e.g. `/work/octopus`. */
  checkoutDir: string;
  /** Where the one-shot bundle URL is served: the dashboard's public base. */
  publicUrl: string;
  exec: MachineExec;
  bundles: BundleHandoff;
  /**
   * `pnpm install --frozen-lockfile --prefer-offline` after the checkout
   * (default true). The landing gate runs that install as its own first step
   * — it is also the stale-lockfile check — so it asks for the bare tree.
   */
  install?: boolean;
  /** Workspace builds after the install (default `TEST_READY_BUILD_FILTERS`; `[]` = none). */
  buildFilters?: readonly string[];
  /**
   * Remove ignored outputs and dependencies before install. Dedicated
   * deterministic build workspaces enable this; ticket workspaces stay warm.
   */
  cleanIgnored?: boolean;
}

export interface RunnerMachineSyncInput {
  /** The ticket worktree on the bot host whose HEAD is shipped. */
  sourceDir: string;
  ref: string;
  ticketId: number;
  /** Object-store checkout inside the container, e.g. `/work/octopus`. */
  checkoutDir: string;
  /** Where the one-shot bundle URL is served: the dashboard's public base. */
  publicUrl: string;
  exec: MachineExec;
  bundles: BundleHandoff;
}

export interface RunnerMachineSyncResult {
  ok: boolean;
  sha?: string;
  checkoutDir: string;
  detail: string;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A ticket's own draft workspace: `<work>/tickets/ticket-<id>`. */
export function ticketWorkspacePath(checkoutDir: string, ticketId: number): string {
  return path.posix.join(path.posix.dirname(checkoutDir), "tickets", `ticket-${ticketId}`);
}

/**
 * Mirror of `sync-workspace.sh`, expressed as Runner exec calls. Returns the
 * workspace path the agent should `cd` into.
 */
export async function syncTicketWorkspaceViaRunner(input: RunnerMachineSyncInput): Promise<RunnerMachineSyncResult> {
  return await syncWorkspaceViaRunner({
    sourceDir: input.sourceDir,
    ref: input.ref,
    key: `ticket-${input.ticketId}`,
    workspace: ticketWorkspacePath(input.checkoutDir, input.ticketId),
    checkoutDir: input.checkoutDir,
    publicUrl: input.publicUrl,
    exec: input.exec,
    bundles: input.bundles,
  });
}

/**
 * Bring `workspace` on the machine to exactly `ref` of `sourceDir`.
 *
 *   1. probe — does the object store already hold the commit? then no bytes
 *      travel;
 *   2. otherwise bundle what it lacks (incremental against its HEAD when the
 *      bot host knows that commit) and let the machine `curl` it once;
 *   3. materialise or move the detached worktree, `reset --hard`, then clean
 *      tracked/untracked state (ticket workspaces keep node_modules/dist;
 *      deterministic builders may remove ignored state too);
 */
export async function syncWorkspaceViaRunner(input: RunnerWorkspaceSyncInput): Promise<RunnerMachineSyncResult> {
  if (!/^[A-Za-z0-9_-]+$/.test(input.key)) {
    return { ok: false, checkoutDir: input.workspace, detail: `非法的工作区键: ${input.key}` };
  }
  const objectRepo = input.checkoutDir;
  const workspace = input.workspace;
  const workspaceRoot = path.posix.dirname(workspace);
  const remoteBundle = path.posix.join(path.posix.dirname(objectRepo), `sync-${input.key}.bundle`);
  const q = shellQuote;
  const install = input.install ?? true;
  const buildFilters = input.buildFilters ?? TEST_READY_BUILD_FILTERS;
  const cleanArgs = input.cleanIgnored ? "-fdqx" : "-fdq -e node_modules -e dist";

  const run = async (label: string, command: string, timeoutMs = STEP_TIMEOUT_MS): Promise<MachineExecResult> => {
    const res = await input.exec({ command, timeout_ms: timeoutMs });
    if (!res.ok) {
      log.warn({ key: input.key, step: label, stderr: res.stderr.slice(-400) }, "runner sync step failed");
    }
    return res;
  };

  let want: string;
  try {
    want = await gitOrThrow(input.sourceDir, ["rev-parse", "--verify", `${input.ref}^{commit}`]);
  } catch (err) {
    return { ok: false, checkoutDir: workspace, detail: `读不到 ${input.ref}: ${String(err).slice(0, 200)}` };
  }

  // 1. Does the machine already hold the commit? Then no bytes travel.
  const has = await run("probe", `git -C ${q(objectRepo)} cat-file -e ${q(`${want}^{commit}`)} && echo HAVE || echo MISSING`, 60_000);
  if (!has.ok && !/MISSING/.test(has.stdout)) {
    return { ok: false, checkoutDir: workspace, detail: `容器里的对象库不可用(${objectRepo}):${(has.stderr || has.stdout).slice(-300)}` };
  }
  if (!/HAVE/.test(has.stdout)) {
    // 2. What does it have, so the bundle can be incremental? Every branch tip
    // and every earlier transfer ref counts as a basis the bot host also
    // knows: the object store's own HEAD never moves, so excluding only it
    // would ship the whole history since the seed on every sync.
    const known = await run(
      "basis",
      `git -C ${q(objectRepo)} for-each-ref --format='%(objectname)' refs/heads refs/remotes/ticket-sync | head -n ${MAX_BASIS_REFS};`
        + ` git -C ${q(objectRepo)} rev-parse --verify HEAD 2>/dev/null || true`,
      60_000,
    );
    const basis: string[] = [];
    for (const line of new Set(known.stdout.split("\n").map((l) => l.trim()))) {
      if (!/^[0-9a-f]{40}$/.test(line) || basis.length >= MAX_BASIS_REFS) continue;
      if ((await git(input.sourceDir, ["cat-file", "-e", `${line}^{commit}`])).ok) basis.push(line);
    }
    const tmp = await mkdtemp(path.join(tmpdir(), `octopus-${input.key}-`));
    const bundle = path.join(tmp, "sync.bundle");
    // Bundles export named refs, not raw object ids. Pin the resolved commit
    // under a unique temporary ref so a moving branch cannot change this sync.
    const exportRef = `refs/octopus/workspace-sync/${randomUUID()}`;
    try {
      await gitOrThrow(input.sourceDir, ["update-ref", exportRef, want, "0".repeat(40)]);
      await gitOrThrow(input.sourceDir, ["bundle", "create", bundle, ...basis.map((sha) => `^${sha}`), exportRef]);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      return { ok: false, checkoutDir: workspace, detail: `打包 bundle 失败: ${String(err).slice(0, 200)}` };
    } finally {
      await git(input.sourceDir, ["update-ref", "-d", exportRef, want]);
    }
    // 3. One-shot URL; the machine pulls it and fetches into a transfer ref.
    const token = input.bundles.offer(bundle, { cleanup: true, purpose: "workspace-sync", identity: want });
    const url = `${input.publicUrl.replace(/\/+$/, "")}/api/contrib/bundle/${token}`;
    const fetched = await run(
      "fetch",
      `set -e; curl -fsSL --max-time ${Math.floor(FETCH_TIMEOUT_MS / 1000)} -o ${q(`${remoteBundle}.new`)} ${q(url)}`
        + ` && mv ${q(`${remoteBundle}.new`)} ${q(remoteBundle)}`
        + ` && git -C ${q(objectRepo)} fetch --quiet ${q(remoteBundle)} ${q(`+${exportRef}:refs/remotes/ticket-sync/${input.key}`)}`
        + ` && git -C ${q(objectRepo)} cat-file -e ${q(`${want}^{commit}`)}`,
      FETCH_TIMEOUT_MS + 60_000,
    );
    input.bundles.revoke(token);
    await rm(tmp, { recursive: true, force: true });
    if (!fetched.ok) {
      return { ok: false, checkoutDir: workspace, detail: `容器拉取 bundle 失败:${(fetched.stderr || fetched.stdout).slice(-300)}` };
    }
  }

  // 4. Materialise / move the detached worktree.
  const tree = await run(
    "worktree",
    `set -e; mkdir -p ${q(workspaceRoot)};`
      + ` if git -C ${q(workspace)} rev-parse --git-dir >/dev/null 2>&1; then git -C ${q(workspace)} reset --hard --quiet ${q(want)};`
      + ` else git -C ${q(objectRepo)} worktree prune; git -C ${q(objectRepo)} worktree add --quiet --detach ${q(workspace)} ${q(want)}; fi;`
      + ` git -C ${q(workspace)} clean ${cleanArgs};`
      + ` git config --global --add safe.directory ${q(workspace)} || true`,
    120_000,
  );
  if (!tree.ok) {
    return { ok: false, checkoutDir: workspace, detail: `容器工作树切换失败:${(tree.stderr || tree.stdout).slice(-300)}` };
  }
  if (!install) {
    return { ok: true, sha: want, checkoutDir: workspace, detail: `sync: workspace ${workspace} now at ${want.slice(0, 12)} (${input.ref}, checkout only)` };
  }

  // 5. Warm relink + the test-ready builds, each its own bounded step.
  // Lowest CPU/IO priority for the heavy steps: the box also hosts the Runner
  // (whose keepalive must keep answering), sshd, and other tickets' work.
  const installed = await run("install", `cd ${q(workspace)} && ${LOW_PRIORITY} pnpm install --frozen-lockfile --prefer-offline`);
  if (!installed.ok) {
    return {
      ok: false,
      sha: want,
      checkoutDir: workspace,
      detail: `代码已到 ${want.slice(0, 12)},但 pnpm install 未完成(可能超时,再次同步会接着装):${(installed.stderr || installed.stdout).slice(-300)}`,
    };
  }
  if (buildFilters.length) {
    const build = await run(
      "build",
      `cd ${q(workspace)} && ${LOW_PRIORITY} pnpm ${buildFilters.map((f) => `--filter ${q(f)}`).join(" ")} build`,
    );
    if (!build.ok) {
      return {
        ok: false,
        sha: want,
        checkoutDir: workspace,
        detail: `代码与依赖已就绪,但测试前置构建失败:${(build.stderr || build.stdout).slice(-300)}`,
      };
    }
  }
  return { ok: true, sha: want, checkoutDir: workspace, detail: `sync: workspace ${workspace} now at ${want.slice(0, 12)} (${input.ref})` };
}
