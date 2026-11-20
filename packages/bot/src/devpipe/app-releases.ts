/**
 * Agentic App release and hot-swap coordination.
 *
 * Extracted from `pipeline.ts` (#192), where it was 557 lines of one 70-method
 * class. It is a genuinely separate job: the rest of the pipeline decides when
 * code becomes the watermark, while this decides when an App's immutable,
 * digest-addressed release becomes the one users are served. The two share a
 * ticket id and nothing else — no merge lock, no worktree, no turn scheduling.
 *
 * The rule this file holds (owner decision #61): **a landed App release goes
 * live by itself once the running trusted code can serve it.** That is true
 * when the deployed tree already contains it, or when every change between the
 * deployed commit and a complete staged release is an App/View release input
 * (`isAppOnlyPath`). Anything else waits for the next full deployment, which
 * runs the same automatic drain once its health gate has passed. Trusted code
 * itself is still deployed only by an explicit operator action. Bytes from a
 * commit the deployed tree does not contain first pass the same tier-3
 * knowledge review a deployment does (#522).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import type { AppHotswapApprovalRow, PendingAppReleaseRow } from "../store/repositories/app-catalog.js";
import type { DevTicketRow } from "../store/repositories/dev-tickets.js";
import { git, msg } from "./worktree.js";
import { assertKnowledgeDeployable } from "./knowledge-deploy.js";
import { appScopeFor, type AppTicketScope } from "./app-scopes.js";
import {
  isAppOnlyPath,
  ticketAllowsAppDebt,
  ticketCanUseAppWorktree,
  ticketDeliveryApps,
} from "./delivery.js";
import { chooseReleaseTree, type ReleaseTreeCandidate } from "../app-registry/release-tree.js";
import { createLogger } from "../logger.js";

const log = createLogger("devpipe");

/** How long a pending hot-swap approval stays decidable. */
export const APP_HOTSWAP_APPROVAL_TTL_MS = 48 * 60 * 60 * 1_000;

/**
 * What the pipeline did about an App's release after an app ticket landed.
 *
 * Reported as a value rather than thrown: the merge already happened and cannot
 * be undone by a publication failing. A refusal here is a fact about the RELEASE
 * pipeline ("this build cannot serve that permission contract", "the backend did
 * not come up"), which is a different question from "is this code good", and the
 * gates already answered the second one.
 */
export type AppReleaseRefreshOutcome =
  | {
      ok: true;
      appId: string;
      packageDigest: string;
      hostLabel: string;
      /** True when these exact bytes were already installed — a no-op install. */
      deduplicated: boolean;
      /** False when this release was ALREADY the active one. */
      changed: boolean;
      /** Whether old bindings remain writable beside the activated release. */
      coexistence: "multi_version" | "refresh_required";
      /** Exact compatibility reason when a refresh is required. */
      coexistenceReason: string | null;
    }
  | {
      ok: false;
      appId: string;
      /** Which half refused. `unsupported` = this composition has no packer/host. */
      step: "pack" | "install" | "activate" | "unsupported";
      code: string;
      message: string;
    };

/**
 * The seam the composition root binds so a landed app ticket republishes.
 *
 * A hook rather than a direct call because of dependency direction: the pipeline
 * is built in step 3 of `bootstrap-v3` and the App catalog in step 4, and having
 * `devpipe/` import `app-registry/` would make the dev pipeline depend on
 * Agentic App hosting in every composition — including the ones (v2's
 * `index.ts`, any deployment with Session Plus off) that host no App at all.
 * Unbound is an honest state with its own message, not a silent no-op.
 *
 * `worktree` is the ticket's own tree, parked at exactly the commit that was
 * gated and merged, with `dist/` freshly built by the gate. Packing THERE rather
 * than from the running process's checkout is the whole point: this process is
 * running whatever was last deployed, so packing its own tree would publish the
 * deployed View under the claim that it is the one that just landed.
 */
export interface AppReleaseRefresher {
  (input: {
    appId: string;
    worktree: string;
    ticketId: number;
    actor: string;
    /** Explicit host-level action may compose a missing declared App first. */
    declareMissing?: boolean;
    /** App-only publication may refresh this App's View bundle before packing. */
    prepareView?: boolean;
  }): Promise<AppReleaseRefreshOutcome>;
}

export type AppHotswapPreviewOutcome =
  | {
      ok: true;
      appId: string;
      packageDigest: string;
      hostLabel: string;
      previousPackageDigest: string | null;
      permissionContractDigest: string;
      coexistence: "multi_version" | "refresh_required";
      coexistenceReason: string | null;
    }
  | Extract<AppReleaseRefreshOutcome, { ok: false }>;

export type AppHotswapPreparedOutcome =
  | (Extract<AppHotswapPreviewOutcome, { ok: true }> & { deduplicated: boolean })
  | Extract<AppHotswapPreviewOutcome, { ok: false }>;

/** Late-bound App host operations; devpipe itself never imports app-registry. */
export interface AppHotswapExecutor {
  prepare(input: {
    appId: string;
    worktree: string;
    ticketId: number;
    actor: string;
    prepareView?: boolean;
  }): Promise<AppHotswapPreparedOutcome>;
  preview(appId: string, packageDigest: string): Promise<AppHotswapPreviewOutcome>;
  activate(appId: string, packageDigest: string, actor: string): Promise<AppReleaseRefreshOutcome>;
}

export interface AppHotswapApprovalView {
  id: string;
  ticketId: number;
  appId: string;
  sourceCommit: string;
  packageDigest: string;
  previousDigest: string | null;
  contractDigest: string;
  coexistence: "multi_version" | "refresh_required";
  coexistenceReason: string | null;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  state: "pending" | "approved";
  outcome: string | null;
}

