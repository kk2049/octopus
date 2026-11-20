/**
 * Content-free Sessions+ renderer health.
 *
 * The trusted parent and the sandboxed View share a browser main thread. A
 * Long Tasks observer therefore captures the stalls that can keep input from
 * painting without asking the View to disclose anything. A visible-tab timer
 * drift check is the compatibility fallback. Projection inspection reads only
 * collection lengths, and reporting is one bounded window rather than one
 * request per frame or keystroke.
 */

import type { SessionPlusPerformanceReport } from "../contract.js";
import type { AgentViewPerformanceWindow } from "@claude-bot/web-trust/frame-protocol";

const DEFAULT_REPORT_INTERVAL_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 1_000;
const TIMER_LAG_THRESHOLD_MS = 100;
const MAX_COUNT = 1_000_000;
const MAX_DURATION_MS = 3_600_000;

export interface SessionPlusPerformanceMonitor {
  start(): void;
  stop(): void;
  observeProjection(projection: unknown): void;
  observeProjectionDispatch(durationMs: number): void;
  observeView(report: AgentViewPerformanceWindow): void;
  /** Emit the current non-empty window now; exposed for deterministic tests. */
  flush(): SessionPlusPerformanceReport | null;
}

export interface SessionPlusPerformanceMonitorOptions {
  report(value: SessionPlusPerformanceReport): void;
  now?: () => number;
  visible?: () => boolean;
  schedule?: (callback: () => void, intervalMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  observeLongTasks?: (record: (durationMs: number) => void) => () => void;
  reportIntervalMs?: number;
  heartbeatMs?: number;
}

interface WindowMetrics {
  projectionCount: number;
  sessionRowsMax: number;
  sourceRowsMax: number;
  transcriptWindowsMax: number;
  transcriptMessagesMax: number;
  projectionDispatchMaxMs: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  timerLagCount: number;
  timerLagMaxMs: number;
  viewReportCount: number;
  viewInputEventCount: number;
  viewInputFrameCount: number;
  viewInputFrameTotalMs: number;
  viewInputFrameMaxMs: number;
  viewInputFrameOver50Count: number;
  viewProjectionCommitCount: number;
  viewProjectionCommitTotalMs: number;
  viewProjectionCommitMaxMs: number;
  viewProjectionFrameCount: number;
  viewProjectionFrameTotalMs: number;
  viewProjectionFrameMaxMs: number;
  viewLongTaskCount: number;
  viewLongTaskTotalMs: number;
  viewLongTaskMaxMs: number;
  viewTimerLagCount: number;
  viewTimerLagMaxMs: number;
  viewDomNodesMax: number;
}

function emptyMetrics(): WindowMetrics {
  return {
    projectionCount: 0,
    sessionRowsMax: 0,
    sourceRowsMax: 0,
    transcriptWindowsMax: 0,
    transcriptMessagesMax: 0,
    projectionDispatchMaxMs: 0,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    longTaskMaxMs: 0,
    timerLagCount: 0,
    timerLagMaxMs: 0,
    viewReportCount: 0,
    viewInputEventCount: 0,
    viewInputFrameCount: 0,
    viewInputFrameTotalMs: 0,
    viewInputFrameMaxMs: 0,
    viewInputFrameOver50Count: 0,
    viewProjectionCommitCount: 0,
    viewProjectionCommitTotalMs: 0,
    viewProjectionCommitMaxMs: 0,
    viewProjectionFrameCount: 0,
    viewProjectionFrameTotalMs: 0,
    viewProjectionFrameMaxMs: 0,
    viewLongTaskCount: 0,
    viewLongTaskTotalMs: 0,
    viewLongTaskMaxMs: 0,
    viewTimerLagCount: 0,
    viewTimerLagMaxMs: 0,
    viewDomNodesMax: 0,
  };
}

export function createSessionPlusPerformanceMonitor(
  options: SessionPlusPerformanceMonitorOptions,
): SessionPlusPerformanceMonitor {
  const now = options.now ?? (() => performance.now());
  const visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
  const schedule = options.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const observeLongTasks = options.observeLongTasks ?? observeBrowserLongTasks;
  const reportIntervalMs = positive(options.reportIntervalMs, DEFAULT_REPORT_INTERVAL_MS);
  const heartbeatMs = positive(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  let metrics = emptyMetrics();
  let started = false;
  let timer: unknown;
  let stopLongTasks = () => {};
  let windowStartedAt = now();
  let heartbeatExpectedAt = windowStartedAt + heartbeatMs;

  const recordLongTask = (durationMs: number): void => {
    const duration = boundedDuration(durationMs);
    if (duration <= 0) return;
    metrics.longTaskCount = boundedCount(metrics.longTaskCount + 1);
    metrics.longTaskTotalMs = boundedDuration(metrics.longTaskTotalMs + duration);
    metrics.longTaskMaxMs = Math.max(metrics.longTaskMaxMs, duration);
  };

  const flush = (): SessionPlusPerformanceReport | null => {
    const end = now();
    const active = metrics.projectionCount > 0
      || metrics.longTaskCount > 0
      || metrics.timerLagCount > 0
      || metrics.viewReportCount > 0;
    const report = active ? {
      version: 2 as const,
      windowMs: boundedDuration(Math.max(0, end - windowStartedAt)),
      ...metrics,
    } : null;
    metrics = emptyMetrics();
    windowStartedAt = end;
    heartbeatExpectedAt = end + heartbeatMs;
    if (report) {
      try {
        options.report(report);
      } catch {
        // Diagnostics must never break the page they diagnose.
      }
    }
    return report;
  };

  const tick = (): void => {
    const observedAt = now();
    const lag = observedAt - heartbeatExpectedAt;
    if (visible() && lag >= TIMER_LAG_THRESHOLD_MS) {
      metrics.timerLagCount = boundedCount(metrics.timerLagCount + 1);
      metrics.timerLagMaxMs = Math.max(metrics.timerLagMaxMs, boundedDuration(lag));
    }
    heartbeatExpectedAt = observedAt + heartbeatMs;
    if (observedAt - windowStartedAt >= reportIntervalMs) flush();
  };

  return {
    start() {
      if (started) return;
      started = true;
      windowStartedAt = now();
      heartbeatExpectedAt = windowStartedAt + heartbeatMs;
      stopLongTasks = observeLongTasks(recordLongTask);
      timer = schedule(tick, heartbeatMs);
    },
    stop() {
      if (!started) return;
      started = false;
      cancel(timer);
      stopLongTasks();
      stopLongTasks = () => {};
    },
    observeProjection(projection) {
      const facts = projectionShape(projection);
      metrics.projectionCount = boundedCount(metrics.projectionCount + 1);
      metrics.sessionRowsMax = Math.max(metrics.sessionRowsMax, facts.sessions);
      metrics.sourceRowsMax = Math.max(metrics.sourceRowsMax, facts.sources);
      metrics.transcriptWindowsMax = Math.max(metrics.transcriptWindowsMax, facts.transcriptWindows);
      metrics.transcriptMessagesMax = Math.max(metrics.transcriptMessagesMax, facts.transcriptMessages);
    },
    observeProjectionDispatch(durationMs) {
      metrics.projectionDispatchMaxMs = Math.max(
        metrics.projectionDispatchMaxMs,
        boundedDuration(durationMs),
      );
    },
    observeView(report) {
      metrics.viewReportCount = boundedCount(metrics.viewReportCount + 1);
      metrics.viewInputEventCount = sumCount(metrics.viewInputEventCount, report.inputEventCount);
      metrics.viewInputFrameCount = sumCount(metrics.viewInputFrameCount, report.inputFrameCount);
      metrics.viewInputFrameTotalMs = sumDuration(metrics.viewInputFrameTotalMs, report.inputFrameTotalMs);
      metrics.viewInputFrameMaxMs = Math.max(metrics.viewInputFrameMaxMs, report.inputFrameMaxMs);
      metrics.viewInputFrameOver50Count = sumCount(
        metrics.viewInputFrameOver50Count,
        report.inputFrameOver50Count,
      );
      metrics.viewProjectionCommitCount = sumCount(
        metrics.viewProjectionCommitCount,
        report.projectionCommitCount,
      );
      metrics.viewProjectionCommitTotalMs = sumDuration(
        metrics.viewProjectionCommitTotalMs,
        report.projectionCommitTotalMs,
      );
      metrics.viewProjectionCommitMaxMs = Math.max(
        metrics.viewProjectionCommitMaxMs,
        report.projectionCommitMaxMs,
      );
      metrics.viewProjectionFrameCount = sumCount(
        metrics.viewProjectionFrameCount,
        report.projectionFrameCount,
      );
      metrics.viewProjectionFrameTotalMs = sumDuration(
        metrics.viewProjectionFrameTotalMs,
        report.projectionFrameTotalMs,
      );
      metrics.viewProjectionFrameMaxMs = Math.max(
        metrics.viewProjectionFrameMaxMs,
        report.projectionFrameMaxMs,
      );
      metrics.viewLongTaskCount = sumCount(metrics.viewLongTaskCount, report.longTaskCount);
      metrics.viewLongTaskTotalMs = sumDuration(metrics.viewLongTaskTotalMs, report.longTaskTotalMs);
      metrics.viewLongTaskMaxMs = Math.max(metrics.viewLongTaskMaxMs, report.longTaskMaxMs);
      metrics.viewTimerLagCount = sumCount(metrics.viewTimerLagCount, report.timerLagCount);
      metrics.viewTimerLagMaxMs = Math.max(metrics.viewTimerLagMaxMs, report.timerLagMaxMs);
      metrics.viewDomNodesMax = Math.max(metrics.viewDomNodesMax, report.domNodes);
    },
    flush,
  };
}

function projectionShape(value: unknown): {
  sessions: number;
  sources: number;
  transcriptWindows: number;
  transcriptMessages: number;
} {
  const projection = recordOf(value);
  const transcript = recordOf(projection?.transcript);
  let transcriptMessages = 0;
  for (const window of Object.values(transcript ?? {})) {
    const messages = recordOf(window)?.messages;
    transcriptMessages = boundedCount(transcriptMessages + (Array.isArray(messages) ? messages.length : 0));
  }
  return {
    sessions: boundedCount(Array.isArray(projection?.sessions) ? projection.sessions.length : 0),
    sources: boundedCount(Array.isArray(projection?.sources) ? projection.sources.length : 0),
    transcriptWindows: boundedCount(transcript ? Object.keys(transcript).length : 0),
    transcriptMessages,
  };
}

function observeBrowserLongTasks(record: (durationMs: number) => void): () => void {
  if (typeof PerformanceObserver !== "function") return () => {};
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record(entry.duration);
    });
    observer.observe({ entryTypes: ["longtask"] });
    return () => observer.disconnect();
  } catch {
    return () => {};
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedCount(value: number): number {
  return Math.min(MAX_COUNT, Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)));
}

function boundedDuration(value: number): number {
  const bounded = Math.min(MAX_DURATION_MS, Math.max(0, Number.isFinite(value) ? value : 0));
  return Math.round(bounded * 10) / 10;
}

function sumCount(current: number, next: number): number {
  return boundedCount(current + next);
}

function sumDuration(current: number, next: number): number {
  return boundedDuration(current + next);
}
