/**
 * The static module registry.
 *
 * ── "Starting a module" is mounting something already compiled in ───────────
 *
 * An Agent View is published as ONE document from an origin that serves no
 * second URL, so there is no chunk to fetch, no package name to resolve and no
 * import specifier a click could produce. A registry is therefore a plain object
 * built at module-evaluation time: id → (manifest, component). Every module a
 * composition could ever open is in the bundle, in the lock, and in the package
 * digest, before anyone clicks anything.
 *
 * That is why this file has no loader, no `import()` and no string-to-module
 * step. `createModuleRegistry` also DERIVES the lock from the manifests it was
 * given, so the release asset that claims what is in the bundle and the object
 * that decides what can mount are the same statement written once.
 *
 * ── Why it throws ───────────────────────────────────────────────────────────
 *
 * Unlike everything in the contract package, a malformed registry is a
 * programming error in code this build compiled — not untrusted input — so it
 * fails at construction, loudly, rather than degrading a panel at runtime.
 */

import type { ComponentType } from "react";
import {
  moduleLockOf,
  readModuleManifest,
  type AgentModuleLock,
  type AgentModuleManifest,
} from "@claude-bot/agent-module-contract";
import type { LayoutPanel } from "./layout.js";
import type { WorkspaceApi } from "./api.js";

/** What every module component receives. Note what is absent: any identity. */
export interface ModuleProps {
  /** This mounted instance: its id, slot, and the resource it was opened for. */
  panel: LayoutPanel;
  /** The only way to affect layout — versioned intents, never DOM. */
  workspace: WorkspaceApi;
}

export type ModuleComponent = ComponentType<ModuleProps>;

export interface ModuleRegistryEntry {
  manifest: AgentModuleManifest;
  component: ModuleComponent;
}

export interface ModuleRegistry {
  get(moduleId: string): ModuleRegistryEntry | null;
  has(moduleId: string): boolean;
  manifests(): ReadonlyMap<string, AgentModuleManifest>;
  /** Exactly what this bundle contains — the lock, derived, not authored. */
  lock(): AgentModuleLock;
}

export function createModuleRegistry(entries: readonly ModuleRegistryEntry[]): ModuleRegistry {
  const byId = new Map<string, ModuleRegistryEntry>();
  const manifests = new Map<string, AgentModuleManifest>();
  for (const entry of entries) {
    const read = readModuleManifest(entry.manifest);
    if (!read.ok) {
      const first = read.issues[0];
      throw new Error(`module registry: invalid manifest (${first?.at ?? "?"}: ${first?.message ?? "unknown"})`);
    }
    if (byId.has(read.value.id)) throw new Error(`module registry: ${read.value.id} is registered twice`);
    if (typeof entry.component !== "function") {
      throw new Error(`module registry: ${read.value.id} has no component`);
    }
    byId.set(read.value.id, { manifest: read.value, component: entry.component });
    manifests.set(read.value.id, read.value);
  }
  if (!byId.size) throw new Error("module registry: a workspace needs at least one module");
  const lock = moduleLockOf([...manifests.values()]);
  return {
    get: (moduleId) => byId.get(moduleId) ?? null,
    has: (moduleId) => byId.has(moduleId),
    manifests: () => manifests,
    lock: () => lock,
  };
}