export type AppHotswapDecisionResult =
  | {
      ok: true;
      decision: "approve" | "reject";
      id: string;
      appId: string;
      packageDigest: string;
      changed?: boolean;
      coexistence?: "multi_version" | "refresh_required";
      coexistenceReason?: string | null;
      message: string;
    }
  | { ok: false; code: string; message: string };

export type AppHotswapToolResult =
  | {
      ok: false;
      status: "approval_required";
      pending_id: string;
      app: string;
      source_commit: string;
      package_digest: string;
      previous_package_digest: string | null;
      coexistence: "multi_version" | "refresh_required";
      coexistence_reason: string | null;
      message: string;
    }
  | {
      ok: false;
      status: "deferred" | "refused";
      app?: string;
      code?: string;
      message: string;
    }
  | {
      ok: true;
      status: "activated";
      pending_id: string;
      app: string;
      source_commit: string;
      package_digest: string;
      changed: false;
      message: string;
    };

export interface PendingAppReleaseResult {
  appId: string;
  title: string;
  ticketId: number | null;
  outcome: AppReleaseRefreshOutcome;
}

export interface PendingAppReleaseDrain {
  ok: boolean;
  results: PendingAppReleaseResult[];
  remaining: string[];
}

export interface AppReleaseDrainState {
  active: boolean;
  mode: AppReleaseDrainMode | null;
}

/** `automatic` needs no operator; `hot-publish` is the explicit Administer retry. */
export type AppReleaseDrainMode = "automatic" | "hot-publish";

/** A complete, staged deployment release: a checkout of `sha` with its CI-built App artifacts. */
export interface StagedReleaseTree {
  sha: string;
  dir: string;
}

/** What the coordinator needs from the pipeline that owns it. */
export interface AppReleaseCoordinatorOpts {
  store: Store;
  repoDir: string;
  /** Deployed run checkout, when this composition has one. Read-only, ever. */
  runTreeDir: string | null;
  baseBranch: string;
  /**
   * Post a pipeline message on a ticket. Injected rather than reimplemented:
   * the real one stamps the pipeline's current turn sequence, which is turn
   * state this class deliberately does not have.
   */
  note: (ticketId: number, body: string) => void;
  /** The same writer, skipping a body the ticket already carries. */
  noteOnce?: (ticketId: number, body: string) => void;
  refreshAppRelease?: AppReleaseRefresher | null;
  appHotswapExecutor?: AppHotswapExecutor | null;
  /** Staged releases that may serve App debt ahead of the deployed tree. */
  releaseTrees?: (() => Promise<StagedReleaseTree[]>) | null;
}

/** One checkout an owed App release may be packed from. */
interface ReleaseSource {
  dir: string;
  sha: string;
  /** Shown in the ticket note: where the published bytes came from. */
  label: string;
  prepareView: boolean;
}

export class AppReleaseCoordinator {
  private readonly store: Store;
  private readonly repoDir: string;
  private readonly runTreeDir: string | null;
  private readonly baseBranch: string;
  private readonly note: (ticketId: number, body: string) => void;
  private readonly noteOnce: (ticketId: number, body: string) => void;
  private refreshFn: AppReleaseRefresher | null;
  private hotswapFn: AppHotswapExecutor | null;
  private releaseTreesFn: (() => Promise<StagedReleaseTree[]>) | null;
  /** One pack/install/activate sequence at a time, across automatic and panel calls. */
  private appReleaseDrainChain: Promise<void> = Promise.resolve();
  /** The one accepted drain, also projected so the panel cannot offer a duplicate action. */
  private activeAppReleaseDrain: {
    mode: AppReleaseDrainMode;
    promise: Promise<PendingAppReleaseDrain>;
  } | null = null;
  /** Inputs the last automatic drain already settled; unchanged inputs are not retried. */
  private automaticSettledKey: string | null = null;

  constructor(opts: AppReleaseCoordinatorOpts) {
    this.store = opts.store;
    this.repoDir = opts.repoDir;
    this.runTreeDir = opts.runTreeDir;
    this.baseBranch = opts.baseBranch;
    this.note = opts.note;
    this.noteOnce = opts.noteOnce ?? opts.note;
    this.refreshFn = opts.refreshAppRelease ?? null;
    this.hotswapFn = opts.appHotswapExecutor ?? null;
    this.releaseTreesFn = opts.releaseTrees ?? null;
  }

  setRefresher(fn: AppReleaseRefresher | null): void {
    this.refreshFn = fn;
  }

  setHotswapExecutor(fn: AppHotswapExecutor | null): void {
    this.hotswapFn = fn;
  }

  setReleaseTrees(fn: (() => Promise<StagedReleaseTree[]>) | null): void {
    this.releaseTreesFn = fn;
  }

  appReleaseDrainState(): AppReleaseDrainState {
    return {
      active: this.activeAppReleaseDrain !== null,
      mode: this.activeAppReleaseDrain?.mode ?? null,
    };
  }

  /** Advance App-only tickets only after every App in their release set settled. */
  private settleAppOnlyTicket(ticketId: number): void {
    const ticket = this.store.devTickets.getDevTicket(ticketId);
    if (!ticket || !ticketDeliveryApps(ticket).length || ticket.dev_status !== "landed") return;
    const stillPending = this.store.appCatalog.listPendingAppReleases().some((row) => row.ticket_id === ticketId);
    if (!stillPending && ["pending", "deploying", "live_unverified"].includes(ticket.deploy_status ?? "")) {
      this.store.devTickets.updateDevTicket(ticket.id, { deploy_status: "app_live" });
    }
  }

  /** Ask for an exact-digest hot swap. Never activates; returns approval_required. */
  async requestHotswap(ticket: DevTicketRow, scope: AppTicketScope): Promise<AppHotswapToolResult> {
    return await this.requestAppHotswap(ticket, scope);
  }

