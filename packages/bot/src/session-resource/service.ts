import { readCodexContinuationSettings, validateCodexContinuationPrompt, encodeSessionIds, publicModelChoices, selectSessionWindow, SESSION_IDS_MAX } from "@claude-bot/agent-sessions-contract";
/**
 * Subject-specific session resource projection over an AppAuthorityBundle.
 *
 * This class never computes rights. It selects one of the two independent
 * planes, opens a ControllerRun below the instance's App Context and asks the
 * kernel Gate. Normalisation is shared with Session Hub; authority is not.
 */

import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { agentDiagnosticCode, publicAgentDiagnosticDetail, publicCodexEmailLabel, publicCodexQuota } from "@claude-bot/runner/inventory";
import type { PermissionService } from "../permissions/service.js";
import type { HubSessionSummary } from "../sessionhub/service.js";
import {
  BOT_HOST_DEVICE,
  decodeResourceId,
  dedupeSessions,
  normaliseSession,
  SESSION_CLI_KINDS,
  withTimeout,
} from "../sessionhub/core.js";
import type { RunnerSessionProjectionService } from "../runner/session-projection.js";
import { sessionDirectoryPlacement } from "../runner/session-catalog.js";
import type { WorkspaceDirectoryKeys } from "../workspace-files/directory-key.js";
import {
  WorkspaceDirectorySnapshotIndex,
  readWorkspaceDirectorySnapshot,
  type WorkspaceDirectorySnapshot,
  type WorkspaceDirectorySnapshotScope,
} from "../workspace-files/directory-index.js";
import { AppAuthorityBundles, type SessionResourcePlane } from "./bundle.js";
import { SessionRosterMemory } from "./roster-memory.js";
import { KeptSessionCache, keptIdentities, type KeptIdentity } from "./kept-sessions.js";
import {
  asRecord,
  boundedText,
  publicSession,
  publicTranscript,
  publicWorkspaceSnapshot,
  prependTranscriptWindow,
  records,
  retainTranscripts,
  runtimeJson,
  strings,
} from "./projection.js";
import { watchTranscript as openTranscriptWatch } from "./transcript-watch.js";
import {
  noResourceAuthority,
  type ResourceRefusal,
  type SessionResourceExecuteOptions,
  type SessionResourcePort,
  type SessionResourceResult,
  type SessionResourceWatchEvent,
  type SessionResourceWatchResult,
} from "./types.js";

export type {
  ResourcePatchResult,
  ResourceRefusal,
  SessionResourceExecuteOptions,
  SessionResourcePort,
  SessionResourceResult,
  SessionResourceSubscription,
  SessionResourceWatchEvent,
  SessionResourceWatchResult,
} from "./types.js";
import { decodeSearchCursor, mergeSearchPages, scanSourceArg, sessionListCursor, type SearchPagePart, type Source as ScanSource } from "@claude-bot/plugin-sessions/scan";

interface CallSuccess {
  ok: true;
  result: unknown;
}

type CallResult = CallSuccess | ResourceRefusal;

interface RosterPlaneProjection {
  sessions: HubSessionSummary[];
  sources: Array<Record<string, unknown>>;
  placement: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  truncated: boolean;
  indexPending: boolean;
}

interface TerminalLease {
  id: string;
  device: string;
  workspaceId: string;
}


const MAX_RUNNER_ROSTER_DEVICES = 64;
const MAX_ROSTER_DEVICE_ID_LENGTH = 64;
const MAX_PROJECTED_ROSTER_SOURCES = MAX_RUNNER_ROSTER_DEVICES + 1;

function emptyRosterPlaneProjection(): RosterPlaneProjection {
  return { sessions: [], sources: [], placement: [], errors: [], truncated: false, indexPending: false };
}

export class SessionResourceService implements SessionResourcePort {
  /** Last successful device rows, bounded and partitioned by App instance. */
  private readonly rosters = new SessionRosterMemory();
  private readonly keptSessions = new KeptSessionCache();
  /** Each live App instance owns an independent lease for each device tab. */
  private readonly terminalLeases = new Map<string, Map<string, TerminalLease>>();


  constructor(
    private readonly bundles: AppAuthorityBundles,
    private readonly permissions: Pick<PermissionService, "audit">,
    private readonly timeoutMs = 60_000,
    private readonly livePollMs = 4_000,
    /**
     * The process's ONE directory-key minter, or none.
     *
     * None is the honest state for a composition that installs no
     * `workspace-files/v2` provider: there would be nothing on the other side to
     * join against, and a key nobody can match is a field that only looks like
     * an answer.
     */
    private readonly directoryKeys: WorkspaceDirectoryKeys | null = null,
    /**
     * The workspace-plane operation standing for one owner, already computed
     * by the trusted composition (requested ∩ granted ∩ effective, with the
     * release's own contract digest), or none.
     *
     * A closure rather than a PermissionService, because the CALLER holds the
     * active release identity this projection must be computed against — and
     * because what crosses here is a display projection, never an authority.
     * Absent means the projection simply omits the field, which a consumer
     * shows as "unknown" rather than as "granted".
     */
    private readonly workspaceAccess: ((owner: string) => RuntimeJson | null) | null = null,
    /** Clock for the process-local stale-row TTL. */
    private readonly now: () => number = Date.now,
    /**
     * Successful sessions-plane directory replies, partitioned by App scope.
     * Workspace-files shares the parser, never these authorized snapshots; an
     * index hit is therefore neither an authorization nor a reason to skip Gate.
     */
    private readonly directorySnapshots = new WorkspaceDirectorySnapshotIndex(),
    private readonly sessionProjection: RunnerSessionProjectionService | null = null,
    /** Permit-filtered display rows only; operation binding re-resolves every selection. */
    private readonly sharedAgentRuntimes: ((owner: string) => Array<Record<string, unknown>>) | null = null,
    /** Durable provenance classifier; used only to avoid the ordinary-root live cache. */
    private readonly isSplitSession: ((owner: string, device: string, source: string, id: string) => boolean) | null = null,
    /** Durable owner/session placement; the chosen execution target still passes Gate. */
    private readonly attachmentTarget: ((owner: string, device: string, source: string, id: string) => { device: string; workspaceId: string } | null) | null = null,
    /** Owner-scoped presentation; never a selector, resource id or authority. */
    private readonly deviceDisplayName: ((owner: string, device: string) => string | undefined) | null = null,
  ) {}

  private displaySession(row: HubSessionSummary): HubSessionSummary {
    const label = this.deviceDisplayName?.(row.owner, row.deviceId);
    return label ? { ...row, deviceLabel: label } : row;
  }

  /** The bounded access rows for a patch, or nothing. Never an authority. */
  private accessPatch(owner: string): Record<string, RuntimeJson> {
    if (!this.workspaceAccess || !owner) return {};
    try {
      const rows = this.workspaceAccess(owner);
      return rows === null ? {} : { workspaceAccess: rows };
    } catch {
      // A projection that cannot be computed is absent, not fabricated.
      return {};
    }
  }

  /**
   * The key for one session, or undefined.
   *
   * Two facts have to line up, and neither is guessed: the device must have said
   * which registered workspace this session's cwd is in, and this build must
   * have a minter. Anything else omits the field — there is no path here that
   * derives a key from a label, a basename or a display path.
   */
  private directoryScope(instanceId: string, owner: string): WorkspaceDirectorySnapshotScope {
    return {
      owner,
      publisher: this.bundles.profile.publisher,
      app: this.bundles.profile.app,
      instance: instanceId,
    };
  }

