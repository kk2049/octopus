/**
 * Republishing an Agentic App after one of its tickets lands.
 *
 * ── The one hard question: which tree do we pack? ───────────────────────────
 *
 * `buildCheckoutBundle()` reads paths relative to its own module, so calling it
 * in the bot process packs THE RUNNING PROCESS'S checkout — which is whatever
 * was last deployed, not what just merged. A deploy and a merge are different
 * events on purpose (deploying trusted code deliberately does not move any App's
 * active pointer), so those two trees are routinely different, and packing the
 * wrong one would publish yesterday's View under the claim that it is the change
 * that just landed. Internally consistent, completely wrong.
 *
 * So the packer runs as a SUBPROCESS in a selected checkout:
 *
 *   · the deployed run tree, already built at the commit that is live, or a
 *     complete staged release whose changes over it are App/View-only (its
 *     App artifacts were built by CI with that release);
 *   · an explicit App-only publication may instead use that App ticket's
 *     path-gated worktree and run only its composition-root View build first;
 *     ordinary/CLI debt is never allowed to pack from an ahead worktree;
 *   · it is the same `pnpm run app:pack` a human would type, so there is one
 *     packing path rather than a second one that could drift from it.
 *
 * Everything after packing is in-process and goes through the ordinary catalog
 * API — `install()` recomputes every digest from the bytes, `activate()` runs
 * the documented inspect → prepare → origin → runtime-health → pointer order.
 * This module adds no shortcut around either.
 *
 * ── What this module is NOT ─────────────────────────────────────────────────
 *
 * Not an authorization decision. `prepare()` is called only after the pipeline
 * resolved a landed ticket closure, while `publish()` is bound to the
 * automatic and Administer debt drains. Which caller may proceed to `activate()` is a property
 * of those composition seams, not this byte-moving helper. And it is not a
 * grant: activating a release grants it nothing, and a release
 * whose permission contract changed still faces every user's consent door.
 *
 * Not a rollback either. A failed activation leaves the previous release serving
 * (that ordering is `HostedApp`'s, not ours) and leaves the merge alone — the
 * code passed its gates; what failed is publication.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { packageHostLabel } from "@claude-bot/app-registry";
import { createLogger } from "../logger.js";
import { parseBundle } from "../app-registry/bundle.js";
import type { AppReleaseHost } from "../app-registry/release-host.js";
import { appScopeFor } from "./app-scopes.js";
import { runChild, stepLogTail, tailBytesFor } from "./child-output.js";
import type {
  AppHotswapExecutor,
  AppHotswapPreparedOutcome,
  AppHotswapPreviewOutcome,
  AppReleaseRefresher,
  AppReleaseRefreshOutcome,
} from "./pipeline.js";

const log = createLogger("app-ticket-refresh");

/** Packing is a build step in a prepared tree; five minutes is head-room. */
export const PACK_TIMEOUT_MS = 300_000;
/** A single App Vite build is bounded separately from packing. */
export const VIEW_BUILD_TIMEOUT_MS = 300_000;
/** A bundle is ~1 MB of base64 today; the parser applies the real bounds. */
const MAX_BUNDLE_FILE_BYTES = 24 * 1024 * 1024;

export interface AppTicketRefreshOptions {
  host: AppReleaseHost;
  /**
   * Debt drains (automatic and Administer) may compose a repository-owned App
   * before installing its first release; an agent approval request never does.
   */
  declareApp?: (input: {
    stableAppId: string;
    publisher: string;
    title: string;
    by: string;
  }) => Promise<
    | { ok: true; app: string; publisher: string; title: string }
    | { ok: false; code: "invalid" | "app_exists" | "compose_failed"; message: string }
  >;
  /**
   * Test seam. Production spawns `pnpm run app:pack -- --out <file>` in the
   * worktree; a test hands back a bundle document without a subprocess.
   */
  pack?: (input: { worktree: string; script: string; out: string }) => Promise<{ ok: boolean; log: string }>;
  /** Test seam for the App-scoped View build used by hot publication. */
  buildView?: (input: { worktree: string; project: string }) => Promise<{ ok: boolean; log: string }>;
  remotePack?: (input: { worktree: string; script: string; out: string }) => Promise<{ ok: boolean; log: string }>;
}

