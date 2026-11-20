/**
 * The bot host's own scan home, as a capability resource.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * The Session Hub has two places a session can live: a laptop Runner, and the
 * home directory the bot host can read itself (`scan_homes`). The Runner side
 * went through the kernel from the first commit. The bot-host side did not — it
 * called `scanListSessions(home, args)` directly, with `home` chosen by a
 * server-side config function.
 *
 * That looked safe because the home was not attacker-chosen, and it was not:
 * two different things were wrong with it.
 *
 *  1. **It answered for a viewer who was not the owner.** The panel's read
 *     predicate lets an admin read across accounts, so `scanHomeFor(alice)`
 *     returned Alice's home to an admin session and the roster, the search hits
 *     and the whole transcript came back. Nothing in the product had decided
 *     that; it fell out of "the local branch has no owner check because the
 *     Runner branch has one".
 *  2. **It survived revocation.** `PermissionService.revoke()` makes the next
 *     `effectiveFor()` empty, which stops the Runner call being derived — and
 *     had no effect whatsoever on a direct filesystem read. So "撤销" closed
 *     one of the two sources and the page carried on working.
 *
 * The fix is not another boolean next to the first one. It is to say that the
 * bot host's scan home IS a resource, with an owner, an operation table, a
 * policy and a revocable root — so that both sources answer to the SAME gate and
 * "who may read this" is a question with one implementation.
 *
 * ── What it deliberately is not ────────────────────────────────────────────
 *
 * It is not the Runner Object with a different device name. The two have
 * different trusted preconditions (a registered device vs. a configured scan
 * home), different operation tables (nothing here can be appended to — the bot
 * host has no CLI to drive), and different failure meanings. Merging them would
 * make "this account has no laptop" and "this deployment scans no local home"
 * the same sentence, and they are not.
 * The one mutation declared here writes a bounded temporary attachment on this
 * same bot host for a session the root already identifies; it does not drive a
 * CLI or make an arbitrary path writable.
 *
 * It is also not a second authorisation system: `permissions/catalog.ts` maps a
 * hub operation onto ONE underlying operation name, and this table uses those
 * same names on purpose, so `read_session` means the same thing on both sides
 * and the projection needs no per-resource branch.
 */

import { CapabilityService, type ContextId, type ObjectDefinition, type Operation, type OperationSpec, type PolicyDecision, type PolicyInput } from "@claude-bot/capability-kernel";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { SessionAttachmentStore, sessionAttachmentWorkspace } from "@claude-bot/runner/session-attachments";
import {
  listRecentSessions as scanListSessions,
  readSession as scanReadSession,
  searchSessions as scanSearchSessions,
} from "@claude-bot/plugin-sessions/scan";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { sessionAttachmentOperation } from "../runner/session-attachment-operation.js";
import { createLogger } from "../logger.js";

const log = createLogger("bot-host-scan");

/** The Context-local slot every bot-host grant is installed under. */
export const LOCAL_SCAN_SLOT = "bot-host";

/**
 * The closed operation table for one user's scan home.
 *
 * Reads inspect the configured home. The only write is a bounded temporary
 * attachment for a session on this host; there is still no CLI process here to
 * drive, so `append_session` remains absent and `resumable: false` stays true.
 *
 * `path` is absent from `read_session` ON PURPOSE. The scan layer accepts an
 * explicit path (jailed to the scan root) because the secretary's MCP surface
 * needs it; nothing that starts in a browser should be able to name a file, and
 * the kernel rejects arguments a schema does not declare — so here the field
 * does not exist rather than being filtered somewhere.
 */