  private async requestAppHotswap(
    ticket: DevTicketRow,
    scope: AppTicketScope,
  ): Promise<AppHotswapToolResult> {
    const sourceCommit = ticket.commit_sha ?? "";
    if (ticket.dev_status !== "landed" || !/^[0-9a-f]{40,64}$/.test(sourceCommit)) {
      return {
        ok: false,
        status: "refused",
        app: scope.appId,
        code: "ticket_not_landed",
        message: "App activation 只能从本票已经 ff 落地的 commit 发起。",
      };
    }
    if (!(await this.refContains(this.repoDir, this.baseBranch, sourceCommit))) {
      return {
        ok: false,
        status: "refused",
        app: scope.appId,
        code: "commit_not_on_base",
        message: `${sourceCommit.slice(0, 12)} 不在 ${this.baseBranch} 上，拒绝打包。`,
      };
    }
    const candidates: ReleaseTreeCandidate[] = [];
    if (this.runTreeDir) candidates.push({ kind: "deployed", dir: this.runTreeDir });
    if (ticketCanUseAppWorktree(ticket, scope.appId) && ticket.worktree) {
      candidates.push({ kind: "worktree", dir: ticket.worktree });
    }
    const probes = new Map<string, { contains: boolean; built: boolean }>();
    for (const candidate of candidates) {
      probes.set(candidate.dir, {
        contains: await this.treeContains(candidate.dir, sourceCommit),
        built: existsSync(path.join(candidate.dir, "node_modules")),
      });
    }
    const tree = chooseReleaseTree({
      sha: sourceCommit,
      candidates,
      contains: (dir) => probes.get(dir)?.contains === true,
      built: (dir) => probes.get(dir)?.built === true,
    });
    if (!tree.ok) {
      return {
        ok: false,
        status: "deferred",
        app: scope.appId,
        code: tree.awaitingDeploy ? "awaiting_deploy" : "no_packable_checkout",
        message:
          `⏳ ${scope.title} 仍保持待发布:${tree.why}。`
          + (tree.awaitingDeploy
            ? "当前部署的可信代码能运行它时，发布包就绪后会自动发布；否则随下一次部署发布。两者都不等待本审批。"
            : "需要管理员按 app-release runbook 提供可打包 checkout。"),
      };
    }
    if (tree.kind === "worktree") {
      const [head, dirty] = await Promise.all([
        git(tree.dir, ["rev-parse", "HEAD"]),
        git(tree.dir, ["status", "--porcelain"]),
      ]);
      if (!head.ok || head.stdout.trim() !== sourceCommit || !dirty.ok || dirty.stdout.trim()) {
        return {
          ok: false,
          status: "refused",
          app: scope.appId,
          code: "source_tree_changed",
          message: "本票 worktree 不再是干净的 landed commit；拒绝把未落地字节包装成该 commit 的 release。",
        };
      }
      const deployed = this.runTreeDir && existsSync(this.runTreeDir)
        ? await git(this.runTreeDir, ["rev-parse", "HEAD"])
        : null;
      if (deployed && (!deployed.ok || !(await this.appOnlyAhead(deployed.stdout, sourceCommit)))) {
        return {
          ok: false,
          status: "deferred",
          app: scope.appId,
          code: "awaiting_deploy",
          message: `⏳ ${scope.title} 仍保持待发布:它所在的提交范围含有尚未部署的可信代码，随下一次部署发布，不等待本审批。`,
        };
      }
    }
    if (!this.hotswapFn) {
      return {
        ok: false,
        status: "refused",
        app: scope.appId,
        code: "hotswap_unbound",
        message: "本进程没有接 Agentic App hot-swap 管线；代码已落地，release 债务仍保留。",
      };
    }

    const actor = `devpipe:ticket-${ticket.id}`;
    const prepared = await this.hotswapFn.prepare({
      appId: scope.appId,
      worktree: tree.dir,
      ticketId: ticket.id,
      actor,
      prepareView: tree.kind === "worktree",
    });
    if (!prepared.ok) {
      return {
        ok: false,
        status: "refused",
        app: scope.appId,
        code: `${prepared.step}_${prepared.code}`,
        message: `✖ ${scope.title} 候选准备失败(${prepared.step}/${prepared.code}):${prepared.message}`,
      };
    }

    const requestedAt = new Date().toISOString();
    const stored = this.store.appCatalog.recordAppHotswapApproval({
      id: `ahr_${randomUUID()}`,
      ticket_id: ticket.id,
      app_id: scope.appId,
      source_commit: sourceCommit,
      package_digest: prepared.packageDigest,
      previous_digest: prepared.previousPackageDigest,
      contract_digest: prepared.permissionContractDigest,
      coexistence_verdict: JSON.stringify({ mode: prepared.coexistence, reason: prepared.coexistenceReason }),
      requested_by: actor,
      requested_at: requestedAt,
    });
    const row = stored.row;
    if (row.app_id !== scope.appId || row.source_commit !== sourceCommit) {
      return {
        ok: false,
        status: "refused",
        app: scope.appId,
        code: "approval_replay_source_changed",
        message: "同一 ticket/digest 已有另一 source 事实的审批记录；拒绝复用。",
      };
    }
    if (row.state === "executed") {
      return {
        ok: true,
        status: "activated",
        pending_id: row.id,
        app: row.app_id,
        source_commit: row.source_commit,
        package_digest: row.package_digest,
        changed: false,
        message: `ℹ ${scope.title} 的同一 digest 已由审批记录 ${row.id} 执行；changed=false，不重复通知。`,
      };
    }
    if (row.state !== "pending" && row.state !== "approved") {
      return {
        ok: false,
        status: "refused",
        app: row.app_id,
        code: `approval_${row.state}`,
        message: `审批记录 ${row.id} 已是 ${row.state}，不会由 agent 重开或重放。`,
      };
    }
    const verdict = parseCoexistenceVerdict(row.coexistence_verdict);
    if (stored.created) {
      this.note(
        ticket.id,
        `🔐 ${scope.title} 候选已打包并安装:${row.package_digest.slice(0, 16)}…；activation **尚未发生**，`
          + `正等待 Dashboard Administer 审批 ${row.id}。批准绑定该确切 digest；agent 不能自批且本轮必须结束。`,
      );
    }
    return {
      ok: false,
      status: "approval_required",
      pending_id: row.id,
      app: row.app_id,
      source_commit: row.source_commit,
      package_digest: row.package_digest,
      previous_package_digest: row.previous_digest,
      coexistence: verdict.mode,
      coexistence_reason: verdict.reason,
      message:
        `approval_required(${row.id}):${scope.title} 候选 ${row.package_digest.slice(0, 16)}… 已安装但未激活。`
        + `请结束本轮；不要轮询、重试或尝试批准。`,
    };
  }

