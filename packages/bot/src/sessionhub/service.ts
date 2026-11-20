import { runnerDisplayName } from "../runner/display-name.js";
import { SESSION_LIST_START_CURSOR, sessionHistoryPage, sessionListCursor } from "@claude-bot/agent-sessions-contract";
/**
 * SessionHubService — the stable boundary between "a web request about
 * sessions" and "a capability call at somebody's laptop".
 *
 * Everything the panel's `/api/sessions*` routes used to do inline now happens
 * here, and the reason is not tidiness. Four things have to be decided
 * identically for every entry point, and inline code decided them four times:
 *
 *   1. WHOSE sessions. The owner comes from the authenticated principal, never
 *      from a body or a query parameter that names somebody. A `resourceId`
 *      the browser sends back is decoded and re-checked, not trusted.
 *   2. WHAT the caller may do. The rights handed to `open()` are
 *      `requested ∩ granted intent ∩ what the account authority holds` —
 *      computed by `PermissionService.effectiveFor`, the same function the
 *      permission screen renders. One computation, two consumers.
 *   3. WHAT COMES BACK. Normalised, with the transcript path removed. A path
 *      is the resource's business; handing it to a browser invites the browser
 *      to send one back, and a path that arrives from outside is a path that
 *      decides what gets read.
 *   4. WHAT IT MEANS TO WRITE. `append`/`resume` take a single-writer lease and
 *      hold it across the approval, so two tabs cannot drive one CLI session.
 *
 * ── TWO resources, one gate ────────────────────────────────────────────────
 *
 * A session lives either on a laptop Runner or in a home directory the bot host
 * can read itself. Both are capability Objects (`runner/capability.ts` and
 * `local-scan.ts`), and every method below derives a grant for each and uses
 * ONLY what it got.
 *
 * It used to derive one and call the other's scan function directly, and that
 * asymmetry was two bugs wearing one coat: an admin — who may READ across
 * accounts — got somebody else's roster, search hits and transcripts from the
 * local branch, and revoking the hub grant closed the Runner while the local
 * branch carried on answering. Neither was a decision anybody made; both fell
 * out of "the branch with no gate has no gate".
 *
 * So the rule here is flat: **nothing reads a session for a caller who neither
 * owns the account nor is a named administrator, and nothing reads a session
 * without the account's grant** — where the bot host is one resource and the
 * laptop is another, not a resource and an exception. (2026-10-15: the owner
 * decided an administrator may read and act on any account, through the same
 * grants, with the acting administrator recorded in the account's audit.)
 *
 * A future v3 shell calls these methods; it does not re-implement them.
 */

import type { Store } from "../store/store.js";
import type { RunnerCapabilities, RunnerGrant } from "../runner/capability.js";
import {
  RESPOND_AGENT_INTERACTION,
  type AgentInteractionCapabilities,
} from "../agent-interactions/capability.js";
import { mergeSearchPages, SEARCH_PAGE_MAX, type SearchPagePart, type Source as ScanSource } from "@claude-bot/plugin-sessions/scan";
import { PermissionService } from "../permissions/service.js";
import { runnerOperationsFor, sessionHubOperation } from "../permissions/catalog.js";
import { autoAllowedOperations, effectiveOperations, type EffectiveView } from "../permissions/effective.js";
import { LOCAL_SCAN_OPERATION_NAMES, type LocalScanCapabilities, type LocalScanGrant } from "./local-scan.js";
import { SessionLeases, type LeaseHandle } from "./lease.js";
import { createLogger } from "../logger.js";
import {
  BOT_HOST_DEVICE,
  appendFingerprint,
  decodeResourceId as decodeCoreResourceId,
  dedupeSessions,
  dispatchObserved,
  normaliseSession,
  resourceId as encodeResourceId,
  SESSION_CLI_KINDS,
  stripSessionPath,
  withTimeout,
} from "./core.js";

export {
  BOT_HOST_DEVICE,
  appendFingerprint,
  decodeResourceId,
  dedupeSessions,
  dispatchObserved,
  normaliseSession,
  resourceId,
  SESSION_CLI_KINDS,
  stripSessionPath,
  withTimeout,
} from "./core.js";

const log = createLogger("session-hub");

/**
 * Who is asking. Assembled by the transport from an authenticated session —
 * there is no constructor that takes a username out of a request.
 */
export interface HubPrincipal {
  /** Absent = the shared key, which names nobody and owns nothing. */
  username?: string;
  admin: boolean;
  /** True when this arrived on a browser session rather than a bearer token. */
  session: boolean;
  /**
   * A one-way handle for the CREDENTIAL this request arrived on — one browser
   * login, or one device token. It is never rendered and never leaves the
   * process; what it does is scope the Contexts this request derives, so that
   * ending exactly one login closes exactly that login's Contexts, its undecided
   * approvals and its leases, and leaves the account's other logins alone.
   *
   * Without it every login of one account shared a Context pool, and "结束这处
   * 登录" was a row update that changed nothing already running.
   */
  credential: string;
}

/** A refusal that is a decision, not a failure. */
export interface HubRefusal {
  ok: false;
  status: number;
  error: string;
}

export type HubResult<T> = ({ ok: true } & T) | HubRefusal;

/** Why a viewer who may READ this account still gets no session material. */
export interface HubRestriction {
  reason: "owner_only" | "not_granted";
  explanation: string;
}

/**
 * One session, as the hub describes it.
 *
 * The legacy scan field names are kept ALONGSIDE the normalised ones on
 * purpose: the existing sessions page reads them, and the execution plan is
 * explicit that the v2 sidebar must keep working through the whole migration.
 * What is NOT kept is `path` — see the file docstring.
 */
