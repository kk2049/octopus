/** Opt-in, marker-owned global hook installation for Claude Code and Codex. */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentProvider } from "./agent-runtime.js";

import { HOOK_REPORTER_SOURCE } from "./hook-reporter.js";

const MARKER = "octopus-agent-runtime:v1";
const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;
const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
] as const;

export interface HookInstallResult {
  provider: AgentProvider;
  file: string;
  changed: boolean;
  installed: number;
  warning?: string;
}

export async function installAgentHooks(
  home: string,
  _executable: string,
  codexHome = path.join(home, ".codex"),
): Promise<HookInstallResult[]> {
  if (process.platform === "win32") {
    throw new Error("agent-hook installation is not available on Windows yet");
  }
  const specs = [
    ["claude", path.join(home, ".claude", "settings.json")],
    ["codex", path.join(codexHome, "hooks.json")],
  ] as const;
  // Validate both user-owned files before changing either. This prevents a
  // malformed second config from leaving a surprising half-install behind.
  const configs = await Promise.all(specs.map(async ([provider, file]) => ({
    provider,
    file,
    doc: await readConfig(file),
  })));
  // Keep the helper inside the existing private installation, independent of
  // the caller's executable location (which can be a read-only package).
  const reporter = path.join(home, ".octopus", "runner", "hook-reporter.mjs");
  await fs.mkdir(path.dirname(reporter), { recursive: true, mode: 0o700 });
  if (await fs.readFile(reporter, "utf8").catch(() => "") !== HOOK_REPORTER_SOURCE) {
    const temporary = reporter + `.${process.pid}.tmp`;
    await fs.writeFile(temporary, HOOK_REPORTER_SOURCE, { mode: 0o600 });
    await fs.rename(temporary, reporter);
  }
  return await Promise.all(configs.map(async ({ provider, file, doc }) => {
    const command = `${shellQuote(process.execPath)} ${shellQuote(reporter)} ${provider} # ${MARKER}`;
    const changed = addHooks(doc, command, provider === "claude" ? CLAUDE_EVENTS : CODEX_EVENTS, provider);
    if (changed > 0) await writeConfig(file, doc);
    return {
      provider,
      file,
      changed: changed > 0,
      installed: countHooks(doc),
      ...(provider === "codex" ? {
        warning: "Codex 会在首次加载新的用户 hooks 时要求 trust review；请在 /hooks 中核对并信任这条 Octopus 命令。",
      } : {}),
    };
  }));
}

export async function uninstallAgentHooks(
  home: string,
  codexHome = path.join(home, ".codex"),
): Promise<HookInstallResult[]> {
  return await Promise.all(([
    ["claude", path.join(home, ".claude", "settings.json")],
    ["codex", path.join(codexHome, "hooks.json")],
  ] as const).map(async ([provider, file]) => {
    const doc = await readConfig(file);
    const removed = removeHooks(doc);
    if (removed > 0) {
      if (Object.keys(doc).length > 0) await writeConfig(file, doc, false);
      else await fs.unlink(file);
    }
    return { provider, file, changed: removed > 0, installed: countHooks(doc) };
  }));
}

export async function agentHookStatus(
  home: string,
  codexHome = path.join(home, ".codex"),
): Promise<HookInstallResult[]> {
  return await Promise.all(([
    ["claude", path.join(home, ".claude", "settings.json")],
    ["codex", path.join(codexHome, "hooks.json")],
  ] as const).map(async ([provider, file]) => {
    const doc = await readConfig(file);
    return { provider, file, changed: false, installed: countHooks(doc) };
  }));
}

function addHooks(
  doc: Record<string, unknown>,
  command: string,
  events: readonly string[],
  provider: AgentProvider,
): number {
  const hooks = object(doc.hooks);
  doc.hooks = hooks;
  let changed = 0;
  for (const event of events) {
    const timeout = hookTimeout(provider, event);
    let found = false;
    const groups = (Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []).map((group) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return group;
      const row = { ...group as Record<string, unknown> };
      if (!Array.isArray(row.hooks)) return group;
      const handlers = row.hooks.map((handler) => {
        if (!handlerHasMarker(handler) || !handler || typeof handler !== "object" || Array.isArray(handler)) return handler;
        found = true;
        const current = handler as Record<string, unknown>;
        if (current.type === "command" && current.command === command && current.timeout === timeout) return handler;
        changed += 1;
        return { ...current, type: "command", command, timeout };
      });
      return { ...row, hooks: handlers };
    });
    if (!found) {
      groups.push({ hooks: [{ type: "command", command, timeout }] });
      changed += 1;
    }
    hooks[event] = groups;
  }
  return changed;
}

function hookTimeout(provider: AgentProvider, event: string): number {
  if (provider === "claude") {
    return event === "PreToolUse" || event === "PermissionRequest" ? 600 : 10;
  }
  // Codex caps SessionEnd at three seconds. Other lifecycle reporters need
  // enough budget for Node startup and local IPC while the host is busy.
  return event === "SessionEnd" ? 3 : 10;
}

function removeHooks(doc: Record<string, unknown>): number {
  const hooks = object(doc.hooks);
  let removed = 0;
  for (const [event, raw] of Object.entries(hooks)) {
    if (!Array.isArray(raw)) continue;
    const next: unknown[] = [];
    for (const group of raw) {
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        next.push(group);
        continue;
      }
      const row = { ...group as Record<string, unknown> };
      const handlers = Array.isArray(row.hooks) ? row.hooks : [];
      const kept = handlers.filter((handler) => {
        const owned = handlerHasMarker(handler);
        if (owned) removed += 1;
        return !owned;
      });
      if (kept.length > 0) next.push({ ...row, hooks: kept });
    }
    if (next.length > 0) hooks[event] = next;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) doc.hooks = hooks;
  else delete doc.hooks;
  return removed;
}

function countHooks(doc: Record<string, unknown>): number {
  const hooks = object(doc.hooks);
  return Object.values(hooks).reduce<number>((count, groups) => count + (
    Array.isArray(groups) ? groups.filter(groupHasMarker).length : 0
  ), 0);
}

function groupHasMarker(group: unknown): boolean {
  if (!group || typeof group !== "object" || Array.isArray(group)) return false;
  const handlers = (group as Record<string, unknown>).hooks;
  return Array.isArray(handlers) && handlers.some(handlerHasMarker);
}

function handlerHasMarker(handler: unknown): boolean {
  if (!handler || typeof handler !== "object" || Array.isArray(handler)) return false;
  return String((handler as Record<string, unknown>).command ?? "").includes(MARKER);
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("top-level JSON must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot update ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeConfig(file: string, doc: Record<string, unknown>, backup = true): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (backup) {
    try {
      const original = await fs.readFile(file);
      const backupFile = `${file}.octopus-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await fs.writeFile(backupFile, original, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temp, file);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export { CLAUDE_EVENTS, CODEX_EVENTS, MARKER as AGENT_HOOK_MARKER };