  private sessionKey(
    instanceId: string,
    owner: string,
    session: Pick<
      HubSessionSummary,
      "deviceId" | "directoryDeviceId" | "directoryWorkspaceId" | "cliKind" | "sessionId"
    >,
  ): string | undefined {
    if (!this.directoryKeys) return undefined;
    const device = session.directoryDeviceId ?? session.deviceId ?? "";
    if (session.directoryWorkspaceId) {
      return this.directoryKeys.mint({
        owner,
        publisher: this.bundles.profile.publisher,
        app: this.bundles.profile.app,
        device,
        workspaceId: session.directoryWorkspaceId,
        relativePath: "",
      }) ?? undefined;
    }
    const location = this.directorySnapshots.location(
      this.directoryScope(instanceId, owner),
      device,
      session.cliKind,
      session.sessionId,
    );
    if (!location) return undefined;
    return this.directoryKeys.mint({
      owner,
      publisher: this.bundles.profile.publisher,
      app: this.bundles.profile.app,
      device,
      workspaceId: location.workspaceId,
      relativePath: location.relativePath,
    }) ?? undefined;
  }

  /** Workspace rows from the same snapshots used to key session rows. */
  private cachedWorkspaces(instanceId: string, owner: string): Record<string, RuntimeJson> {
    const snapshots = [...this.directorySnapshots.snapshots(this.directoryScope(instanceId, owner))]
      .sort((a, b) => a.device.localeCompare(b.device));
    if (!snapshots.length) return {};
    const workspacesByDevice: Record<string, RuntimeJson> = {};
    for (const snapshot of snapshots) {
      workspacesByDevice[snapshot.device] = runtimeJson(this.projectWorkspaceSnapshot(owner, snapshot));
    }
    return { workspacesByDevice: runtimeJson(workspacesByDevice) };
  }

  private projectWorkspaceSnapshot(owner: string, snapshot: WorkspaceDirectorySnapshot): Record<string, RuntimeJson> {
    const mintRootKey = this.directoryKeys
      ? (workspaceId: string) => this.directoryKeys!.mint({
          owner,
          publisher: this.bundles.profile.publisher,
          app: this.bundles.profile.app,
          device: snapshot.device,
          workspaceId,
          relativePath: "",
        })
      : undefined;
    const result = publicWorkspaceSnapshot(snapshot, mintRootKey);
    const label = this.deviceDisplayName?.(owner, snapshot.device);
    return label ? { ...result, deviceLabel: label } : result;
  }

  async execute(
    instanceId: string,
    action: string,
    params: Readonly<Record<string, string>>,
    current: RuntimeJson,
    options: SessionResourceExecuteOptions = {},
  ): Promise<SessionResourceResult> {
    for (const held of this.terminalLeases.keys()) {
      if (!this.bundles.get(held)) this.terminalLeases.delete(held);
    }
    switch (action) {
      case "refresh_sessions":
        return await this.roster(instanceId, params, current, options);
      case "search_sessions":
        return await this.search(instanceId, params);
      case "open_session":
        return await this.read(instanceId, params, current);
      case "read_codex_continuation":
      case "save_codex_continuation":
        return await this.continuation(instanceId, action, params);
      case "refresh_workspaces":
        return await this.workspaces(instanceId, params, current);
      case "attach_file":
        return await this.attachFile(instanceId, params);
      case "open_terminal":
      case "read_terminal":
      case "send_terminal":
      case "close_terminal":
        return await this.terminal(instanceId, action, params, current);
      default:
        return { ok: false, code: "resource_denied", message: "此 App 版本请求了平台不支持的操作，没有执行。请刷新页面使用最新版本；仍出现时用 🐞 报告这个 App 的问题。" };
    }
  }

  /**
   * Hold one ControllerRun for the lifetime of a transcript subscription.
   * The polling source is shared with Session Hub, while the authority is this
   * instance's app Context. Destroying that parent makes the next Gate call
   * fail, and the instance teardown closes the timer immediately.
   */
  watchTranscript(
    instanceId: string,
    resource: string,
    listener: (event: SessionResourceWatchEvent) => void,
    maxMessages = 200,
  ): SessionResourceWatchResult {
    return openTranscriptWatch({
      bundles: this.bundles,
      instanceId,
      resource,
      timeoutMs: this.timeoutMs,
      pollMs: this.livePollMs,
      maxMessages: Math.min(500, Math.max(1, Math.trunc(maxMessages) || 200)),
      projection: this.sessionProjection ?? undefined,
      isSplitSession: this.isSplitSession ?? undefined,
      audit: (owner, operation, target, decision, reason) => {
        this.audit(owner, operation, target, decision, reason);
      },
      listener,
    });
  }

  private async roster(
    instanceId: string,
    params: Readonly<Record<string, string>>,
    current: RuntimeJson,
    options: SessionResourceExecuteOptions,
  ): Promise<SessionResourceResult> {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return noResourceAuthority();
    // Manifest normalization fills absent optional fields with "". A device
    // selects the first history page; a nonempty cursor still needs validation.
    if (params.device || params.cursor) return this.history(instanceId, params);
    const now = this.now();
    const isCurrent = (): boolean => {
      try {
        return options.isCurrent?.() ?? true;
      } catch {
        // A broken generation predicate must fail closed: no shared cache write
        // and no partial projection may escape from an execution we cannot name.
        return false;
      }
    };
    const args: Record<string, unknown> = {
      source: source(params.source),
      limit: boundedInt(params.limit, 1, 200, 200),
      primary_window: true,
    };
    const since = boundedNumber(params.since_hours, 0, 24 * 365);
    if (since !== undefined) args.since_hours = since;

    const staged = rosterAlreadyProjected(current) ? withoutProgressivePatch(options) : options;
    // Favorites and folder members are App state in this same projection.
    const kept = keptIdentities(current, bundle.owner);
    return await this.singleStageRoster(instanceId, bundle.owner, args, staged, now, isCurrent, kept);
  }

  private async history(instanceId: string, params: Readonly<Record<string, string>>): Promise<SessionResourceResult> {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return noResourceAuthority();
    const device = String(params.device ?? "").trim();
    const cursor = String(params.cursor ?? "");
    const previous = cursor ? decodeResourceId(cursor) : null;
    if (!device || device.length > 128 || (cursor && (!previous || previous.owner !== bundle.owner || previous.device !== device))) {
      return { ok: false, code: "invalid_resource", message: "设备或会话翻页游标无效" };
    }
    const selectedSource = source(params.source);
    if (previous && selectedSource !== "all" && selectedSource !== previous.cliKind) {
      return { ok: false, code: "invalid_resource", message: "切换来源后请从第一页浏览" };
    }
    const plane = device === BOT_HOST_DEVICE ? "local" : "runner";
    const args = { source: selectedSource, limit: boundedInt(params.limit, 1, 100, 100),
      cursor: previous ? sessionListCursor({ source: previous.cliKind, id: previous.sessionId }) : "",
      ...(plane === "runner" ? { device, _octopus_include_session_plus: true } : {}),
    };
    const call = await this.call(instanceId, plane, "refresh_sessions", "list_recent_sessions", args);
    if (!call.ok) return call;
    const value = asRecord(call.result);
    if (value.history_supported === false || typeof value.has_more !== "boolean") {
      return { ok: false, code: "resource_failed", message: "该设备 Runner 尚不支持完整会话分页，请更新后重试" };
    }
    const rows = records(value.sessions).slice(0, args.limit)
      .filter((row) => plane === "local" || row.device === device)
      .map((row) => normaliseSession({ ...row, device }, bundle.owner, device, sessionDirectoryPlacement(value, row)))
      .filter((row) => Boolean(row.sessionId));
    const sessions = rows.map((row) => publicSession(this.displaySession(row), this.sessionKey(instanceId, bundle.owner, row)));
    const history = runtimeJson({ device, source: selectedSource, cursor, sessions,
      nextCursor: rows.at(-1)?.resourceId,
      hasMore: value.has_more === true,
      totalFound: boundedInt(String(value.total_found ?? rows.length), 0, 1_000_000_000, rows.length),
    });
    return { ok: true, result: history, patch: { sessionHistory: history } };
  }

