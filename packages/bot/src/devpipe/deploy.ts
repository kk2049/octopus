/**
 * DeployService — bot side of the phase-2 deploy choreography
 * (doc/design-self-hosting.md 上线流水线). The watermark model:
 *
 *   staging (baseBranch) — rises as gated tickets merge;
 *   stable              — the last SHA whose full GitLab CI suite passed.
 *
 * The bot never restarts itself: trigger() sends the RESCUE CARD first (all
 * coordinates a human needs if everything goes dark — static text that
 * survives in Feishu history), then writes the deploy intent; the ring-0
 * supervisor does the physical deploy. This service watches the intent from
 * the bot side. New supervisors complete as soon as their startup health gate
 * passes; confirm_wait handling remains only so an in-flight legacy supervisor
 * can finish during rollout. Terminal intents are finalized exactly once:
 * success → verify ticket + per-ticket deploy axis advances; rollback/fail →
 * tickets return to 'pending' and the reason is reported honestly.
 *
 * Agentic App debt is published by `publishApps`, which this service calls
 * only while no deployment is in flight: right after a success is finalized
 * and on the idle poll. A rolled-back deployment therefore never leaves Apps
 * on packages built for the platform that failed its health gate.
 */

import path from "node:path";
import type { DeploymentOrigin } from "@claude-bot/dashboard-web/contract";
import type { Store } from "../store/store.js";
import type {
  DeployIntentRow,
  DevTicketRow,
  VerifyTicketBlock,
  VerifyTicketRow,
} from "../store/repositories/dev-tickets.js";
import { git, gitOrThrow } from "./worktree.js";
import { createLogger } from "../logger.js";
import { resolveCapabilityBits } from "../permissions/capability-bits.js";
import type { BuildWarmJoinResult } from "./build-warm.js";
import { ticketNeedsTrustedDeploy } from "./delivery.js";
import { assertKnowledgeDeployable } from "./knowledge-deploy.js";
import type { StartupIngress, StartupIngressStatus } from "./startup-ingress.js";
import type { RunnerBundleDrainResult } from "./runner-bundle-delivery.js";
import type { ReleasePreparation } from "./deploy-artifact.js";
import type { GitLabReleaseCatalog, ReleasePin } from "./gitlab-release.js";

const log = createLogger("deploy");

export const DEFAULT_STABLE_BRANCH = "stable";
const WATCH_INTERVAL_MS = 3_000;
/** Idle cadence for automatic App publication; a finalized success runs it at once. */
const APP_PUBLISH_INTERVAL_MS = 30_000;

export type DeployEvent =
  | { kind: "rescue"; text: string; triggeredBy: string }
  | { kind: "confirm_request"; intent: DeployIntentRow }
  | { kind: "deploy_result"; intent: DeployIntentRow; verify?: VerifyTicketRow }
  | { kind: "verify_resolved"; verify: VerifyTicketRow; stableAdvanced: boolean };

export interface DeployServiceOpts {
  startupFailure?: (id: number) => string | null;
  ingress?: StartupIngress;
  store: Store;
  repoDir: string;
  baseBranch: string;
  stableBranch?: string;
  /** Non-empty = only these users may trigger deploys / resolve verification. */
  deployers?: string[];
  /** Paths quoted verbatim in the rescue card. */
  runTreeDir?: string;
  supervisorLog?: string;
  backupsDir?: string;
  /** Async so trigger() can await the rescue card BEFORE writing the intent. */
  notify?: (ev: DeployEvent) => Promise<void>;
  /** Join, but never start, cache warming already scheduled for this exact SHA. */
  prepareTarget?: (sha: string) => Promise<BuildWarmJoinResult>;
  /** Remote release preparation is durable background work; trigger still responds promptly. */
  prepareRelease?: (intent: DeployIntentRow) => Promise<void>;
  prewarmRelease?: (sha: string) => Promise<void>;
  releaseStatus?: (sha: string) => Promise<ReleasePreparation>;
  stagedReleaseShas?: () => Promise<string[]>;
  releaseCatalog?: GitLabReleaseCatalog;
  /** Runs only after the supervisor has declared the startup health gate passed. */
  settleRunnerBundle?: (intent: DeployIntentRow) => Promise<RunnerBundleDrainResult>;
  /**
   * Publish owed App releases the running trusted code can serve. Called only
   * while no deployment is in flight; it must be idempotent and cheap when
   * nothing changed.
   */
  publishApps?: () => Promise<void>;
}

