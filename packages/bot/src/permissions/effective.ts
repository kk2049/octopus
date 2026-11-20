/**
 * Requested ∩ granted ∩ everything that is true right now — as a pure
 * function, with machine-readable reasons.
 *
 * ── Why these are three columns and not one green tick ──────────────────────
 *
 * Collapsing them produces exactly two lies, and both have been shipped by
 * other systems: "the laptop was revoked but the page still says the app may
 * read it", and "the new release asks for `exec` and the old tick makes it look
 * like the original grant covered it". So:
 *
 *   Requested  what the subject DECLARES it wants. Grants nothing.
 *   Granted    what a person or an operator actually authorised. Persistent
 *              intent; survives a code update, dies on revocation.
 *   Effective  what would work if it were called this instant, after the
 *              account's real authority, the parent grant, the per-agent
 *              narrowing, the contract version and expiry have all had a say.
 *
 * The front end does not recompute any of this. It renders `entries` and shows
 * `explanation`; every security conclusion is reached here and re-reached by
 * the Gate when the call actually happens. Which is the point of the
 * differential test in `effective.test.ts`: for every row this file calls
 * effective, the kernel must really derive it, and for every row it does not,
 * the kernel must really not.
 */

import { SESSION_HUB_CATALOG, type OperationCatalog } from "./catalog.js";

export type GrantStatus = "active" | "revoked" | "expired" | "superseded";

/**
 * Machine-readable reasons an operation is not effective. The UI maps these to
 * sentences and the tests assert on them, so renaming one is a visible change
 * rather than a silently different screen.
 */
export type ReasonCode =
  | "not_requested"
  | "not_granted"
  | "revoked"
  | "expired"
  | "superseded"
  | "publisher_changed"
  | "contract_expanded"
  | "agent_narrowed"
  | "parent_revoked"
  | "device_revoked"
  | "account_lacks_operation"
  | "unknown_operation";

export interface EffectiveGrantInput {
  operations: readonly string[];
  autoAllow: readonly string[];
  status: GrantStatus;
  /** ISO or null. A grant with no expiry never expires on its own. */
  expiresAt?: string | null;
  /** The permission contract this grant was issued against (SEC-02). */
  contractDigest?: string | null;
  /** The publisher this grant was issued to. A different publisher never inherits it. */
  publisher?: string | null;
}

export interface EffectiveInput {
  /** Hub operation ids the subject declares it wants. */
  requested: readonly string[];
  /** The recorded authorisation, or null when nothing was ever authorised. */
  grant: EffectiveGrantInput | null;
  /**
   * The contract the subject declares NOW. Differs from the grant's =
   * the declaration widened, and the extra operations stay closed (SEC-02).
   */
  contractDigest?: string | null;
  /** The publisher asking now. It is part of the durable grant identity. */
  publisher?: string | null;
  /**
   * Underlying operations the account's authority actually holds this instant,
   * read from the kernel rather than from a table, and UNIONED across the hub's
   * resources: the laptop Runner and the bot host's scan home.
   *
   * This is how "the laptop was removed" reaches the screen without anybody
   * writing a rule for it — with no device registered the Runner root is revoked
   * and contributes nothing. It is also why a deployment that only scans a local
   * home is not reported as having lost its permissions: it never had a Runner
   * root, and the bot-host root is a different root.
   *
   * The union is safe to take because `catalog.ts` maps a hub operation onto ONE
   * underlying name, and both resources use those same names for the same
   * meaning. What the union cannot say is WHICH resource will answer — that is
   * the hub's business, and it derives from each separately.
   */
  accountOperations: readonly string[];
  /** For an agent: the parent App's effective set. Absent for an App itself. */
  parentEffective?: readonly string[];
  /** For an agent: its declared subset. Absent = inherits the App's set. */
  agentSubset?: readonly string[];
  now: number;
}