  /** Preserve the pre-head-read behavior for callers that did not opt in. */
  private async singleStageRoster(
    instanceId: string,
    owner: string,
    args: Readonly<Record<string, unknown>>,
    options: SessionResourceExecuteOptions,
    now: number,
    isCurrent: () => boolean,
    kept: readonly KeptIdentity[] = [],
  ): Promise<SessionResourceResult> {
    if (isCurrent()) {
      this.rosters.prune((id) => Boolean(this.bundles.get(id)), now);
      this.keptSessions.prune((id) => Boolean(this.bundles.get(id)));
    }
    const keptIds = new Set(kept.map((identity) => identity.resourceId));
    const calls: Partial<Record<SessionResourcePlane, CallResult>> = {};
    const projections: Record<SessionResourcePlane, RosterPlaneProjection> = {
      runner: emptyRosterPlaneProjection(),
      local: emptyRosterPlaneProjection(),
    };
    const completed = new Set<SessionResourcePlane>();
    let partialPublished = false;
    const publishPartial = (): void => {
      if (partialPublished || !options.onPatch || !isCurrent()) return;
      const partial = this.rosterProjection(
        instanceId,
        owner,
        projections,
        Number(args.limit),
        "loading",
        keptIds,
      ).patch;
      if (!isCurrent()) return;
      partialPublished = true;
      try {
        options.onPatch(partial);
      } catch {
        // A progressive projection is optional. The authoritative final
        // result must still settle even if its trusted consumer is closing.
      }
    };
    const settle = async (plane: SessionResourcePlane, callPromise: Promise<CallResult>): Promise<void> => {
      const call = await callPromise;
      // One promise belongs to one plane. Keeping completion explicit makes it
      // impossible for a later fan-in step to reconcile the same reply twice.
      if (completed.has(plane)) return;
      calls[plane] = call;
      completed.add(plane);
      projections[plane] = this.projectRosterPlane(instanceId, owner, plane, call, now, isCurrent);

      // A failed or empty first completion must not consume the one partial
      // slot while the other independent Gate can still return visible rows.
      if (call.ok && projections[plane].sessions.length > 0) publishPartial();
    };

    // Start both capability calls before awaiting either. Each call opens its
    // own ControllerRun and therefore crosses its own Gate exactly once.
    const runnerCall = this.call(instanceId, "runner", "refresh_sessions", "list_recent_sessions", {
      ...args,
      _octopus_include_session_plus: true,
    });
    const localCall = this.call(instanceId, "local", "refresh_sessions", "list_recent_sessions", args);
    await Promise.all([
      settle("runner", runnerCall),
      settle("local", localCall),
    ]);
    // Only after this plane's own Gate answered without approval: a kept-row
    // lookup spends the same read and must never be what raises a card.
    if (kept.length && calls.runner?.ok && isCurrent()) {
      const rows = await this.keptRows(instanceId, owner, kept, projections.runner, now);
      if (isCurrent()) projections.runner.sessions = [...projections.runner.sessions, ...rows];
    }
    if (!partialPublished && (calls.runner?.ok || calls.local?.ok)) publishPartial();
    const final = this.finalRosterResult(instanceId, owner, calls, projections, Number(args.limit), keptIds);
    if (!final.ok && options.onPatch && isCurrent()) {
      const terminal = this.rosterProjection(
        instanceId,
        owner,
        projections,
        Number(args.limit),
        "final",
        keptIds,
      ).patch;
      if (isCurrent()) {
        try {
          options.onPatch(terminal);
        } catch {
          // The trusted consumer may close between generation checks.
        }
      }
    }
    return final;
  }


  private finalRosterResult(
    instanceId: string,
    owner: string,
    calls: Partial<Record<SessionResourcePlane, CallResult>>,
    projections: Readonly<Record<SessionResourcePlane, RosterPlaneProjection>>,
    limit: number,
    keptIds: ReadonlySet<string> = new Set(),
  ): SessionResourceResult {
    const runner = calls.runner ?? noResourceAuthority();
    const local = calls.local ?? noResourceAuthority();
    const pending = !runner.ok && runner.code === "approval_required"
      ? runner
      : !local.ok && local.code === "approval_required"
        ? local
        : null;
    if (!runner.ok && !local.ok && pending) return pending;
    if (!runner.ok && !local.ok && runner.code === "no_authority" && local.code === "no_authority") {
      return noResourceAuthority();
    }
    const projection = this.rosterProjection(instanceId, owner, projections, limit, "final", keptIds);
    return {
      ok: true,
      result: projection.result,
      patch: projection.patch,
    };
  }


  /** Normalize and apply one plane result at most once for the current generation. */
  private projectRosterPlane(
    instanceId: string,
    owner: string,
    plane: SessionResourcePlane,
    call: CallResult,
    now: number,
    isCurrent: () => boolean,
  ): RosterPlaneProjection {
    const projected = emptyRosterPlaneProjection();
    if (!isCurrent()) return projected;
    if (call.ok) {
      const value = asRecord(call.result);
      projected.indexPending = value.index_pending === true;
      projected.truncated = Number(value.total_found) > records(value.sessions).length;
      if (plane === "runner") {
        const devices = boundedRosterDevices(value.devices);
        const current = records(value.sessions)
          .map((entry) => normaliseSession(
            entry,
            owner,
            BOT_HOST_DEVICE,
            sessionDirectoryPlacement(value, entry),
          ))
          .filter((entry) => Boolean(entry.sessionId));
        if (!isCurrent()) return projected;
        projected.sessions = this.rosters.reconcile(instanceId, plane, devices, current, now);
        projected.sources = devices.map((device) => ({ kind: "runner", device, online: true }));
        projected.placement = boundedPlacementDevices(value.runner_inventory, new Set(devices));
      } else {
        const current = records(value.sessions)
          .map((entry) => normaliseSession({ ...entry, device: BOT_HOST_DEVICE }, owner, BOT_HOST_DEVICE))
          .filter((entry) => Boolean(entry.sessionId));
        if (!isCurrent()) return projected;
        projected.sessions = this.rosters.reconcile(instanceId, plane, [BOT_HOST_DEVICE], current, now);
        projected.sources = [{ kind: "local", device: BOT_HOST_DEVICE }];
      }
      return projected;
    }

    if (call.code === "approval_required") {
      // A pending approval is not current disclosure authority. Keeping an
      // older successful snapshot here would let a later operational failure
      // resurrect rows that the newest Gate did not release.
      if (!isCurrent()) return projected;
      this.rosters.forgetPlane(instanceId, plane);
      return projected;
    }
    if (call.code === "resource_failed") {
      if (!isCurrent()) return projected;
      projected.sessions = this.rosters.stale(instanceId, plane, now);
    } else {
      if (!isCurrent()) return projected;
      this.rosters.forgetPlane(instanceId, plane);
    }
    if (call.code !== "no_authority") projected.errors = [{ source: plane, code: call.code }];
    return projected;
  }

