import { describe, expect, it, vi } from "vitest";
import { createSessionPlusPerformanceMonitor } from "./performance.js";

describe("Sessions+ browser performance monitor", () => {
  it("reports only bounded projection shape and renderer timing", () => {
    let clock = 0;
    let longTask = (_duration: number) => {};
    const reports: unknown[] = [];
    const monitor = createSessionPlusPerformanceMonitor({
      now: () => clock,
      report: (value) => reports.push(value),
      schedule: () => 1,
      cancel: () => {},
      observeLongTasks: (record) => {
        longTask = record;
        return () => {};
      },
    });
    monitor.start();
    monitor.observeProjection({
      sessions: [{ resource: "must-not-be-reported" }, {}, {}],
      sources: [{ device: "also-private" }],
      transcript: {
        first: { messages: [{ text: "secret" }, {}] },
        second: { messages: [{}, {}, {}] },
      },
    });
    monitor.observeProjectionDispatch(12.34);
    longTask(75.55);
    clock = 60_000;

    expect(monitor.flush()).toMatchObject({
      version: 2,
      windowMs: 60_000,
      projectionCount: 1,
      sessionRowsMax: 3,
      sourceRowsMax: 1,
      transcriptWindowsMax: 2,
      transcriptMessagesMax: 5,
      projectionDispatchMaxMs: 12.3,
      longTaskCount: 1,
      longTaskTotalMs: 75.6,
      longTaskMaxMs: 75.6,
      timerLagCount: 0,
      timerLagMaxMs: 0,
    });
    expect(JSON.stringify(reports)).not.toContain("secret");
    expect(JSON.stringify(reports)).not.toContain("private");
  });

  it("merges the sandboxed View window without accepting content dimensions", () => {
    const monitor = createSessionPlusPerformanceMonitor({
      now: () => 60_000,
      report: vi.fn(),
      schedule: () => 1,
      cancel: () => {},
      observeLongTasks: () => () => {},
    });
    monitor.start();
    monitor.observeView({
      version: 1,
      windowMs: 60_000,
      inputEventCount: 9,
      inputFrameCount: 7,
      inputFrameTotalMs: 105,
      inputFrameMaxMs: 45,
      inputFrameOver50Count: 0,
      projectionCommitCount: 30,
      projectionCommitTotalMs: 180,
      projectionCommitMaxMs: 14,
      projectionFrameCount: 28,
      projectionFrameTotalMs: 400,
      projectionFrameMaxMs: 28,
      longTaskCount: 1,
      longTaskTotalMs: 70,
      longTaskMaxMs: 70,
      timerLagCount: 2,
      timerLagMaxMs: 240,
      domNodes: 12_345,
    });
    expect(monitor.flush()).toMatchObject({
      viewReportCount: 1,
      viewInputEventCount: 9,
      viewInputFrameCount: 7,
      viewInputFrameTotalMs: 105,
      viewInputFrameMaxMs: 45,
      viewProjectionCommitCount: 30,
      viewProjectionCommitTotalMs: 180,
      viewProjectionCommitMaxMs: 14,
      viewProjectionFrameCount: 28,
      viewProjectionFrameMaxMs: 28,
      viewLongTaskCount: 1,
      viewTimerLagCount: 2,
      viewTimerLagMaxMs: 240,
      viewDomNodesMax: 12_345,
    });
  });

  it("uses visible-tab timer drift as a fallback and tears observers down", () => {
    let clock = 0;
    let visible = false;
    let tick = () => {};
    const cancel = vi.fn();
    const disconnect = vi.fn();
    const report = vi.fn();
    const monitor = createSessionPlusPerformanceMonitor({
      now: () => clock,
      visible: () => visible,
      heartbeatMs: 1_000,
      reportIntervalMs: 10_000,
      report,
      schedule: (callback) => {
        tick = callback;
        return 7;
      },
      cancel,
      observeLongTasks: () => disconnect,
    });
    monitor.start();

    clock = 1_500;
    tick();
    visible = true;
    clock = 2_650;
    tick();
    clock = 10_000;
    tick();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({
      timerLagCount: 2,
      timerLagMaxMs: 6_350,
    });
    monitor.stop();
    expect(cancel).toHaveBeenCalledWith(7);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not emit empty windows", () => {
    const report = vi.fn();
    const monitor = createSessionPlusPerformanceMonitor({
      report,
      schedule: () => 1,
      cancel: () => {},
      observeLongTasks: () => () => {},
    });
    monitor.start();
    expect(monitor.flush()).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });
});
