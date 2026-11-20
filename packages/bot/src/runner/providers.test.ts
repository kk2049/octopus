import { describe, expect, it } from "vitest";
import type { RunnerInventory } from "@claude-bot/runner/inventory";
import { RunnerProviderCatalog, runnerProviderAdvertisements } from "./providers.js";

function inventory(knowledge = false): RunnerInventory {
  return {
    schema: "runner-inventory/v1",
    agent_backends: [],
    execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 0, codex_exec_server: false },
    ...(knowledge ? { knowledge_index_jobs: { protocol: "knowledge-index-jobs/v1", concurrency: 1, max_chunk_bytes: 1024 * 1024 } } : {}),
  };
}

describe("first-party Runner provider discovery", () => {
  it("discovers compute providers without advertising a model host or inventing a durable workspace protocol", () => {
    expect(runnerProviderAdvertisements(inventory(true))).toEqual([
      { kind: "workspace" },
      { kind: "knowledge-index", protocol: "knowledge-index-jobs/v1", concurrency: 1 },
    ]);
    const disabled = inventory();
    disabled.execution.shell = false;
    expect(runnerProviderAdvertisements(disabled)).toEqual([]);
    expect(runnerProviderAdvertisements()).toEqual([]);
  });

  it("does not resolve a same-named device registered to another owner", () => {
    const catalog = new RunnerProviderCatalog({ listDevices: (owner) => owner === "alice"
      ? [{ device: "compute", online: true, inventory: inventory(true) }] : [] });
    expect(catalog.status({ owner: "alice", device: "compute" }, "knowledge-index")).toBe("available");
    expect(catalog.status({ owner: "bob", device: "compute" }, "knowledge-index")).toBe("unregistered");
    expect(catalog.list("bob")).toEqual([]);
  });

  it("reflects reconnect, inventory withdrawal and revocation without stale cached capabilities", () => {
    let rows: Array<{ device: string; online: boolean; inventory?: RunnerInventory }> = [
      { device: "compute", online: true, inventory: inventory(true) },
    ];
    const catalog = new RunnerProviderCatalog({ listDevices: () => rows });
    const target = { owner: "alice", device: "compute" };
    expect(catalog.list(target.owner)).toHaveLength(2);
    rows[0].online = false;
    expect(catalog.status(target, "knowledge-index")).toBe("offline");
    expect(catalog.list(target.owner)).toEqual([]);
    rows[0] = { device: "compute", online: true };
    expect(catalog.status(target, "knowledge-index")).toBe("inventory_unavailable");
    rows[0].inventory = inventory();
    expect(catalog.status(target, "knowledge-index")).toBe("unsupported");
    expect(catalog.status(target, "workspace")).toBe("available");
    rows = [];
    expect(catalog.status(target, "workspace")).toBe("unregistered");
  });

  it("requires the exact knowledge protocol limits and returns detached bounded descriptions", () => {
    const value = inventory(true);
    value.knowledge_index_jobs!.max_chunk_bytes = 2 * 1024 * 1024;
    expect(runnerProviderAdvertisements(value)).toEqual([{ kind: "workspace" }]);
    value.knowledge_index_jobs!.max_chunk_bytes = 1024 * 1024;
    const first = runnerProviderAdvertisements(value);
    first.splice(0);
    expect(runnerProviderAdvertisements(value)).toHaveLength(2);
  });
});

it("advertises durable workspace jobs only with the exact opted-in protocol", () => {
  const value = inventory();
  value.workspace_jobs = { protocol: "workspace-jobs/v1", concurrency: 1, max_log_chunk_bytes: 65536 };
  expect(runnerProviderAdvertisements(value)).toEqual([{ kind: "workspace", protocol: "workspace-jobs/v1", concurrency: 1 }]);
  const malformed = { ...value, workspace_jobs: { ...value.workspace_jobs, max_log_chunk_bytes: 1 } } as unknown as RunnerInventory;
  expect(runnerProviderAdvertisements(malformed)).toEqual([{ kind: "workspace" }]);
});

it("discovers transcription readiness separately from shell and protocol presence", () => {
  const value = inventory();
  value.meeting_transcription_jobs = { protocol: "meeting-transcription-jobs/v1", available: false, reason: "not_configured",
    backend: "MOSS-Transcribe-Diarize", concurrency: 1, max_input_bytes: 64 * 1024 * 1024, max_chunk_bytes: 256 * 1024 };
  const catalog = new RunnerProviderCatalog({ listDevices: () => [{ device: "compute", online: true, inventory: value }] });
  expect(catalog.list("alice")).toContainEqual(expect.objectContaining({ kind: "meeting-transcription", available: false, reason: "not_configured" }));
  expect(catalog.status({ owner: "alice", device: "compute" }, "meeting-transcription")).toBe("unavailable");
  value.meeting_transcription_jobs.available = true; delete value.meeting_transcription_jobs.reason;
  expect(catalog.status({ owner: "alice", device: "compute" }, "meeting-transcription")).toBe("available");
  value.meeting_transcription_jobs.max_chunk_bytes = 1;
  expect(catalog.status({ owner: "alice", device: "compute" }, "meeting-transcription")).toBe("unsupported");
});
