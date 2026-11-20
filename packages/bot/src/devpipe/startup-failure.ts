import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AppBackendStartupFailure } from "../app-registry/backend-supervisor.js";

/** Private, bounded diagnostic handoff survives a failed bootstrap and rollback. */
export function recordStartupFailure(dataDir: string, id: number, app: string, failure: AppBackendStartupFailure): void {
  const file = join(dataDir, "deploy-startup-failure.json");
  writeFileSync(file + ".tmp", JSON.stringify({ id, app, ...failure, at: new Date().toISOString() }), { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

export function startupFailureDetail(dataDir: string, id: number): string | null {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, "deploy-startup-failure.json"), "utf8"));
    if (value.id !== id || !/^[a-z0-9-]{1,64}$/.test(value.app)
      || !/^(state|runtime)$/.test(value.service) || !/^[a-z_]{1,80}$/.test(value.code)
      || !/^[a-z_]{1,40}$/.test(value.phase) || !Number.isFinite(value.elapsedMs)) return null;
    return `${value.app}/${value.service}: ${value.code}; phase=${value.phase}; elapsed=${value.elapsedMs}ms`;
  } catch { return null; }
}