export const LOCAL_SCAN_OPERATIONS: Record<Operation, OperationSpec> = {
  list_recent_sessions: {
    args: {
      cursor: { type: "string", maxLength: 1024 },
      primary_window: { type: "boolean" },
      source: { type: "string", enum: ["claude", "codex", "omp", "all"] },
      limit: { type: "number", min: 1, max: 500, integer: true },
      since_hours: { type: "number", min: 0, max: 24 * 365 },
    },
    effect: "read",
    title: "列出 bot 主机上的会话",
  },
  search_sessions: {
    args: {
      query: { type: "string", required: true, maxLength: 512 },
      source: { type: "string", enum: ["claude", "codex", "omp", "all"] },
      limit: { type: "number", min: 1, max: 50, integer: true },
      since_hours: { type: "number", min: 0, max: 24 * 365 },
      cursor: { type: "string", maxLength: 1024 },
    },
    effect: "read",
    title: "搜索 bot 主机上的会话",
  },
  read_session: {
    args: {
      source: { type: "string", enum: ["claude", "codex", "omp"] },
      id: { type: "string", required: true, maxLength: MACHINE_LIMITS.sessionIdMaxBytes },
      max_messages: { type: "number", min: 1, max: 500, integer: true },
      // Positions in a transcript of any length: windows are bounded, totals are not.
      offset: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
      before: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
      // One complete block of the message at `offset`, one character window at a time.
      block: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
      field: { type: "string", enum: ["text", "input", "output"] },
      char_offset: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
      rich: { type: "boolean" },
      tool_detail: { type: "boolean" },
    },
    effect: "read",
    title: "读取 bot 主机上的会话",
  },
  upload_session_file: sessionAttachmentOperation(),
};

/** Every operation this resource can back. Used by the permission projection. */
export const LOCAL_SCAN_OPERATION_NAMES: readonly string[] = Object.keys(LOCAL_SCAN_OPERATIONS);

interface LocalScanBinding {
  /** Fixed at registration from the trusted user row. Never from arguments. */
  owner: string;
  /**
   * Resolved at CALL time rather than captured, so a configuration change is
   * not silently ignored by an Object that was registered before it. The
   * closure is held only by the kernel's registry; no caller can reach it.
   */
  resolveHome: () => string | undefined;
  /** Joins only the device-local work after every caller crossed its own Gate. */
  rosterReads: LocalRosterReadCoordinator;
  /** Writes only random files below the bot host's OS-managed temporary root. */
  sessionAttachments: SessionAttachmentStore;
}

type ListRecentSessions = (home: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Process-local, completed-value-free coordination for the bot-host scanner.
 *
 * This object is held by one `LocalScanCapabilities` composition. The
 * capability adapter is entered only after policy/Gate, so joining here shares
 * filesystem facts without sharing a caller's authority or audit decision.
 */
class LocalRosterReadCoordinator {
  private readonly flights = new Map<string, Promise<unknown>>();

  constructor(private readonly read: ListRecentSessions) {}

  async list(owner: string, home: string, raw: Readonly<Record<string, unknown>>): Promise<unknown> {
    const args = normalizedRosterArgs(raw);
    const key = JSON.stringify([owner, home, args.source, args.limit, args.since_hours ?? null, args.cursor ?? null, args.primary_window === true]);
    let flight = this.flights.get(key);
    if (!flight) {
      let started!: Promise<unknown>;
      started = Promise.resolve()
        .then(() => this.read(home, args))
        .finally(() => {
          if (this.flights.get(key) === started) this.flights.delete(key);
        });
      flight = started;
      this.flights.set(key, flight);
    }
    return await flight;
  }
}

function normalizedRosterArgs(raw: Readonly<Record<string, unknown>>): Record<string, unknown> & {
  source: "claude" | "codex" | "omp" | "all";
  limit: number;
  since_hours?: number;
} {
  const source = raw.source === "claude" || raw.source === "codex" || raw.source === "omp" ? raw.source : "all";
  const limit = Math.max(1, Math.min(500, Number(raw.limit ?? 20) || 20));
  const since = raw.since_hours == null ? undefined : Number(raw.since_hours);
  return {
    source,
    limit,
    ...(since !== undefined && Number.isFinite(since) ? { since_hours: since } : {}),
    ...(typeof raw.cursor === "string" ? { cursor: raw.cursor } : {}),
    ...(raw.primary_window === true ? { primary_window: true } : {}),
  };
}

/**
 * Mandatory policy. Same three decisions, in the same order, as the Runner
 * Object's — evidence of an approval for exactly this call, then the grant's own
 * terms, then ask the owner. It is written out rather than shared because a
 * policy that took a parameter would be a policy with a branch, and the point of
 * a mandatory policy is that reading it tells you what it does.
 */
function localScanPolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "bot-host scan object has no bound owner" };

  const a = input.approval;
  if (
    a
    && a.objectId === input.object.id
    && a.operation === input.operation
    && a.argsHash === input.argsHash
    && a.contextId === input.context.id
    && a.slot === input.slot
    && a.approver === owner
  ) {
    return { kind: "allow" };
  }

  if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };

  const details = [
    `会话：${String(input.args.id ?? input.args.query ?? "(全部)").slice(0, 64)}`,
    `动作类别：${input.effect}`,
    `发起方：${input.context.metadata.purpose ?? input.context.kind}`,
    `参数指纹：${input.argsHash.slice(0, 16)}`,
  ];
  return {
    kind: "approval_required",
    summary: {
      title: `${input.spec.title ?? input.operation} · ${owner}/bot 主机`,
      target: `${owner}/bot-host`,
      details,
      allowedApprover: owner,
    },
  };
}

