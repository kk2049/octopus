import { readMeetingTranscriptionAdvertisement } from "@claude-bot/runner/meeting-transcription-protocol";
import type { RunnerInventory } from "@claude-bot/runner/inventory";

/** First-party services already implemented by Runner; these names grant no authority. */
export type RunnerProviderKind = "workspace" | "knowledge-index" | "meeting-transcription";

export interface RunnerProviderAdvertisement {
  kind: RunnerProviderKind;
  /** Only protocols actually negotiated on the wire have a protocol field. */
  protocol?: "knowledge-index-jobs/v1" | "workspace-jobs/v1" | "meeting-transcription-jobs/v1";
  available?: boolean;
  reason?: string;
  concurrency?: 1;
}

/** Missing CLI binaries do not remove readable logs. Only an explicit opt-out does. */
export function runnerHasSessionRoster(inventory?: RunnerInventory): boolean {
  return inventory?.session_roster !== false;
}

/** Project authenticated inventory, never commands, paths, credentials or remote callbacks. */
export function runnerProviderAdvertisements(inventory?: RunnerInventory): RunnerProviderAdvertisement[] {
  if (!inventory) return [];
  const providers: RunnerProviderAdvertisement[] = [];
  if (inventory.execution.shell && inventory.execution.workspace_files) {
    const jobs = inventory.workspace_jobs;
    providers.push({ kind: "workspace", ...(jobs?.protocol === "workspace-jobs/v1" && jobs.concurrency === 1 && jobs.max_log_chunk_bytes === 65536
      ? { protocol: jobs.protocol, concurrency: jobs.concurrency } : {}) });
  }
  const jobs = inventory.knowledge_index_jobs;
  if (jobs?.protocol === "knowledge-index-jobs/v1" && jobs.concurrency === 1 && jobs.max_chunk_bytes === 1024 * 1024) {
    providers.push({ kind: "knowledge-index", protocol: jobs.protocol, concurrency: jobs.concurrency });
  }
  const transcription = readMeetingTranscriptionAdvertisement(inventory.meeting_transcription_jobs);
  if (transcription) providers.push({ kind: "meeting-transcription", protocol: transcription.protocol, concurrency: 1,
    available: transcription.available, ...(transcription.reason ? { reason: transcription.reason } : {}) });
  return providers;
}

export interface RunnerProviderTarget {
  owner: string;
  device: string;
}

export type RunnerProviderStatus = "available" | "unregistered" | "offline" | "inventory_unavailable" | "unsupported";
export type MeetingTranscriptionProviderStatus = RunnerProviderStatus | "unavailable";

interface ProviderDevice {
  device: string;
  online: boolean;
  inventory?: RunnerInventory;
}

/**
 * Read-through view of the existing owner-scoped registration and connection.
 * No second registry, persistence, credential or automatic placement policy.
 * A successful lookup is presence, not a grant: calls still open the existing
 * workspace/knowledge capability bound to the configured owner and device.
 */
export class RunnerProviderCatalog {
  constructor(private readonly runner: { listDevices(owner: string): ProviderDevice[] }) {}

  list(owner: string): Array<RunnerProviderAdvertisement & { device: string }> {
    return this.runner.listDevices(owner).filter((row) => row.online).flatMap((row) =>
      runnerProviderAdvertisements(row.inventory).map((provider) => ({ ...provider, device: row.device })),
    );
  }

  status(target: RunnerProviderTarget, kind: "meeting-transcription"): MeetingTranscriptionProviderStatus;
  status(target: RunnerProviderTarget, kind: "workspace" | "knowledge-index"): RunnerProviderStatus;
  status(target: RunnerProviderTarget, kind: RunnerProviderKind): MeetingTranscriptionProviderStatus;
  status(target: RunnerProviderTarget, kind: RunnerProviderKind): MeetingTranscriptionProviderStatus {
    const row = this.runner.listDevices(target.owner).find((device) => device.device === target.device);
    if (!row) return "unregistered";
    if (!row.online) return "offline";
    if (!row.inventory) return "inventory_unavailable";
    const provider = runnerProviderAdvertisements(row.inventory).find((provider) => provider.kind === kind);
    return !provider ? "unsupported" : kind === "meeting-transcription" && provider.available === false ? "unavailable" : "available";
  }
}
