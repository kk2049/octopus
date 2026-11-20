/**
 * PermissionService — the durable half of authorisation, and the one place a
 * revocation is allowed to happen.
 *
 * ── The division of labour, stated once ────────────────────────────────────
 *
 *   this file      what a person AGREED to, durably. Rows, diffs, revocation,
 *                  the activity record, and the projection the UI renders.
 *   capability     what is TRUE right now. Contexts, derivation, the Gate, the
 *   kernel         approval queue. It is the only thing that authorises a call.
 *
 * A row here never authorises anything by itself. `effectiveFor()` intersects
 * the recorded intent with what the account's authority actually holds this
 * instant — read from the kernel, not from a second table — and the caller
 * passes the RESULT to `RunnerCapabilities.open()`. So the screen and the
 * execution path consume the same computation; there is no second, similar
 * rule that can drift.
 *
 * ── Revocation: synchronously safe, then cleaned up ────────────────────────
 *
 * `revoke()` marks the row BEFORE it tears anything down, and that ordering is
 * the security content. From the moment it returns, every new `effectiveFor()`
 * already omits the operation, so a fresh call cannot derive it — even if the
 * teardown below fails, throws, or is interrupted. The teardown then closes the
 * things that were already open (pooled Contexts, their undecided approvals,
 * live streams). Doing it the other way round — tear down, then mark — leaves a
 * window in which a request re-derives from a grant that is on its way out.
 */

import { randomUUID } from "node:crypto";
import type { Store, GrantIntentRow } from "../store/store.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import { RUNNER_SLOT } from "../runner/capability.js";
import type { LocalScanCapabilities } from "../sessionhub/local-scan.js";
import type { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import type { UserMemoryCapabilities } from "../user-memory/capability.js";
import type { UserSkillsCapabilities } from "../user-skills/capability.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_OWNER_LOCAL_OPERATIONS,
  sessionPlusContractCovering,
  sessionPlusContractFor,
} from "../session-resource/contract.js";
import {
  DEV_FACTORY_SUBJECT,
  SESSION_HUB_CATALOG,
  SESSION_HUB_SUBJECT,
  SESSION_HUB_SUBJECT_ENTRY,
  type OperationCatalog,
  type SubjectCatalogEntry,
  type SubjectInfo,
  type SubjectType,
} from "./catalog.js";
import {
  computeEffective,
  permissionDiff,
  type EffectiveView,
  type GrantStatus,
  type PermissionDiff,
} from "./effective.js";

export type GrantSource = "user" | "admin" | "config" | "system-policy" | "bootstrap";

export interface GrantIntent {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  owner: string;
  resourceType: "runner-account" | "runner-device";
  resourceId: string;
  operations: string[];
  autoAllow: string[];
  source: GrantSource;
  status: GrantStatus;
  contractDigest: string | null;
  publisher: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
}

/**
 * The subscriber interface for revocation side effects.
 *
 * Deliberately a list of callbacks rather than direct calls into the dashboard:
 * this module must be constructible in a unit test without an HTTP server, and
 * the things that need closing (SSE registries, append leases) are owned by
 * layers above it. Each one is best-effort and isolated — a listener that
 * throws must not stop the next one, because a half-finished cleanup is worse
 * than a slow one and the ROW is already safe.
 */
export interface RevocationListener {
  (event: { owner: string; subjectType: SubjectType; subjectId: string; operations: string[] }): void;
}