  /** Build either the progressive loading patch or the unchanged final shape. */
  private rosterProjection(
    instanceId: string,
    owner: string,
    projections: Readonly<Record<SessionResourcePlane, RosterPlaneProjection>>,
    limit: number,
    state: "loading" | "final",
    keptIds: ReadonlySet<string> = new Set(),
  ): { result: Record<string, RuntimeJson>; patch: Record<string, RuntimeJson> } {
    // Preserve the established runner-then-local merge order regardless of
    // which independent Gate happened to settle first.
    const sessions = [...projections.runner.sessions, ...projections.local.sessions];
    const merged = dedupeSessions(sessions);
    merged.sort((a, b) => String(b.sortActivity ?? b.lastActivity ?? "")
      .localeCompare(String(a.sortActivity ?? a.lastActivity ?? "")));
    const sources = [...projections.runner.sources, ...projections.local.sources]
      .slice(0, MAX_PROJECTED_ROSTER_SOURCES).map((entry) => {
        const label = this.deviceDisplayName?.(owner, String(entry.device ?? ""));
        return label ? { ...entry, deviceLabel: label } : entry;
      });
    const ownPlacement = projections.runner.placement.slice(0, MAX_RUNNER_ROSTER_DEVICES).map((entry) => {
      const label = this.deviceDisplayName?.(owner, String(entry.device ?? ""));
      return label ? { ...entry, deviceLabel: label } : entry;
    });
    const ownNames = new Set(ownPlacement.map((entry) => String(entry.device ?? "")));
    let sharedPlacement: Array<Record<string, unknown>> = [];
    try {
      sharedPlacement = (this.sharedAgentRuntimes?.(owner) ?? [])
        .filter((entry) => entry.sharedAgentRuntime === true && !ownNames.has(String(entry.device ?? "")));
    } catch {
      // A failed authorization/accounting projection reveals nothing and does
      // not erase the owner's ordinary Runner inventory.
    }
    const placement = {
      devices: [...ownPlacement, ...sharedPlacement].slice(0, MAX_RUNNER_ROSTER_DEVICES),
    };
    const errors = [...projections.runner.errors, ...projections.local.errors];
    const selected = selectSessionWindow(merged, limit, (row) => row.parentResourceId, undefined, {
      kept: (row) => keptIds.has(row.resourceId),
    });
    const result = {
      rosterIndexPending: projections.runner.indexPending || projections.local.indexPending,
      rosterTruncated: projections.runner.truncated || projections.local.truncated || merged.length > selected.length,
      sessions: selected.map((entry) => publicSession(
        this.displaySession(entry),
        this.sessionKey(instanceId, owner, entry),
      )),
      sources,
      placement,
      errors,
      resourceState: state === "loading" ? "loading" : merged.length ? "ready" : "empty",
      notice: state === "loading"
        ? merged.length
          ? "已显示首个能力平面的真实会话，正在等待其余资源。"
          : "首个能力平面已返回，正在等待其余会话资源。"
        : merged.length
          ? "真实会话资源由平台能力管线提供；收藏属于 App 自己的持久状态。"
          : "当前授权下没有可显示的会话。可检查端点、bot-host 扫描目录或部署授权。",
    };
    const safe = runtimeJson(result) as Record<string, RuntimeJson>;
    return {
      result: safe,
      patch: {
        ...safe,
        // Only a prior sessions-plane `list_session_workspaces` answer may have
        // populated these facts. The files Object uses the same parser but does
        // not feed this index: sibling capability disclosures never substitute
        // for this plane's own Gate.
        ...this.cachedWorkspaces(instanceId, owner),
        ...this.accessPatch(owner),
      },
    };
  }

  /**
   * Exact-identity summaries for kept chats missing from the window: one read
   * per online device, at most `SESSION_IDS_MAX` identities each, answered from
   * the per-instance cache while fresh. A refused or failed read is not proof
   * of absence and is not remembered; an old Runner that ignores `ids` simply
   * returns rows this filter drops.
   */
  private async keptRows(
    instanceId: string,
    owner: string,
    kept: readonly KeptIdentity[],
    runner: RosterPlaneProjection,
    now: number,
  ): Promise<HubSessionSummary[]> {
    const present = new Set(runner.sessions.map((row) => row.resourceId));
    const online = new Set(runner.sources.map((row) => String(row.device ?? "")));
    const rows: HubSessionSummary[] = [];
    const lookups = new Map<string, KeptIdentity[]>();
    for (const identity of kept) {
      if (present.has(identity.resourceId) || !online.has(identity.device)) continue;
      const cached = this.keptSessions.fresh(instanceId, identity.resourceId, now);
      if (cached) {
        if (cached.row) rows.push(cached.row);
        continue;
      }
      const group = lookups.get(identity.device) ?? [];
      if (group.length < SESSION_IDS_MAX) lookups.set(identity.device, [...group, identity]);
    }
    await Promise.all([...lookups].map(async ([device, group]) => {
      const call = await this.call(instanceId, "runner", "refresh_sessions", "list_recent_sessions", {
        device,
        source: "all",
        limit: group.length,
        ids: encodeSessionIds(group),
        _octopus_include_session_plus: true,
      });
      if (!call.ok) return;
      const value = asRecord(call.result);
      const found = new Map<string, HubSessionSummary>();
      for (const entry of records(value.sessions)) {
        const row = normaliseSession({ ...entry, device }, owner, device, sessionDirectoryPlacement(value, entry));
        if (row.sessionId) found.set(row.resourceId, row);
      }
      for (const identity of group) {
        const row = found.get(identity.resourceId) ?? null;
        this.keptSessions.remember(instanceId, identity.resourceId, row, now);
        if (row) rows.push(row);
      }
    }));
    return rows;
  }

  private async continuation(instanceId: string, action: string, params: Readonly<Record<string, string>>): Promise<SessionResourceResult> {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return noResourceAuthority();
    const decoded = decodeResourceId(params.resource ?? "");
    if (!decoded || decoded.owner !== bundle.owner || decoded.cliKind !== "codex" || decoded.device === BOT_HOST_DEVICE) {
      return { ok: false, code: "invalid_resource", message: "请选择本人 Runner 上的 Codex 会话" };
    }
    const save = action === "save_codex_continuation";
    if (save) {
      try { validateCodexContinuationPrompt(params.prompt === "" ? null : params.prompt); }
      catch (error) { return { ok: false, code: "invalid_resource", message: (error as Error).message }; }
      if (!/^(?:0|[a-f0-9-]{36})$/.test(params.revision ?? "")) return { ok: false, code: "invalid_resource", message: "请先读取当前续接设置" };
    }
    const call = await this.call(instanceId, "runner", action, save ? "append_session" : "read_session", {
      device: decoded.device, source: "codex", id: decoded.sessionId,
      ...(save ? { configure_continuation: true, continuation_prompt: params.prompt, continuation_revision: params.revision }
        : { continuation_settings: true, _octopus_include_session_plus: true, max_messages: 1 }),
    });
    if (!call.ok) return call;
    const settings = readCodexContinuationSettings(call.result);
    if (!settings) return { ok: false, code: "resource_failed", message: "Runner 尚不支持此设置或回执不完整；未确认保存，请更新 Runner 后重新读取" };
    return { ok: true, result: runtimeJson(settings), patch: {} };
  }

