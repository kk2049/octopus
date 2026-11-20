import { describe, expect, it, vi } from "vitest";
import { createSessionPlusViewPerformanceMonitor } from "./view-performance.js";

describe("Sessions+ sandboxed View performance monitor", () => {
  it("coalesces input/projection frames and reports only bounded numeric behavior", () => {
    let now = 0;
    let input!: () => void;
    let longTask!: (durationMs: number) => void;
    let tick!: () => void;
    const frames: Array<() => void> = [];
    const reports: unknown[] = [];
    const monitor = createSessionPlusViewPerformanceMonitor({
      report: (report) => reports.push(report),
      now: () => now,
      visible: () => true,
      schedule: (callback) => {
        tick = callback;
        return "timer";
      },
      cancel: vi.fn(),
      scheduleFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      listenInputs: (record) => {
        input = record;
        return vi.fn();
      },
      observeLongTasks: (record) => {
        longTask = record;
        return vi.fn();
      },
      countDomNodes: () => 8_400,
      reportIntervalMs: 60_000,
      heartbeatMs: 1_000,
    });
    monitor.start();

    now = 10;
    monitor.observeProjectionCommit(4);
    now = 12;
    monitor.observeProjectionCommit(8);
    expect(frames).toHaveLength(1);
    now = 30;
    frames.shift()!();

    now = 40;
    input();
    now = 45;
    input();
    expect(frames).toHaveLength(1);
    now = 105;
    frames.shift()!();
    longTask(72.25);
    now = 1_250;
    tick();

    const report = monitor.flush();
    expect(report).toEqual({
      version: 1,
      windowMs: 1_250,
      inputEventCount: 2,
      inputFrameCount: 1,
      inputFrameTotalMs: 65,
      inputFrameMaxMs: 65,
      inputFrameOver50Count: 1,
      projectionCommitCount: 2,
      projectionCommitTotalMs: 10,
      projectionCommitMaxMs: 6,
      projectionFrameCount: 1,
      projectionFrameTotalMs: 26,
      projectionFrameMaxMs: 26,
      longTaskCount: 1,
      longTaskTotalMs: 72.3,
      longTaskMaxMs: 72.3,
      timerLagCount: 1,
      timerLagMaxMs: 250,
      domNodes: 8_400,
    });
    expect(reports).toEqual([report]);
  });

  it("stays silent for an inactive window and cancels pending frame work", () => {
    const cancel = vi.fn();
    const cancelFrame = vi.fn();
    const stopInputs = vi.fn();
    const stopLongTasks = vi.fn();
    const monitor = createSessionPlusViewPerformanceMonitor({
      report: vi.fn(),
      now: () => 0,
      schedule: () => "timer",
      cancel,
      scheduleFrame: () => "frame",
      cancelFrame,
      listenInputs: () => stopInputs,
      observeLongTasks: () => stopLongTasks,
    });
    monitor.start();
    expect(monitor.flush()).toBeNull();
    monitor.observeProjectionCommit(0);
    monitor.stop();
    expect(cancel).toHaveBeenCalledWith("timer");
    expect(cancelFrame).toHaveBeenCalledWith("frame");
    expect(stopInputs).toHaveBeenCalledTimes(1);
    expect(stopLongTasks).toHaveBeenCalledTimes(1);
  });
});
