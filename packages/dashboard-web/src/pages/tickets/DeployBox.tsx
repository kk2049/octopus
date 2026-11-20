import { uiText } from "../../i18n/ui-text.js";
import { UiButton } from "../../ui-kit/primitives.js";
import { useNow } from "../../ui/misc.js";
import styles from "../TicketsPage.module.css";
import type { DeployState, Roster } from "./model.js";
import { useMessages } from "../../i18n/react.js";
import type { MessageKey } from "../../i18n/messages.js";

const DEPLOY_LABEL: Record<string, MessageKey> = {
  requested: "deploy.status.requested",
  claimed: "deploy.status.claimed",
  building: "deploy.status.building",
  restarting: "deploy.status.restarting",
  health_gate: "deploy.status.health_gate",
  confirm_wait: "deploy.status.confirm_wait",
  succeeded: "deploy.status.succeeded",
  rolled_back: "deploy.status.rolled_back",
  failed: "deploy.status.failed",
};

/**
 * Ordered supervisor stages we render as a stepper. Terminal states
 * (succeeded/rolled_back/failed) never appear as an "active" intent so they
 * are not in this list; when the deploy finishes we fall back to the "no
 * deploy" branch of DeployBox with the recent status inline.
 *
 * Ticket #38-2: the user asked for a "假进度条" — this is honest about being
 * a stepper (each stage lights up when the supervisor actually enters it),
 * plus an elapsed-time counter so a stall is visible instead of a mystery.
 */
const DEPLOY_STAGES: Array<{ status: string; label: MessageKey; hint: MessageKey }> = [
  { status: "requested", label: "deploy.stage.requested", hint: "deploy.hint.requested" },
  { status: "claimed", label: "deploy.stage.claimed", hint: "deploy.hint.claimed" },
  { status: "building", label: "deploy.stage.building", hint: "deploy.hint.building" },
  { status: "restarting", label: "deploy.stage.restarting", hint: "deploy.hint.restarting" },
  { status: "health_gate", label: "deploy.stage.health_gate", hint: "deploy.hint.health_gate" },
  { status: "confirm_wait", label: "deploy.stage.confirm_wait", hint: "deploy.hint.confirm_wait" },
];

