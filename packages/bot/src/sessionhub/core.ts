import { activityPhase, readCodexTokenUsage, type Activity } from "@claude-bot/agent-sessions-contract";
/**
 * Subject-neutral Session resource mechanics.
 *
 * Session Hub and an Agentic App may have different principals and capability
 * bundles, but resource identity, browser-safe normalization, deduplication and
 * timeout reporting must not fork. This leaf contains no Store, grant or
 * transport dependency.
 */

import { createHash } from "node:crypto";
import { SESSION_CLI_KINDS } from "@claude-bot/agent-sessions-contract";
import {
  parentOwnedSessionParentId,
  subagentParentId,
  type Source as ScanSource,
} from "@claude-bot/plugin-sessions/scan";
import type { HubSessionSummary } from "./service.js";

/** Compatibility export; the neutral sessions contract owns this vocabulary. */
export { SESSION_CLI_KINDS };

/** Pseudo-device label for sessions scanned on the bot host itself. */
export const BOT_HOST_DEVICE = "bot-host";

export function resourceId(parts: {
  owner: string;
  device: string;
  cliKind: string;
  sessionId: string;
}): string {
  return Buffer.from(
    JSON.stringify([parts.owner, parts.device, parts.cliKind, parts.sessionId]),
    "utf8",
  ).toString("base64url");
}

export function decodeResourceId(
  raw: string,
): { owner: string; device: string; cliKind: ScanSource; sessionId: string } | null {
  try {
    const parts = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parts) || parts.length !== 4) return null;
    const [owner, device, cliKind, sessionId] = parts.map((part) => String(part ?? ""));
    if (!owner || !sessionId) return null;
    if (!SESSION_CLI_KINDS.includes(cliKind as ScanSource)) return null;
    return { owner, device, cliKind: cliKind as ScanSource, sessionId };
  } catch {
    return null;
  }
}

export function normaliseSession(
  raw: Record<string, unknown>,
  owner: string,
  fallbackDevice: string,
  directoryPlacement?: {
    executionDevice: string;
    workspaceId: string;
    workspaceLabel?: string;
    workspaceDisplay?: string;
  },
  nowMs = Date.now(),
): HubSessionSummary {
  const device = String(raw.device ?? fallbackDevice ?? "");
  const source = SESSION_CLI_KINDS.includes(raw.source as ScanSource)
    ? raw.source as ScanSource
    : "claude";
  const id = String(raw.id ?? "");
  // Revalidate the scanner's complete provider claim before it can become a
  // public resource id. Malformed metadata degrades to no ownership claim.
  const lineage = { ...raw, id, source };
  const parentSessionId = subagentParentId(lineage) ?? "";
  const parentOwned = Boolean(parentOwnedSessionParentId(lineage));
  const activity = raw.activity as { state?: string; observed_at?: string } | undefined;
  const runtime = raw.runtime as {
    process_state?: string;
    turn_state?: string;
    observed_at?: string;
    event?: string;
    tool?: string;
  } | undefined;
  const cwd = raw.cwd == null ? undefined : String(raw.cwd);
  const scannedCompletedAt = raw.completed_at == null ? undefined : String(raw.completed_at);
  // `observed_at` is evidence freshness: OMP discovery refreshes it on every
  // identical probe. Only hook events that themselves close a turn may promote
  // that observation into the durable completion/review ordering clock.
  const runtimeCompletedAt = runtime?.observed_at && (
    runtime.event === "Stop" || runtime.event === "SessionEnd"
  ) ? String(runtime.observed_at) : undefined;
  const completedAt = !scannedCompletedAt
    ? runtimeCompletedAt
    : !runtimeCompletedAt || scannedCompletedAt > runtimeCompletedAt
      ? scannedCompletedAt
      : runtimeCompletedAt;
  // A fresh idle/needs-input/process-exit observation can disprove an older
  // scanner busy marker without becoming a completion event itself.
  const runtimeSettledAt = runtime?.observed_at && (
    runtime.turn_state === "idle"
    || runtime.turn_state === "needs_input"
    || runtime.process_state === "exited"
  ) ? String(runtime.observed_at) : undefined;
  const effectiveActivity = activity
    && runtimeSettledAt
    && activity.state !== "idle"
    && (!activity.observed_at || runtimeSettledAt >= activity.observed_at)
    ? { state: "idle", observed_at: runtimeSettledAt }
    : raw.activity;
  const activityState = (effectiveActivity as { state?: string } | undefined)?.state;
  // Live needs fresh evidence. A Runner-verified process (or a Runner-owned
  // attachment) is re-proven on every report; a turn state without one, and
  // transcript activity, count only while recent under the shared expiry rule.
  // A cold header read or a sub-agent that stopped mid-tool is therefore idle.
  const runtimeBusy = runtime?.turn_state === "working" || runtime?.turn_state === "needs_input";
  const runtimeLive = runtimeBusy && (runtime?.process_state === "alive" || (runtime?.process_state !== "exited"
    && activityPhase({ state: runtime?.tool ? "tool" : "running", observed_at: runtime?.observed_at }, nowMs) === "live"));
  const activityEvidence = effectiveActivity as Activity | undefined;
  const activityLive = activityState !== "unknown" && activityPhase(
    activityEvidence && !activityEvidence.observed_at && raw.last_activity != null
      // Old Runners send no observed_at; the last recorded write stands in.
      ? { ...activityEvidence, observed_at: String(raw.last_activity) }
      : activityEvidence,
    nowMs,
  ) === "live";
  const scannedSortActivity = raw.sort_activity == null ? undefined : String(raw.sort_activity);
  const sortActivity = !scannedSortActivity
    ? completedAt ?? (raw.last_activity == null ? undefined : String(raw.last_activity))
      ?? (raw.started_at == null ? undefined : String(raw.started_at))
    : !completedAt || scannedSortActivity > completedAt
      ? scannedSortActivity
      : completedAt;
  return {
    resourceId: resourceId({ owner, device, cliKind: source, sessionId: id }),
    usage: source === "codex" ? readCodexTokenUsage(raw.usage) : undefined,
    owner,
    deviceId: device,
    deviceLabel: device === BOT_HOST_DEVICE ? "bot 主机" : device,
    ...(directoryPlacement?.executionDevice
      ? { directoryDeviceId: directoryPlacement.executionDevice }
      : {}),
    ...(directoryPlacement?.workspaceId
      ? { directoryWorkspaceId: directoryPlacement.workspaceId }
      : {}),
    cliKind: source,
    ...(source === "codex" && raw.execution_mode === "exec" ? { executionMode: "exec" as const } : {}),
    sessionId: id,
    projectLabel: directoryPlacement?.workspaceLabel
      || (raw.project == null ? undefined : String(raw.project)),
    accountLabel: source === "codex" && typeof raw.account_label === "string" && /^[a-z]$/.test(raw.account_label)
      ? raw.account_label
      : undefined,
    // New Runners send a display-only ~/… label. Keep canonical cwd in the
    // legacy trusted field, but prefer the safe label at App boundaries.
    cwdDisplay: directoryPlacement?.workspaceDisplay
      || (raw.cwd_display == null ? cwd : String(raw.cwd_display)),
    lastActivity: raw.last_activity == null ? undefined : String(raw.last_activity),
    sortActivity,
    completedAt,
    status: runtimeLive || activityLive ? "live" : "idle",
    resumable: !parentOwned && device !== BOT_HOST_DEVICE && Boolean(device),
    ...(parentOwned ? { inputMode: "parent_owned" as const } : {}),
    ...(parentSessionId ? {
      parentResourceId: resourceId({
        owner,
        device,
        cliKind: source,
        sessionId: parentSessionId,
      }),
    } : {}),
    id,
    source,
    device,
    project: raw.project == null ? undefined : String(raw.project),
    cwd,
    last_activity: raw.last_activity == null ? undefined : String(raw.last_activity),
    sort_activity: sortActivity,
    completed_at: completedAt,
    started_at: raw.started_at == null ? undefined : String(raw.started_at),
    message_count: raw.message_count == null ? undefined : Number(raw.message_count),
    title: raw.title == null ? undefined : String(raw.title),
    preview: raw.preview == null ? undefined : String(raw.preview),
    first_user_text: raw.first_user_text == null ? undefined : String(raw.first_user_text),
    activity: effectiveActivity,
    runtime: raw.runtime,
  };
}