export class DeployService {
  private startupFailure: (id: number) => string | null;
  private ingress?: StartupIngress;
  private bootSha: Promise<string | null>;
  private store: Store;
  private repoDir: string;
  readonly baseBranch: string;
  readonly stableBranch: string;
  private deployers: string[];
  private paths: { runTree: string; log: string; backups: string };
  private notifyFn: (ev: DeployEvent) => Promise<void>;
  private prepareTargetFn: ((sha: string) => Promise<BuildWarmJoinResult>) | null;
  private settleRunnerBundleFn: ((intent: DeployIntentRow) => Promise<RunnerBundleDrainResult>) | null;
  private readonly publishAppsFn: (() => Promise<void>) | null;
  private publishingApps = false;
  private nextAppPublish = 0;
  private timer: NodeJS.Timeout | null = null;
  private confirmRequested = new Set<number>();
  private finalizing = false;
  private triggering = false;
  private readonly prepareReleaseFn?: (intent: DeployIntentRow) => Promise<void>;
  private readonly prewarmReleaseFn?: (sha: string) => Promise<void>;
  private readonly releaseStatusFn?: (sha: string) => Promise<ReleasePreparation>;
  private readonly stagedReleaseShas?: () => Promise<string[]>;
  private warming = false;
  private nextWarmCheck = 0;
  private warmGeneration = 0;
  private readonly releaseCatalog?: GitLabReleaseCatalog;

  constructor(opts: DeployServiceOpts) {
    this.startupFailure = opts.startupFailure ?? (() => null);
    this.ingress = opts.ingress;
    this.store = opts.store;
    this.repoDir = opts.repoDir;
    this.baseBranch = opts.baseBranch;
    this.stableBranch = opts.stableBranch ?? DEFAULT_STABLE_BRANCH;
    this.deployers = opts.deployers ?? [];
    this.paths = {
      runTree: opts.runTreeDir ?? this.repoDir,
      log: opts.supervisorLog ?? "(supervisor 日志路径未配置)",
      backups: opts.backupsDir ?? "(备份目录未配置)",
    };
    this.bootSha = git(this.paths.runTree, ["rev-parse", "HEAD"]).then((result) => result.ok ? result.stdout.trim() : null);
    this.notifyFn = opts.notify ?? (async () => {});
    this.prepareTargetFn = opts.prepareTarget ?? null;
    this.prepareReleaseFn = opts.prepareRelease;
    this.prewarmReleaseFn = opts.prewarmRelease;
    this.releaseStatusFn = opts.releaseStatus;
    this.stagedReleaseShas = opts.stagedReleaseShas;
    this.releaseCatalog = opts.releaseCatalog;
    this.settleRunnerBundleFn = opts.settleRunnerBundle ?? null;
    this.publishAppsFn = opts.publishApps ?? null;
  }

  setNotify(fn: (ev: DeployEvent) => Promise<void>): void {
    this.notifyFn = fn;
  }