export interface HubSessionSummary {
  usage?: import("@claude-bot/agent-sessions-contract").CodexTokenUsage;
  /** Opaque, server-minted, and re-checked on the way back in. Not authority. */
  resourceId: string;
  owner: string;
  deviceId: string;
  deviceLabel: string;
  /** Directory/archive coordinate; resource operations still use deviceId. */
  directoryDeviceId?: string;
  /** Trusted internal workspace join evidence; never projected directly. */
  directoryWorkspaceId?: string;
  cliKind: ScanSource;
  sessionId: string;
  projectLabel?: string;
  /** Single-character account marker minted by trusted Runner configuration. */
  accountLabel?: string;
  /** Display only. Never used as a path on any subsequent request. */
  cwdDisplay?: string;
  lastActivity?: string;
  /** Stable roster key: latest real user prompt or completed agent turn. */
  sortActivity?: string;
  /** Latest completed agent turn, for App-owned review acknowledgement. */
  completedAt?: string;
  /** "live" while something is running, else "idle". */
  status: "live" | "idle";
  /** Whether this hub could drive it — needs a real device, not the bot host. */
  resumable: boolean;
  /** Explicit provider ownership; these rows are observable but not directly writable. */
  inputMode?: "parent_owned";
  /** Trusted opaque resource for the provider-declared parent thread. */
  parentResourceId?: string;
  /** Explicit non-interactive Codex exec origin; display grouping only. */
  executionMode?: "exec";
  /** Last-known row retained after an operational device absence. */
  stale?: boolean;

  // ── legacy keys the v2 page reads ──
  id: string;
  source: ScanSource;
  device: string;
  project?: string;
  cwd?: string;
  last_activity?: string;
  sort_activity?: string;
  completed_at?: string;
  started_at?: string;
  message_count?: number;
  /** Provider-owned display title; absent for providers without one. */
  title?: string;
  preview?: string;
  first_user_text?: string;
  activity?: unknown;
  /** Declassified hook/process state; device-local identity is never present. */
  runtime?: unknown;
}

export interface HubPermissionsBlock {
  requested: string[];
  granted: string[];
  effective: string[];
  autoAllow: string[];
  /** Conditional on this request arriving through the owner's browser session. */
  directSelfAutoAllow: string[];
  reasons: Record<string, string[]>;
}

export interface HubRosterView {
  username: string;
  sources: Array<Record<string, unknown>>;
  returned: number;
  sessions: HubSessionSummary[];
  errors?: Array<Record<string, unknown>>;
  permissions: HubPermissionsBlock;
  /** Present when the roster is deliberately empty rather than actually empty. */
  restricted?: HubRestriction;
  /**
   * The complete walk continues after this position (`roster({ cursor })`).
   * Absent means nothing remains: a recent page that covered every session, or
   * the last page of the walk.
   */
  nextCursor?: string;
}

/**
 * A prepared submission: authorised, holding the session's single-writer lease
 * and an open capability grant, not yet dispatched.
 *
 * `fingerprint` is what makes two attempts the same intent; `contextId` is the
 * capability Context the call will be made in, which is the only handle that
 * can later read the outcome of an approval (the kernel refuses `resultOf` from
 * any other Context, so recording it is a lookup key, not authority).
 */
export interface AppendTicket {
  owner: string;
  device: string;
  cliKind: ScanSource;
  sessionId: string;
  operation: "append_session" | "resume_session" | "takeover_session" | "fallback_session" | "interrupt_session";
  fingerprint: string;
  contextId: string;
  args: Record<string, unknown>;
  /** Interrupt deliberately bypasses the writer lease it is stopping. */
  lease?: LeaseHandle;
  grant: RunnerGrant;
}

export interface AppendHooks {
  /** The call reached the device rather than an approval card. */
  onDispatched?(contextId: string): void;
  /** A PendingCall was created; the lease is now held across the decision. */
  onPending?(pendingCallId: string, contextId: string): void;
}

export type AppendOutcome =
  | { ok: true; result: unknown; newSessionId?: string; durationMs?: number }
  | {
      ok: false;
      status: number;
      error: string;
      pendingCallId?: string;
      approvalRequired?: boolean;
      /** The frame left the process and the outcome cannot be determined. */
      indeterminate?: boolean;
    };

/**
 * Did this request reach the adapter, rather than stopping at an approval card?
 *
 * The gate decides "a human must see this" before anything is dispatched, and
 * that decision path contains no I/O to wait on (the kernel's store is
 * synchronous), so it settles in microtasks. A request still unsettled on the
 * next macrotask is therefore one the adapter already has.
 *
 * This is a REPORTING signal and nothing else depends on it: the durable
 * transitions all come from the resolved result, so being wrong here can only
 * make a chip say "running" a moment before it says "waiting for approval". It
 * is pinned by tests in both directions rather than left as a comment.
 */
export interface SessionHubOptions {
  store: Store;
  permissions: PermissionService;
  /** Laptop Runners. Absent = this deployment has no devices. */
  caps?: RunnerCapabilities;
  /** The bot host's own scan home. Absent = this deployment scans nothing locally. */
  local?: LocalScanCapabilities;
  /** Provider-originated questions/approvals; separate from session append authority. */
  agentInteractions?: AgentInteractionCapabilities;
  now?: () => number;
  /** How long a resource call may take before it is reported as a failure. */
  runnerTimeoutMs?: number;
}

const DEFAULT_RUNNER_TIMEOUT_MS = 300_000;

export class SessionHubService {
  readonly leases: SessionLeases;
  private nowMs: () => number;

  constructor(private opts: SessionHubOptions) {
    this.nowMs = opts.now ?? Date.now;
    this.leases = new SessionLeases({
      now: this.nowMs,
      // The approval queue is the truth about whether a card is still waiting.
      // Asking it here keeps the lease a VIEW of that truth instead of a second
      // copy that goes stale whenever a card is decided somewhere else.
      pendingIsLive: (pendingCallId, owner) =>
        (opts.caps?.listPending(owner) ?? []).some((p) => p.id === pendingCallId),
    });
    // A revoked grant must not leave a lease claiming the surface still drives
    // that session. The row is already safe by the time this runs; this closes
    // what was open.
    opts.permissions.onRevoked((e) => {
      if (e.subjectId === "session-hub") this.leases.releaseOwner(e.owner);
    });
  }