/** Merge duplicate reports without collapsing the same id on two real devices. */
export function dedupeSessions(entries: readonly HubSessionSummary[]): HubSessionSummary[] {
  const seen = new Set<string>();
  const out: HubSessionSummary[] = [];
  const onRealDevice = new Set(
    entries.filter((entry) => entry.deviceId !== BOT_HOST_DEVICE)
      .map((entry) => `${entry.cliKind}:${entry.sessionId}`),
  );
  for (const entry of entries) {
    if (
      entry.deviceId === BOT_HOST_DEVICE
      && onRealDevice.has(`${entry.cliKind}:${entry.sessionId}`)
    ) continue;
    const key = `${entry.deviceId}:${entry.cliKind}:${entry.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Drop filesystem paths from both the legacy and rich transcript envelope. */
export function stripSessionPath(input: Record<string, unknown>): Record<string, unknown> {
  const { path: _dropped, ...rest } = input;
  void _dropped;
  if (rest.meta && typeof rest.meta === "object" && !Array.isArray(rest.meta)) {
    const { path: _metaPath, ...meta } = rest.meta as Record<string, unknown>;
    void _metaPath;
    rest.meta = meta;
  }
  return rest;
}

/** The intent fingerprint two submissions must share to be one operation. */
export function appendFingerprint(
  operation: string,
  source: string | undefined,
  prompt: string,
  permissionProfile?: string,
  effort?: string,
  model?: string,
): string {
  // Keep the historical three-field and effort-only tuples byte-for-byte
  // stable. A deployment may retry an operation minted before model existed;
  // adding the new coordinate must not turn that retry into a second intent.
  return createHash("sha256")
    .update(JSON.stringify(permissionProfile === undefined && effort === undefined && model === undefined
      ? [operation, source ?? "", prompt]
      : model === undefined
        ? [operation, source ?? "", prompt, permissionProfile ?? "", effort ?? ""]
        : [operation, source ?? "", prompt, permissionProfile ?? "", effort ?? "", model]), "utf8")
    .digest("hex");
}

/** Did a capability call survive the synchronous approval decision path? */
export async function dispatchObserved(call: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const mark = (): void => { settled = true; };
  call.then(mark, mark);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 0);
    timer.unref?.();
  });
  return !settled;
}

/** Report a bounded wait. This cannot cancel a frame already sent to a resource. */
export async function withTimeout<T>(promise: Promise<T>, what: string, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} 超时（${Math.round(ms / 1000)}s 未返回）`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