export interface EffectiveEntry {
  operation: string;
  title: string;
  description: string;
  risk: string;
  effect: string;
  requested: boolean;
  granted: boolean;
  effective: boolean;
  /** True when this may run with no approval card. Never for `alwaysApprove`. */
  autoAllow: boolean;
  /**
   * Conditional system policy: the owner, using a real browser login, may
   * submit this first-party Session Hub action without a redundant second
   * click. Bearers, Apps and Agents do not inherit it.
   */
  directSelfAutoAllow: boolean;
  /** True when every call queues a card no matter what the grant says. */
  alwaysApprove: boolean;
  reasons: ReasonCode[];
  /** One sentence for a person; derived from `reasons`, never freehand. */
  explanation: string;
}

export interface EffectiveView {
  entries: EffectiveEntry[];
  requestedCount: number;
  grantedCount: number;
  effectiveCount: number;
  /** True when the declaration asks for more than the grant covers. */
  needsAuthorization: boolean;
  /** Operations declared now that the recorded grant does not cover. */
  pendingAuthorization: string[];
}

const REASON_TEXT: Record<ReasonCode, string> = {
  not_requested: "这个能力没有被申请。",
  not_granted: "还没有授权 — 在本页勾选并保存即可生效。",
  revoked: "授权已被撤销。",
  expired: "授权已过期。",
  superseded: "这条授权已被更新的一条取代。",
  publisher_changed: "应用发布者已经变化；旧发布者的授权不会由新发布者继承。",
  contract_expanded: "新版本申请的权限比你当初同意的更多 — 多出来的部分在你重新确认之前不会生效。",
  agent_narrowed: "这个 Agent 的显式子集里没有它（Agent 永远不能超出所属 App 的授权）。",
  parent_revoked: "所属 App 的授权里没有它 — App 是上限。",
  device_revoked:
    "这个账号当前既没有已注册的章鱼端点，bot 主机上也没有可扫描的会话目录 — 没有任何资源可以派生权限。",
  account_lacks_operation: "账号本身当前不持有这个操作。",
  unknown_operation: "未知操作 — 目录里没有它。",
};

function isExpired(grant: EffectiveGrantInput, now: number): boolean {
  if (!grant.expiresAt) return false;
  const t = Date.parse(grant.expiresAt);
  // An unreadable timestamp is treated as expired: a date we cannot read is a
  // window we cannot police.
  return !Number.isFinite(t) || t <= now;
}

/**
 * Compute the three columns for one subject.
 *
 * Reasons are collected in most-specific-first order and ALL of them are kept.
 * "Not granted because the contract widened" and "not granted because you never
 * granted it" are different things to do about it, and a single primary reason
 * would pick one and hide the other.
 */