export interface PermissionServiceOptions {
  store: Store;
  /** The kernel-facing control plane for laptop Runners. Absent = no devices. */
  caps?: RunnerCapabilities;
  /**
   * The kernel-facing control plane for the bot host's own scan home — the
   * hub's SECOND resource. It is separate from `caps` because the two have
   * different trusted preconditions and different meanings when absent: no
   * `caps` means "this deployment has no laptops", no `local` means "this
   * deployment scans nothing locally", and a bot-host-only install is an
   * ordinary configuration rather than a degraded one.
   */
  local?: LocalScanCapabilities;
  /**
   * The workspace-files plane, when this deployment composed one.
   *
   * A THIRD root over the same laptops, with its own Object id and its own
   * version line (`workspace-files/CLAUDE.md`). It is here for one reason: the
   * effective column is "what the account's authority actually holds", and an
   * operation served by a plane this projection never asked would read as
   * `account_lacks_operation` forever — a screen saying "you cannot do this"
   * about something the Gate would allow.
   */
  workspaceFiles?: WorkspaceFilesCapabilities;
  /**
   * The two per-owner directory planes on the BOT host (memory and skills),
   * when this deployment composed them. Same reason as `workspaceFiles`: an
   * operation served by a plane this projection never asked would read as
   * `account_lacks_operation` forever.
   */
  userMemory?: UserMemoryCapabilities;
  userSkills?: UserSkillsCapabilities;
  /**
   * Planes that are NOT capability roots but still hold operations.
   *
   * `notify/v1` is the first: it is served by a delivery path, so "what does the
   * account hold" is a question about the deployment (is there an outbound
   * channel at all) rather than about a device. It is here for exactly the
   * reason `workspaceFiles` is — an operation no plane reports would read as
   * `account_lacks_operation` for ever, and the screen would be denying
   * something the provider would do.
   *
   * Deliberately a list of thunks rather than one more named field per plane:
   * the shape a plane has to satisfy here is "name the operations this account
   * holds", and a caller that can answer that has said everything this
   * projection needs. It is constructor data, not a registry app code can push
   * onto.
   */
  extraAccountOperations?: readonly ((owner: string) => readonly string[])[];
  now?: () => number;
  /**
   * How the Session Hub's first grant comes into existence (execution plan
   * §10). See `bootstrapSessionHub` for why this defaults to on and what it
   * deliberately does NOT claim.
   */
  bootstrapSessionHub?: boolean;
  /** @deprecated Owner-local interactive Session Hub submits are now the default. */
  directSubmitAutoAllowUsers?: readonly string[];
  /**
   * Additional subjects explicitly composed by this process. This is immutable
   * constructor data, not a process-global registry that app code can mutate.
   */
  subjects?: readonly SubjectCatalogEntry[];
}

export class PermissionService {
  private listeners: RevocationListener[] = [];
  private nowMs: () => number;
  private subjectEntries = new Map<string, SubjectCatalogEntry>();

  constructor(private opts: PermissionServiceOptions) {
    this.nowMs = opts.now ?? Date.now;
    for (const entry of [SESSION_HUB_SUBJECT_ENTRY, ...(opts.subjects ?? [])]) {
      const key = subjectKey(entry.info.type, entry.info.id);
      if (this.subjectEntries.has(key)) throw new Error(`duplicate permission subject: ${key}`);
      this.subjectEntries.set(key, Object.freeze({ ...entry }));
    }
  }

