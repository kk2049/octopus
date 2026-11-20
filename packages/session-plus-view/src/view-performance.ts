/**
 * Content-free performance sampling from inside the sandboxed Sessions+ View.
 *
 * The trusted parent can count projections but cannot see how long this React
 * tree takes to commit or when a keystroke finally reaches a frame. This
 * monitor stays entirely numeric: it never reads an input value, target,
 * resource, message, URL or DOM text. Input and projection bursts are coalesced
 * to one requestAnimationFrame callback so observing a slow UI does not add a
 * callback per key or projection.
 */

import { useEffect, useLayoutEffect, useMemo } from "react";
import type {
  AgentViewClient,
  AgentViewPerformanceWindow,
  AgentViewSnapshot,
} from "@claude-bot/agent-view-react";

const DEFAULT_REPORT_INTERVAL_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 1_000;
const TIMER_LAG_THRESHOLD_MS = 100;
const INPUT_FRAME_SLOW_MS = 50;
const MAX_COUNT = 1_000_000;
const MAX_DURATION_MS = 3_600_000;

export interface SessionPlusViewPerformanceMonitor {
  start(): void;
  stop(): void;
  observeProjectionCommit(receivedAt: number): void;
  flush(): AgentViewPerformanceWindow | null;
}

export interface SessionPlusViewPerformanceMonitorOptions {
  report(value: AgentViewPerformanceWindow): void;
  now?: () => number;
  visible?: () => boolean;
  schedule?: (callback: () => void, intervalMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  scheduleFrame?: (callback: () => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
  listenInputs?: (record: () => void) => () => void;
  observeLongTasks?: (record: (durationMs: number) => void) => () => void;
  countDomNodes?: () => number;
  reportIntervalMs?: number;
  heartbeatMs?: number;
}

interface ViewMetrics {
  inputEventCount: number;
  inputFrameCount: number;
  inputFrameTotalMs: number;
  inputFrameMaxMs: number;
  inputFrameOver50Count: number;
  projectionCommitCount: number;
  projectionCommitTotalMs: number;
  projectionCommitMaxMs: number;
  projectionFrameCount: number;
  projectionFrameTotalMs: number;
  projectionFrameMaxMs: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  timerLagCount: number;
  timerLagMaxMs: number;
}

function emptyMetrics(): ViewMetrics {
  return {
    inputEventCount: 0,
    inputFrameCount: 0,
    inputFrameTotalMs: 0,
    inputFrameMaxMs: 0,
    inputFrameOver50Count: 0,
    projectionCommitCount: 0,
    projectionCommitTotalMs: 0,
    projectionCommitMaxMs: 0,
    projectionFrameCount: 0,
    projectionFrameTotalMs: 0,
    projectionFrameMaxMs: 0,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    longTaskMaxMs: 0,
    timerLagCount: 0,
    timerLagMaxMs: 0,
  };
}

export function createSessionPlusViewPerformanceMonitor(
  options: SessionPlusViewPerformanceMonitorOptions,
): SessionPlusViewPerformanceMonitor {
  const now = options.now ?? (() => performance.now());
  const visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
  const schedule = options.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const scheduleFrame = options.scheduleFrame ?? scheduleBrowserFrame;
  const cancelFrame = options.cancelFrame ?? cancelBrowserFrame;
  const listenInputs = options.listenInputs ?? listenToBrowserInputs;
  const observeLongTasks = options.observeLongTasks ?? observeBrowserLongTasks;
  const countDomNodes = options.countDomNodes ?? (() => typeof document === "undefined"
    ? 0
    : document.getElementsByTagName("*").length);
  const reportIntervalMs = positive(options.reportIntervalMs, DEFAULT_REPORT_INTERVAL_MS);
  const heartbeatMs = positive(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  let metrics = emptyMetrics();
  let started = false;
  let timer: unknown;
  let inputFrame: unknown;
  let projectionFrame: unknown;
  let pendingInputAt: number | null = null;
  let pendingProjectionAt: number | null = null;
  let stopInputs = () => {};
  let stopLongTasks = () => {};
  let windowStartedAt = now();
  let heartbeatExpectedAt = windowStartedAt + heartbeatMs;

  const recordInputFrame = (): void => {
    inputFrame = undefined;
    if (pendingInputAt === null) return;
    const duration = boundedDuration(Math.max(0, now() - pendingInputAt));
    pendingInputAt = null;
    metrics.inputFrameCount = boundedCount(metrics.inputFrameCount + 1);
    metrics.inputFrameTotalMs = boundedDuration(metrics.inputFrameTotalMs + duration);
    metrics.inputFrameMaxMs = Math.max(metrics.inputFrameMaxMs, duration);
    if (duration >= INPUT_FRAME_SLOW_MS) {
      metrics.inputFrameOver50Count = boundedCount(metrics.inputFrameOver50Count + 1);
    }
  };

  const recordInput = (): void => {
    metrics.inputEventCount = boundedCount(metrics.inputEventCount + 1);
    pendingInputAt ??= now();
    inputFrame ??= scheduleFrame(recordInputFrame);
  };

  const recordProjectionFrame = (): void => {
    projectionFrame = undefined;
    if (pendingProjectionAt === null) return;
    const duration = boundedDuration(Math.max(0, now() - pendingProjectionAt));
    pendingProjectionAt = null;
    metrics.projectionFrameCount = boundedCount(metrics.projectionFrameCount + 1);
    metrics.projectionFrameTotalMs = boundedDuration(metrics.projectionFrameTotalMs + duration);
    metrics.projectionFrameMaxMs = Math.max(metrics.projectionFrameMaxMs, duration);
  };

  const recordLongTask = (durationMs: number): void => {
    const duration = boundedDuration(durationMs);
    if (duration <= 0) return;
    metrics.longTaskCount = boundedCount(metrics.longTaskCount + 1);
    metrics.longTaskTotalMs = boundedDuration(metrics.longTaskTotalMs + duration);
    metrics.longTaskMaxMs = Math.max(metrics.longTaskMaxMs, duration);
  };

  const flush = (): AgentViewPerformanceWindow | null => {
    const end = now();
    const active = metrics.inputEventCount > 0
      || metrics.inputFrameCount > 0
      || metrics.projectionCommitCount > 0
      || metrics.projectionFrameCount > 0
      || metrics.longTaskCount > 0
      || metrics.timerLagCount > 0;
    const report = active ? {
      version: 1 as const,
      windowMs: boundedDuration(Math.max(0, end - windowStartedAt)),
      ...metrics,
      domNodes: boundedCount(countDomNodes()),
    } : null;
    metrics = emptyMetrics();
    windowStartedAt = end;
    heartbeatExpectedAt = end + heartbeatMs;
    if (report) {
      try {
        options.report(report);
      } catch {
        // Diagnostics must never break the View they diagnose.
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
      stopInputs = listenInputs(recordInput);
      stopLongTasks = observeLongTasks(recordLongTask);
      timer = schedule(tick, heartbeatMs);
    },
    stop() {
      if (!started) return;
      started = false;
      cancel(timer);
      stopInputs();
      stopLongTasks();
      stopInputs = () => {};
      stopLongTasks = () => {};
      if (inputFrame !== undefined) cancelFrame(inputFrame);
      if (projectionFrame !== undefined) cancelFrame(projectionFrame);
      inputFrame = undefined;
      projectionFrame = undefined;
      pendingInputAt = null;
      pendingProjectionAt = null;
    },
    observeProjectionCommit(receivedAt) {
      if (!Number.isFinite(receivedAt) || receivedAt < 0) return;
      const committedAt = now();
      const duration = boundedDuration(Math.max(0, committedAt - receivedAt));
      metrics.projectionCommitCount = boundedCount(metrics.projectionCommitCount + 1);
      metrics.projectionCommitTotalMs = boundedDuration(metrics.projectionCommitTotalMs + duration);
      metrics.projectionCommitMaxMs = Math.max(metrics.projectionCommitMaxMs, duration);
      pendingProjectionAt = pendingProjectionAt === null
        ? receivedAt
        : Math.min(pendingProjectionAt, receivedAt);
      projectionFrame ??= scheduleFrame(recordProjectionFrame);
    },
    flush,
  };
}

/** Wire one monitor to the committed View root without adding another store subscription. */
export function useSessionPlusViewPerformance(
  client: AgentViewClient,
  snapshot: AgentViewSnapshot,
): void {
  const monitor = useMemo(() => createSessionPlusViewPerformanceMonitor({
    report: (report) => void client.reportPerformance(report),
  }), [client]);
  useEffect(() => {
    monitor.start();
    return () => monitor.stop();
  }, [monitor]);
  useLayoutEffect(() => {
    if (snapshot.projection === null) return;
    monitor.observeProjectionCommit(snapshot.projectionReceivedAt ?? performance.now());
  }, [monitor, snapshot.projection, snapshot.projectionReceivedAt]);
}

function listenToBrowserInputs(record: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("input", record, { capture: true, passive: true });
  return () => document.removeEventListener("input", record, { capture: true });
}

function scheduleBrowserFrame(callback: () => void): unknown {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : setTimeout(callback, 0);
}

function cancelBrowserFrame(handle: unknown): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle as number);
  else clearTimeout(handle as ReturnType<typeof setTimeout>);
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
