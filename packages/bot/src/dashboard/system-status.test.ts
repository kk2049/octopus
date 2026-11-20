import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  SystemStatusProbe,
  cpuPercentBetween,
  memoryUsedPercent,
  systemStatusHosts,
  type CpuCounters,
} from "./system-status.js";

describe("system status calculations", () => {
  it("derives bounded host CPU and memory percentages", () => {
    expect(cpuPercentBetween({ idle: 100, total: 1_000 }, { idle: 150, total: 1_200 })).toBe(75);
    expect(cpuPercentBetween({ idle: 100, total: 1_000 }, { idle: 90, total: 1_200 })).toBe(0);
    expect(cpuPercentBetween({ idle: 100, total: 1_000 }, { idle: 100, total: 1_000 })).toBe(0);
    expect(memoryUsedPercent({ free: 250, total: 1_000 })).toBe(75);
    expect(memoryUsedPercent({ free: -100, total: 1_000 })).toBe(100);
    expect(memoryUsedPercent({ free: 1_100, total: 1_000 })).toBe(0);
  });
});

describe("SystemStatusProbe", () => {
  it("takes a short initial CPU sample, then shares each ten-second window", async () => {
    let now = 1_800_000_000_000;
    const cpuSamples: CpuCounters[] = [
      { idle: 100, total: 1_000 },
      { idle: 150, total: 1_200 },
      { idle: 350, total: 1_600 },
    ];
    const readCpu = vi.fn(() => cpuSamples.shift()!);
    const readMemory = vi.fn()
      .mockReturnValueOnce({ free: 400, total: 1_000 })
      .mockReturnValueOnce({ free: 250, total: 1_000 });
    const probe = new SystemStatusProbe({
      cacheMs: 10_000,
      initialSampleMs: 250,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      readCpu,
      readMemory,
      readHostname: () => "octopus-main",
    });

    const first = await probe.snapshot();
    expect(first).toEqual({
      hostname: "octopus-main",
      cpuPercent: 75,
      memoryPercent: 60,
      windowMs: 250,
      sampledAt: new Date(now).toISOString(),
    });
    expect(await probe.snapshot()).toBe(first);
    expect(readCpu).toHaveBeenCalledTimes(2);
    expect(readMemory).toHaveBeenCalledTimes(1);

    now += 10_000;
    const second = await probe.snapshot();
    expect(second).toMatchObject({ cpuPercent: 50, memoryPercent: 75, windowMs: 10_000 });
    expect(readCpu).toHaveBeenCalledTimes(3);
    expect(readMemory).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent first samples", async () => {
    const ready = new EventEmitter();
    const gate = once(ready, "release").then(() => undefined);
    const readCpu = vi.fn()
      .mockReturnValueOnce({ idle: 0, total: 100 })
      .mockReturnValueOnce({ idle: 20, total: 200 });
    const probe = new SystemStatusProbe({
      now: () => 1_800_000_000_000,
      sleep: () => gate,
      readCpu,
      readMemory: () => ({ free: 20, total: 100 }),
    });

    const first = probe.snapshot();
    const second = probe.snapshot();
    expect(second).toBe(first);
    ready.emit("release");
    await expect(first).resolves.toMatchObject({ cpuPercent: 80, memoryPercent: 80 });
    expect(readCpu).toHaveBeenCalledTimes(2);
  });
});

describe("systemStatusHosts", () => {
  const main = {
    hostname: "octopus-main",
    cpuPercent: 20,
    memoryPercent: 30,
    windowMs: 10_000,
    sampledAt: "2026-09-09T12:00:00.000Z",
  };
  const inventory = (available: Array<"claude" | "codex" | "omp">) => ({
    schema: "runner-inventory/v1" as const,
    agent_backends: (["claude", "codex", "omp"] as const).map((kind) => ({
      kind,
      available: available.includes(kind),
      split_execution: true,
    })),
    execution: {
      platform: "linux",
      arch: "x64",
      shell: true,
      workspace_files: true,
      workspace_count: 1,
      codex_exec_server: true,
    },
  });
  const status = (hostname: string, cpuPercent: number, sampledAt = "2026-09-09T12:00:05.000Z") => ({
    schema: "runner-system-status/v1" as const,
    hostname,
    cpuPercent,
    memoryPercent: 40,
    windowMs: 15_000,
    sampledAt,
  });

  it("keeps only the main site and the exact 4090 developer machine", () => {
    const hosts = systemStatusHosts(main, [
      {
        owner: "lht",
        device: "gpu-box",
        online: true,
        inventory: inventory([]),
        system_status: status("shared-runner", 50),
      },
      {
        owner: "bob",
        device: "same-box",
        online: true,
        inventory: inventory(["omp"]),
        system_status: status("SHARED-RUNNER", 55, "2026-09-09T12:00:06.000Z"),
      },
      {
        owner: "bob",
        device: "session-only",
        online: true,
        inventory: inventory([]),
        system_status: status("not-a-source", 90),
      },
    ]);

    expect(hosts).toHaveLength(2);
    expect(hosts[0]).toMatchObject({ id: "main", label: "主站", cpuPercent: 20 });
    expect(hosts[1]).toMatchObject({
      id: "runner:shared-runner",
      label: "4090 · 开发机",
      sources: [],
      cpuPercent: 50,
    });
  });

  it("deduplicates a Runner on the main hostname without replacing direct samples", () => {
    expect(systemStatusHosts(main, [{
      owner: "alice",
      device: "loopback-runner",
      online: true,
      inventory: inventory(["codex"]),
      system_status: status("OCTOPUS-MAIN", 99),
    }])).toEqual([
      expect.objectContaining({
        id: "main",
        cpuPercent: 20,
        sources: ["codex"],
      }),
    ]);
  });
});
