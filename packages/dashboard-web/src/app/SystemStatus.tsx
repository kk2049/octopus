import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { pollInterval } from "../lib/query.js";
import styles from "./SystemStatus.module.css";

const SYSTEM_STATUS_PATH = "/api/dev/system-status";

type AgentSource = "claude" | "codex" | "omp";

interface SystemStatusHost {
  id: string;
  label: string;
  kind: "main" | "runner";
  sources: AgentSource[];
  hostname: string;
  cpuPercent: number;
  memoryPercent: number;
  windowMs: number;
  sampledAt: string;
}

interface SystemStatusSnapshot {
  hostname?: string;
  cpuPercent: number;
  memoryPercent: number;
  windowMs: number;
  sampledAt: string;
  hosts?: SystemStatusHost[];
}

type Severity = "normal" | "warning" | "critical";

function percent(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

export function systemSeverity(value: number): Severity {
  const used = percent(value);
  if (used >= 90) return "critical";
  if (used >= 75) return "warning";
  return "normal";
}

function cpuWindow(windowMs: number): string {
  const seconds = Math.max(0.1, windowMs / 1_000);
  return uiText("最近 {v0} 秒平均", { v0: seconds >= 9.5 ? Math.round(seconds) : seconds.toFixed(1) });
}

function Metric({ host, label, value, detail }: { host: string; label: string; value: number; detail: string }) {
  useDashboardLanguage();
  const used = percent(value);
  const severity = systemSeverity(used);
  return (
    <span
      className={`${styles.metric} ${styles[severity]}`}
      title={`${host} · ${label} · ${detail} · ${used}%`}
      aria-label={`${host} · ${label}:${detail},${used}%`}
    >
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{used}%</span>
    </span>
  );
}

function hostsOf(data: SystemStatusSnapshot): SystemStatusHost[] {
  if (data.hosts?.length) return data.hosts;
  return [{
    id: "main",
    label: uiText("主站"),
    kind: "main",
    sources: [],
    hostname: data.hostname ?? "",
    cpuPercent: data.cpuPercent,
    memoryPercent: data.memoryPercent,
    windowMs: data.windowMs,
    sampledAt: data.sampledAt,
  }];
}

function sourceLabel(source: AgentSource): string {
  if (source === "claude") return "Claude";
  if (source === "codex") return "Codex";
  return "OMP";
}

export function SystemStatus() {
  useDashboardLanguage();
  const { data } = useQuery({
    queryKey: ["dev", "system-status"],
    queryFn: () => api<SystemStatusSnapshot>(SYSTEM_STATUS_PATH),
    refetchInterval: pollInterval(SYSTEM_STATUS_PATH, 10_000),
    refetchIntervalInBackground: false,
  });

  if (!data) return null;
  return (
    <span className={styles.panel} role="group" aria-label={uiText("机器资源状态")}>
      {hostsOf(data).map((host) => {
        const label = host.kind === "main" ? uiText("主站") : host.label;
        return (
          <span className={styles.host} key={host.id} data-host-kind={host.kind}>
            <span className={styles.hostHead}>
              <strong>{label}</strong>
              {host.sources.length ? (
                <span className={styles.sources} title={uiText("可用 Agent 来源")}>
                  {host.sources.map(sourceLabel).join(" / ")}
                </span>
              ) : null}
            </span>
            <span className={styles.metrics}>
              <Metric host={label} label="CPU" value={host.cpuPercent} detail={cpuWindow(host.windowMs)} />
              <Metric host={label} label={uiText("内存")} value={host.memoryPercent} detail={uiText("当前使用")} />
            </span>
          </span>
        );
      })}
    </span>
  );
}