function DeployProgress({
  status,
  createdAt,
  updatedAt,
}: {
  status: string;
  createdAt: string | undefined;
  updatedAt: string | undefined;
}) {
  const { t } = useMessages();
  const now = useNow(true);
  const currentIndex = DEPLOY_STAGES.findIndex((s) => s.status === status);
  const started = createdAt ? Date.parse(createdAt) : NaN;
  const elapsedMs = Number.isFinite(started) ? Math.max(0, now - started) : 0;
  const stageEnteredMs = updatedAt ? Date.parse(updatedAt) : NaN;
  const stageElapsedMs = Number.isFinite(stageEnteredMs) ? Math.max(0, now - stageEnteredMs) : 0;
  return (
    <div className={styles.progress} role="status" aria-live="polite">
      <ol className={styles.progressSteps}>
        {DEPLOY_STAGES.map((stage, index) => {
          const state =
            currentIndex < 0
              ? index === 0
                ? "current"
                : "future"
              : index < currentIndex
                ? "done"
                : index === currentIndex
                  ? "current"
                  : "future";
          return (
            <li key={stage.status} className={`${styles.progressStep} ${styles[`ps-${state}`]}`}>
              <span className={styles.progressDot}>
                {state === "done" ? "✓" : state === "current" ? "●" : "○"}
              </span>
              <span className={styles.progressLabel}>{t(stage.label)}</span>
              {state === "current" ? <span className={styles.progressHint}>{t(stage.hint)}</span> : null}
            </li>
          );
        })}
      </ol>
      {createdAt ? (
        <div className={styles.progressMeta}>
          {t("deploy.elapsed", { duration: formatDuration(elapsedMs) })}
          {currentIndex >= 0 && updatedAt ? (
            <>{t("deploy.stageElapsed", { duration: formatDuration(stageElapsedMs) })}</>
          ) : null}
        </div>
      ) : (
        <div className={styles.progressMeta}>{t("deploy.triggering")}</div>
      )}
    </div>
  );
}
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${minutes}m${s.toString().padStart(2, "0")}s`;
}

function PreparationDetails({ preparation }: { preparation: NonNullable<DeployState['preparation']> }) {
  const stopped = Boolean(preparation.error) || ['failed', 'unknown', 'unavailable'].includes(preparation.state);
  const now = useNow(preparation.state !== 'ready' && !stopped);
  const phases = [...(preparation.phases ?? []), ...(preparation.installation?.phases ?? [])];
  const labels: Record<string, string> = {
    cached_dependencies: uiText('校验依赖缓存'), cached_outputs: uiText('校验程序缓存'),
    receive_dependencies: uiText('接收依赖'), receive_outputs: uiText('接收程序'),
    verify_dependencies: uiText('校验依赖'), verify_outputs: uiText('校验程序'),
    waiting_install_lock: uiText('等待安装'), dependency_cache: uiText('检查依赖缓存'),
    checkout: uiText('准备源码'), dependencies_extract: uiText('展开依赖'),
    dependencies_link: uiText('复用依赖'), outputs_extract: uiText('展开程序'),
    validate: uiText('检查运行文件'), publish: uiText('完成准备'),
  };
  if (!phases.length && !preparation.maintenance) return null;
  return <details className={styles.dstat} data-testid="release-preparation-details">
    <summary>{uiText('查看准备耗时')}</summary>
    <ul>
      {phases.map((phase) => <li key={`${phase.name}-${phase.startedAt}`}>
        {labels[phase.name] ?? phase.name} · {formatDuration(phase.state === 'running' && !stopped
          ? Math.max(phase.elapsedMs, now - Date.parse(phase.startedAt)) : phase.elapsedMs)}
        {phase.state === 'running' ? ` · ${uiText(stopped ? '已让路或停止' : '进行中')}` : phase.state === 'failed' ? ` · ${uiText('失败')}` : ''}
        {phase.cacheHit ? ` · ${uiText('缓存命中')}` : ''}
        {phase.filesReused !== undefined ? ` · ${uiText('复用 {v0} 个文件', { v0: String(phase.filesReused) })}` : ''}
      </li>)}
    </ul>
    {preparation.maintenance ? <div>{uiText('后台清理')} · {formatDuration(preparation.maintenance.elapsedMs)} · {preparation.maintenance.state === 'running'
      ? uiText('进行中') : preparation.maintenance.state === 'succeeded' ? uiText('已完成') : preparation.maintenance.state === 'failed' ? uiText('失败') : uiText('已让路或停止')}</div> : null}
  </details>;
}

export function DeployBox({
  state,
  viewer,
  pendingCount,
  busy,
  deploying,
  publishingApps,
  decidedIntent,
  onTrigger,
  onCheckUpdates,
  checkingUpdates,
  onPublishApps,
  onConfirm,
  onVerify,
}: {
  state: DeployState | undefined;
  viewer: Roster["viewer"];
  pendingCount: number;
  busy: boolean;
  deploying: boolean;
  publishingApps: boolean;
  decidedIntent: { id: number; decision: "alive" | "rollback" } | null;
  onTrigger: () => void;
  onCheckUpdates?: () => void;
  checkingUpdates?: boolean;
  onPublishApps: () => void;
  onConfirm: (id: number, decision: "alive" | "rollback") => void;
  onVerify: (id: number, result: "passed" | "failed") => void;
}) {
  const { t } = useMessages();
  if (!state) return null;
  const active = state.active;
  const verify = state.verify_open;
  const pendingApps = state.app_releases_pending ?? [];
  const runnerBundle = state.runner_bundle;
  const pendingRunner = runnerBundle?.pending ?? [];
  const serverPublishingApps = state.app_release_drain?.active === true;
  const automaticAppDrain = serverPublishingApps && state.app_release_drain?.mode === "automatic";
  // Only App debt is pending. With staged releases (GitLab) it goes live by
  // itself once its release is staged: hot publication is then an Administer
  // retry shown beside, not instead of, the release deployment.
  const appOnly = pendingCount === 0 && pendingApps.length > 0 && pendingRunner.length === 0 && !serverPublishingApps;
  const release = state.releases?.snapshot;
  const deployable = state.releases?.deployable;
  let modules: string[] = [];
  let checklist: Array<{ ticket_id: number; title: string; criteria: string }> = [];
  let assignees: string[] = [];
  if (verify) {
    try {
      modules = JSON.parse(verify.modules_touched);
      checklist = JSON.parse(verify.checklist);
      assignees = JSON.parse(verify.assignees);
    } catch {
      /* a malformed column must not blank the panel */
    }
  }
  const mayVerify = Boolean(viewer && (viewer.admin || assignees.includes(viewer.username ?? "")));
  return (
    <div className={styles.deployBox}>
      {state.releases ? <>
        <div className={styles.dstat} role="status">
          {uiText("主线 {v0} · 可用发布 {v1} · 线上 {v2}", { v0: release?.mainlineSha.slice(0, 10) ?? "—", v1: deployable?.sha.slice(0, 10) ?? "—", v2: state.deployed_sha?.slice(0, 10) ?? "—" })}
        </div>
        {state.may_deploy ? <div className={styles.drow}>
          <UiButton disabled={busy || checkingUpdates} onClick={onCheckUpdates}>
            {checkingUpdates ? uiText("正在检查更新…") : uiText("检查更新")}
          </UiButton>
        </div> : null}
      </> : null}
      {state.preparation ? <div className={styles.dstat} role="status">
        {state.preparation.state === "ready"
          ? uiText("发布准备就绪：{v0}（已构建、下载和暂存）", { v0: state.preparation.sha.slice(0, 10) })
          : state.preparation.error ? uiText("发布准备受阻：{v0}；当前服务继续运行", { v0: state.preparation.error })
          : uiText("发布准备中：{v0} · {v1}；当前服务继续运行", {
            v0: state.preparation.sha.slice(0, 10),
            v1: state.preparation.error ?? state.preparation.state,
          })}
      </div> : null}
      {state.preparation ? <PreparationDetails key={state.preparation.sha} preparation={state.preparation} /> : null}
      {deployable && deployable.sha !== state.deployed_sha && state.preparation && state.preparation.sha !== deployable.sha
        ? <div className={styles.dstat} role="status">{uiText("可立即上线已准备版本 {v0}；后台准备不影响本次上线。", { v0: deployable.sha.slice(0, 10) })}</div> : null}
      {state.ingress ? <div className={styles.dstat} role={state.ingress.ready ? "status" : "alert"}>
        {state.ingress.ready ? uiText("入口加载页：已启用并核验") : uiText("入口加载页待处理：{v0}", { v0: state.ingress.reason ?? "" })}
      </div> : null}
      {state.recent?.[0] && ["failed", "rolled_back"].includes(state.recent[0].status) ? <div role="alert" className={styles.dstat}>
        <strong>D{state.recent[0].id} · {t(DEPLOY_LABEL[state.recent[0].status]!)}</strong>
        <div>{uiText("目标 {v0} · 实际运行 {v1}", { v0: state.recent[0].target_sha?.slice(0, 12) ?? "?", v1: state.deployed_sha?.slice(0, 12) ?? "?" })}</div>
        <div>{state.recent[0].detail}</div>
      </div> : null}
      <div className={styles.dhd}>
        {automaticAppDrain
          ? t("deploy.autoApps")
          : appOnly && !state.releases
            ? t("deploy.hotApps")
            : t("deploy.title", { base: state.base_branch, stable: state.stable_branch })}
      </div>
      {active ? (
        <>
          <div className={styles.dstat}>
            {t("deploy.batch", {
              id: active.id,
              sha: String(active.target_sha).slice(0, 10),
              status: DEPLOY_LABEL[active.status] ? t(DEPLOY_LABEL[active.status]!) : active.status,
            })}
          </div>
          {active.status === "confirm_wait" ? (
            decidedIntent && decidedIntent.id === active.id ? (
              // Optimistic: hide the two buttons the moment either is clicked
              // so a second tap can't fire the same request and read the 409 as
              // "已经确认过". Cleared when the poll leaves confirm_wait
              // (ticket #38-1).
              <div className={`${styles.dstat} ${styles.confirmAck}`}>
                {decidedIntent.decision === "alive"
                  ? t("deploy.aliveSubmitted")
                  : t("deploy.rollbackSubmitted")}
              </div>
            ) : (
              <div className={styles.drow}>
                <UiButton
                  className="primary"
                  disabled={busy}
                  onClick={() => onConfirm(active.id, "alive")}
                >
                  {t("deploy.alive")}
                </UiButton>
                <UiButton
                  className="danger"
                  disabled={busy}
                  onClick={() => onConfirm(active.id, "rollback")}
                >
                  {t("deploy.rollback")}
                </UiButton>
              </div>
            )
          ) : null}
          <DeployProgress
            status={active.status}
            createdAt={active.created_at}
            updatedAt={active.updated_at}
          />
          {active.detail ? <pre>{String(active.detail).slice(-500)}</pre> : null}
        </>
      ) : verify ? (
        <>
          <div className={styles.dstat}>
            {t("deploy.verifySummary", {
              count: verify.deployment_count ?? 1,
              id: verify.intent_id,
              sha: String(verify.target_sha).slice(0, 10),
              modules: modules.join("、") || t("deploy.none"),
            })}
          </div>
          {checklist.length ? (
            <pre>
              {checklist
                .map((item) => `#${item.ticket_id} ${item.title}\n${item.criteria}`)
                .join("\n\n")}
            </pre>
          ) : null}
          {mayVerify ? (
            <div className={styles.drow}>
              <UiButton
                className="primary"
                disabled={busy}
                onClick={() => onVerify(verify.id, "passed")}
              >
                {t("deploy.verifyAll")}
              </UiButton>
              <UiButton
                className="danger"
                disabled={busy}
                onClick={() => onVerify(verify.id, "failed")}
              >
                {t("deploy.problem")}
              </UiButton>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className={styles.dstat}>
            {t("deploy.idle")}
            {state.recent?.[0]
              ? t("deploy.recent", {
                  id: state.recent[0].id,
                  status: DEPLOY_LABEL[state.recent[0].status]
                    ? t(DEPLOY_LABEL[state.recent[0].status]!)
                    : state.recent[0].status,
                })
              : ""}{" "}
            {t("deploy.pendingTickets", { count: pendingCount })}
          </div>
        </>
      )}
      {!active && (state.releases || deploying || serverPublishingApps || pendingCount > 0 || pendingApps.length > 0 || pendingRunner.length > 0) ? (
        <>
          {verify ? (
            <div className={styles.dstat}>{t("deploy.nextPendingTickets", { count: pendingCount })}</div>
          ) : null}
          {pendingApps.length ? (
            <div className={styles.dstat}>
              {t("deploy.pendingApps", {
                apps: pendingApps.map((app) => app.title).join("、"),
                detail: appOnly
                ? t(state.releases ? "deploy.appsAutoReady" : "deploy.appsHotReady")
                : automaticAppDrain
                  ? t("deploy.appsInstalling")
                  : t("deploy.appsAfterHealth"),
              })}
            </div>
          ) : null}
          {pendingRunner.length ? (
            <div className={styles.dstat}>
              {t("deploy.pendingRunner", {
                tickets: pendingRunner.map((row) => `#${row.ticket_id}`).join("、"),
              })}
              {pendingRunner.some((row) => row.last_error) ? (
                <>{t("deploy.runnerFailure", {
                  error: pendingRunner.find((row) => row.last_error)?.last_error ?? "",
                })}</>
              ) : (
                <>{t("deploy.runnerAfterHealth")}</>
              )}
              {runnerBundle?.active_sha ? <>{uiText(" · 已激活 ")}{runnerBundle.active_sha.slice(0, 12)}</> : null}
            </div>
          ) : null}
          {appOnly && state.releases && state.may_publish_apps && !publishingApps ? (
            <div className={styles.drow}>
              <UiButton disabled={busy} onClick={onPublishApps}>
                {t("deploy.hotPublish", { count: pendingApps.length })}
              </UiButton>
            </div>
          ) : null}
          {publishingApps || serverPublishingApps ? (
            <div className={styles.dstat} role="status">
              {automaticAppDrain
                ? t("deploy.publishingAuto")
                : t("deploy.publishing")}
            </div>
          ) : appOnly && !state.releases ? (
            state.may_publish_apps ? (
              <div className={styles.drow}>
                <UiButton className="primary" disabled={busy} onClick={onPublishApps}>
                  {t("deploy.hotPublish", { count: pendingApps.length })}
                </UiButton>
              </div>
            ) : (
              <div className={styles.dstat}>{t("deploy.adminRequired")}</div>
            )
          ) : deploying ? (
            // The trigger POST has returned but the poll hasn't yet swapped
            // state.active in — showing the requested stage right away gives
            // the operator immediate visual feedback while build (which really
            // does take several minutes cold) is starting on the supervisor
            // side (ticket #38-2).
            <DeployProgress status="requested" createdAt={undefined} updatedAt={undefined} />
          ) : state.may_deploy ? (
            <div className={styles.drow}>
              <UiButton className="primary" disabled={busy || (state.releases
                ? !deployable || state.deployed_sha === deployable.sha
                : Boolean(state.preparation && state.preparation.state !== "ready"))} onClick={onTrigger}>
                {state.releases ? uiText("上线") : t("deploy.launch", {
                  branch: state.base_branch,
                  summary: [
                    pendingCount ? t("deploy.ticketCount", { count: pendingCount }) : "",
                    pendingApps.length ? t("deploy.appCount", { count: pendingApps.length }) : "",
                    pendingRunner.length ? t("deploy.runnerCount", { count: pendingRunner.length }) : "",
                  ]
                    .filter(Boolean)
                    .join(" + "),
                })}
              </UiButton>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