  /**
   * One browser login (or one device token) has ended. Close everything that
   * was derived FROM it — Contexts on both resources, which takes their
   * undecided approval cards with them, and the leases they were holding.
   *
   * Conservative by design at the edges: it drops this owner's Contexts for
   * that credential only, never another owner's, and never a still-valid
   * login's. What it must guarantee is the direction that matters — after this
   * returns, a replayed approval from the ended login reaches no adapter.
   */
  releaseCredential(owner: string, credential: string): void {
    const prefix = `${credential}/`;
    this.opts.caps?.dropPooled(owner, prefix);
    this.opts.local?.dropPooled(owner, prefix);
    this.leases.releaseCredential(owner, credential);
  }

  /**
   * Everything this account has derived on this surface, whatever login it came
   * from — for a device revocation, where the account root itself is being
   * taken away and there is nothing left for any login to hold.
   */
  releaseOwner(owner: string): void {
    this.opts.caps?.dropPooled(owner);
    this.opts.local?.dropPooled(owner);
    this.leases.releaseOwner(owner);
  }

  // ── identity ──

  /**
   * Which account this request is about, and whether the caller owns it.
   *
   * Owner-bound is the strong form: only it reaches a Runner. An admin looking
   * across accounts gets `owned: false`, which means bot-host material only —
   * reading somebody's laptop needs a delegation this product does not have,
   * and the admin bit is not that delegation.
   */
  resolveTarget(principal: HubPrincipal, requested?: string): { owner: string; owned: boolean } {
    const owner = (requested || principal.username || "").trim();
    return { owner, owned: actsFor(principal, owner) };
  }

  /** The permission projection for one owner — what the screen renders. */
  effective(owner: string): EffectiveView {
    return this.opts.permissions.sessionHubEffective(owner);
  }

  permissionsBlock(view: EffectiveView, principal: HubPrincipal): HubPermissionsBlock {
    return {
      requested: view.entries.map((e) => e.operation),
      granted: view.entries.filter((e) => e.granted).map((e) => e.operation),
      effective: effectiveOperations(view),
      autoAllow: autoAllowedOperations(view),
      directSelfAutoAllow: principal.session
        ? view.entries.filter((e) => e.effective && e.directSelfAutoAllow).map((e) => e.operation)
        : [],
      reasons: Object.fromEntries(view.entries.filter((e) => e.reasons.length).map((e) => [e.operation, e.reasons])),
    };
  }

  /**
   * Derive a Context on EACH resource, for exactly the hub operations that are
   * effective right now.
   *
   * Both grants are null — not an exception — when the caller does not own the
   * account, when the grant covers none of the requested operations, or when the
   * account holds no authority. Those are ordinary refusals; the caller's job is
   * to say no, not to find another way in.
   *
   * Each grant is independently null when its resource is absent or holds
   * nothing: no laptop registered, or no scan home configured. A deployment with
   * only one of the two is normal in both directions, which is why this returns
   * a pair rather than a preference.
   *
   * `pool` is `<credential>/<surface>`, and both halves are load-bearing. The
   * SURFACE half is why the kernel's duplicate-approval detection works: it is
   * keyed on the Context, so a re-submitted identical action has to land in the
   * Context that already has a card for it (P1-3). The CREDENTIAL half is why
   * ending one browser login can close exactly that login's Contexts.
   */
  private grantsFor(
    principal: HubPrincipal,
    owner: string,
    hubOperations: readonly string[],
    purpose: string,
    surface: string,
  ): {
    runner: RunnerGrant | null;
    local: LocalScanGrant | null;
    view: EffectiveView;
    allowed: string[];
    owned: boolean;
  } {
    const view = this.effective(owner);
    const allowed = hubOperations.filter((op) => effectiveOperations(view).includes(op));
    const owned = actsFor(principal, owner);
    if (!owned || allowed.length === 0) {
      return { runner: null, local: null, view, allowed, owned };
    }
    if (principal.username !== owner) this.auditActor(owner, allowed, principal.username!, purpose);
    const rights = runnerOperationsFor(allowed);
    // Ordinary unsupervised terms come from the durable grant.  A separately
    // named system-policy exception can add append/resume only for the owner's
    // real browser session.  Bearer scripts see the same effective grant but
    // never receive this conditional term.
    const direct = principal.session
      ? view.entries
          .filter((e) => e.effective && e.directSelfAutoAllow && allowed.includes(e.operation))
          .map((e) => e.operation)
      : [];
    const autoAllow = runnerOperationsFor([
      ...autoAllowedOperations(view).filter((op) => allowed.includes(op)),
      ...direct,
    ]);
    const pool = `${principal.credential}/${surface}`;
    const runner =
      this.opts.caps?.open({
        username: owner,
        purpose,
        kind: "session",
        rights,
        autoAllow,
        pool,
        metadata: { surface: "session-hub" },
      }) ?? null;
    // The bot host declares fewer operations, so asking it for `append_session`
    // is not an error — the kernel intersects and hands back nothing, which is
    // the correct answer for "this session cannot be resumed from here".
    const localRights = rights.filter((r) => LOCAL_SCAN_OPERATION_NAMES.includes(r));
    const local = localRights.length
      ? (this.opts.local?.open({
          username: owner,
          purpose,
          rights: localRights,
          autoAllow: autoAllow.filter((r) => LOCAL_SCAN_OPERATION_NAMES.includes(r)),
          pool,
          metadata: { surface: "session-hub" },
        }) ?? null)
      : null;
    return { runner, local, view, allowed, owned };
  }