  onRevoked(fn: RevocationListener): () => void {
    this.listeners.push(fn);
    return () => {
      const index = this.listeners.indexOf(fn);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** Drop composition-owned callbacks after a factory fails before publication. */
  close(): void {
    this.listeners = [];
  }

  // ── subjects ──

  /**
   * Everything the permission centre lists for one account: explicitly
   * composed subjects plus legacy v3 rows that may already exist. Dev Factory is included
   * with its trusted-service badge and no authorise button — it did not get its
   * authority from a grant, and saying it did on this screen is the specific
   * misrepresentation the execution plan forbids.
   *
   * A legacy row without a composed catalog is listed as `enforced: false`, and
   * the write path refuses to create another. Explicit entries keep their own
   * truthful `enforced` and mutation policy.
   */
  subjects(owner: string, o: { devFactoryEnabled?: boolean } = {}): SubjectInfo[] {
    const out: SubjectInfo[] = [...this.subjectEntries.values()].map((entry) => entry.info);
    if (o.devFactoryEnabled) out.push(DEV_FACTORY_SUBJECT);
    const seen = new Set(out.map((s) => `${s.type}:${s.id}`));
    for (const row of this.opts.store.listGrantIntents(owner)) {
      const key = `${row.subject_type}:${row.subject_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.subject_type !== "app" && row.subject_type !== "agent") continue;
      out.push({
        type: row.subject_type,
        id: row.subject_id,
        title: row.subject_id,
        publisher: row.publisher ?? "first-party",
        description: "",
        enforced: false,
      });
    }
    return out;
  }

  /** Explicit composition metadata for route policy and rendering. */
  subject(subjectType: SubjectType, subjectId: string): SubjectCatalogEntry | undefined {
    return this.subjectEntries.get(subjectKey(subjectType, subjectId));
  }

  /**
   * What this subject is asking for RIGHT NOW.
   *
   * Usually the whole catalog. A subject whose ask can change between releases
   * supplies `declared`, so a consent screen shows the running release's
   * request rather than the union of everything this build could implement —
   * granting an operation the active release never declared would record an
   * agreement about a contract nobody was shown.
   */
  declaredOperations(subjectType: SubjectType, subjectId: string, owner?: string): readonly string[] {
    const entry = this.subject(subjectType, subjectId);
    if (!entry) return [];
    return entry.declared?.(owner) ?? entry.catalog.ids;
  }

  // ── grants ──

  /**
   * The stable row id. Derived from (subject, owner, resource) rather than
   * random, so re-granting updates the one row in force instead of appending a
   * second one that a reader would have to rank.
   */
  private idFor(subjectType: SubjectType, subjectId: string, owner: string, resourceId: string): string {
    return `gi:${subjectType}:${subjectId}:${owner}:${resourceId}`;
  }

  get(subjectType: SubjectType, subjectId: string, owner: string, resourceId = "*"): GrantIntent | null {
    const row = this.opts.store.getGrantIntent(this.idFor(subjectType, subjectId, owner, resourceId));
    return row ? toIntent(row) : null;
  }

  list(owner: string): GrantIntent[] {
    return this.opts.store.listGrantIntents(owner).map(toIntent);
  }

  /**
   * Record an authorisation. `operations` is the WHOLE new set, not a delta:
   * a grant screen shows checkboxes and saves what is ticked, so "unticked" has
   * to mean "removed" or narrowing would need its own endpoint and would be the
   * one nobody wired up.
   *
   * Narrowing therefore takes effect here and needs no consent; the caller gets
   * the diff back so it can say what changed.
   */
  grant(o: {
    subjectType: SubjectType;
    subjectId: string;
    owner: string;
    resourceType?: "runner-account" | "runner-device";
    resourceId?: string;
    operations: readonly string[];
    autoAllow?: readonly string[];
    source: GrantSource;
    createdBy: string;
    expiresAt?: string | null;
    contractDigest?: string | null;
    publisher?: string | null;
  }): { intent: GrantIntent; diff: PermissionDiff } {
    const resourceId = o.resourceId ?? "*";
    const previous = this.get(o.subjectType, o.subjectId, o.owner, resourceId);
    const subject = this.subject(o.subjectType, o.subjectId);
    const catalog = this.catalogFor(o.subjectType, o.subjectId);
    // Unknown operation names are dropped rather than stored: a row naming an
    // operation the catalog does not have would render as a permission that can
    // never be exercised, which reads as "granted" and behaves as "denied".
    const operations = [...new Set(o.operations)].filter((op) => catalog?.ids.includes(op) ?? false).sort();
    // User-controlled auto-allow can only ever be a subset of what is granted
    // and what this exact subject catalog declares auto-allowable. Risk class
    // alone is not enough: scope ownership and trust boundary live in the
    // subject's catalog and in the capability derivation that consumes it.
    const autoAllow = [...new Set(o.autoAllow ?? [])]
      .filter((op) => operations.includes(op) && (catalog?.autoAllowable.includes(op) ?? false))
      .sort();
    const nowIso = new Date(this.nowMs()).toISOString();
    const row: GrantIntentRow = {
      id: this.idFor(o.subjectType, o.subjectId, o.owner, resourceId),
      subject_type: o.subjectType,
      subject_id: o.subjectId,
      owner: o.owner,
      resource_type: o.resourceType ?? "runner-account",
      resource_id: resourceId,
      operations: JSON.stringify(operations),
      terms: JSON.stringify({ autoAllow }),
      source: o.source,
      status: "active",
      contract_digest: o.contractDigest ?? subject?.grantIdentity?.contractDigest ?? null,
      publisher: o.publisher ?? subject?.grantIdentity?.publisher ?? "first-party",
      created_by: o.createdBy,
      created_at: nowIso,
      expires_at: o.expiresAt ?? null,
      revoked_by: null,
      revoked_at: null,
    };
    this.opts.store.saveGrantIntent(row);
    const diff = permissionDiff(previous?.operations ?? [], operations);
    this.audit({
      owner: o.owner,
      subjectType: o.subjectType,
      subjectId: o.subjectId,
      operation: "(grant)",
      decision: "grant",
      reason: o.source,
      detail: JSON.stringify({ added: diff.added, removed: diff.removed, by: o.createdBy }),
    });
    // Narrowing must bite immediately, so anything the shrunken grant no longer
    // covers gets the same teardown a full revoke would give it.
    if (diff.removed.length) this.propagate(o.owner, o.subjectType, o.subjectId, diff.removed);
    return { intent: toIntent(row), diff };
  }

  /**
   * Revoke a whole grant. Row first, teardown second — see the file docstring.
   * Returns false when there was nothing active, so a double click is cheap and
   * honest rather than a second round of teardown.
   */
  revoke(o: {
    subjectType: SubjectType;
    subjectId: string;
    owner: string;
    resourceId?: string;
    by: string;
  }): boolean {
    const id = this.idFor(o.subjectType, o.subjectId, o.owner, o.resourceId ?? "*");
    const before = this.opts.store.getGrantIntent(id);
    const changed = this.opts.store.revokeGrantIntent(id, o.by, new Date(this.nowMs()).toISOString());
    if (!changed) return false;
    this.audit({
      owner: o.owner,
      subjectType: o.subjectType,
      subjectId: o.subjectId,
      operation: "(revoke)",
      decision: "revoke",
      reason: `by ${o.by}`,
      detail: before?.operations ?? "[]",
    });
    this.propagate(o.owner, o.subjectType, o.subjectId, before ? (JSON.parse(before.operations) as string[]) : []);
    // Revoking an App's grant must invalidate its Agents' subsets too: an Agent
    // is a narrowing of its App and cannot outlive what it narrows.
    if (o.subjectType === "app") {
      for (const child of this.list(o.owner)) {
        if (child.subjectType !== "agent") continue;
        if (!child.subjectId.startsWith(`${o.subjectId}/`)) continue;
        if (child.status !== "active") continue;
        this.revoke({ subjectType: "agent", subjectId: child.subjectId, owner: o.owner, by: o.by });
      }
    }
    return true;
  }

  /**
   * Close what was already open. Best-effort and isolated per listener: the row
   * is already safe, so one listener throwing must not skip the rest.
   */
  private propagate(owner: string, subjectType: SubjectType, subjectId: string, operations: string[]): void {
    // These two pools belong specifically to Session Hub. Other subjects own
    // their own derived Contexts and tear them down through the listener below;
    // destroying Hub pools for an App revocation would couple two independent
    // authority planes and interrupt an unrelated surface.
    if (subjectType === "service" && subjectId === SESSION_HUB_SUBJECT.id) {
      for (const drop of [() => this.opts.caps?.dropPooled(owner), () => this.opts.local?.dropPooled(owner)]) {
        try {
          drop();
        } catch {
          /* the row is authoritative; a failed teardown must not undo it */
        }
      }
    }
    for (const fn of this.listeners) {
      try {
        fn({ owner, subjectType, subjectId, operations });
      } catch {
        /* same */
      }
    }
  }

  // ── projection ──

  /**
   * Underlying operations this account's authority actually holds right now,
   * across every resource plane this deployment composed.
   *
   * Read from the kernel every time. That is why "the last laptop was removed"
   * shows up on the permissions screen without anybody writing a rule for it:
   * with no device registered `accountAuthority` revokes the root and returns
   * null, so the Runner contributes nothing. The bot-host root answers the same
   * question about the local scan home, and a deployment with one and not the
   * other is normal in both directions.
   */
  private accountOperations(owner: string): string[] {
    const out = new Set<string>();
    const caps = this.opts.caps;
    const authority = caps?.accountAuthority(owner);
    if (caps && authority) {
      for (const op of caps.service.rightsOf(authority.contextId, authority.slot)) out.add(op);
    }
    for (const op of this.opts.local?.accountOperations(owner) ?? []) out.add(op);
    // The workspace-files plane answers about the SAME laptops through its own
    // root, so "the last device went away" ends it at the same moment.
    for (const op of this.opts.workspaceFiles?.accountOperations(owner) ?? []) out.add(op);
    // The bot-host directory planes: each holds its whole table exactly while
    // the account exists and the directory resolver answers for it.
    for (const op of this.opts.userMemory?.accountOperations(owner) ?? []) out.add(op);
    for (const op of this.opts.userSkills?.accountOperations(owner) ?? []) out.add(op);
    // Planes with no capability root of their own. One throwing must not blank
    // the whole answer: an empty set is read as `device_revoked`, which would
    // say "you have no resources at all" because one channel probe failed.
    for (const fn of this.opts.extraAccountOperations ?? []) {
      try {
        for (const op of fn(owner)) out.add(op);
      } catch {
        /* a plane that cannot answer holds nothing, which is the safe reading */
      }
    }
    return [...out];
  }

  /**
   * Requested / granted / effective for one subject, with reasons.
   *
   * `requested` defaults to the Session Hub catalog because that is the only
   * subject with a declared surface today; a v3 App passes its own declared
   * operations in.
   */
  effectiveFor(o: {
    subjectType: SubjectType;
    subjectId: string;
    owner: string;
    resourceId?: string;
    requested?: readonly string[];
    contractDigest?: string | null;
    parentEffective?: readonly string[];
    agentSubset?: readonly string[];
  }): EffectiveView {
    const grant = this.get(o.subjectType, o.subjectId, o.owner, o.resourceId ?? "*");
    const subject = this.subject(o.subjectType, o.subjectId);
    const catalog = this.catalogFor(o.subjectType, o.subjectId) ?? SESSION_HUB_CATALOG;
    return computeEffective({
      requested: o.requested ?? this.declaredOperations(o.subjectType, o.subjectId, o.owner),
      grant: grant
        ? {
            operations: grant.operations,
            autoAllow: grant.autoAllow,
            status: grant.status,
            expiresAt: grant.expiresAt,
            contractDigest: grant.contractDigest,
            publisher: grant.publisher,
          }
        : null,
      contractDigest: o.contractDigest ?? subject?.grantIdentity?.contractDigest ?? null,
      publisher: subject?.grantIdentity?.publisher ?? null,
      accountOperations: this.accountOperations(o.owner),
      parentEffective: o.parentEffective,
      agentSubset: o.agentSubset,
      now: this.nowMs(),
    }, catalog);
  }

  /**
   * The Session Hub's own effective set, bootstrapping the grant on first use.
   *
   * ── What the bootstrap is, and what it deliberately is not ───────────────
   *
   * Before this change, an owner could already list, read, search and tail
   * their own sessions: the check was `identity.username === username` inline
   * in the route. Importing that as a grant does not widen anything — it makes
   * the existing access VISIBLE and REVOCABLE, which is exactly what §10 asks
   * for. So the row is written with `source: "bootstrap"` and never with
   * `source: "user"`: recording it as "the user clicked agree" would be a
   * fabricated consent, and a reader deserves to see which of their permissions
   * they actually chose.
   *
   * `append_session`/`resume_session` are in the bootstrap set too. Their
   * owner-local browser exception is projected below rather than inherited by
   * Bearers, Apps, Agents or cross-user callers.
   */
  sessionHubEffective(owner: string): EffectiveView {
    const current = this.get("service", SESSION_HUB_SUBJECT.id, owner);
    if (this.opts.bootstrapSessionHub !== false && !current) {
      this.grant({
        subjectType: "service",
        subjectId: SESSION_HUB_SUBJECT.id,
        owner,
        operations: SESSION_HUB_CATALOG.ids,
        autoAllow: SESSION_HUB_CATALOG.autoAllowable,
        source: "bootstrap",
        createdBy: "system:bootstrap",
      });
    } else if (current?.status === "active" && current.source === "bootstrap") {
      // A bootstrap row written before append/resume became grantable silent
      // terms (O1) picks them up for the operations it already holds, so the
      // owner's scripts and MCP agents stop queueing cards for their own
      // sessions without anybody re-consenting. User/config rows are theirs.
      const autoAllow = [...new Set([
        ...current.autoAllow,
        ...SESSION_HUB_CATALOG.autoAllowable.filter((operation) => current.operations.includes(operation)),
      ])];
      if (autoAllow.length !== current.autoAllow.length) {
        this.grant({
          subjectType: "service",
          subjectId: SESSION_HUB_SUBJECT.id,
          owner,
          operations: current.operations,
          autoAllow,
          source: "bootstrap",
          createdBy: current.createdBy,
          expiresAt: current.expiresAt,
        });
      }
    }
    const base = this.effectiveFor({ subjectType: "service", subjectId: SESSION_HUB_SUBJECT.id, owner });
    return {
      ...base,
      entries: base.entries.map((entry) => {
        if (entry.operation !== "append_session" && entry.operation !== "resume_session") return entry;
        return {
          ...entry,
          // This is not stored in the user's grant and is not an unconditional
          // autoAllow term.  SessionHubService still requires owner equality
          // and a real browser session before asking the child grant for it.
          directSelfAutoAllow: true,
          explanation: !entry.effective
            ? entry.explanation
            : entry.autoAllow
              ? "已授权。本人提交给自己的会话（网页、脚本或 MCP）免批准。"
              : "已授权。本人在可信网页中直接提交时免二次批准；脚本与 MCP 提交按这条授权的设置逐次批准。",
        };
      }),
    };
  }

  /**
   * Session Plus defaults for its owner's trusted human plane.
   *
   * The bootstrap covers only the owner-local session and workspace contract.
   * Collaborative documents and outbound notifications are deliberately not
   * included: they cross a resource/person boundary and remain real consent.
   * A revocation is sticky, and user/config narrowing is never widened. Existing
   * active rows do receive the new silent terms for operations they already
   * granted, so a policy upgrade does not strand people behind stale cards.
   */
  sessionPlusEffective(owner: string, activeContractDigest?: string | null): EffectiveView {
    const requested = this.declaredOperations("app", SESSION_PLUS_APP_ID, owner);
    const requestedSet = new Set(requested);
    // Everything the release asks for on the owner's OWN sessions, workspaces,
    // files and terminals is held and silent without a consent click (O1):
    // acting on one's own resources needs no approval. Shared documents and
    // outbound notification stay real consent.
    const defaults = SESSION_PLUS_OWNER_LOCAL_OPERATIONS.filter((operation) => requestedSet.has(operation));
    const inferred = sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, requested)?.digest ?? null;
    const activeDigest = activeContractDigest ?? inferred;
    const activeContract = activeDigest ? sessionPlusContractFor(SESSION_PLUS_PUBLISHER, activeDigest)?.contract : null;
    const silentDefaults = defaults;
    let current = this.get("app", SESSION_PLUS_APP_ID, owner);

    if (!current && activeContract) {
      this.grant({
        subjectType: "app",
        subjectId: SESSION_PLUS_APP_ID,
        owner,
        operations: defaults,
        autoAllow: silentDefaults,
        source: "bootstrap",
        createdBy: "system:self-service",
        contractDigest: activeDigest,
        publisher: SESSION_PLUS_PUBLISHER,
      });
      current = this.get("app", SESSION_PLUS_APP_ID, owner);
    } else if (
      current?.status === "active"
      && current.publisher === SESSION_PLUS_PUBLISHER
      && activeContract
      && (!current.expiresAt || Date.parse(current.expiresAt) > this.nowMs())
    ) {
      // Owner-local operations are the owner's own resources (O1/O2): a new
      // release declaring one reaches every active row the owner holds — the
      // bootstrap row and the row their own "授权" click wrote — with no
      // re-consent. Deployment-config rows stay exactly what config says.
      const operations = current.source === "config"
        ? current.operations
        : [...new Set([...current.operations, ...defaults])];
      const operationSet = new Set(operations);
      const autoAllow = [...new Set([
        ...current.autoAllow,
        ...silentDefaults.filter((operation) => operationSet.has(operation)),
      ])];
      const digest = activeDigest ?? current.contractDigest;
      if (
        operations.slice().sort().join("\0") !== current.operations.slice().sort().join("\0")
        || autoAllow.slice().sort().join("\0") !== current.autoAllow.slice().sort().join("\0")
        || digest !== current.contractDigest
      ) {
        this.grant({
          subjectType: "app",
          subjectId: SESSION_PLUS_APP_ID,
          owner,
          operations,
          autoAllow,
          source: current.source,
          createdBy: current.createdBy,
          expiresAt: current.expiresAt,
          contractDigest: digest,
          publisher: SESSION_PLUS_PUBLISHER,
        });
      }
    }

    return this.effectiveFor({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner,
      requested,
      contractDigest: activeDigest,
    });
  }

  private catalogFor(subjectType: SubjectType, subjectId: string): OperationCatalog | undefined {
    const direct = this.subject(subjectType, subjectId)?.catalog;
    if (direct || subjectType !== "agent") return direct;
    const slash = subjectId.indexOf("/");
    if (slash <= 0) return undefined;
    return this.subject("app", subjectId.slice(0, slash))?.catalog;
  }

  // ── activity record ──

  audit(o: {
    owner: string;
    subjectType: string;
    subjectId: string;
    operation: string;
    resource?: string;
    decision: string;
    reason?: string | null;
    detail?: string | null;
  }): void {
    try {
      this.opts.store.recordPermissionAudit({
        at: new Date(this.nowMs()).toISOString(),
        owner: o.owner,
        subject_type: o.subjectType,
        subject_id: o.subjectId,
        operation: o.operation,
        resource: o.resource ?? "",
        decision: o.decision,
        reason: o.reason ?? null,
        detail: o.detail ?? null,
      });
    } catch {
      // Never let bookkeeping fail a request. An audit gap is visible in the
      // record; a 500 from an INSERT would be a denial-of-service on a read.
    }
  }

  activity(
    owner: string,
    filter: { subjectId?: string; operation?: string; decision?: string; limit?: number; beforeId?: number } = {},
  ) {
    return this.opts.store.listPermissionAudit(owner, filter);
  }
}

function toIntent(row: GrantIntentRow): GrantIntent {
  let operations: string[] = [];
  let autoAllow: string[] = [];
  try {
    operations = JSON.parse(row.operations) as string[];
  } catch {
    /* a corrupt row grants nothing, which is the safe reading */
  }
  try {
    autoAllow = ((JSON.parse(row.terms) as { autoAllow?: string[] }).autoAllow ?? []) as string[];
  } catch {
    /* same */
  }
  return {
    id: row.id,
    subjectType: row.subject_type as SubjectType,
    subjectId: row.subject_id,
    owner: row.owner,
    resourceType: row.resource_type as "runner-account" | "runner-device",
    resourceId: row.resource_id,
    operations: Array.isArray(operations) ? operations : [],
    autoAllow: Array.isArray(autoAllow) ? autoAllow : [],
    source: row.source as GrantSource,
    status: row.status as GrantStatus,
    contractDigest: row.contract_digest,
    publisher: row.publisher,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
  };
}

function subjectKey(type: SubjectType, id: string): string {
  return `${type}:${id}`;
}

/** Unused today; kept so a caller needing a one-off id does not invent one. */
export function newGrantId(): string {
  return `gi:${randomUUID()}`;
}

export { RUNNER_SLOT };