/**
 * Build the prepare/preview/activate mechanics plus the direct operator/deploy
 * publisher. The composition root binds both narrow surfaces once the catalog
 * exists; the agent path receives the split mechanics and cannot call the
 * direct publisher.
 */
export function createAppTicketReleaseTools(
  options: AppTicketRefreshOptions,
): AppHotswapExecutor & { publish: AppReleaseRefresher } {
  const packFn = options.pack ?? runPackScript;
  const buildViewFn = options.buildView ?? runViewBuild;

  const prepare = async function prepareAppRelease(input: {
    appId: string;
    worktree: string;
    ticketId: number;
    actor: string;
    declareMissing?: boolean;
    prepareView?: boolean;
  }): Promise<AppHotswapPreparedOutcome> {
    const { appId } = input;
    const scope = appScopeFor(appId);
    // Two separate "this build cannot do it" answers, kept apart because they
    // send a reader to two different places: no packer is a repository fact
    // (nobody has written one for this App), no hosted app is a deployment fact
    // (this process does not serve it).
    if (!scope?.packScript) {
      return {
        ok: false,
        appId,
        step: "unsupported",
        code: scope ? "no_packer" : "not_ticketable",
        message: scope
          ? `本仓库没有 ${appId} 的打包脚本(APP_TICKET_SCOPES 里 packScript 为空)。`
            + `这个 App 的产物要由它自己的构建方 pack 好之后在 /apps 安装并激活。`
          : `${appId} 不在本仓库的 APP_TICKET_SCOPES 里,没有可执行的打包路径。`,
      };
    }
    let app = options.host.app(appId);
    if (!app && (!input.declareMissing || !options.declareApp)) {
      return {
        ok: false,
        appId,
        step: "unsupported",
        code: "unknown_app",
        message:
          `本进程没有服务 ${appId} 这个 App(服务的是:${options.host.ids().join("、") || "（没有）"}),`
          + `所以没有可移动的 active 指针。代码已合入基线。`,
      };
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devpipe-apppack-"));
    const out = path.join(dir, "release.json");
    try {
      if (process.env.OCTOPUS_COMPUTE_ROLE === "control" && !options.remotePack) {
        return { ok: false, appId, step: "pack", code: "remote_pack_unavailable", message: "App 发布需要远端构建 provider；不会在控制节点编译" };
      }
      if (input.prepareView && !options.remotePack) {
        const project = scope.projects[0];
        if (!project) {
          return {
            ok: false,
            appId,
            step: "pack",
            code: "view_build_unconfigured",
            message: `${appId} 没有可定向构建的 View project。`,
          };
        }
        const built = await buildViewFn({ worktree: input.worktree, project });
        if (!built.ok) {
          return {
            ok: false,
            appId,
            step: "pack",
            code: "view_build_failed",
            message: tail(built.log),
          };
        }
      }
      const packed = await (options.remotePack ?? packFn)({ worktree: input.worktree, script: scope.packScript, out });
      if (!packed.ok) {
        return {
          ok: false,
          appId,
          step: "pack",
          code: "pack_failed",
          // The packer's own refusals are the informative ones — a stale View
          // build, a module plan that does not link, a missing dist — so its
          // output tail is the message rather than a paraphrase of it.
          message: tail(packed.log),
        };
      }

      const document = await readBundleDocument(out);
      if (!document.ok) {
        return { ok: false, appId, step: "pack", code: "pack_unreadable", message: document.error };
      }
      const parsed = parseBundle(document.value);
      if (!parsed.ok) {
        return { ok: false, appId, step: "pack", code: "bundle_rejected", message: parsed.error };
      }
      // The bundle names its own app, and `install()` routes on that. Checking
      // it here as well is not redundant: it is how "the ticket said session-plus
      // and the packer produced something else" becomes a refusal naming the
      // ticket's App rather than an `unknown_app` naming the bundle's.
      const packedApp = parsed.bundle.descriptor.stableAppId;
      if (packedApp !== appId) {
        return {
          ok: false,
          appId,
          step: "pack",
          code: "wrong_app",
          message: `本票是 ${appId} 的 App 工单,但打包脚本产出的是 ${packedApp} 的 release,拒绝安装。`,
        };
      }

      // Declaring an App is a durable host-level decision taken only by a debt
      // drain for a reviewed repository App (`declareMissing`). An agent's
      // approval request still refuses an unknown App before packing. A
      // disabled declaration is never re-enabled here.
      if (!app) {
        const declared = await options.declareApp!({
          stableAppId: packedApp,
          publisher: parsed.bundle.descriptor.publisher,
          title: scope.title,
          by: input.actor,
        });
        app = options.host.app(appId);
        if (!declared.ok && !app) {
          return {
            ok: false,
            appId,
            step: "unsupported",
            code: `declare_${declared.code}`,
            message: declared.message,
          };
        }
        if (!app) {
          return {
            ok: false,
            appId,
            step: "unsupported",
            code: "declare_not_composed",
            message: `${appId} 的声明已记录，但当前进程没有把它组合进 App host。`,
          };
        }
      }

      const installed = options.host.install(parsed.bundle, input.actor);
      if (!installed.ok) {
        return {
          ok: false,
          appId,
          step: "install",
          code: installed.failure.code,
          message: describeFailure(installed.failure),
        };
      }

      const previewed = await previewInstalled(options.host, appId, installed.packageDigest);
      if (!previewed.ok) return previewed;
      log.info(
        {
          app: appId,
          ticket: input.ticketId,
          packageDigest: installed.packageDigest,
          coexistence: previewed.coexistence,
          coexistenceReason: previewed.coexistenceReason,
        },
        "an App release candidate was packed, installed and previewed",
      );
      return {
        ...previewed,
        deduplicated: installed.deduplicated,
      };
    } catch (error) {
      // Publication is best-effort by construction: the merge is done and the
      // caller turns this into a conversation note.
      return {
        ok: false,
        appId,
        step: "pack",
        code: "refresh_crashed",
        message: describeError(error),
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  const preview = (appId: string, packageDigest: string): Promise<AppHotswapPreviewOutcome> =>
    previewInstalled(options.host, appId, packageDigest);

  const activate = async (
    appId: string,
    packageDigest: string,
    actor: string,
  ): Promise<AppReleaseRefreshOutcome> => {
    const app = options.host.app(appId);
    if (!app) {
      return {
        ok: false,
        appId,
        step: "unsupported",
        code: "unknown_app",
        message: `本进程没有服务 ${appId} 这个 App。`,
      };
    }
    const activated = await app.activate(packageDigest, actor);
    if (!activated.ok) {
      return {
        ok: false,
        appId,
        step: "activate",
        code: activated.failure.code,
        message: describeFailure(activated.failure),
      };
    }
    log.info(
      {
        app: appId,
        packageDigest,
        changed: activated.changed,
        coexistence: activated.coexistence,
        coexistenceReason: activated.reason,
        actor,
      },
      "an installed App release candidate was activated",
    );
    return {
      ok: true,
      appId,
      packageDigest,
      hostLabel: packageHostLabel(packageDigest),
      deduplicated: true,
      changed: activated.changed,
      coexistence: activated.coexistence,
      coexistenceReason: activated.reason,
    };
  };

  const publish: AppReleaseRefresher = async (input) => {
    const prepared = await prepare(input);
    if (!prepared.ok) return prepared;
    const activated = await activate(input.appId, prepared.packageDigest, input.actor);
    return activated.ok ? { ...activated, deduplicated: prepared.deduplicated } : activated;
  };

  return { prepare, preview, activate, publish };
}

/** Compatibility constructor for callers that only need direct publication. */
export function createAppTicketRefresher(options: AppTicketRefreshOptions): AppReleaseRefresher {
  return createAppTicketReleaseTools(options).publish;
}

async function previewInstalled(
  host: AppReleaseHost,
  appId: string,
  packageDigest: string,
): Promise<AppHotswapPreviewOutcome> {
  const app = host.app(appId);
  if (!app) {
    return {
      ok: false,
      appId,
      step: "unsupported",
      code: "unknown_app",
      message: `本进程没有服务 ${appId} 这个 App。`,
    };
  }
  if (!app.previewActivation) {
    return {
      ok: false,
      appId,
      step: "unsupported",
      code: "preview_unavailable",
      message: `${appId} 的 host 没有实现 activation 预判，拒绝创建缺少审批事实的请求。`,
    };
  }
  const preview = await app.previewActivation(packageDigest);
  if (!preview.ok) {
    return {
      ok: false,
      appId,
      step: "activate",
      code: preview.failure.code,
      message: describeFailure(preview.failure),
    };
  }
  return {
    ok: true,
    appId,
    packageDigest,
    hostLabel: packageHostLabel(packageDigest),
    previousPackageDigest: preview.previousPackageDigest,
    permissionContractDigest: preview.permissionContractDigest,
    coexistence: preview.coexistence,
    coexistenceReason: preview.reason,
  };
}

/**
 * Only the log's tail is ever reported (`tail()`), so each step keeps a bounded
 * tail and its output volume never fails the step: `execFile`'s 8 MiB
 * `maxBuffer` used to kill a chatty build and report it as broken.
 */
const STEP_LOG_CHARS = 16 * 1024;

/** Build only the App composition root; Vite consumes its workspace sources. */
async function runViewBuild(input: { worktree: string; project: string }): Promise<{ ok: boolean; log: string }> {
  const filter = `@claude-bot/${input.project}`;
  const run = await runChild("pnpm", ["--filter", filter, "build"], {
    cwd: input.worktree, timeoutMs: VIEW_BUILD_TIMEOUT_MS, killSignal: "SIGKILL", tailBytes: tailBytesFor(STEP_LOG_CHARS),
  });
  return { ok: !run.error, log: `$ pnpm --filter ${filter} build\n${stepLogTail(run, STEP_LOG_CHARS)}` };
}

/** `pnpm run <script> -- --out <file>` inside the ticket's worktree. */
async function runPackScript(input: { worktree: string; script: string; out: string }): Promise<{ ok: boolean; log: string }> {
  const run = await runChild("pnpm", ["run", input.script, "--", "--out", input.out], {
    cwd: input.worktree, timeoutMs: PACK_TIMEOUT_MS, killSignal: "SIGKILL", tailBytes: tailBytesFor(STEP_LOG_CHARS),
  });
  return { ok: !run.error, log: `$ pnpm run ${input.script} -- --out <tmp>\n${stepLogTail(run, STEP_LOG_CHARS)}` };
}

async function readBundleDocument(file: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let raw: string;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_BUNDLE_FILE_BYTES) {
      return { ok: false, error: `打包产物 ${stat.size} 字节,超过 ${MAX_BUNDLE_FILE_BYTES} 上限` };
    }
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    return { ok: false, error: `读不到打包产物:${describeError(error)}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error: "打包产物不是合法 JSON" };
  }
}

function describeFailure(failure: { message: string; issues?: Array<{ code: string; message: string }> }): string {
  const issues = (failure.issues ?? []).slice(0, 4).map((issue) => `${issue.code}: ${issue.message}`);
  return [failure.message, ...issues].join(" / ").slice(0, 600);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 400);
}

function tail(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").slice(-1_200).trim();
}