  private async read(
    instanceId: string,
    params: Readonly<Record<string, string>>,
    current: RuntimeJson,
  ): Promise<SessionResourceResult> {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return noResourceAuthority();
    const decoded = decodeResourceId(params.resource ?? "");
    // This check precedes openControllerRun, so a handle minted for another
    // owner produces no transport frame and no approval card.
    if (!decoded || decoded.owner !== bundle.owner) {
      this.permissions.audit({
        owner: bundle.owner,
        subjectType: "app",
        subjectId: this.bundles.profile.app,
        operation: "read_session",
        decision: "deny",
        reason: "resource owner mismatch",
      });
      return { ok: false, code: "invalid_resource", message: "这个会话标识不属于当前账户" };
    }
    const plane: SessionResourcePlane = decoded.device === BOT_HOST_DEVICE ? "local" : "runner";
    const requestedOffset = optionalBoundedInt(params.offset, 0, Number.MAX_SAFE_INTEGER);
    const identity = {
      id: decoded.sessionId,
      source: decoded.cliKind,
      // A resource selected from one device must still name that device when
      // the account has two machines carrying the same session id. The local
      // object has no device selector in its schema.
      ...(plane === "runner" ? { device: decoded.device } : {}),
      ...(plane === "runner" ? { _octopus_include_session_plus: true } : {}),
      rich: true,
    };
    if (params.block !== undefined && params.block !== "") return await this.readBlock(instanceId, plane, identity, params, requestedOffset);
    const limit = boundedInt(params.limit, 1, 500, 200);
    const call = await this.call(instanceId, plane, "open_session", "read_session", {
      ...identity,
      max_messages: limit,
      // An explicit offset asks for the page that ends where the shown window
      // starts. `before` keeps that edge when the page stops at its byte
      // budget; a Runner that predates it reads from `offset` as before.
      ...(requestedOffset === undefined ? {} : { offset: requestedOffset, before: requestedOffset + limit }),
    });
    if (!call.ok) return call;
    const previous = asRecord(asRecord(current).transcript);
    const page = runtimeJson(publicTranscript(call.result, decoded));
    const data = requestedOffset === undefined
      ? page
      : runtimeJson(prependTranscriptWindow(previous[params.resource], page));
    const transcript = retainTranscripts(previous, params.resource, data);
    return { ok: true, result: data, patch: { transcript } };
  }

