import os from "node:os";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_CACHE_MS = 10_000;
const DEFAULT_INITIAL_SAMPLE_MS = 250;

export interface CpuCounters {
  idle: number;
  total: number;
}

export interface MemoryCounters {
  free: number;
  total: number;
}

export interface SystemStatusSnapshot {
  hostname: string;
  cpuPercent: number;
  memoryPercent: number;
  windowMs: number;
  sampledAt: string;
}

export interface SystemStatusProbeOptions {
  cacheMs?: number;
  initialSampleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readCpu?: () => CpuCounters;
  readMemory?: () => MemoryCounters;
  readMacMemoryPressure?: () => Promise<number>;
  readHostname?: () => string;
  platform?: NodeJS.Platform;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function cpuPercentBetween(start: CpuCounters, end: CpuCounters): number {
  const total = end.total - start.total;
  const idle = end.idle - start.idle;
  if (total <= 0 || idle < 0) return 0;
  return clampPercent(((total - idle) / total) * 100);
}

export function memoryUsedPercent(memory: MemoryCounters): number {
  if (!Number.isFinite(memory.total) || memory.total <= 0) return 0;
  return clampPercent(((memory.total - memory.free) / memory.total) * 100);
}

/**
 * `memory_pressure -Q` reports the kernel's system-wide percentage free,
 * derived by memorystatus rather than from raw free/total byte counters. The
 * dashboard's scale runs in the opposite direction (higher means worse), so
 * expose the complementary pressure percentage.
 */
export function macMemoryPressurePercentFromOutput(output: string): number | null {
  const match = /System-wide memory free percentage:\s*(\d{1,3})%/.exec(output);
  if (!match) return null;
  const freePercent = Number(match[1]);
  if (!Number.isInteger(freePercent) || freePercent < 0 || freePercent > 100) return null;
  return 100 - freePercent;
}

function readCpuCounters(): CpuCounters {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function readMemoryCounters(): MemoryCounters {
  return { free: os.freemem(), total: os.totalmem() };
}

function readMacMemoryPressure(): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/memory_pressure",
      ["-Q"],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error("macOS memory pressure probe failed", { cause: error }));
          return;
        }
        const pressure = macMemoryPressurePercentFromOutput(stdout);
        if (pressure === null) {
          reject(new Error("macOS memory pressure probe returned an unknown format"));
          return;
        }
        resolve(pressure);
      },
    );
  });
}

/**
 * Host pressure sampled on demand and shared by the bot host and standalone
 * Runners. Keeping one sampler here prevents the dashboard and device wire
 * projection from assigning different meanings to the same percentages.
 */
export class SystemStatusProbe {
  private readonly cacheMs: number;
  private readonly initialSampleMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readCpu: () => CpuCounters;
  private readonly readMemory: () => MemoryCounters;
  private readonly readMacMemoryPressure: () => Promise<number>;
  private readonly readHostname: () => string;
  private readonly platform: NodeJS.Platform;
  private baseline: { counters: CpuCounters; at: number } | null = null;
  private cached: { expiresAt: number; value: SystemStatusSnapshot } | null = null;
  private inFlight: Promise<SystemStatusSnapshot> | null = null;

  constructor(options: SystemStatusProbeOptions = {}) {
    this.cacheMs = Math.max(1, options.cacheMs ?? DEFAULT_CACHE_MS);
    this.initialSampleMs = Math.max(1, options.initialSampleMs ?? DEFAULT_INITIAL_SAMPLE_MS);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.readCpu = options.readCpu ?? readCpuCounters;
    this.readMemory = options.readMemory ?? readMemoryCounters;
    this.readMacMemoryPressure = options.readMacMemoryPressure ?? readMacMemoryPressure;
    this.readHostname = options.readHostname ?? os.hostname;
    this.platform = options.platform ?? process.platform;
  }

  snapshot(): Promise<SystemStatusSnapshot> {
    const now = this.now();
    if (this.cached && now < this.cached.expiresAt) return Promise.resolve(this.cached.value);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.measure().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async measure(): Promise<SystemStatusSnapshot> {
    const start = this.baseline ?? { counters: this.readCpu(), at: this.now() };
    if (!this.baseline) await this.sleep(this.initialSampleMs);

    const memoryPercent = this.platform === "darwin"
      ? clampPercent(await this.readMacMemoryPressure())
      : memoryUsedPercent(this.readMemory());
    const at = this.now();
    const counters = this.readCpu();
    const value: SystemStatusSnapshot = {
      hostname: this.readHostname(),
      cpuPercent: cpuPercentBetween(start.counters, counters),
      memoryPercent,
      windowMs: Math.max(1, at - start.at),
      sampledAt: new Date(at).toISOString(),
    };
    this.baseline = { counters, at };
    this.cached = { expiresAt: at + this.cacheMs, value };
    return value;
  }
}
