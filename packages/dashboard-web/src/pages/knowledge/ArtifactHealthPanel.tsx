import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText, localizedLabels } from "../../i18n/ui-text.js";
import styles from "../KnowledgePage.module.css";
import type {
  WikiArtifactActivationHealth,
  WikiArtifactEvaluationHealth,
  WikiArtifactHealth,
} from "./types.js";

const HEALTH_LABEL = localizedLabels((): Record<WikiArtifactHealth["status"], string> => ({
  healthy: uiText("健康"),
  evaluating: uiText("评测中"),
  degraded: uiText("已降级"),
  unavailable: uiText("不可用"),
}));

const EVALUATION_LABEL = localizedLabels((): Record<WikiArtifactEvaluationHealth["state"], string> => ({
  pending: uiText("等待运行"),
  running: uiText("运行中"),
  passed: uiText("通过"),
  failed: uiText("失败"),
  unavailable: uiText("不可用"),
}));

function unavailableMessage(reason: string): string {
  if (reason === "offline") return uiText("知识计算设备离线");
  if (reason === "provider_changed") return uiText("计算设备已改变，旧任务等待原设备核实");
  if (reason === "provider_identity_missing") return uiText("旧任务缺少设备归属，需先核实执行状态");
  if (reason === "remote_job_missing" || reason === "remote_status_unavailable" || reason === "job_retired_no_replay") return uiText("原任务回执不可读，执行状态未知，未重新执行");
  return uiText("知识计算能力尚不可用") + " (" + reason + ")";
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return uiText("{v0} 秒", { v0: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return uiText("{v0} 分钟", { v0: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return uiText("{v0} 小时", { v0: hours });
  return uiText("{v0} 天", { v0: Math.floor(hours / 24) });
}

function timestamp(value: string | null): string {
  return value ? value.slice(0, 16).replace("T", " ") : "—";
}

function metric(value: number | boolean | undefined, digits = 1): string | null {
  if (typeof value === "boolean") return value ? uiText("是") : uiText("否");
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function EvaluationCard({ title, value }: { title: string; value: WikiArtifactEvaluationHealth }) {
  useDashboardLanguage();
  const summary = value.metrics.recall_at_10 !== undefined
    ? `recall@10 ${metric(value.metrics.recall_at_10, 3)}`
    : value.metrics.p95_ms !== undefined
      ? `p95 ${metric(value.metrics.p95_ms)} ms`
      : null;
  return (
    <article className={styles.healthEvaluation}>
      <div>
        <b>{title}</b>
        <span className={styles.healthEvalState} data-state={value.state}>{EVALUATION_LABEL()[value.state]}</span>
      </div>
      {value.scope === "repository" ? <span>{uiText("仓库范围评估，不含服务私有台账")}</span> : null}
      {value.scope === "artifact" ? <span>{uiText("完整索引产物评估")}</span> : null}
      {value.executor ? <span>{value.executor}</span> : null}
      {summary ? <span>{summary}</span> : null}
      {value.failureCode ? <code>{value.failureCode}</code> : null}
      {value.finishedAt ? <time dateTime={value.finishedAt}>{timestamp(value.finishedAt)}</time> : null}
    </article>
  );
}

function TimelineRow({ activation }: { activation: WikiArtifactActivationHealth }) {
  useDashboardLanguage();
  return (
    <li>
      <time dateTime={activation.activatedAt}>{timestamp(activation.activatedAt)}</time>
      <code title={activation.repoSha}>{activation.repoSha.slice(0, 10)}</code>
      <span>{uiText("使用场景")}{EVALUATION_LABEL()[activation.evaluations.journeys.state]}</span>
      <span>{uiText("向量")}{EVALUATION_LABEL()[activation.evaluations.vectorBenchmark.state]}</span>
    </li>
  );
}

export function ArtifactHealthPanel({
  health,
  loading,
  error,
  refreshing,
  onRefresh,
}: {
  health: WikiArtifactHealth | undefined;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  useDashboardLanguage();
  return (
    <section className={styles.healthPanel} aria-labelledby="knowledge-artifact-health-title">
      <div className={styles.healthHead}>
        <div>
          <h3 id="knowledge-artifact-health-title">{uiText("知识产物健康")}</h3>
          <p>{uiText("激活、检索评测与远端构建任务的服务端投影")}</p>
        </div>
        <div className={styles.healthHeadActions}>
          {health ? <span className={styles.healthStatus} data-status={health.status}>{HEALTH_LABEL()[health.status]}</span> : null}
          <button type="button" className={styles.filter} disabled={refreshing} onClick={onRefresh}>
            {refreshing ? uiText("刷新中…") : uiText("刷新")}
          </button>
        </div>
      </div>
      {loading ? <p className={styles.empty}>{uiText("读取产物状态…")}</p> : null}
      {error ? <p className={styles.healthError}>{error}</p> : null}
      {!loading && health && !health.configured ? <p className={styles.empty}>{uiText("当前进程未配置知识产物服务。")}</p> : null}
      {health?.configured ? (
        <>
          <dl className={styles.healthGrid}>
            <div>
              <dt>{uiText("活跃代年龄")}</dt>
              <dd>{health.active ? duration(health.active.ageMs) : uiText("无活跃代")}</dd>
            </div>
            <div>
              <dt>{uiText("相对 ")}{health.active?.baselineRef ?? "v4"}</dt>
              <dd>{health.active?.commitsBehind === null || health.active?.commitsBehind === undefined ? uiText("未知") : uiText("落后 {v0} 个提交", { v0: health.active.commitsBehind })}</dd>
            </div>
            <div>
              <dt>{uiText("当前任务")}</dt>
              <dd>{health.task.phase}{health.task.remoteState ? ` / ${health.task.remoteState}` : ""}</dd>
            </div>
            <div>
              <dt>{uiText("向量检索")}</dt>
              <dd>{health.vectorSearchOnline ? uiText("在线") : uiText("离线")}</dd>
            </div>
            <div>
              <dt>{uiText("最近 failureCode")}</dt>
              <dd><code>{health.lastFailureCode ?? uiText("无")}</code></dd>
            </div>
            <div>
              <dt>{uiText("活跃提交")}</dt>
              <dd><code title={health.active?.repoSha}>{health.active?.repoSha.slice(0, 10) ?? "—"}</code></dd>
            </div>
          </dl>
          {health.task.unavailableReason ? <p role="status">{unavailableMessage(health.task.unavailableReason)}</p> : null}
          {health.active ? (
            <div className={styles.healthEvaluations} aria-label={uiText("激活后评测")}>
              <EvaluationCard title="knowledge:journeys" value={health.active.evaluations.journeys} />
              <EvaluationCard title="knowledge:vector:benchmark" value={health.active.evaluations.vectorBenchmark} />
            </div>
          ) : null}
          <div className={styles.healthTimeline}>
            <h4>{uiText("最近 ")}{health.recentActivations.length} {uiText(" 次激活")}</h4>
            {health.recentActivations.length ? (
              <ol>{health.recentActivations.map((activation) => <TimelineRow key={activation.manifestDigest} activation={activation} />)}</ol>
            ) : <p className={styles.empty}>{uiText("尚无激活记录。")}</p>}
          </div>
        </>
      ) : null}
    </section>
  );
}