  /** Pending exact-digest approvals rendered by the Dashboard Administer surface. */
  listAppHotswapApprovals(): AppHotswapApprovalView[] {
    const now = new Date();
    this.store.appCatalog.expireAppHotswapApprovals(
      new Date(now.getTime() - APP_HOTSWAP_APPROVAL_TTL_MS).toISOString(),
      now.toISOString(),
    );
    return this.store.appCatalog.listAppHotswapApprovals()
      .filter((row) => row.state === "pending" || row.state === "approved")
      .map((row) => this.appHotswapApprovalView(row));
  }

  /**
   * Consume one human approval. The stored candidate facts are assertions too:
   * ticket closure, predecessor, contract and coexistence are all revalidated
   * immediately before the exact installed digest may move the active pointer.
   */
  async decideAppHotswapApproval(
    id: string,
    decision: "approve" | "reject",
    actor: string,
  ): Promise<AppHotswapDecisionResult> {
    if (!/^user:[^\s:][^\s]*$/.test(actor)) {
      return { ok: false, code: "browser_session_required", message: "App activation 审批只接受 Dashboard 登录用户。" };
    }
    const now = new Date();
    this.store.appCatalog.expireAppHotswapApprovals(
      new Date(now.getTime() - APP_HOTSWAP_APPROVAL_TTL_MS).toISOString(),
      now.toISOString(),
    );

    const existing = this.store.appCatalog.getAppHotswapApproval(id);
    let row: AppHotswapApprovalRow;
    if (decision === "approve" && existing?.state === "approved") {
      // Recovery after a process crash or a bounded activation failure. The
      // final exact-digest activation is idempotent; finish() below ensures
      // only the winner emits the completion note.
      row = existing;
    } else {
      const claimed = this.store.appCatalog.claimAppHotswapApproval(id, decision, actor, now.toISOString());
      if (!claimed.ok) {
        return {
          ok: false,
          code: claimed.code === "unknown" ? "unknown_approval" : `approval_${claimed.row?.state ?? "not_pending"}`,
          message: claimed.code === "unknown"
            ? `找不到 App activation 审批 ${id}。`
            : `审批 ${id} 已是 ${claimed.row?.state ?? "非 pending"}，不会重复消费。`,
        };
      }
      row = claimed.row;
    }

    if (decision === "reject") {
      this.note(row.ticket_id, `⛔ Dashboard 管理员 ${actor.slice(5)} 拒绝了 ${row.app_id} 的 activation 审批 ${row.id}；active release 未改变。`);
      return {
        ok: true,
        decision,
        id: row.id,
        appId: row.app_id,
        packageDigest: row.package_digest,
        message: `已拒绝 ${row.app_id} 的 exact-digest activation；active release 未改变。`,
      };
    }

    const failApproved = (code: string, message: string): AppHotswapDecisionResult => {
      this.store.appCatalog.finishAppHotswapApproval(row.id, "approved", JSON.stringify({ code, message: message.slice(0, 500) }));
      this.note(row.ticket_id, `⚠ ${row.app_id} 的 activation 审批 ${row.id} 已批准，但执行前复核失败(${code}):${message}`);
      return { ok: false, code, message };
    };
    const ticket = this.store.devTickets.getDevTicket(row.ticket_id);
    if (
      !ticket
      || !ticketAllowsAppDebt(ticket, row.app_id)
      || ticket.dev_status !== "landed"
      || ticket.commit_sha !== row.source_commit
    ) {
      return failApproved("ticket_closure_changed", "工单闭包与申请时记录不再完全一致，拒绝移动 active pointer。");
    }
    if (!(await this.refContains(this.repoDir, this.baseBranch, row.source_commit))) {
      return failApproved("commit_not_on_base", `${row.source_commit.slice(0, 12)} 已不在 ${this.baseBranch}。`);
    }
    if (!this.hotswapFn) return failApproved("hotswap_unbound", "本进程没有接 Agentic App hot-swap 管线。");

    let preview: AppHotswapPreviewOutcome;
    try {
      preview = await this.hotswapFn.preview(row.app_id, row.package_digest);
    } catch (error) {
      return failApproved("preview_crashed", msg(error).slice(0, 400));
    }
    if (!preview.ok) {
      return failApproved(`preview_${preview.code}`, `确切候选不可激活:${preview.message}`);
    }
    if (preview.packageDigest !== row.package_digest) {
      return failApproved("candidate_changed", "host 返回的候选 digest 与审批记录不一致。");
    }
    if (preview.permissionContractDigest !== row.contract_digest) {
      return failApproved("contract_changed", "已安装候选的权限契约摘要与审批记录不一致。");
    }
    if (preview.previousPackageDigest === row.package_digest) {
      const finished = this.store.appCatalog.finishAppHotswapApproval(
        row.id,
        "executed",
        JSON.stringify({ code: "already_active", changed: false }),
      );
      await this.clearPublishedAppReleases(row.app_id, row.source_commit);
      this.settleAppOnlyTicket(row.ticket_id);
      if (finished) this.note(row.ticket_id, `ℹ ${row.app_id} 的审批候选已经是 active digest；changed=false，不重复发送版本切换通知。`);
      return {
        ok: true,
        decision,
        id: row.id,
        appId: row.app_id,
        packageDigest: row.package_digest,
        changed: false,
        coexistence: preview.coexistence,
        coexistenceReason: preview.coexistenceReason,
        message: `${row.app_id} 的 exact digest 已经 active；未重复切换。`,
      };
    }
    const recordedVerdict = parseCoexistenceVerdict(row.coexistence_verdict);
    if (preview.previousPackageDigest !== row.previous_digest) {
      return failApproved("predecessor_changed", "active predecessor 已变化；原审批事实过期，拒绝套用到另一条版本边。");
    }
    if (preview.coexistence !== recordedVerdict.mode || preview.coexistenceReason !== recordedVerdict.reason) {
      return failApproved("coexistence_changed", "候选的多版本/刷新判定与审批记录不一致。");
    }

    let activated: AppReleaseRefreshOutcome;
    let unreviewed: string | null = null;
    try {
      // A candidate the deployed tree already carries passed that deployment's
      // knowledge review; an ahead candidate passes the same review here.
      const deployed = this.runTreeDir && existsSync(this.runTreeDir)
        ? (await git(this.runTreeDir, ["rev-parse", "HEAD"])).stdout || null
        : null;
      if (!deployed || !(await this.treeContains(this.runTreeDir!, row.source_commit))) {
        const review = await this.reviewKnowledge(row.source_commit, deployed);
        if ("blocked" in review) throw new Error(review.blocked);
        unreviewed = review.warning;
      }
      activated = await this.hotswapFn.activate(row.app_id, row.package_digest, actor);
    } catch (error) {
      return failApproved("activate_crashed", msg(error).slice(0, 400));
    }
    if (!activated.ok) {
      return failApproved(`activate_${activated.code}`, activated.message);
    }
    const finished = this.store.appCatalog.finishAppHotswapApproval(
      row.id,
      "executed",
      JSON.stringify({
        code: "activated",
        changed: activated.changed,
        coexistence: activated.coexistence,
        reason: activated.coexistenceReason,
      }),
    );
    await this.clearPublishedAppReleases(row.app_id, row.source_commit);
    this.settleAppOnlyTicket(ticket.id);
    if (finished) {
      this.note(
        row.ticket_id,
        `⚡ Dashboard 管理员 ${actor.slice(5)} 批准并激活了 ${row.app_id}:${row.package_digest.slice(0, 16)}…；`
          + `coexistence=${activated.coexistence}${activated.coexistenceReason ? `(${activated.coexistenceReason})` : ""}。`
          + (unreviewed ? `\n${unreviewed}` : ""),
      );
    }
    return {
      ok: true,
      decision,
      id: row.id,
      appId: row.app_id,
      packageDigest: row.package_digest,
      changed: activated.changed,
      coexistence: activated.coexistence,
      coexistenceReason: activated.coexistenceReason,
      message: `已激活 ${row.app_id} 的 exact digest ${row.package_digest.slice(0, 16)}…。`,
    };
  }

