import { describe, expect, it, vi } from "vitest";
import {
  SystemStatusProbe,
  macMemoryPressurePercentFromOutput,
} from "./system-status.js";

describe("macOS system memory pressure", () => {
  it("converts the kernel-backed memory_pressure percentage to the dashboard scale", () => {
    expect(macMemoryPressurePercentFromOutput([
      "The system has 34359738368 (2097152 pages with a page size of 16384).",
      "System-wide memory free percentage: 73%",
    ].join("\n"))).toBe(27);
    expect(macMemoryPressurePercentFromOutput("System-wide memory free percentage: 101%"))
      .toBeNull();
    expect(macMemoryPressurePercentFromOutput("Pages free: 12345"))
      .toBeNull();
  });

  it("uses native pressure on Darwin and never divides raw memory counters", async () => {
    let now = 1_800_000_000_000;
    const readMemory = vi.fn(() => ({ free: 99, total: 100 }));
    const readMacMemoryPressure = vi.fn(async () => 64);
    const probe = new SystemStatusProbe({
      platform: "darwin",
      now: () => now,
      sleep: async (ms) => { now += ms; },
      readCpu: vi.fn()
        .mockReturnValueOnce({ idle: 100, total: 1_000 })
        .mockReturnValueOnce({ idle: 150, total: 1_200 }),
      readMemory,
      readMacMemoryPressure,
      readHostname: () => "mac-runner",
    });

    await expect(probe.snapshot()).resolves.toMatchObject({
      hostname: "mac-runner",
      memoryPercent: 64,
    });
    expect(readMacMemoryPressure).toHaveBeenCalledOnce();
    expect(readMemory).not.toHaveBeenCalled();
  });

  it("omits a Darwin snapshot when native pressure is unavailable instead of guessing", async () => {
    const readMemory = vi.fn(() => ({ free: 1, total: 100 }));
    const probe = new SystemStatusProbe({
      platform: "darwin",
      now: () => 1_800_000_000_000,
      sleep: async () => undefined,
      readCpu: () => ({ idle: 0, total: 100 }),
      readMemory,
      readMacMemoryPressure: async () => { throw new Error("unavailable"); },
    });

    await expect(probe.snapshot()).rejects.toThrow("unavailable");
    expect(readMemory).not.toHaveBeenCalled();
  });
});