  /** The wording a refusal carries, taken from the projection rather than invented. */
  private refusal(view: EffectiveView, operation: string, owned: boolean): HubRefusal {
    if (!owned) {
      return {
        ok: false,
        status: 403,
        error: "会话内容只能由本人或具名管理员读取 — 共享管理密钥不代表任何人。",
      };
    }
    const entry = view.entries.find((e) => e.operation === operation);
    return {
      ok: false,
      status: 403,
      error: entry ? `无法读取：${entry.explanation}` : "会话中心当前没有可用的权限。",
    };
  }

  // ── resource identity ──

  /**
   * A stable, opaque handle for one session. Base64url of the trusted tuple.
   *
   * It is a CONVENIENCE, not a credential: `decodeResourceId` hands back the
   * parts and every caller re-checks the owner against the authenticated
   * principal. Encoding it stops the browser from having to reassemble
   * (device, kind, id) — it does not stop the browser from lying, and nothing
   * downstream assumes it does.
   */
  resourceId(parts: { owner: string; device: string; cliKind: string; sessionId: string }): string {
    return encodeResourceId(parts);
  }

  decodeResourceId(
    raw: string,
  ): { owner: string; device: string; cliKind: ScanSource; sessionId: string } | null {
    return decodeCoreResourceId(raw);
  }

  // ── normalisation ──

  private normalise(raw: Record<string, unknown>, owner: string, fallbackDevice: string): HubSessionSummary {
    const row = normaliseSession(raw, owner, fallbackDevice);
    const displayName = runnerDisplayName(this.opts.store, owner, row.deviceId);
    return displayName ? { ...row, deviceLabel: displayName } : row;
  }

  // ── list ──

  async roster(
    principal: HubPrincipal,
    owner: string,
    args: {
      limit: number; source: string; sinceHours?: number; includeSessionPlus?: boolean; device?: string;
      /**
       * A position in the complete walk: every source pages in the same stable
       * `[source, id]` order (`sessionListCursor`), so one cursor serves every
       * device. Absent keeps the recent-activity page.
       */
      cursor?: string;
    },
  ): Promise<HubRosterView> {
    const history = typeof args.cursor === "string";
    const scanArgs: Record<string, unknown> = { limit: args.limit, source: args.source, ...(history ? { cursor: args.cursor } : {}) };
    if (args.sinceHours) scanArgs.since_hours = args.sinceHours;
    // One named device: only its Runner is asked, or only the bot host's own scan.
    const device = args.device?.trim() || undefined;
    const runnerScanArgs = {
      ...scanArgs,
      ...(args.includeSessionPlus ? { _octopus_include_session_plus: true } : {}),
      ...(device ? { device } : {}),
    };

    const sessions: Array<Record<string, unknown>> = [];
    const sources: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];

    const { runner, local, view, owned, allowed } = this.grantsFor(
      principal,
      owner,
      ["list_sessions"],
      `session-hub-list/${owner}`,
      "list",
    );
    // An empty roster, said out loud. A viewer who may read this account but
    // does not own it gets the projection and no session material — not because
    // the scan came back empty, which is what a silent `[]` would imply.
    if (!owned || allowed.length === 0) {
      runner?.close();
      local?.close();
      if (!owned) this.audit(owner, "list_sessions", "deny", "not_owner");
      return {
        username: owner,
        sources: [],
        returned: 0,
        sessions: [],
        permissions: this.permissionsBlock(view, principal),
        restricted: {
          reason: owned ? "not_granted" : "owner_only",
          explanation: owned
            ? (view.entries.find((e) => e.operation === "list_sessions")?.explanation
              ?? "会话中心当前没有可用的权限。")
            : "会话列表只对本人和具名管理员可见。",
        },
      };
    }

    const online = runner && device !== BOT_HOST_DEVICE && this.opts.caps?.isOnline(owner);
    const runnerP = online
      ? this.withTimeout(runner!.call("list_recent_sessions", runnerScanArgs), "list_recent_sessions")
      : null;
    if (!runnerP) runner?.close();
    const localP = local && (!device || device === BOT_HOST_DEVICE)
      ? this.withTimeout(local.call("list_recent_sessions", scanArgs), "list_recent_sessions") : null;
    // Observe both up front so whichever settles while we await the other
    // cannot fire an unhandledRejection; the awaits below still see the error.
    runnerP?.catch(() => {});
    localP?.catch(() => {});

    // Whether some queried source holds more rows than it returned. A walk page
    // also needs every source's page to be a page of the same walk.
    let sourceHasMore = false;
    let historyUnsupported = false;
    const observe = (r: { sessions?: unknown[]; total_found?: unknown; has_more?: unknown; history_supported?: unknown }): void => {
      const returned = r.sessions?.length ?? 0;
      if (history) {
        sourceHasMore ||= r.has_more === true;
        historyUnsupported ||= r.history_supported === false || typeof r.has_more !== "boolean";
      } else {
        sourceHasMore ||= typeof r.total_found === "number" ? r.total_found > returned : returned >= args.limit;
      }
    };

    if (runnerP) {
      try {
        const r = (await runnerP) as { devices?: string[]; sessions?: Array<Record<string, unknown>> };
        for (const d of r.devices ?? []) sources.push({ device: d, kind: "runner", online: true });
        sessions.push(...(r.sessions ?? []));
        observe(r);
        this.audit(owner, "list_sessions", "allow");
      } catch (err) {
        errors.push({ device: "(runner)", error: message(err) });
        this.audit(owner, "list_sessions", "error", message(err));
      } finally {
        runner?.close();
      }
    } else if (runner) {
      runner.close();
    }
    if (localP) {
      // No `home` here: it is an absolute path on the bot host, and the page
      // renders only `kind` and `device`. A field nobody displays and everybody
      // receives is the shape of leak this service exists to stop.
      sources.push({ device: BOT_HOST_DEVICE, kind: "local" });
      try {
        const r = (await localP) as { sessions?: Array<Record<string, unknown>> };
        sessions.push(...(r.sessions ?? []).map((s) => ({ ...s, device: BOT_HOST_DEVICE })));
        observe(r);
      } catch (err) {
        errors.push({ device: BOT_HOST_DEVICE, error: message(err) });
      } finally {
        local?.close();
      }
    } else {
      local?.close();
    }