  private appHotswapApprovalView(row: AppHotswapApprovalRow): AppHotswapApprovalView {
    const verdict = parseCoexistenceVerdict(row.coexistence_verdict);
    return {
      id: row.id,
      ticketId: row.ticket_id,
      appId: row.app_id,
      sourceCommit: row.source_commit,
      packageDigest: row.package_digest,
      previousDigest: row.previous_digest,
      contractDigest: row.contract_digest,
      coexistence: verdict.mode,
      coexistenceReason: verdict.reason,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      expiresAt: new Date(Date.parse(row.requested_at) + APP_HOTSWAP_APPROVAL_TTL_MS).toISOString(),
      state: row.state === "approved" ? "approved" : "pending",
      outcome: row.outcome,
    };
  }

  /**
   * Publish every owed App release the running trusted code can serve, with
   * no operator action (owner decision #61).
   *
   * The deploy service calls this only while no deployment is in flight: right
   * after a deployment passed its health gate, and on its idle poll, which also
   * notices a newly staged release. Inputs that an earlier call already settled
   * (deployed commit, staged releases, owed revisions, knowledge reviews) are
   * not retried, so a failure produces one ticket note rather than one per
   * poll; a new release, landing, deployment, review or restart tries again.
   * Before App hosting is bound this is a no-op that a later call repeats.
   */
  async autoPublishPendingAppReleases(): Promise<void> {
    if (!this.refreshFn) return;
    const before = await this.automaticInputs();
    if (automaticKey(before) === this.automaticSettledKey) return;
    await this.enqueuePendingAppReleaseDrain({ actor: "devpipe:automatic", mode: "automatic" });
    // Debt that appeared while the drain ran was never considered: keep it out
    // of the settled inputs so the next call picks it up.
    const considered = new Set(before.owed);
    const after = await this.automaticInputs();
    this.automaticSettledKey = automaticKey({ ...before, owed: after.owed.filter((row) => considered.has(row)) });
  }

  /**
   * The explicit Administer retry of the same drain, without restarting
   * trusted code. Only this door may also pack a submit-verified App-only
   * ticket's own built worktree, for compositions without staged releases.
   */
  async publishPendingAppReleases(actor: string): Promise<PendingAppReleaseDrain> {
    return this.enqueuePendingAppReleaseDrain({ actor, mode: "hot-publish" });
  }