async function localScanAdapter(
  binding: LocalScanBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const home = binding.resolveHome();
  // Not an authorisation failure — the gate already said yes. This is the
  // deployment having no local source, which is an ordinary operational fact.
  if (!home) throw new Error("该用户在 bot 主机上没有可扫描的会话目录");
  const a = { ...args };
  switch (operation) {
    case "list_recent_sessions":
      return await binding.rosterReads.list(binding.owner, home, a);
    case "search_sessions":
      return await scanSearchSessions(home, a);
    case "read_session":
      return await scanReadSession(home, a);
    case "upload_session_file":
      // Owner comes from the root binding, never the View. Keep multipart ids
      // scoped even though this one process serves more than one account.
      return await binding.sessionAttachments.accept(a, binding.owner, await sessionAttachmentWorkspace(home, a));
    default:
      // Unreachable: the registry rejects operations it does not declare. Kept
      // because "unreachable" and "silently does something else" are one edit
      // apart in a switch.
      throw new Error(`unsupported bot-host operation: ${operation}`);
  }
}

/** A narrow authority over one account's bot-host scan home. */
export class LocalScanGrant extends SlotGrant {
  constructor(svc: CapabilityService, contextId: ContextId, purpose: string, owner: string, borrowed = false) {
    super(svc, contextId, LOCAL_SCAN_SLOT, purpose, owner, borrowed);
  }
}

export interface LocalScanCapabilitiesOptions {
  /**
   * The process's capability service. Shared with `RunnerCapabilities` when
   * there is one — a Context minted by one service means nothing to another, and
   * the SQLite store takes a single-writer lease. When the Runner is disabled
   * this is the only kernel in the process, which is the bot-host-only
   * deployment and a perfectly ordinary configuration.
   */
  service: CapabilityService;
  /** The trusted user directory. An account that does not exist holds nothing. */
  userExists: (username: string) => boolean;
  /** Server-side config: which home, if any, may be scanned for this user. */
  scanHomeFor?: (username: string) => string | undefined;
  now?: () => number;
  /** @internal Deterministic scanner seam; production uses plugin-sessions. */
  listRecentSessions?: ListRecentSessions;
  /** @internal Multipart writer seam; production uses the bot host's temp directory. */
  sessionAttachments?: SessionAttachmentStore;
}

export class LocalScanCapabilities {
  private authority: AccountAuthority<LocalScanBinding>;
  private readonly rosterReads: LocalRosterReadCoordinator;
  private readonly sessionAttachments: SessionAttachmentStore;