  /**
   * One character window of one complete transcript block, through the same
   * `open_session` → `read_session` authority as the page that showed it. The
   * answer is returned to the asking module, not written into the projection.
   */
  private async readBlock(
    instanceId: string,
    plane: SessionResourcePlane,
    identity: Record<string, unknown>,
    params: Readonly<Record<string, string>>,
    offset: number | undefined,
  ): Promise<SessionResourceResult> {
    const block = optionalBoundedInt(params.block, 0, Number.MAX_SAFE_INTEGER);
    const field = params.field === "input" || params.field === "output" ? params.field : "text";
    if (offset === undefined || block === undefined) {
      return { ok: false, code: "invalid_resource", message: "读取完整内容需要消息序号和块序号" };
    }
    const call = await this.call(instanceId, plane, "open_session", "read_session", {
      ...identity,
      offset,
      block,
      field,
      char_offset: optionalBoundedInt(params.char_offset, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    });
    if (!call.ok) return call;
    const value = asRecord(call.result);
    if (typeof value.text !== "string" || typeof value.total_chars !== "number") {
      return { ok: false, code: "resource_failed", message: "该设备 Runner 尚不支持读取完整内容，请更新后重试" };
    }
    const next = value.next_char_offset;
    return {
      ok: true,
      result: runtimeJson({
        offset,
        block,
        field,
        text: value.text,
        charOffset: typeof value.char_offset === "number" ? value.char_offset : 0,
        totalChars: value.total_chars,
        ...(typeof next === "number" && Number.isSafeInteger(next) ? { nextCharOffset: next } : {}),
      }),
      patch: {},
    };
  }

  private async attachFile(
    instanceId: string,
    params: Readonly<Record<string, string>>,
  ): Promise<SessionResourceResult> {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return noResourceAuthority();
    const decoded = decodeResourceId(params.resource ?? "");
    const draft = !params.resource && Boolean(params.device);
    if (draft ? (bundle.actor !== "user" || this.bundles.profile.app !== "session-plus" || params.device === BOT_HOST_DEVICE)
      : (!decoded || decoded.owner !== bundle.owner || Boolean(params.device || params.workspace_id))) {
      this.audit(bundle.owner, "upload_session_file", "runner", "deny", "invalid upload target");
      return { ok: false, code: "invalid_resource", message: "这个附件目标不属于当前新建草稿或会话" };
    }
    // Draft identity is minted here, scoped to the instance and execution target.
    // It names only multipart state; the Runner chooses a fresh temporary path.
    const sessionId = decoded?.sessionId ?? "draft-" + createHash("sha256")
      .update(JSON.stringify([instanceId, params.device, params.workspace_id ?? ""])).digest("hex").slice(0, 32);
    const chunkIndex = Number(params.chunk_index);
    const chunkCount = Number(params.chunk_count);
    if (
      !Number.isSafeInteger(chunkIndex)
      || chunkIndex < 0
      || chunkIndex >= MACHINE_LIMITS.sessionAttachmentMaxChunks
      || !Number.isSafeInteger(chunkCount)
      || chunkCount < 1
      || chunkCount > MACHINE_LIMITS.sessionAttachmentMaxChunks
      || chunkIndex >= chunkCount
    ) {
      return { ok: false, code: "invalid_resource", message: "文件分块参数无效" };
    }
    const target = decoded ? this.attachmentTarget?.(bundle.owner, decoded.device, decoded.cliKind, decoded.sessionId) : undefined;
    const device = target?.device ?? decoded?.device ?? params.device!;
    const workspaceId = decoded ? target?.workspaceId ?? this.directorySnapshots.location(
      this.directoryScope(instanceId, bundle.owner), device, decoded.cliKind, decoded.sessionId,
    )?.workspaceId : params.workspace_id || undefined;
    const targetPlane: SessionResourcePlane = device === BOT_HOST_DEVICE ? "local" : "runner";
    const call = await this.call(instanceId, targetPlane, "attach_file", "upload_session_file", {
      ...(targetPlane === "runner" ? { device } : {}),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      id: sessionId,
      name: params.name,
      media_type: params.media_type,
      chunk_index: chunkIndex,
      chunk_count: chunkCount,
      ...(params.upload_id ? { upload_id: params.upload_id } : {}),
      data: params.data,
    });
    if (!call.ok) return call;
    const result = asRecord(call.result);
    if (workspaceId && result.workspace_id !== workspaceId) {
      return { ok: false, code: "resource_failed", message: "执行 Runner 未确认目标工作区，请升级 Runner 后重新选择文件" };
    }
    const uploadId = boundedText(result.upload_id, MACHINE_LIMITS.sessionAttachmentUploadIdMaxBytes);
    if (!/^[A-Za-z0-9_-]{24}$/.test(uploadId)) {
      return { ok: false, code: "resource_failed", message: "设备返回了无法识别的上传回执" };
    }
    if (result.complete !== true) {
      const receivedBytes = Number(result.received_bytes);
      return {
        ok: true,
        result: runtimeJson({
          upload_id: uploadId,
          complete: false,
          received_bytes: Number.isSafeInteger(receivedBytes)
            ? Math.min((chunkIndex + 1) * MACHINE_LIMITS.sessionAttachmentChunkBytes, Math.max(0, receivedBytes))
            : 0,
        }),
        patch: {},
      };
    }
    const attachment = asRecord(result.attachment);
    const label = boundedText(attachment.label, MACHINE_LIMITS.sessionAttachmentNameMaxBytes);
    const attachmentPath = boundedText(attachment.path, MACHINE_LIMITS.pathMaxBytes);
    const bytes = Number(attachment.bytes);
    const mediaType = boundedText(
      attachment.media_type,
      MACHINE_LIMITS.sessionAttachmentMediaTypeMaxBytes,
    );
    if (
      !label
      || !isAbsolute(attachmentPath)
      || !attachmentPath
      || !Number.isSafeInteger(bytes)
      || bytes < 1
      || bytes > chunkCount * MACHINE_LIMITS.sessionAttachmentChunkBytes
    ) {
      return { ok: false, code: "resource_failed", message: "设备返回了无法识别的文件引用" };
    }
    return {
      ok: true,
      result: runtimeJson({
        upload_id: uploadId,
        complete: true,
        attachment: { label, path: attachmentPath, bytes, mediaType },
      }),
      patch: {},
    };
  }

  /**
   * One page of a complete search over both planes. The projection holds the
   * page the reader asked for (its `cursor`), like the history browser; the
   * shared merge guarantees `nextCursor` skips nothing either plane holds.
   */
  private async search(instanceId: string, params: Readonly<Record<string, string>>): Promise<SessionResourceResult> {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return noResourceAuthority();
    const query = String(params.query ?? "").trim();
    if (!query) return { ok: false, code: "resource_denied", message: "请输入搜索内容" };
    const cursor = String(params.cursor ?? "");
    try { decodeSearchCursor(cursor); } catch {
      return { ok: false, code: "invalid_resource", message: "搜索翻页游标无效，请重新搜索" };
    }
    const args = { query, source: source(params.source), limit: boundedInt(params.limit, 1, 50, 15), ...(cursor ? { cursor } : {}) };
    const [runner, local] = await Promise.all([
      this.call(instanceId, "runner", "search_sessions", "search_sessions", {
        ...args,
        _octopus_include_session_plus: true,
      }),
      this.call(instanceId, "local", "search_sessions", "search_sessions", args),
    ]);
    const errors: Array<Record<string, unknown>> = [];
    const parts: SearchPagePart[] = [];
    // Which plane page each hit came from: directory placements are keyed by that page object.
    const origin = new Map<Record<string, unknown>, { plane: "runner" | "local"; value: Record<string, unknown> }>();
    let pending: ResourceRefusal | null = null;
    for (const [plane, call] of [["runner", runner], ["local", local]] as const) {
      if (!call.ok) {
        if (call.code === "approval_required") pending ??= call;
        else if (call.code !== "no_authority") {
          errors.push({ source: plane, code: call.code });
          parts.push({ label: plane === "local" ? "bot 主机" : "Runner 设备" });
        }
        continue;
      }
      const value = asRecord(call.result);
      const results = records(value.results).map((item) => {
        const hit = plane === "local" ? { ...item, session: { ...asRecord(item.session), device: BOT_HOST_DEVICE } } : item;
        origin.set(hit, { plane, value });
        return hit;
      });
      parts.push({ label: plane === "local" ? "bot 主机" : "Runner 设备", page: { ...value, results } });
    }
    if (!runner.ok && !local.ok && pending) return pending;
    if (!runner.ok && !local.ok && runner.code === "no_authority" && local.code === "no_authority") {
      return noResourceAuthority();
    }
    const page = mergeSearchPages(parts, args.limit, Boolean(cursor));
    const hits: Array<Record<string, unknown>> = [];
    for (const item of page.results) {
      const from = origin.get(item);
      if (!from) continue;
      const rawSession = asRecord(item.session);
      const normal = normaliseSession(
        rawSession,
        bundle.owner,
        BOT_HOST_DEVICE,
        from.plane === "runner" ? sessionDirectoryPlacement(from.value, rawSession) : undefined,
      );
      if (!normal.sessionId) continue;
      hits.push({
        session: publicSession(
          this.displaySession(normal),
          this.sessionKey(instanceId, bundle.owner, normal),
        ),
        snippet: boundedText(item.snippet ?? item.preview ?? item.text ?? firstSnippet(item.matches), 2_000),
      });
    }
    const result = {
      query,
      cursor,
      results: hits,
      returned: hits.length,
      errors,
      complete: page.complete,
      ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}),
      ...(page.incomplete_sources ? { incompleteSources: page.incomplete_sources } : {}),
    };
    const safe = runtimeJson(result);
    return { ok: true, result: safe, patch: { search: safe } };
  }

  reconcileWorkspacePatch(
    instanceId: string,
    current: RuntimeJson,
    patch: Record<string, RuntimeJson>,
  ): Record<string, RuntimeJson> {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return patch;
    const sessions = this.rekeySessions(instanceId, bundle.owner, current);
    const { sessions: _oldSessions, ...workspacePatch } = patch;
    return { ...workspacePatch, ...this.cachedWorkspaces(instanceId, bundle.owner), ...(sessions ? { sessions } : {}) };
  }

  private async workspaces(
    instanceId: string,
    params: Readonly<Record<string, string>>,
    current: RuntimeJson,
  ): Promise<SessionResourceResult> {
    const device = String(params.device ?? "").trim();
    if (!device) return { ok: false, code: "resource_denied", message: "请选择一台在线设备" };
    const call = await this.call(
      instanceId,
      "runner",
      "refresh_workspaces",
      "list_session_workspaces",
      { device },
    );
    if (!call.ok) return call;
    const bundle = this.bundles.get(instanceId);
    const owner = bundle?.owner ?? "";

    // This sessions-plane request has gone through its own Gate. Only now does
    // it replace this plane's facts for the device. Workspace-files never
    // populates this slot, and an index hit never answers or authorizes a call.
    const snapshot = readWorkspaceDirectorySnapshot(call.result, device);
    if (!snapshot) {
      return { ok: false, code: "resource_failed", message: "设备返回了无法识别的工作区列表" };
    }
    const scope = this.directoryScope(instanceId, owner);
    this.directorySnapshots.prune((held) => Boolean(this.bundles.get(held.instance)));
    this.directorySnapshots.replace(scope, snapshot);

    const result = runtimeJson(this.projectWorkspaceSnapshot(owner, snapshot));
    const workspacesByDevice = this.cachedWorkspaces(instanceId, owner).workspacesByDevice
      ?? runtimeJson({ [device]: result });
    // Sessions already on screen gain their keys now rather than at the next
    // roster refresh — which the view has no reason to make, and which would
    // otherwise leave a projection where roots can be joined and sessions
    // cannot.
    const sessions = this.rekeySessions(instanceId, owner, current);
    return {
      ok: true,
      result,
      // `workspaces` remains as a compatibility alias for old releases. The
      // map lets a declarative roster render every device at once and place a
      // compact launch action on each registered directory.
      patch: {
        workspaces: result,
        workspacesByDevice,
        ...(sessions ? { sessions } : {}),
        ...this.accessPatch(owner),
      },
    };
  }

  private async terminal(
    instanceId: string,
    action: "open_terminal" | "read_terminal" | "send_terminal" | "close_terminal",
    params: Readonly<Record<string, string>>,
    current: RuntimeJson,
  ): Promise<SessionResourceResult> {
    const device = boundedText(params.device, 64);
    if (!device) return { ok: false, code: "invalid_resource", message: "请选择一台在线设备" };
    const args: Record<string, unknown> = { device };
    let deviceLeases = this.terminalLeases.get(instanceId);
    const lease = deviceLeases?.get(device);

    if (action === "open_terminal") {
      const workspaceId = boundedText(params.workspace_id, 64);
      const root = asRecord(current);
      const byDevice = asRecord(root.workspacesByDevice);
      const projected = asRecord(byDevice[device] ?? root.workspaces);
      const workspace = records(projected.workspaces)
        .find((row) => String(row.id ?? "") === workspaceId);
      if (String(projected.device ?? "") !== device || !workspace) {
        return { ok: false, code: "invalid_resource", message: "工作区列表已经变化；请刷新后重新选择" };
      }
      const readiness = asRecord(projected.terminal);
      if (readiness.available === false) {
        return { ok: false, code: "resource_failed", message: boundedText(readiness.reason, 240) || "这台设备的远端终端不可用；请刷新工作区。" };
      }

      const existingLease = lease?.device === device && lease.workspaceId === workspaceId
        ? lease
        : undefined;
      const openLease = existingLease ?? {
        id: `lease_${randomBytes(24).toString("hex")}`,
        device,
        workspaceId,
      };
      if (!existingLease) {
        if (!deviceLeases) {
          deviceLeases = new Map();
          this.terminalLeases.set(instanceId, deviceLeases);
        }
        if (!deviceLeases.has(device) && deviceLeases.size >= MAX_RUNNER_ROSTER_DEVICES) {
          return { ok: false, code: "resource_failed", message: "当前页面的终端设备数量已达上限；请先结束一个终端。" };
        }
        deviceLeases.set(device, openLease);
      } else {
        const claimed = await this.call(
          instanceId,
          "runner",
          "claim_terminal",
          "workspace_terminal",
          {
            device,
            action: "claim",
            lease_id: openLease.id,
            cols: boundedInt(params.cols, 40, 240, 120),
            rows: boundedInt(params.rows, 12, 80, 32),
          },
        );
        if (claimed.ok) {
          const result = terminalSnapshot(claimed.result);
          if (!result) return { ok: false, code: "resource_failed", message: "设备返回了无法识别的终端画面" };
          return { ok: true, result: runtimeJson(result), patch: {} };
        }
      }

      const opened = await this.call(
        instanceId,
        "runner",
        "open_terminal",
        "open_workspace_terminal",
        {
          device,
          lease_id: openLease.id,
          workspace_id: workspaceId,
          cols: boundedInt(params.cols, 40, 240, 120),
          rows: boundedInt(params.rows, 12, 80, 32),
        },
      );
      if (!opened.ok) return opened;
      const result = terminalSnapshot(opened.result);
      if (!result) return { ok: false, code: "resource_failed", message: "设备返回了无法识别的终端画面" };
      return { ok: true, result: runtimeJson(result), patch: {} };
    }

    if (!lease || lease.device !== device) {
      return { ok: false, code: "invalid_resource", message: "这个远端终端没有当前页面的授权通道" };
    }
    const terminalId = boundedText(params.terminal_id, 64);
    if (!/^term_[0-9a-f]{48}$/.test(terminalId)) {
      return { ok: false, code: "invalid_resource", message: "这个远端终端标识无效" };
    }
    args.action = action === "send_terminal" ? "input" : action.replace("_terminal", "");
    args.lease_id = lease.id;
    args.terminal_id = terminalId;
    if (action === "send_terminal") {
      const input = boundedText(params.input, 16 * 1024);
      if (!input.trim()) return { ok: false, code: "invalid_resource", message: "终端输入不能为空" };
      args.input = input;
    }
    if (action !== "close_terminal") {
      args.cols = boundedInt(params.cols, 40, 240, 120);
      args.rows = boundedInt(params.rows, 12, 80, 32);
    }
    const called = await this.call(instanceId, "runner", action, "workspace_terminal", args);
    if (!called.ok) return called;
    const result = terminalSnapshot(called.result);
    if (!result) return { ok: false, code: "resource_failed", message: "设备返回了无法识别的终端画面" };
    if (action === "close_terminal" && deviceLeases?.get(device) === lease) deviceLeases.delete(device);
    return { ok: true, result: runtimeJson(result), patch: {} };
  }

  /**
   * Re-attach directory facts to sessions already in the projection, or null
   * when nothing changed.
   *
   * Ordinary rows update only `directoryKey`. Split rows already carry a
   * catalog-minted key, which a device snapshot may enrich with the current
   * workspace label/display but may never replace from a coincident local
   * transcript id. When no successful snapshot exists for an ordinary row's
   * device, an old key is retained because absence is unknown. Once a
   * successful whole-device reply omits its association, that old key is
   * deleted as stale join evidence.
   */
  private rekeySessions(instanceId: string, owner: string, current: RuntimeJson): RuntimeJson | null {
    if (!this.directoryKeys) return null;
    const rows = records(asRecord(current).sessions);
    if (!rows.length) return null;
    let changed = false;
    const next = rows.map((row) => {
      const resource = typeof row.resourceId === "string" ? row.resourceId : "";
      const deviceId = typeof row.deviceId === "string" ? row.deviceId : "";
      const directoryDeviceId = typeof row.directoryDeviceId === "string" ? row.directoryDeviceId : "";
      const directoryKey = typeof row.directoryKey === "string" ? row.directoryKey : "";
      if (directoryDeviceId) {
        const snapshot = this.directorySnapshots.snapshot(
          this.directoryScope(instanceId, owner),
          directoryDeviceId,
        );
        const root = directoryKey && snapshot
          ? snapshot.roots.find((candidate) => this.directoryKeys!.mint({
              owner,
              publisher: this.bundles.profile.publisher,
              app: this.bundles.profile.app,
              device: directoryDeviceId,
              workspaceId: candidate.workspaceId,
              relativePath: "",
            }) === directoryKey)
          : undefined;
        if (!root) return row;
        const projectLabel = root.label || row.projectLabel;
        const cwdDisplay = root.display || row.cwdDisplay;
        if (projectLabel === row.projectLabel && cwdDisplay === row.cwdDisplay) return row;
        changed = true;
        return { ...row, projectLabel, cwdDisplay };
      }
      const decoded = resource ? decodeResourceId(resource) : null;
      const key = decoded
        ? this.sessionKey(instanceId, owner, {
            deviceId,
            ...(directoryDeviceId ? { directoryDeviceId } : {}),
            cliKind: decoded.cliKind,
            sessionId: decoded.sessionId,
        })
        : undefined;
      if (key && row.directoryKey === key) return row;
      if (!key) {
        // A successful whole-device replacement that omits this association is
        // deletion evidence for the JOIN fact (unlike a failed device fan-out).
        // Remove the old key only when this device has a current snapshot; with
        // no snapshot at all, absence is still unknown and the row is retained.
        const hasDeviceSnapshot = Boolean(
          decoded && this.directorySnapshots.snapshot(this.directoryScope(instanceId, owner), deviceId),
        );
        if (!hasDeviceSnapshot || !("directoryKey" in row)) return row;
        const { directoryKey: _dropped, ...withoutKey } = row;
        changed = true;
        return withoutKey;
      }
      changed = true;
      return { ...row, directoryKey: key };
    });
    return changed ? runtimeJson(next) : null;
  }

  private async call(
    instanceId: string,
    plane: SessionResourcePlane,
    action: string,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<CallResult> {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return noResourceAuthority();
    const run = this.bundles.openController(instanceId, plane, action);
    if (!run) {
      this.audit(bundle.owner, operation, plane, "deny", "no authority context");
      return noResourceAuthority();
    }
    try {
      const out = await withTimeout(run.caps.request("resources", operation, args), operation, this.timeoutMs);
      if (out.status === "succeeded") {
        this.audit(bundle.owner, operation, plane, "allow");
        return { ok: true, result: out.result };
      }
      if (out.status === "approval_required") {
        this.audit(bundle.owner, operation, plane, "pending", out.pendingCallId);
        return {
          ok: false,
          code: "approval_required",
          message: operation === "open_workspace_terminal"
            ? "远端终端等待一次可信批准；批准后再次点击即可接入快速通道"
            : operation === "workspace_terminal"
              ? "远端终端快速通道未生效，请在会话信息里重新授权"
              : operation === "upload_session_file"
                ? "文件上传等待可信批准；批准后请重新选择文件"
                : "这个读取没有配置免批，需要先在可信审批栏确认",
          pendingCallId: out.pendingCallId,
        };
      }
      if (out.status === "denied") {
        this.audit(bundle.owner, operation, plane, "deny", out.reason);
        return { ok: false, code: "resource_denied", message: out.reason || "资源调用被拒绝" };
      }
      // `failed` / `unknown`: the device or its link answered badly, not the
      // authority. Callers treat this as retryable (a roster keeps its last
      // rows, a chat keeps following) instead of as a refusal.
      this.audit(bundle.owner, operation, plane, "error", out.reason);
      return { ok: false, code: "resource_failed", message: out.reason || `${plane} 会话资源暂时不可用` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit(bundle.owner, operation, plane, "error", message);
      return { ok: false, code: "resource_failed", message: `${plane} 会话资源暂时不可用` };
    } finally {
      run.close();
    }
  }

  private audit(owner: string, operation: string, resource: string, decision: string, reason?: string): void {
    this.permissions.audit({
      owner,
      subjectType: "app",
      subjectId: this.bundles.profile.app,
      operation,
      resource,
      decision,
      reason: reason ?? null,
    });
  }
}

function source(value: string | undefined): ScanSource | "all" {
  return scanSourceArg(value);
}

/** Hostile Runner arrays never become an unbounded source projection or cache key set. */
function boundedRosterDevices(value: unknown): string[] {
  const devices: string[] = [];
  const seen = new Set<string>();
  for (const raw of strings(value)) {
    if (!raw || raw.length > MAX_ROSTER_DEVICE_ID_LENGTH || seen.has(raw)) continue;
    seen.add(raw);
    devices.push(raw);
    if (devices.length >= MAX_RUNNER_ROSTER_DEVICES) break;
  }
  return devices;
}
export function boundedPlacementDevices(value: unknown, allowed: ReadonlySet<string>): Array<Record<string, unknown>> {
  const devices: Array<Record<string, unknown>> = [];
  for (const raw of records(value).slice(0, MAX_RUNNER_ROSTER_DEVICES)) {
    const device = String(raw.device ?? "").trim();
    const inventory = asRecord(raw.inventory);
    const execution = asRecord(inventory.execution);
    if (!allowed.has(device) || inventory.schema !== "runner-inventory/v1") continue;
    const agentBackends = records(inventory.agent_backends)
      .slice(0, SESSION_CLI_KINDS.length)
      .flatMap((backend) => {
        const kind = String(backend.kind ?? "");
        if (!SESSION_CLI_KINDS.includes(kind as ScanSource) || typeof backend.available !== "boolean") return [];
        const version = typeof backend.version === "string" ? backend.version.slice(0, 120) : "";
        const reason = typeof backend.reason === "string" ? backend.reason.slice(0, 64) : "";
        const splitExecution = backend.split_execution === true;
        const splitExecutionReason = typeof backend.split_execution_reason === "string"
          ? backend.split_execution_reason.slice(0, 64)
          : "";
        // Own devices only: shared runtimes are projected separately without diagnostics.
        const detail = publicAgentDiagnosticDetail(backend.diagnostic_detail);
        return [{
          kind,
          available: backend.available,
          splitExecution,
          ...(splitExecutionReason ? { splitExecutionReason } : {}),
          ...(version ? { version } : {}),
          ...(agentDiagnosticCode(backend.diagnostic_code) ? { diagnosticCode: agentDiagnosticCode(backend.diagnostic_code) } : {}),
          ...(detail ? { diagnosticPath: detail.path, diagnosticRule: detail.rule } : {}),
          ...(reason ? { reason } : {}),
        }];
      });
    devices.push({
      device,
      online: raw.online === true,
      agentBackends,
      codexAccounts: records(asRecord(inventory.ticket_options).codex_accounts).slice(0, 27).flatMap((account) => {
        if (typeof account.id !== "string" || !/^(?:@default|[A-Za-z0-9_-]{1,32})$/.test(account.id)
          || typeof account.label !== "string" || account.label.length > 120) return [];
        const quota = publicCodexQuota(account.quota);
        const models = publicModelChoices(account.models);
        const emailLabel = publicCodexEmailLabel(account.emailLabel);
        return [{ id: account.id, label: account.label,
          ...(models ? { models } : {}),
          ...(emailLabel ? { emailLabel } : {}),
          ...(quota ? { quota } : {}) }];
      }),
      execution: {
        platform: String(execution.platform ?? "").slice(0, 32),
        arch: String(execution.arch ?? "").slice(0, 32),
        shell: execution.shell === true,
        workspaceFiles: execution.workspace_files === true,
        workspaceCount: Math.max(0, Math.min(10_000, Number(execution.workspace_count) || 0)),
        codexExecServer: execution.codex_exec_server === true,
      },
    });
  }
  return devices;
}


function boundedInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function terminalSnapshot(value: unknown): { terminal_id: string; screen: string; closed: boolean } | null {
  const row = asRecord(value as RuntimeJson);
  const terminalId = typeof row.terminal_id === "string" ? row.terminal_id : "";
  const screen = typeof row.screen === "string" ? row.screen : "";
  if (!/^term_[0-9a-f]{48}$/.test(terminalId) || screen.length > 128 * 1024 || typeof row.closed !== "boolean") {
    return null;
  }
  return { terminal_id: terminalId, screen, closed: row.closed };
}

function boundedNumber(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}

function optionalBoundedInt(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : undefined;
}

function rosterAlreadyProjected(current: RuntimeJson): boolean {
  const sessions = asRecord(current).sessions;
  return Array.isArray(sessions) && sessions.length > 0;
}

function withoutProgressivePatch(options: SessionResourceExecuteOptions): SessionResourceExecuteOptions {
  const { onPatch: _progressive, ...rest } = options;
  return rest;
}

/** Device search hits carry `matches[].snippet`; the projection shows the first. */
function firstSnippet(matches: unknown): string | undefined {
  const first = Array.isArray(matches) ? asRecord(matches[0]) : {};
  return typeof first.snippet === "string" ? first.snippet : undefined;
}