  private async automaticInputs(): Promise<AutomaticInputs> {
    const deployed = this.runTreeDir && existsSync(this.runTreeDir)
      ? (await git(this.runTreeDir, ["rev-parse", "HEAD"])).stdout
      : "";
    const trees = (await this.stagedTrees()).map((tree) => tree.sha).sort();
    const owed = this.store.appCatalog.listPendingAppReleaseRevisions()
      .map((row) => `${row.app_id}@${row.commit_sha}#${row.ticket_id ?? ""}`)
      .sort();
    // A recorded knowledge review may lift a verdict that held a release back.
    const reviews = this.store.knowledge.listReviews().length;
    return { deployed, trees, owed, reviews };
  }

  private async stagedTrees(): Promise<StagedReleaseTree[]> {
    if (!this.releaseTreesFn) return [];
    try {
      return await this.releaseTreesFn();
    } catch (error) {
      log.warn({ err: msg(error) }, "devpipe: staged release inventory unavailable; App debt waits for the deployed tree");
      return [];
    }
  }

  private enqueuePendingAppReleaseDrain(input: {
    actor: string;
    mode: AppReleaseDrainMode;
  }): Promise<PendingAppReleaseDrain> {
    // One drain at a time. A Dashboard click while an automatic drain runs
    // joins it instead of queuing a second, usually empty, publication.
    if (this.activeAppReleaseDrain) return this.activeAppReleaseDrain.promise;
    const run = this.appReleaseDrainChain.then(() => this.drainPendingAppReleases(input));
    const active = { mode: input.mode, promise: run };
    this.activeAppReleaseDrain = active;
    this.appReleaseDrainChain = run.then(() => undefined, () => undefined);
    const clear = () => {
      if (this.activeAppReleaseDrain === active) this.activeAppReleaseDrain = null;
    };
    void run.then(clear, clear);
    return run;
  }

  private async drainPendingAppReleases(input: {
    actor: string;
    mode: AppReleaseDrainMode;
  }): Promise<PendingAppReleaseDrain> {
    const explicit = input.mode === "hot-publish";
    const rows = this.store.appCatalog.listPendingAppReleases();
    const results: PendingAppReleaseResult[] = [];
    const publishedCommits = new Map<string, string>();
    // One conversation note per ticket and drain, however many Apps it owed.
    const lines = new Map<number, string[]>();
    const say = (ticketId: number | null, line: string): void => {
      if (ticketId) lines.set(ticketId, [...(lines.get(ticketId) ?? []), line]);
    };
    const sources = rows.length ? await this.releaseSources() : { deployed: null, ahead: [] };
    // One tier-3 knowledge review per ahead source and drain, however many Apps it serves.
    const reviews = new Map<string, Promise<KnowledgeReview>>();
    const unreviewedTickets = new Set<number>();
    for (const pending of rows) {
      const scope = appScopeFor(pending.app_id);
      if (!scope?.packScript) {
        results.push({
          appId: pending.app_id,
          title: scope?.title ?? pending.app_id,
          ticketId: pending.ticket_id,
          outcome: {
            ok: false,
            appId: pending.app_id,
            step: "unsupported",
            code: scope ? "no_packer" : "not_ticketable",
            message: "没有可从本仓库部署 checkout 打包这个 App 的路径。",
          },
        });
        continue;
      }
      if (!this.refreshFn) {
        results.push({
          appId: pending.app_id,
          title: scope.title,
          ticketId: pending.ticket_id,
          outcome: {
            ok: false,
            appId: pending.app_id,
            step: "unsupported",
            code: "release_pipeline_unbound",
            message: "本进程没有接 App release 管线。",
          },
        });
        continue;
      }
      const chosen = await this.chooseSource(pending, sources, explicit);
      if (!chosen) {
        log.info({ app: pending.app_id, commit: pending.commit_sha }, "devpipe: pending app release waits for a deployment that can serve it");
        results.push({
          appId: pending.app_id,
          title: scope.title,
          ticketId: pending.ticket_id,
          outcome: {
            ok: false,
            appId: pending.app_id,
            step: "unsupported",
            code: sources.deployed ? "commit_not_deployed" : "run_tree_unavailable",
            message: sources.deployed
              ? "当前部署和与它兼容的已暂存发布包都不包含这项 release；它所在的提交范围含有尚未部署的可信代码，随下一次部署发布。"
              : "本进程没有部署 checkout，也没有可安全定向构建的 App 工单 worktree。",
          },
        });
        continue;
      }
      const { row, source } = chosen;
      if (source.sha !== sources.deployed?.sha) {
        // The deployed tree passed its deployment's knowledge review; a source
        // ahead of it has not, so it passes the same review here (#522).
        let review = reviews.get(source.sha);
        if (!review) {
          review = this.reviewKnowledge(source.sha, sources.deployed?.sha ?? null);
          reviews.set(source.sha, review);
        }
        const verdict = await review;
        if ("blocked" in verdict) {
          const outcome: AppReleaseRefreshOutcome = {
            ok: false, appId: row.app_id, step: "activate", code: "knowledge_review", message: verdict.blocked,
          };
          results.push({ appId: row.app_id, title: scope.title, ticketId: row.ticket_id, outcome });
          say(row.ticket_id, `⚠ ${scope.title} 发布失败(activate/knowledge_review):${verdict.blocked}`);
          continue;
        }
        if (verdict.warning && row.ticket_id && !unreviewedTickets.has(row.ticket_id)) {
          unreviewedTickets.add(row.ticket_id);
          say(row.ticket_id, verdict.warning);
        }
      }
      const outcome = await this.refreshAppReleaseFrom(
        scope.appId,
        source.dir,
        row.ticket_id ?? 0,
        input.actor,
        true,
        source.prepareView,
      );
      results.push({ appId: row.app_id, title: scope.title, ticketId: row.ticket_id, outcome });
      if (outcome.ok) {
        // A newer landing may replace this App's row while packing is in
        // flight. Never erase that newer debt; remember the exact commit this
        // activation did cover so its older tickets can still be reconciled.
        await this.clearPublishedAppReleases(row.app_id, source.sha);
        publishedCommits.set(row.app_id, source.sha);
        say(row.ticket_id, outcome.changed
          ? `✅ ${scope.title} 已上线:${outcome.packageDigest.slice(0, 16)}…(${outcome.hostLabel})，${source.label}。`
          : `ℹ ${scope.title} 的 active release 已包含这次改动(内容未变，未切换版本)。`);
      } else {
        say(row.ticket_id, `⚠ ${scope.title} 发布失败(${outcome.step}/${outcome.code}):${outcome.message}`);
      }
      log.info(
        {
          app: row.app_id,
          actor: input.actor,
          mode: input.mode,
          source: source.sha,
          ok: outcome.ok,
          ...(outcome.ok ? { digest: outcome.packageDigest } : { code: outcome.code }),
        },
        "devpipe: pending app release drain",
      );
    }
    for (const settled of await this.settlePublishedAppOnlyTickets(publishedCommits)) {
      say(settled.ticketId, lines.has(settled.ticketId)
        ? "工单状态已同步为已发布。"
        : `✅ 所欠 ${settled.apps.join("、")} release 已由当前或较新的 active release 覆盖；工单状态已同步为已发布。`);
    }
    for (const [ticketId, body] of lines) {
      const failed = body.some((line) => line.startsWith("⚠"));
      this.noteOnce(ticketId, [
        explicit
          ? `⚡ 管理员 ${input.actor.replace(/^user:/, "")} 热发布 App(未重启 bot):`
          : "📦 App release 自动发布:",
        ...body,
        ...(failed && !explicit
          ? ["待发布记录保留：有新的发布包、合入或部署时自动重试；管理员也可在 /tickets 立即热发布。"]
          : []),
      ].join("\n"));
    }
    const remaining = this.store.appCatalog.listPendingAppReleases().map((row) => row.app_id);
    return { ok: results.every((result) => result.outcome.ok) && remaining.length === 0, results, remaining };
  }