  async ingressStatus(): Promise<StartupIngressStatus | null> {
    if (!this.ingress) return null;
    const sha = await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]);
    return this.ingress.check(sha);
  }

  runningSha(): Promise<string | null> { return this.bootSha; }

  async preparationStatus(checkedSha?: string): Promise<ReleasePreparation | null> {
    if (!this.releaseStatusFn) return null;
    if (checkedSha) return this.releaseStatusFn(checkedSha);
    if (this.releaseCatalog) {
      const pin = (await this.releaseCatalog.snapshot())?.ready;
      return pin ? this.releaseStatusFn(pin.sha) : null;
    }
    return this.releaseStatusFn(await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]));
  }

  async releaseCatalogStatus() {
    if (!this.releaseCatalog) return null;
    const snapshot = await this.releaseCatalog.snapshot();
    let deployable: ReleasePin | null = null;
    if (snapshot && this.releaseStatusFn) {
      const candidates = new Set(await this.stagedReleaseShas?.() ?? []);
      if (snapshot.ready) candidates.add(snapshot.ready.sha);
      // CI upload order and staging order can differ. Only a fully staged
      // ancestor of the checked mainline is offered, newest commit first.
      const history = (await gitOrThrow(this.repoDir, ["rev-list", "--first-parent", "--max-count=5000", snapshot.mainlineSha])).split("\n");
      for (const sha of history) {
        if (!candidates.has(sha)) continue;
        const prepared = await this.releaseStatusFn(sha);
        if (prepared.state !== "ready" || !prepared.manifestSha256) continue;
        if (snapshot.ready?.sha === sha && snapshot.ready.manifestSha256 !== prepared.manifestSha256) continue;
        deployable = { sha, manifestSha256: prepared.manifestSha256 };
        break;
      }
    }
    return { enabled: true as const, snapshot, deployable };
  }
  async checkUpdates() {
    if (!this.releaseCatalog) throw new Error("GitLab release catalog is not configured");
    const snapshot = await this.releaseCatalog.check();
    if (snapshot.ready) void this.prewarmReleaseFn?.(snapshot.ready.sha).catch(error => log.warn({ error: String(error) }, "checked release staging failed"));
    return snapshot;
  }

  private async requireIngress(sha: string): Promise<void> {
    if (!this.ingress) return;
    const result = await this.ingress.check(sha, true);
    if (!result.ready) throw new Error(result.reason ?? "入口加载页未就绪");
  }

  /** Config allow-list, folded into the dashboard identity's `deploy` bit. */
  get deployerList(): readonly string[] {
    return this.deployers;
  }

  /**
   * Feishu `/deploy` path (the dashboard resolves this in the identity now).
   *
   * Ticket #15 removed the "empty list = everyone" fallback: an unset
   * `selfhosting.deployers` used to let any registered user fast-forward the
   * base branch and restart production. Deploy rights are granted, never
   * assumed — from config here, or at /admin on the web side.
   */
  mayDeploy(username: string, isAdmin: boolean): boolean {
    if (isAdmin) return true;
    // The SAME resolver the panel uses, not a second copy of the rule: the
    // Feishu door and the web door cannot disagree about who may deploy if
    // there is only one function that answers it.
    return resolveCapabilityBits({
      username,
      deployers: this.deployers,
      granted: this.store.listUserGrants(username).map((g) => g.capability),
    }).deploy;
  }

  /** Resume watching after a restart; also finalizes anything missed. */
  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.pollOnce().catch(() => {}), WATCH_INTERVAL_MS);
      this.timer.unref?.();
    }
    void this.pollOnce().catch((err) => log.warn({ err }, "deploy poll failed"));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.warmGeneration++;
  }

  /**
   * Recover tickets created after an older process triggered the deployment.
   *
   * A CLI report is stored in Git first and projected into SQLite by the new
   * process. The old process therefore could not mark that row as `deploying`
   * when it created the intent. Only adopt pending commits that are actually
   * ancestors of the active target; a newer ticket must wait for the next
   * deployment.
   */
  async reconcilePendingTicketsForActiveDeploy(): Promise<number[]> {
    const intent = this.store.devTickets.getActiveDeployIntent();
    if (!intent) return [];
    const adopted: number[] = [];
    for (const ticket of this.pendingTickets()) {
      if (ticket.deploy_status !== "pending" || !ticket.commit_sha) continue;
      const contained = await git(this.repoDir, [
        "merge-base", "--is-ancestor", ticket.commit_sha, intent.target_sha,
      ]);
      if (!contained.ok) continue;
      this.store.devTickets.updateDevTicket(ticket.id, { deploy_status: "deploying" });
      adopted.push(ticket.id);
    }
    if (adopted.length) {
      log.info(
        { intent: intent.id, target: intent.target_sha.slice(0, 10), tickets: adopted },
        "adopted late-projected tickets into active deployment",
      );
    }
    return adopted;
  }

  /**
   * Trigger a deploy of `target` (default: trunk HEAD). Order is the point:
   * rescue card OUT, then intent row IN — if everything later goes dark, the
   * card already sits in message history.
   */
  async trigger(by: string, target?: string, source?: Omit<DeploymentOrigin, "intent_id" | "actor">, releasePin?: ReleasePin): Promise<DeployIntentRow> {
    if (this.triggering || this.store.devTickets.getActiveDeployIntent()) {
      throw new Error("已有部署在进行中,等它落定再触发");
    }
    this.triggering = true;
    try {
      if (this.releaseCatalog) {
        if (!releasePin || target !== releasePin.sha) throw new Error("先检查更新，再提交所选发布包的完整 SHA 和摘要");
        const checked = await this.releaseCatalog.snapshot();
        // Background discovery may advance while a confirmation is open. The
        // reviewed SHA+digest stays valid when it is still a prepared mainline
        // ancestor; a newer build must never substitute or invalidate it.
        if (!checked || !(await git(this.repoDir, ["merge-base", "--is-ancestor", releasePin.sha, checked.mainlineSha])).ok) {
          throw new Error("所选发布包不属于已检查的主线，请重新检查更新");
        }
        await this.releaseCatalog.release(releasePin.sha, releasePin.manifestSha256);
      }
      const requested = target?.trim() || this.baseBranch;
      const explicitTarget = Boolean(target?.trim());
      let targetSha = await gitOrThrow(this.repoDir, ["rev-parse", `${requested}^{commit}`]);
      if (this.prepareTargetFn && !this.releaseCatalog) {
        try {
          const prepared = await this.prepareTargetFn(targetSha);
          log.info(
            {
              target: targetSha.slice(0, 10),
              ready: prepared.ready,
              joined: prepared.joined,
              waitedMs: prepared.waitedMs,
            },
            "deploy build-warm preparation settled",
          );
        } catch (err) {
          // Cache warming is only latency work. Supervisor build remains the
          // correctness path when it crashes or becomes unavailable.
          log.warn({ target: targetSha.slice(0, 10), err }, "deploy build-warm preparation failed; continuing normally");
        }
      }

      // Waiting for a warm build must not pin the default deployment to an old
      // watermark if another ticket landed meanwhile. An explicit ref remains
      // exact by request; the default branch is re-read immediately before the
      // rescue card and durable intent are created.
      if (!explicitTarget) {
        const latest = await gitOrThrow(this.repoDir, ["rev-parse", `${this.baseBranch}^{commit}`]);
        if (latest !== targetSha) {
          log.info(
            { before: targetSha.slice(0, 10), after: latest.slice(0, 10) },
            "deploy watermark advanced during build preparation",
          );
          targetSha = latest;
        }
      }
      if (this.store.devTickets.getActiveDeployIntent()) throw new Error("已有部署在进行中,等它落定再触发");

      if (this.releaseStatusFn) {
        const prepared = await this.releaseStatusFn(targetSha);
        if (prepared.state !== "ready" || (releasePin && prepared.manifestSha256 !== releasePin.manifestSha256)) throw new Error("所选发布包尚未完成下载和暂存；请等待准备就绪后上线，当前服务保持运行");
      }

      const stable = (await git(this.repoDir, ["rev-parse", this.stableBranch])).stdout || "(无)";
      // A computed tier-3 verdict blocks (#522). A review that cannot run is
      // no verdict: the deployment proceeds and the intent carries a warning.
      const unreviewed: string[] = [];
      await assertKnowledgeDeployable({ repoDir: this.repoDir, target: targetSha, previous: await this.bootSha, store: this.store,
        onUnavailable: (reason) => unreviewed.push(`⚠ 知识审查未能运行(${reason})，本次部署未经第三档冲突复核。`) });
      await this.requireIngress(targetSha);
      const pending: DevTicketRow[] = [];
      for (const ticket of this.pendingTickets()) {
        if (!this.releaseCatalog || (ticket.commit_sha && (await git(this.repoDir, ["merge-base", "--is-ancestor", ticket.commit_sha, targetSha])).ok)) pending.push(ticket);
      }
      const rescue = [this.rescueText(by, targetSha, stable, pending), ...unreviewed].join("\n");
      try {
        await this.notifyFn({ kind: "rescue", text: rescue, triggeredBy: by });
      } catch (err) {
        log.warn({ err }, "rescue card send failed — deploying anyway (panel still shows the runbook)");
      }

      const intent = this.store.devTickets.createDeployIntent({ target_sha: targetSha, triggered_by: by,
        ...(releasePin ? { release_manifest_sha256: releasePin.manifestSha256 } : {}),
        ...(source ? { trigger_source: JSON.stringify(source) } : {}),
      });
      if (unreviewed[0]) this.store.devTickets.updateDeployIntent(intent.id, { detail: unreviewed[0] });
      for (const t of pending) this.store.devTickets.updateDevTicket(t.id, { deploy_status: "deploying" });
      log.info({ intent: intent.id, target: targetSha.slice(0, 10), by }, "deploy triggered");
      this.start();
      return this.store.devTickets.getDeployIntent(intent.id) ?? intent;
    } finally {
      this.triggering = false;
    }
  }

  /** Liveness decision from either surface; false = lost the race. */
  decide(intentId: number, decision: "alive" | "rollback", by: string): boolean {
    const ok = this.store.devTickets.recordDeployDecision(intentId, decision, by);
    if (ok) log.info({ intentId, decision, by }, "deploy liveness decision");
    return ok;
  }

  /**
   * Resolve the product-acceptance ticket. CI owns the tested stable watermark;
   * acceptance only advances the ticket's deployment axis.
   */
  async resolveVerify(
    id: number,
    result: "passed" | "failed",
    by: string,
    notes?: string,
  ): Promise<VerifyTicketBlock> {
    const row = this.store.devTickets.getVerifyTicket(id);
    if (!row) throw new Error(`验证工单不存在: #${id}`);
    if (result === "passed" && this.ingress) {
      const deployed = await gitOrThrow(this.paths.runTree, ["rev-parse", "HEAD"]);
      await this.requireIngress(deployed);
    }
    if (
      result === "passed"
      && this.store.runnerArtifacts.hasPendingForTickets(JSON.parse(row.ticket_ids) as number[])
    ) {
      throw new Error("验收区块仍有 Runner bundle 待激活或激活失败，不能标记完成");
    }
    const resolved = this.store.devTickets.resolveOpenVerifyBlock(id, result, by, notes);
    if (!resolved) {
      throw new Error(`验证工单 #${id} 已判定过(${row.status})`);
    }
    const stableAdvanced = false;
    if (result === "passed") {
      const ticketIds = JSON.parse(resolved.ticket_ids) as number[];
      for (const tid of ticketIds) {
        const t = this.store.devTickets.getDevTicket(tid);
        if (t?.deploy_status === "live_unverified") this.store.devTickets.updateDevTicket(tid, { deploy_status: "verified" });
      }
      log.info(
        { verify: id, deployments: resolved.deployment_count, sha: resolved.target_sha.slice(0, 10) },
        "production acceptance block passed",
      );
    }
    void this.notifyFn({ kind: "verify_resolved", verify: resolved, stableAdvanced }).catch(() => {});
    return resolved;
  }

  /** One watch step — exposed for tests; the interval calls it too. */
  async pollOnce(): Promise<void> {
    const active = this.store.devTickets.getActiveDeployIntent();
    if (!active && this.prewarmReleaseFn && !this.warming && Date.now() >= this.nextWarmCheck) {
      this.warming = true;
      this.nextWarmCheck = Date.now() + 30000;
      const generation = this.warmGeneration;
      void (async () => {
        // A saved manual check never discovers a newly completed CI release.
        // Refresh automatically, serially, even if mainline itself did not move
        // while its build was running. This only prepares; it creates no intent.
        const sha = this.releaseCatalog ? (await this.releaseCatalog.check()).ready?.sha : await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]);
        const boot = await this.bootSha;
        if (generation !== this.warmGeneration || this.triggering || this.store.devTickets.getActiveDeployIntent()) return;
        if (sha && sha !== boot) await this.prewarmReleaseFn!(sha);
      })().catch(error => log.warn({ error: String(error) }, "release prewarming unavailable"))
        .finally(() => { this.warming = false; });
    }
    if (active && ["requested", "claimed", "building"].includes(active.status) && this.prepareReleaseFn) {
      void this.prepareReleaseFn(active).catch(error => log.warn({ id: active.id, error: String(error) }, "remote deployment preparation unavailable"));
    }
    if (active?.status === "confirm_wait" && !this.confirmRequested.has(active.id)) {
      this.confirmRequested.add(active.id);
      void this.notifyFn({ kind: "confirm_request", intent: active }).catch(() => {});
    }
    if (this.finalizing) return;
    this.finalizing = true;
    try {
      for (const intent of this.store.devTickets.listUnnotifiedDeployIntents()) {
        await this.finalize(intent);
      }
    } finally {
      this.finalizing = false;
    }
    this.maybePublishApps();
  }

  // ── internals ──

  /**
   * Automatic App publication, never while a deployment is in flight: during
   * one the new process has not passed its health gate, and a rollback must
   * not leave Apps on packages built for the platform that failed it.
   */
  private maybePublishApps(): void {
    if (!this.publishAppsFn || this.publishingApps || this.triggering || Date.now() < this.nextAppPublish) return;
    if (this.store.devTickets.getActiveDeployIntent()) return;
    this.publishingApps = true;
    this.nextAppPublish = Date.now() + APP_PUBLISH_INTERVAL_MS;
    void this.publishAppsFn()
      .catch((error) => log.warn({ error: String(error) }, "automatic App publication failed"))
      .finally(() => { this.publishingApps = false; });
  }

  private pendingTickets(): DevTicketRow[] {
    return this.store.devTickets.listTicketsByDeployStatus(["pending", "deploying"])
      .filter((t) => ticketNeedsTrustedDeploy(t) && t.dev_status === "landed");
  }

  private deployingTickets(): DevTicketRow[] {
    return this.store.devTickets.listTicketsByDeployStatus(["deploying"]);
  }

  private rescueText(by: string, target: string, stable: string, tickets: DevTicketRow[]): string {
    const lines = [
      `🚀 部署已触发 · ${by}`,
      `target ${target.slice(0, 10)}(${this.baseBranch}) · CI 水位 stable@${stable.slice(0, 10)}`,
      tickets.length
        ? "包含工单:\n" +
          tickets
            .map((t) => t.kind === "cli"
              ? `  #${t.id} ${t.title} — CLI ${t.branch ?? "?"}@${t.commit_sha?.slice(0, 10) ?? "?"}`
              : `  #${t.id} ${t.title} — session ${t.session_id?.slice(0, 12) ?? "?"}(worktree ${t.worktree ?? "?"})`)
            .join("\n")
        : "包含工单:(无新工单——重部署/回滚类操作)",
      "⏱ 启动健康门通过即完成,无需人工确认；启动失败自动恢复上一个已验证构建包。",
      "──若部署失败且系统未自动恢复──",
      "1. SSH bot 主机",
      `2. supervisor 日志:${this.paths.log}`,
      `3. 人工恢复:检查 /home/ubuntu/lht/octopus-dev/releases 后,按 doc/runbooks/deployment.md 处理`,
      "4. 牵 agent 修复:cd <上面的 worktree> && claude --resume <session id>",
      `5. db 备份:${this.paths.backups}(supervisor 部署前自动留)`,
    ];
    return lines.join("\n");
  }

  private async finalize(intent: DeployIntentRow): Promise<void> {
    if (intent.status === "succeeded") {
      // `succeeded` is written by the ring-0 supervisor only after the new
      // process passed its startup health gate. Moving the Runner pointer any
      // earlier would let a later Bot rollback leave clients on bytes from the
      // failed checkout.
      if (this.settleRunnerBundleFn) {
        try {
          const result = await this.settleRunnerBundleFn(intent);
          if (result.outcome === "failed" || result.error) {
            log.error({ intent: intent.id, result }, "deployed Runner bundle debt remains unresolved");
          }
        } catch (error) {
          // The durable rows remain the gate. A thrown callback must never let
          // the intent notifier skip the same unresolved-ticket reconciliation.
          log.error({ intent: intent.id, error }, "Runner bundle settlement threw");
        }
      }
      // The post-health settlement above clears every covered debt it could.
      // Any debt still attached to a deploying ticket is therefore either
      // ahead of this target or an activation failure. Do not let the trusted
      // checkout's healthy restart make that partially delivered ticket look
      // live, and do not include it in a block a human could verify away.
      const unresolvedRunnerTickets = new Set(
        this.store.runnerArtifacts.listPending().map((row) => row.ticket_id),
      );
      for (const ticket of this.deployingTickets()) {
        if (unresolvedRunnerTickets.has(ticket.id)) {
          this.store.devTickets.updateDevTicket(ticket.id, { deploy_status: "pending" });
        }
      }
      const verify = await this.buildVerifyTicket(intent);
      for (const t of this.deployingTickets()) this.store.devTickets.updateDevTicket(t.id, { deploy_status: "live_unverified" });
      this.store.devTickets.updateDeployIntent(intent.id, { notified: 1 });
      // The health gate passed: publish the App debt this checkout carries now.
      this.nextAppPublish = 0;
      void this.notifyFn({ kind: "deploy_result", intent: this.store.devTickets.getDeployIntent(intent.id)!, verify }).catch(() => {});
      return;
    }
    // rolled_back / failed: the water didn't rise — tickets return to pending.
    const failure = this.startupFailure(intent.id);
    if (failure) this.store.devTickets.updateDeployIntent(intent.id, { detail: `${intent.detail ?? intent.status}; ${failure}` });
    for (const t of this.deployingTickets()) this.store.devTickets.updateDevTicket(t.id, { deploy_status: "pending" });
    this.store.devTickets.updateDeployIntent(intent.id, { notified: 1 });
    void this.notifyFn({ kind: "deploy_result", intent: this.store.devTickets.getDeployIntent(intent.id)! }).catch(() => {});
  }

  private async buildVerifyTicket(intent: DeployIntentRow): Promise<VerifyTicketRow> {
    const included = this.deployingTickets();
    const base = intent.base_sha ?? this.stableBranch;
    let modules: string[] = [];
    const diff = await git(this.repoDir, ["diff", "--name-only", `${base}..${intent.target_sha}`]);
    if (diff.ok) {
      modules = [...new Set(diff.stdout.split("\n").filter(Boolean).map(moduleOf))].sort();
    }
    const checklist = included.map((t) => ({
      ticket_id: t.id,
      title: t.title,
      criteria: extractAcceptance(t.spec ?? ""),
    }));
    const assignees = [...new Set([intent.triggered_by, ...included.map((t) => t.requester)])];
    return this.store.devTickets.createVerifyTicket({
      intent_id: intent.id,
      target_sha: intent.target_sha,
      ticket_ids: included.map((t) => t.id),
      modules_touched: modules,
      checklist,
      assignees,
    });
  }
}

/** path → coarse module label (top segment; src 下钻一层)。 */
export function moduleOf(file: string): string {
  const segs = file.split("/");
  if (segs[0] === "packages" || segs[0] === "plugins") return segs.slice(0, 2).join("/");
  return segs.length > 1 ? segs[0] + "/" : segs[0];
}

/** Pull the 「## 验收标准」 section out of a spec; fall back to the whole text. */
export function extractAcceptance(spec: string): string {
  const m = /##\s*验收标准\s*\n([\s\S]*?)(?:\n##\s|$)/.exec(spec);
  return (m ? m[1] : spec).trim().slice(0, 1_500);
}