export function computeEffective(
  input: EffectiveInput,
  catalog: OperationCatalog = SESSION_HUB_CATALOG,
): EffectiveView {
  const grant = input.grant;
  const grantOps = new Set(grant?.operations ?? []);
  const autoOps = new Set(grant?.autoAllow ?? []);
  const parent = input.parentEffective ? new Set(input.parentEffective) : null;
  const subset = input.agentSubset ? new Set(input.agentSubset) : null;
  const accountOps = new Set(input.accountOperations);
  const contractMoved = Boolean(
    grant?.contractDigest && input.contractDigest && grant.contractDigest !== input.contractDigest,
  );
  const publisherMoved = Boolean(
    grant?.publisher && input.publisher && grant.publisher !== input.publisher,
  );

  const entries: EffectiveEntry[] = [];
  for (const id of input.requested) {
    const info = catalog.operation(id);
    const reasons: ReasonCode[] = [];
    if (!info) {
      entries.push({
        operation: id,
        title: id,
        description: "",
        risk: "枚举与状态",
        effect: "observe",
        requested: true,
        granted: false,
        effective: false,
        autoAllow: false,
        directSelfAutoAllow: false,
        alwaysApprove: true,
        reasons: ["unknown_operation"],
        explanation: REASON_TEXT.unknown_operation,
      });
      continue;
    }

    // 1. The recorded grant. Status first, because a revoked grant is not a
    //    grant that happens to be missing an operation.
    let granted = false;
    if (!grant) {
      reasons.push("not_granted");
    } else if (grant.status === "revoked") {
      reasons.push("revoked");
    } else if (grant.status === "superseded") {
      reasons.push("superseded");
    } else if (grant.status === "expired" || isExpired(grant, input.now)) {
      reasons.push("expired");
    } else if (publisherMoved) {
      reasons.push("publisher_changed");
    } else if (!grantOps.has(id)) {
      if (contractMoved) reasons.push("contract_expanded");
      reasons.push("not_granted");
    } else {
      granted = true;
    }

    // 2. The chain above this subject. An agent can only narrow.
    if (subset && !subset.has(id)) reasons.push("agent_narrowed");
    if (parent && !parent.has(id)) reasons.push("parent_revoked");

    // 3. What the account can back it with, right now.
    if (accountOps.size === 0) {
      reasons.push("device_revoked");
    } else {
      const runner = catalog.kernelOperation(id)!;
      if (!accountOps.has(runner)) reasons.push("account_lacks_operation");
    }

    const effective = reasons.length === 0;
    entries.push({
      operation: id,
      title: info.title,
      description: info.description,
      risk: info.risk,
      effect: info.effect,
      requested: true,
      granted,
      effective,
      // Catalog + exact grant terms decide silence. Scope ownership is enforced
      // by the capability chain that consumes this projection.
      autoAllow: effective && info.mayAutoAllow && !info.alwaysApprove && autoOps.has(id),
      directSelfAutoAllow: false,
      alwaysApprove: info.alwaysApprove,
      reasons,
      explanation: reasons.length ? reasons.map((r) => REASON_TEXT[r]).join(" ") : explainEffective(info),
    });
  }

  const pendingAuthorization = entries.filter((e) => !e.granted).map((e) => e.operation);
  return {
    entries,
    requestedCount: entries.length,
    grantedCount: entries.filter((e) => e.granted).length,
    effectiveCount: entries.filter((e) => e.effective).length,
    needsAuthorization: pendingAuthorization.length > 0,
    pendingAuthorization,
  };
}

function explainEffective(info: { alwaysApprove: boolean }): string {
  return info.alwaysApprove
    ? "已授权。每一次调用仍会在「待批准」里等你逐条点头。"
    : "已授权，当前有效。";
}

/**
 * The hub operations that are effective — i.e. the set a caller may actually
 * ask the Gate for. This is what `SessionHubService` passes to `open()`, so the
 * screen and the execution path read the SAME computation rather than two
 * similar-looking ones.
 */
export function effectiveOperations(view: EffectiveView): string[] {
  return view.entries.filter((e) => e.effective).map((e) => e.operation);
}

/** Of those, the ones that may run with no approval card. */
export function autoAllowedOperations(view: EffectiveView): string[] {
  return view.entries.filter((e) => e.effective && e.autoAllow).map((e) => e.operation);
}

// ── permission diff, for the authorise screen (§8) ──

export interface PermissionDiff {
  added: string[];
  kept: string[];
  removed: string[];
  /** True when nothing changed — the case that must NOT interrupt anybody. */
  unchanged: boolean;
}

/**
 * What a person is being asked to agree to, relative to what they already
 * agreed to. A first-party bugfix that changes no permission produces
 * `unchanged: true` and no prompt; a release that adds `exec` asks about
 * `exec` and not about the twelve things already granted.
 */
export function permissionDiff(previous: readonly string[], next: readonly string[]): PermissionDiff {
  const prev = new Set(previous);
  const now = new Set(next);
  const added = [...now].filter((op) => !prev.has(op)).sort();
  const kept = [...now].filter((op) => prev.has(op)).sort();
  const removed = [...prev].filter((op) => !now.has(op)).sort();
  return { added, kept, removed, unchanged: added.length === 0 && removed.length === 0 };
}