  /**
   * Checkouts the running trusted code can serve App releases from: complete
   * staged releases whose every change over the deployed commit is App-only
   * (newest first), then the deployed tree itself.
   */
  private async releaseSources(): Promise<{ deployed: ReleaseSource | null; ahead: ReleaseSource[] }> {
    if (!this.runTreeDir || !existsSync(this.runTreeDir)) return { deployed: null, ahead: [] };
    const head = await git(this.runTreeDir, ["rev-parse", "HEAD"]);
    if (!head.ok || !head.stdout) return { deployed: null, ahead: [] };
    const deployedSha = head.stdout;
    const ahead: Array<ReleaseSource & { distance: number }> = [];
    for (const tree of await this.stagedTrees()) {
      if (tree.sha === deployedSha || !(await this.appOnlyAhead(deployedSha, tree.sha))) continue;
      const count = await git(this.repoDir, ["rev-list", "--count", `${deployedSha}..${tree.sha}`]);
      ahead.push({
        dir: tree.dir,
        sha: tree.sha,
        label: `来自发布包 ${tree.sha.slice(0, 10)}(相对当前部署只改 App/View，无需重启)`,
        prepareView: false,
        distance: Number(count.stdout) || 0,
      });
    }
    ahead.sort((left, right) => right.distance - left.distance);
    return {
      deployed: { dir: this.runTreeDir, sha: deployedSha, label: "来自当前部署", prepareView: false },
      ahead,
    };
  }

  /**
   * The #522 tier-3 knowledge review for App bytes from `target`, a commit the
   * deployed tree does not contain. A computed verdict blocks; a review that
   * cannot run (knowledge Runner unavailable) is a warning, not a block.
   */
  private async reviewKnowledge(target: string, deployed: string | null): Promise<KnowledgeReview> {
    const unavailable: string[] = [];
    try {
      await assertKnowledgeDeployable({
        repoDir: this.repoDir,
        target,
        previous: deployed,
        store: this.store,
        onUnavailable: (reason) => unavailable.push(reason),
      });
    } catch (error) {
      return { blocked: msg(error).slice(0, 400) };
    }
    return { warning: unavailable[0] ? `⚠ 知识审查未能运行(${unavailable[0]})，本次发布未经第三档冲突复核。` : null };
  }

  /**
   * The compatibility rule: `sha` descends from the deployed commit and every
   * path changed between them is an App/View release input or neutral
   * evidence. Then the App bytes built at `sha` need no trusted code that is
   * not already running, including any undeployed landing they sit on.
   */
  private async appOnlyAhead(deployed: string, sha: string): Promise<boolean> {
    if (!(await this.refContains(this.repoDir, sha, deployed))) return false;
    const diff = await git(this.repoDir, ["diff", "--name-only", "--no-renames", deployed, sha]);
    return diff.ok && diff.stdout.split("\n").filter(Boolean).every(isAppOnlyPath);
  }

  /**
   * The newest owed revision of one App that a compatible source carries. A
   * newer landing may be ahead while an older owed revision is ready: that
   * revision is published and every ahead obligation stays pending.
   */
  private async chooseSource(
    pending: PendingAppReleaseRow,
    sources: { deployed: ReleaseSource | null; ahead: ReleaseSource[] },
    explicit: boolean,
  ): Promise<{ row: PendingAppReleaseRow; source: ReleaseSource } | null> {
    const older = this.store.appCatalog.listPendingAppReleaseRevisions(pending.app_id)
      .reverse()
      .filter((row) => row.commit_sha !== pending.commit_sha);
    for (const row of [pending, ...older]) {
      if (!row.commit_sha) {
        if (sources.deployed) return { row, source: sources.deployed };
        continue;
      }
      for (const source of sources.ahead) {
        if (await this.refContains(this.repoDir, source.sha, row.commit_sha)) return { row, source };
      }
      if (sources.deployed && await this.treeContains(sources.deployed.dir, row.commit_sha)) {
        return { row, source: sources.deployed };
      }
      if (explicit && row === pending) {
        const worktree = await this.appOnlyTicketWorktree(row, sources.deployed);
        if (worktree) return { row, source: worktree };
      }
    }
    return null;
  }

