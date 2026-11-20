import type { RunnerSystemStatus } from "@claude-bot/runner/gateway-protocol";
import type { RunnerAgentBackend, RunnerInventory } from "@claude-bot/runner/inventory";
import type { SystemStatusSnapshot } from "@claude-bot/runner/system-status";

export {
  SystemStatusProbe,
  cpuPercentBetween,
  memoryUsedPercent,
} from "@claude-bot/runner/system-status";
export type {
  CpuCounters,
  MemoryCounters,
  SystemStatusProbeOptions,
  SystemStatusSnapshot,
} from "@claude-bot/runner/system-status";

export interface RunnerStatusDevice {
  owner: string;
  device: string;
  online: boolean;
  inventory?: RunnerInventory;
  system_status?: RunnerSystemStatus;
}

export interface SystemStatusHost extends SystemStatusSnapshot {
  id: string;
  label: string;
  kind: "main" | "runner";
  sources: RunnerAgentBackend[];
}

function hostIdentity(hostname: string): string {
  return hostname.trim().toLocaleLowerCase("en-US");
}

function availableSources(inventory: RunnerInventory | undefined): RunnerAgentBackend[] {
  const available = new Set(
    (inventory?.agent_backends ?? [])
      .filter((backend) => backend.available)
      .map((backend) => backend.kind),
  );
  return (["claude", "codex", "omp"] as const).filter((source) => available.has(source));
}

function newer(left: SystemStatusSnapshot, right: SystemStatusSnapshot): SystemStatusSnapshot {
  return Date.parse(right.sampledAt) > Date.parse(left.sampledAt) ? right : left;
}

function snapshotOf(status: RunnerSystemStatus): SystemStatusSnapshot {
  return {
    hostname: status.hostname,
    cpuPercent: status.cpuPercent,
    memoryPercent: status.memoryPercent,
    windowMs: status.windowMs,
    sampledAt: status.sampledAt,
  };
}

/**
 * Build one resource row per physical hostname. A Runner that advertises
 * several model backends contributes several `sources` to the same row, never
 * one row per provider. If the bot host is also registered as a Runner, its
 * directly sampled values win and the Runner only contributes source labels.
 */
export function systemStatusHosts(
  main: SystemStatusSnapshot,
  devices: readonly RunnerStatusDevice[],
): SystemStatusHost[] {
  const mainIdentity = hostIdentity(main.hostname);
  const byHostname = new Map<string, SystemStatusHost>();
  byHostname.set(mainIdentity, {
    id: "main",
    label: "主站",
    kind: "main",
    sources: [],
    ...main,
  });

  const ordered = [...devices].sort((left, right) =>
    left.owner.localeCompare(right.owner) || left.device.localeCompare(right.device));
  for (const device of ordered) {
    const status = device.system_status;
    const sources = availableSources(device.inventory);
    if (!device.online || !status) continue;
    const identity = hostIdentity(status.hostname);
    if (!identity) continue;
    // The site strip shows the service and the exact delegated development machine.
    if (identity !== mainIdentity && (device.owner !== "lht" || device.device !== "gpu-box")) continue;
    const existing = byHostname.get(identity);
    if (existing) {
      existing.sources = (["claude", "codex", "omp"] as const)
        .filter((source) => existing.sources.includes(source) || sources.includes(source));
      if (existing.kind === "runner") Object.assign(existing, newer(existing, snapshotOf(status)));
      continue;
    }
    byHostname.set(identity, {
      id: `runner:${identity}`,
      label: "4090 · 开发机",
      kind: "runner",
      sources,
      ...snapshotOf(status),
    });
  }

  return [...byHostname.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "main" ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}