  constructor(private opts: LocalScanCapabilitiesOptions) {
    this.rosterReads = new LocalRosterReadCoordinator(opts.listRecentSessions ?? scanListSessions);
    this.sessionAttachments = opts.sessionAttachments ?? new SessionAttachmentStore();
    this.authority = new AccountAuthority<LocalScanBinding>({
      service: opts.service,
      slot: LOCAL_SCAN_SLOT,
      // v2 adds the bounded upload operation. A new id prevents persisted v1
      // roots and pending approvals from being reinterpreted as writable.
      objectPrefix: "bot-host-home-v2",
      kind: "bot-host-home",
      operations: LOCAL_SCAN_OPERATIONS,
      policy: localScanPolicy,
      rootAutoAllow: (_username, defaults) => [...defaults, "upload_session_file"],
      adapter: localScanAdapter as ObjectDefinition<LocalScanBinding>["adapter"],
      now: opts.now,
      /**
       * Two trusted facts, re-read on every use, exactly like the Runner's:
       *
       *  1. the user row exists;
       *  2. this deployment has a scan home configured for them.
       *
       * Dropping either revokes the root, so a deployment that stops scanning a
       * home also ends every grant that was derived from it — rather than
       * leaving live authority over a directory nobody is offering any more.
       */
      bindingFor: (name) => {
        if (!opts.userExists(name)) return null;
        if (!this.homeFor(name)) return null;
        return {
          owner: name,
          resolveHome: () => this.homeFor(name),
          rosterReads: this.rosterReads,
          sessionAttachments: this.sessionAttachments,
        };
      },
      onWarning: (message, fields) => log.warn(fields, message),
    });
  }

  /** Shared process kernel for trusted composition code. */
  get service(): CapabilityService {
    return this.opts.service;
  }

  /** The configured scan home, or undefined. Server-side only; never returned to a browser. */
  homeFor(username: string): string | undefined {
    const home = this.opts.scanHomeFor?.(String(username ?? "").trim());
    return home && home.trim() ? home : undefined;
  }

  /**
   * Derive a Context over this user's scan home. Null is a fail-closed answer:
   * no user row, no configured home, or none of `rights` survives.
   */
  open(o: {
    username: string;
    purpose: string;
    rights: readonly Operation[];
    autoAllow?: readonly Operation[];
    pool?: string;
    metadata?: Record<string, string>;
  }): LocalScanGrant | null {
    const username = String(o.username ?? "").trim();
    const derived = this.authority.derive({
      username,
      purpose: o.purpose,
      kind: "session",
      rights: o.rights,
      autoAllow: o.autoAllow,
      metadata: o.metadata,
      pool: o.pool,
    });
    if (!derived) return null;
    return new LocalScanGrant(this.opts.service, derived.contextId, o.purpose, username, derived.borrowed);
  }

  /**
   * What this account's bot-host root holds right now. Empty when the user is
   * gone or the deployment scans no home for them — which is how "this
   * deployment has no local source" reaches the permission screen without
   * anybody writing a rule for it.
   */
  accountOperations(username: string): string[] {
    return this.authority.rightsOfAccount(username);
  }

  /**
   * The one bot-host account root another trusted plane may derive from.
   * Returning only (Context, slot) mirrors RunnerCapabilities and preserves the
   * single-root lifecycle: this accessor never mints a second capability.
   */
  accountAuthority(username: string): { contextId: ContextId; slot: string } | null {
    const authority = this.authority.authorityFor(username);
    return authority ? { contextId: authority.context, slot: LOCAL_SCAN_SLOT } : null;
  }

  /** Teardown half of a revocation; `surface` narrows to one pool prefix. */
  dropPooled(username: string, surface?: string): number {
    return this.authority.dropPooled(username, surface);
  }

  revokeAccount(username: string): void {
    this.authority.revokeAccount(username);
  }

  /** Test/diagnostics. */
  get pooledContexts(): number {
    return this.authority.pooledContexts;
  }
}