  /**
   * An explicit request may pack a submit-verified App-only ticket's exact,
   * built worktree (the delivery gate proved its own diff App-only and its
   * declared App set exact), provided nothing between the deployed commit and
   * that worktree needs new trusted code. Ordinary and CLI debt never do this.
   */
  private async appOnlyTicketWorktree(
    row: PendingAppReleaseRow,
    deployed: ReleaseSource | null,
  ): Promise<ReleaseSource | null> {
    if (!row.ticket_id || !row.commit_sha) return null;
    const ticket = this.store.devTickets.getDevTicket(row.ticket_id);
    if (
      !ticket?.worktree
      || !ticketCanUseAppWorktree(ticket, row.app_id)
      || !existsSync(path.join(ticket.worktree, "node_modules"))
      || !(await this.treeContains(ticket.worktree, row.commit_sha))
    ) {
      return null;
    }
    const head = await git(ticket.worktree, ["rev-parse", "HEAD"]);
    if (!head.ok || !head.stdout) return null;
    if (deployed && !(await this.appOnlyAhead(deployed.sha, head.stdout))) return null;
    return { dir: ticket.worktree, sha: head.stdout, label: "来自本票 worktree", prepareView: true };
  }

  private async clearPublishedAppReleases(appId: string, sourceCommit: string): Promise<void> {
    for (const row of this.store.appCatalog.listPendingAppReleaseRevisions(appId)) {
      if (!row.commit_sha || row.commit_sha === sourceCommit
        || (await git(this.repoDir, ["merge-base", "--is-ancestor", row.commit_sha, sourceCommit])).ok) {
        this.store.appCatalog.clearPendingAppReleaseIf(row.app_id, row.commit_sha, row.ticket_id);
      }
    }
  }

  /**
   * Reconcile App-only tickets whose debt row was folded into a newer release.
   *
   * `app_release_pending` intentionally keeps one newest row per App, so a
   * later landing can replace the ticket id of an older owed release. Absence
   * of a row means that App was already cleared successfully. If a newer row
   * appeared during this drain, the exact commit we just published may still
   * cover the older ticket; ancestry proves that without clearing the newer
   * row or pretending its own change is live. Returns the tickets it settled;
   * the caller owns their (single) note.
   */
  private async settlePublishedAppOnlyTickets(
    publishedCommits: ReadonlyMap<string, string>,
  ): Promise<Array<{ ticketId: number; apps: string[] }>> {
    const pendingByApp = new Map(
      this.store.appCatalog.listPendingAppReleases().map((row) => [row.app_id, row]),
    );
    const settled: Array<{ ticketId: number; apps: string[] }> = [];
    for (const ticket of this.store.devTickets.listPendingAppReleaseTickets()) {
      const apps = ticketDeliveryApps(ticket);
      if (!apps.length) continue;
      let covered = true;
      for (const appId of apps) {
        if (!pendingByApp.has(appId)) continue;
        const publishedCommit = publishedCommits.get(appId);
        if (
          !ticket.commit_sha
          || !publishedCommit
          || !(await this.refContains(this.repoDir, publishedCommit, ticket.commit_sha))
        ) {
          covered = false;
          break;
        }
      }
      if (!covered) continue;
      this.store.devTickets.updateDevTicket(ticket.id, { deploy_status: "app_live" });
      settled.push({ ticketId: ticket.id, apps });
    }
    return settled;
  }

  /** One refresher call, with its throw turned into an outcome. */
  private async refreshAppReleaseFrom(
    appId: string,
    worktree: string,
    ticketId: number,
    actor: string,
    declareMissing = false,
    prepareView = false,
  ): Promise<AppReleaseRefreshOutcome> {
    try {
      return await this.refreshFn!({ appId, worktree, ticketId, actor, declareMissing, prepareView });
    } catch (err) {
      return { ok: false, appId, step: "pack", code: "refresher_threw", message: msg(err).slice(0, 400) };
    }
  }

  /** Is `sha` in this checkout's history? A missing tree answers "no". */
  private async treeContains(dir: string, sha: string): Promise<boolean> {
    if (!sha || !existsSync(dir)) return false;
    return (await git(dir, ["merge-base", "--is-ancestor", sha, "HEAD"])).ok;
  }

  /** Is `sha` reachable from one named ref? Used for the landed-ticket assertion. */
  private async refContains(dir: string, ref: string, sha: string): Promise<boolean> {
    if (!sha || !existsSync(dir)) return false;
    return (await git(dir, ["merge-base", "--is-ancestor", sha, ref])).ok;
  }
}

interface AutomaticInputs {
  deployed: string;
  trees: string[];
  owed: string[];
  reviews: number;
}

type KnowledgeReview = { blocked: string } | { warning: string | null };

function automaticKey(inputs: AutomaticInputs): string {
  return JSON.stringify([inputs.deployed, inputs.trees, inputs.owed, inputs.reviews]);
}

function parseCoexistenceVerdict(raw: string): {
  mode: "multi_version" | "refresh_required";
  reason: string | null;
} {
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; reason?: unknown };
    if (parsed.mode === "multi_version" || parsed.mode === "refresh_required") {
      return {
        mode: parsed.mode,
        reason: typeof parsed.reason === "string" ? parsed.reason : null,
      };
    }
  } catch {
    // Fail safe below: malformed durable evidence never opts into coexistence.
  }
  return { mode: "refresh_required", reason: "approval_record_invalid" };
}