    const merged = dedupeSessions(sessions.map((s) => this.normalise(s, owner, BOT_HOST_DEVICE)));
    if (history) {
      // A page with a source missing or ignoring the cursor would advance the
      // walk past rows nobody returned. Refuse it; the same cursor retries.
      if (errors.length) {
        throw new Error(`部分会话来源读取失败，未推进翻页位置；请用同一 cursor 重试（${errors.map((row) => `${String(row.device)}: ${String(row.error)}`).join("；")}）`);
      }
      if (historyUnsupported) throw new Error("有设备的 Runner 尚不支持完整会话分页，未推进翻页位置；请更新 Runner 后用同一 cursor 重试");
      const page = sessionHistoryPage(merged, (row) => sessionListCursor({ source: row.cliKind, id: row.sessionId }),
        args.limit, sourceHasMore);
      return {
        username: owner,
        sources,
        returned: page.sessions.length,
        sessions: page.sessions,
        permissions: this.permissionsBlock(view, principal),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
    merged.sort((a, b) => (String(b.lastActivity ?? "") < String(a.lastActivity ?? "") ? -1 : 1));

    // The recent page is a window over activity order. When it may not hold
    // every session (a source had more, or did not answer), the complete walk
    // starts from the beginning of the stable order; it may repeat rows this
    // page already showed.
    const incomplete = sourceHasMore || merged.length > args.limit || errors.length > 0;
    return {
      username: owner,
      sources,
      returned: Math.min(merged.length, args.limit),
      sessions: merged.slice(0, args.limit),
      errors: errors.length ? errors : undefined,
      permissions: this.permissionsBlock(view, principal),
      ...(incomplete ? { nextCursor: SESSION_LIST_START_CURSOR } : {}),
    };
  }

  // ── read ──

  async read(
    principal: HubPrincipal,
    owner: string,
    device: string,
    args: Record<string, unknown>,
  ): Promise<HubResult<{ data: Record<string, unknown> }>> {
    const { runner, local, view, owned, allowed } = this.grantsFor(
      principal,
      owner,
      ["read_session"],
      `session-hub-read/${owner}`,
      "read",
    );
    if (!owned || allowed.length === 0) {
      runner?.close();
      local?.close();
      this.audit(owner, "read_session", "deny", owned ? "not_granted" : "not_owner", String(args.id ?? ""));
      return this.refusal(view, "read_session", owned);
    }
    const viaLocal = async (): Promise<HubResult<{ data: Record<string, unknown> }>> => {
      if (!local) {
        return { ok: false, status: 404, error: "该用户在 bot 主机上没有可扫描的会话目录" };
      }
      try {
        const localArgs = { ...args };
        delete localArgs._octopus_include_session_plus;
        const r = (await this.withTimeout(local.call("read_session", localArgs), "read_session")) as Record<string, unknown>;
        this.audit(owner, "read_session", "allow", BOT_HOST_DEVICE, String(args.id ?? ""));
        return { ok: true, data: { ...stripSessionPath(r), device: BOT_HOST_DEVICE } };
      } catch (err) {
        this.audit(owner, "read_session", "error", message(err), String(args.id ?? ""));
        return { ok: false, status: 502, error: message(err) };
      }
    };
    try {
      if (device === BOT_HOST_DEVICE) return await viaLocal();
      if (runner && this.opts.caps?.isOnline(owner)) {
        try {
          // The handle names its device: ask that Runner, not each of the owner's devices in turn.
          const pinned = device && args.device === undefined ? { ...args, device } : args;
          const r = (await this.withTimeout(runner.call("read_session", pinned), "read_session")) as Record<
            string,
            unknown
          >;
          this.audit(owner, "read_session", "allow", device, String(args.id ?? ""));
          return { ok: true, data: { ...stripSessionPath(r), device: device || undefined } };
        } catch (err) {
          this.audit(owner, "read_session", "error", message(err), String(args.id ?? ""));
          // A fallback between two READ sources the caller HOLDS A GRANT FOR —
          // never a fallback around the gate. `local` is null unless the same
          // computation that authorised the Runner call authorised this one, so
          // a denied capability cannot reach the local branch through here.
          if (local) return await viaLocal();
          return { ok: false, status: 502, error: message(err) };
        }
      }
      return await viaLocal();
    } finally {
      runner?.close();
      local?.close();
    }
  }

  // ── search ──

  async search(
    principal: HubPrincipal,
    owner: string,
    query: string,
    args: Record<string, unknown>,
  ): Promise<HubResult<{ data: Record<string, unknown> }>> {
    const parts: SearchPagePart[] = [];
    const errors: Array<Record<string, unknown>> = [];

    const { runner, local, view, owned, allowed } = this.grantsFor(
      principal,
      owner,
      ["search_sessions"],
      `session-hub-search/${owner}`,
      "search",
    );
    // A search hit carries the matching text, so this is a transcript read with
    // a filter on it and is refused on exactly the same terms.
    if (!owned || allowed.length === 0) {
      runner?.close();
      local?.close();
      this.audit(owner, "search_sessions", "deny", owned ? "not_granted" : "not_owner");
      return this.refusal(view, "search_sessions", owned);
    }
    if (runner && this.opts.caps?.isOnline(owner)) {
      try {
        parts.push({ label: "(runner)", page: await this.withTimeout(runner.call("search_sessions", { ...args, query }), "search_sessions") });
        this.audit(owner, "search_sessions", "allow");
      } catch (err) {
        parts.push({ label: "(runner)" });
        errors.push({ device: "(runner)", error: message(err) });
        this.audit(owner, "search_sessions", "error", message(err));
      } finally {
        runner.close();
      }
    } else {
      runner?.close();
    }
    if (local) {
      try {
        const localArgs: Record<string, unknown> = { ...args, query };
        delete localArgs._octopus_include_session_plus;
        const page = await this.withTimeout(local.call("search_sessions", localArgs), "search_sessions");
        const value = page && typeof page === "object" ? page as Record<string, unknown> : {};
        parts.push({
          label: BOT_HOST_DEVICE,
          page: {
            ...value,
            results: (Array.isArray(value.results) ? value.results as Array<Record<string, unknown>> : [])
              .map((item) => ({ ...item, session: { ...(item.session as Record<string, unknown> ?? {}), device: BOT_HOST_DEVICE } })),
          },
        });
      } catch (err) {
        parts.push({ label: BOT_HOST_DEVICE });
        errors.push({ device: BOT_HOST_DEVICE, error: message(err) });
      } finally {
        local.close();
      }
    }

    // One page of a complete search over both planes (plugins/sessions search.ts).
    const limit = Math.max(1, Math.min(SEARCH_PAGE_MAX, Number(args.limit ?? 15) || 15));
    const page = mergeSearchPages(parts, limit, typeof args.cursor === "string" && args.cursor !== "");
    // Same rule as the roster, applied to the `session` inside each hit.
    const byResource = new Map<string, Record<string, unknown>>();
    for (const item of page.results) {
      const normalised = this.normalise((item.session ?? {}) as Record<string, unknown>, owner, BOT_HOST_DEVICE);
      if (!byResource.has(normalised.resourceId)) byResource.set(normalised.resourceId, { ...item, session: normalised });
    }
    const merged = dedupeSessions([...byResource.values()].map((i) => i.session as HubSessionSummary)).map(
      (s) => byResource.get(s.resourceId)!,
    );
    return {
      ok: true,
      data: {
        username: owner,
        query,
        scanned: page.scanned,
        returned: merged.length,
        results: merged,
        complete: page.complete,
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        ...(page.incomplete_sources ? { incomplete_sources: page.incomplete_sources } : {}),
        errors: errors.length ? errors : undefined,
        permissions: this.permissionsBlock(view, principal),
      },
    };
  }

  // ── live ──

  /**
   * The capability half of a live subscription. The transport owns the SSE
   * plumbing; what it must not own is the decision, or the lifetime.
   *
   * Returns exactly ONE grant — the resource the stream will poll — or a
   * refusal. That shape matters: the previous version returned a Runner grant
   * plus a `useLocal` flag and a home path, and the caller could (and did) open
   * a local tail with no grant at all when the flag was set. A tail is a
   * repeated read; it needs the same authority a single read needs.
   *
   * The grant is closed by the caller when the stream ends — `res.on("close")`
   * — so a stream cannot outlive its authority: destroying the Context (a
   * revocation, a logout, a removed device) makes the next poll deny, and the
   * transport separately ENDS the stream so a dead page does not keep looking
   * connected.
   */
  liveGrant(
    principal: HubPrincipal,
    owner: string,
    device: string,
  ): HubResult<{ grant: RunnerGrant | LocalScanGrant; local: boolean }> {
    const { runner, local, view, owned, allowed } = this.grantsFor(
      principal,
      owner,
      ["live_session"],
      `session-hub-live/${owner}`,
      "live",
    );
    if (!owned || allowed.length === 0) {
      runner?.close();
      local?.close();
      this.audit(owner, "live_session", "deny", owned ? "not_granted" : "not_owner");
      return this.refusal(view, "live_session", owned);
    }
    const useLocal = device === BOT_HOST_DEVICE || !runner || !this.opts.caps?.isOnline(owner);
    if (useLocal) {
      runner?.close();
      if (!local) {
        return { ok: false, status: 404, error: "该用户在 bot 主机上没有可扫描的会话目录" };
      }
      this.audit(owner, "live_session", "allow", BOT_HOST_DEVICE);
      return { ok: true, grant: local, local: true };
    }
    local?.close();
    this.audit(owner, "live_session", "allow", device);
    return { ok: true, grant: runner!, local: false };
  }

  // ── append / resume ──

  async respondInteraction(
    principal: HubPrincipal,
    input: {
      owner: string;
      device: string;
      provider: string;
      sessionId: string;
      interactionId: string;
      responseJson: string;
    },
  ): Promise<HubResult<{ data: unknown }>> {
    if (!principal.session || !actsFor(principal, input.owner)) {
      return { ok: false, status: 403, error: "回答 Agent 请求只允许本人或管理员当前的网页登录操作" };
    }
    if (principal.username !== input.owner) {
      this.auditActor(input.owner, ["respond_interaction"], principal.username!, "session-hub interaction");
    }
    if (!input.device || input.device === BOT_HOST_DEVICE) {
      return { ok: false, status: 400, error: "这个会话没有可响应的 Runner 设备" };
    }
    if (
      !SESSION_CLI_KINDS.includes(input.provider as ScanSource)
      || !input.sessionId || !input.interactionId || !input.responseJson
    ) return { ok: false, status: 400, error: "Agent 请求目标或响应无效" };
    const grant = this.opts.agentInteractions?.openHumanResponse(
      input.owner,
      `session-hub interaction/${input.owner}`,
    );
    if (!grant) return { ok: false, status: 503, error: "Agent 交互能力当前不可用或设备已离线" };
    try {
      const outcome = await grant.request(RESPOND_AGENT_INTERACTION, {
        device: input.device,
        provider: input.provider,
        session_id: input.sessionId,
        interaction_id: input.interactionId,
        response_json: input.responseJson,
      });
      if (outcome.status === "succeeded") return { ok: true, data: outcome.result };
      if (outcome.status === "approval_required") {
        return { ok: false, status: 502, error: "Agent 回答不应产生第二层通用审批" };
      }
      return {
        ok: false,
        status: outcome.status === "denied" ? 403 : outcome.status === "unknown" ? 504 : 502,
        error: outcome.reason,
      };
    } catch (error) {
      return { ok: false, status: 502, error: error instanceof Error ? error.message : String(error) };
    } finally {
      grant.close();
    }
  }

  /**
   * Everything that has to be true before a submission becomes an operation:
   * ownership, a runnable target, the single-writer lease, and a capability
   * grant that actually covers this operation.
   *
   * Split out of `append` because a durable operation record must not exist for
   * a request that was refused — "there is a row saying you asked" and "you were
   * told no" are different facts, and a refusal is not a lifecycle. Every
   * refusal below is decided BEFORE anything is dispatched, so the caller can
   * treat this as the fast half and `runAppend` as the slow one.
   *
   * Holding a ticket means holding a lease and an open grant. `runAppend`
   * releases both; a caller that abandons a ticket must call `discardAppend`.
   */
  prepareAppend(
    principal: HubPrincipal,
    o: {
      owner: string;
      device: string;
      sessionId: string;
      prompt?: string;
      source?: string;
      operation?: "append_session" | "resume_session" | "takeover_session" | "fallback_session" | "interrupt_session";
    },
  ): { ok: true; ticket: AppendTicket } | { ok: false; status: number; error: string; pendingCallId?: string } {
    const operation = o.operation === "resume_session"
      ? "resume_session"
      : o.operation === "takeover_session"
        ? "takeover_session"
        : o.operation === "fallback_session"
          ? "fallback_session"
          : o.operation === "interrupt_session"
            ? "interrupt_session"
            : "append_session";
    if (!actsFor(principal, o.owner)) {
      // The owner, or a named administrator (2026-10-15 owner decision): append
      // spends the target user's own CLI quota on the target user's machine,
      // so nobody else reaches it.
      return { ok: false, status: 403, error: "append 仅限本人或管理员操作 — 请用自己的 /dashboard 链接登录" };
    }
    if (!o.sessionId || (operation !== "interrupt_session" && !o.prompt)) {
      return { ok: false, status: 400, error: operation === "interrupt_session" ? "id is required" : "id and prompt are required" };
    }
    if (!o.device || o.device === BOT_HOST_DEVICE) {
      return {
        ok: false,
        status: 400,
        error:
          "bot 主机上的会话是只读的 — 要追加指令,请在那台机器上跑一个章鱼端点(octopus endpoint),对该设备上的会话操作",
      };
    }

    const cliKind = SESSION_CLI_KINDS.includes(o.source as ScanSource) ? o.source as ScanSource : "claude";
    if (operation === "fallback_session" && cliKind !== "codex") {
      return { ok: false, status: 400, error: "备用账号切换只支持 Codex 会话" };
    }
    // Everything that makes two attempts the SAME intent. It mirrors what the
    // kernel hashes, which is why an identical re-submission joins the card
    // that already exists instead of being told the session is busy.
    const fingerprint = appendFingerprint(operation, o.source, o.prompt ?? "");
    let lease: LeaseHandle | undefined;
    if (operation !== "interrupt_session") {
      const taken = this.leases.acquire(
        { owner: o.owner, device: o.device, cliKind, sessionId: o.sessionId },
        `${operation} · ${o.owner}`,
        fingerprint,
        principal.credential,
      );
      if (!taken.ok) {
        this.audit(o.owner, operation, "deny", "busy", o.sessionId);
        return { ok: false, status: 409, error: taken.message, pendingCallId: taken.pendingCallId };
      }
      lease = taken.lease;
    }

    // Takeover and fallback are distinct, explicit UI/audit intents. Neither
    // mints a new persistent permission: remote execution is still one bounded
    // append_session call, with the chosen intent frozen into the call args.
    const gateOperation = operation === "takeover_session"
      || operation === "fallback_session"
      || operation === "interrupt_session"
      ? "append_session"
      : operation;
    const { runner: grant, view } = this.grantsFor(
      principal,
      o.owner,
      [gateOperation],
      `session-hub-${operation}/${o.owner}`,
      "append",
    );
    if (!grant) {
      if (lease) this.leases.release(lease);
      // 503 and 403 are different answers and callers act on them differently:
      // "the capability service is not running here" is an operational fact
      // the user can do nothing about, while "your grant does not cover this"
      // has a button on the permissions page. Collapsing them into one status
      // sends people to fix the wrong thing.
      if (!this.opts.caps) {
        this.audit(o.owner, operation, "error", "capability service disabled", o.sessionId);
        return { ok: false, status: 503, error: "章鱼端点能力服务未启用,或你没有该设备的权限" };
      }
      const entry = view.entries.find((e) => e.operation === gateOperation);
      this.audit(o.owner, operation, "deny", entry?.reasons.join(",") ?? "no grant", o.sessionId);
      return {
        ok: false,
        status: 403,
        error: entry ? `无法续跑：${entry.explanation}` : "章鱼端点能力服务未启用,或你没有该设备的权限",
      };
    }

    const args: Record<string, unknown> = { device: o.device, id: o.sessionId };
    if (SESSION_CLI_KINDS.includes(o.source as ScanSource)) args.source = o.source;
    if (operation === "interrupt_session") args.interrupt = true;
    else {
      args.prompt = o.prompt;
      if (operation === "takeover_session") args.takeover = true;
      if (operation === "fallback_session") args.account_fallback = true;
    }
    return {
      ok: true,
      ticket: {
        owner: o.owner,
        device: o.device,
        cliKind,
        sessionId: o.sessionId,
        operation,
        fingerprint,
        contextId: String(grant.contextId),
        args,
        ...(lease ? { lease } : {}),
        grant,
      },
    };
  }

  /** Give back a prepared ticket nobody is going to run. */
  discardAppend(ticket: AppendTicket): void {
    if (ticket.lease) this.leases.release(ticket.lease);
    ticket.grant.close();
  }

  /**
   * Drive one more turn on an existing session.
   *
   * `operation` distinguishes append from resume. They execute through the same
   * Runner call, and that is stated rather than hidden: what differs is the
   * authorisation and the audit identity, which is precisely what the execution
   * plan permits.
   *
   * The approval binds owner, device, CLI kind, session id, the prompt and the
   * operation, because all of them are inside the args the kernel hashes.
   * Changing any one produces a different hash and therefore a different card —
   * an approval cannot be moved onto another call.
   *
   * `hooks.onDispatched` fires when the call reached the adapter rather than a
   * human. It is a REPORTING signal, not an authorisation one: see
   * `dispatchObserved` for why "not settled on the next macrotask" is the honest
   * way to observe it, and why nothing downstream depends on getting it right.
   */
  async runAppend(ticket: AppendTicket, hooks?: AppendHooks): Promise<AppendOutcome> {
    const { owner, operation, sessionId, lease, grant } = ticket;
    let dispatched = false;
    const t0 = this.nowMs();
    try {
      const call = grant.request("append_session", ticket.args);
      dispatched = await dispatchObserved(call);
      if (dispatched) {
        // Once a conversational append has crossed the Gate, the Runner's
        // provider-native attachment owns ordering/steering. Keeping the bot
        // lease until the whole turn finishes would incorrectly reduce that
        // multi-message transport to one prompt at a time. Takeover/fallback
        // remain exclusive because they can replace ownership or fork state.
        if (lease && (operation === "append_session" || operation === "resume_session")) {
          this.leases.handoff(lease);
        }
        hooks?.onDispatched?.(ticket.contextId);
      }
      const out = await call;
      if (out.status === "approval_required") {
        // Keep the lease across the decision: the gap between "card created"
        // and "card pressed" is minutes long, and it is exactly where a second
        // tab would otherwise queue a second turn.
        if (lease) this.leases.bindPending(lease, out.pendingCallId);
        this.audit(owner, operation, "pending", out.pendingCallId, sessionId);
        hooks?.onPending?.(out.pendingCallId, ticket.contextId);
        return {
          ok: false,
          status: 202,
          approvalRequired: true,
          pendingCallId: out.pendingCallId,
          error: "续跑会在你批准之后才真正执行 — 请到「待批准」页确认这条指令。",
        };
      }
      if (lease) this.leases.release(lease);
      if (out.status !== "succeeded") {
        this.audit(owner, operation, "deny", out.reason, sessionId);
        // `unknown` is its own answer all the way up: the frame left the
        // process and nothing may replay it on the caller's behalf.
        return {
          ok: false,
          status: out.status === "denied" ? 403 : out.status === "unknown" ? 504 : 502,
          error: out.reason,
          indeterminate: out.status === "unknown",
        };
      }
      const result = (out.result ?? null) as Record<string, unknown> | null;
      const newSessionId = result && typeof result.new_session_id === "string" ? result.new_session_id : undefined;
      this.audit(owner, operation, "result", `${this.nowMs() - t0}ms`, sessionId);
      return { ok: true, result, newSessionId, durationMs: this.nowMs() - t0 };
    } catch (err) {
      if (lease) this.leases.release(lease);
      this.audit(owner, operation, "error", message(err), sessionId);
      log.warn({ owner, device: ticket.device, err: message(err) }, "session hub append failed");
      return { ok: false, status: dispatched ? 504 : 502, error: message(err), ...(dispatched ? { indeterminate: true } : {}) };
    } finally {
      grant.close();
    }
  }

  /**
   * Prepare and run in one call — the shape that existed before submissions
   * became durable operations. Kept because "one submission, start to finish"
   * is still the right API for a caller that has nothing to report progress to.
   */
  async append(
    principal: HubPrincipal,
    o: {
      owner: string;
      device: string;
      sessionId: string;
      prompt?: string;
      source?: string;
      operation?: "append_session" | "resume_session" | "takeover_session" | "fallback_session" | "interrupt_session";
    },
  ): Promise<AppendOutcome> {
    const prepared = this.prepareAppend(principal, o);
    if (!prepared.ok) {
      return { ok: false, status: prepared.status, error: prepared.error, pendingCallId: prepared.pendingCallId };
    }
    return await this.runAppend(prepared.ticket);
  }

  /**
   * An approval was decided (either way) or expired: the session is free.
   * Called by the transport's approve/reject route.
   */
  releasePendingLease(pendingCallId: string): void {
    this.leases.releaseByPending(pendingCallId);
  }

  // ── helpers ──

  /**
   * A Runner fan-out that never answers must not hold an HTTP request open
   * forever. The timeout is a REPORT, not a cancellation: the frame already
   * left, so the honest answer is "we stopped waiting", not "it did not run".
   */
  private async withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
    const ms = this.opts.runnerTimeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
    return await withTimeout(p, what, ms);
  }

  /** The account's own activity record names the administrator acting on it. */
  private auditActor(owner: string, operations: readonly string[], actor: string, purpose: string): void {
    this.opts.permissions.audit({
      owner,
      subjectType: "service",
      subjectId: "session-hub",
      operation: operations.join(","),
      decision: "admin_access",
      reason: purpose,
      detail: JSON.stringify({ by: actor }),
    });
  }

  private audit(owner: string, operation: string, decision: string, reason?: string, resource?: string): void {
    this.opts.permissions.audit({
      owner,
      subjectType: "service",
      subjectId: "session-hub",
      operation,
      resource: resource ? `session:${resource.slice(0, 64)}` : "",
      decision,
      reason: reason ?? null,
      detail: sessionHubOperation(operation)?.risk ?? null,
    });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The account's owner, or a named administrator. The shared key names nobody. */
function actsFor(principal: HubPrincipal, owner: string): boolean {
  return Boolean(principal.username) && (principal.username === owner || principal.admin);
}
