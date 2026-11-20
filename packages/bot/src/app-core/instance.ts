/** Per-tab trusted lifecycle records. They contain no capability in Group 1. */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RuntimeJson } from "@claude-bot/app-runtime";

export const SESSION_PLUS_INSTANCE_TTL_MS = 4 * 60 * 60_000;
export const SESSION_PLUS_INSTANCE_LIMITS = Object.freeze({
  perCredential: 32,
  perOwner: 128,
  global: 2_048,
});

export interface SessionPlusInstanceLimits {
  perCredential: number;
  perOwner: number;
  global: number;
}

/**
 * WHO is driving this instance.
 *
 * A discriminant rather than a flag on top of `session`, because `session:
 * true` is a sentence about a real browser login being present (it is what
 * keeps a Bearer admin key from opening the App). An agent turn that carried it
 * would answer "yes, a person is here" to every future reader of that field —
 * including a check somebody adds later meaning exactly "a person is here".
 * An agent principal therefore has `session: false` and cannot be mistaken for
 * one, and `human_only` has something real to test.
 */
export type SessionPlusActor =
  | { kind: "user" }
  | {
      kind: "agent";
      app: string;
      agent: string;
      turnId: string;
      /** Trusted shared-role evidence; absent for account and legacy external actors. */
      role?: string;
    };

/**
 * Proof that a principal is an EXTERNAL trusted host holding a bound
 * capability, rather than a browser or a bearer script.
 *
 * Branded, and the brand is not exported: the only way to obtain one is
 * `externalPresence()` below, which `AppInstanceService.openExternal` calls and
 * nothing else does. That matters because this value is the ONLY thing that
 * admits a `user`-kind actor without a browser session — an ordinary
 * `session: false` caller stays refused exactly as it was, and a host cannot
 * forge one by writing a plain object literal.
 */
declare const EXTERNAL_PRESENCE: unique symbol;

export interface ExternalPresence {
  /** The allow-listed host id this credential is bound to. Recorded, not trusted. */
  readonly host: string;
  readonly [EXTERNAL_PRESENCE]: true;
}

export function externalPresence(host: string): ExternalPresence {
  if (!host) throw new Error("an external presence must name the host its capability is bound to");
  return { host } as unknown as ExternalPresence;
}

/**
 * WHERE the holder of a handle is, as the registry distinguishes them.
 *
 * Three classes, not a boolean, because there are three genuinely different
 * holders and conflating any two of them silently widens a door:
 *
 *  · `browser`  — a real Octopus login. The only one that may auto-allow, and
 *    what `session: true` has always meant.
 *  · `external` — an external trusted host presenting a capability a person
 *    minted for it in their own browser session (`app-external/`).
 *  · `headless` — everything else with no person present: an MCP agent turn.
 */
export type SessionPlusPresence = "browser" | "external" | "headless";

export interface SessionPlusPrincipal {
  /** Trusted issuer delegation; never accepted from an App proposal. */
  delegation?: { shareId: string; viewer: string };
  owner: string;
  credential: string;
  session: boolean;
  /** Absent means a human actor — every browser-facing call site. */
  actor?: SessionPlusActor;
  /**
   * Present only for an external trusted host's binding, and unforgeable.
   * Mutually exclusive with `session`.
   */
  external?: ExternalPresence;
}

/** Which of the three holders this principal is. */
export function principalPresence(principal: SessionPlusPrincipal): SessionPlusPresence {
  if (principal.session) return "browser";
  return principal.external ? "external" : "headless";
}

/** The actor a principal names, with the browser default made explicit. */
export function principalActor(principal: SessionPlusPrincipal): SessionPlusActor {
  return principal.actor ?? { kind: "user" };
}

export interface SessionPlusInstanceBinding {
  /** Trusted shared registry identity. Never accepted from proposal params. */
  sharedInstanceKey?: string;
  delegation?: { shareId: string; viewer: string };
  id: string;
  owner: string;
  credential: string;
  /** The actor kind this instance was opened for. */
  actorKind: SessionPlusActor["kind"];
  /** Exact trusted actor evidence; used when a shared stream reprojects this viewer. */
  actor: SessionPlusActor;
  /**
   * Which holder this instance was opened for.
   *
   * Recorded, and then required to MATCH on every resolve, rather than tested
   * for one value: a browser tab's handle must not be resolvable by an external
   * host's credential, an external host's handle must not be resolvable by a
   * browser principal, and neither may be resolved by a headless agent turn —
   * all three are the same statement. Presence class is part of the identity a
   * handle was minted for.
   */
  presence: SessionPlusPresence;
  /**
   * Which App this instance belongs to.
   *
   * Widened from the literal `"session-plus"` when a second App started using
   * this registry (`app-registry/app-instance.ts`). It is a FIELD rather than a
   * type-level constant because writing `"session-plus"` into a `showcase`
   * instance would be a false record — and a record nobody currently reads is
   * exactly where a false statement survives longest.
   */
  stableAppId: string;
  packageDigest: string;
  contractDigest: string;
  /** New active release this browser binding may move to on an explicit page reload. */
  availableDigest?: string;
  /** Whether the current release may keep submitting until that explicit reload. */
  availableMode?: ReleaseAvailabilityMode;
  streamId: string;
  /** Per-instance sequence for projection frames; independent of durable State head. */
  viewRevision: number;
  /** Durable App State stream head. Resource-only projection updates do not change it. */
  head: number;
  projection: RuntimeJson;
  createdAt: number;
  expiresAt: number;
}

export type ReleaseAvailabilityMode = "multi_version" | "refresh_required";

export type InstanceEvent =
  /** `revision` orders projection frames for one instance; it is not the durable State head. */
  | { type: "view"; revision: number; projection: RuntimeJson }
  | { type: "op"; operation: RuntimeJson }
  /**
   * ADR 0006: a resource this instance holds changed; worth asking again.
   *
   * Deliberately the only variant that carries NO content — `binding` is the
   * App-local binding name from its own plan and `ref` is a ref the scope was
   * already handed at open, so the event can neither disclose new addressing
   * nor authorise anything. Losing one is safe; the next means the same.
   */
  | { type: "wake"; binding: string; ref: string }
  | {
      type: "release_available";
      current_package_digest: string;
      available_package_digest: string;
      mode: ReleaseAvailabilityMode;
    }
  | { type: "closed"; reason: string };

export type InstanceListener = (event: InstanceEvent) => void;

export interface InstanceSubscription {
  /** Snapshot and listener are acquired atomically on the same event-loop turn. */
  initial: Extract<InstanceEvent, { type: "view" }>;
  /** Persisted chrome-only signal, sent immediately after `initial` on reconnect. */
  releaseAvailable: Extract<InstanceEvent, { type: "release_available" }> | null;
  close(): void;
}

interface StoredInstance extends SessionPlusInstanceBinding {
  listeners: Set<InstanceListener>;
}

export interface CreateInstanceInput {
  sharedInstanceKey?: string;
  principal: SessionPlusPrincipal;
  packageDigest: string;
  contractDigest: string;
  streamId: string;
  head: number;
  projection: RuntimeJson;
}

/** A capacity slot held before the coordinator starts expensive async work. */
export interface SessionPlusInstanceReservation {
  commit(input: CreateInstanceInput): { handle: string; binding: SessionPlusInstanceBinding };
  release(): void;
}

interface StoredReservation {
  owner: string;
  credential: string;
  actorKey: string;
  active: boolean;
}

export type ResolveInstance =
  | { ok: true; binding: SessionPlusInstanceBinding }
  | { ok: false; code: "invalid_instance" | "instance_expired" | "instance_stale" };

/** The sentence every App coordinator returns for an instance-resolution failure; each names the next step. */
export function instanceMessage(code: Extract<ResolveInstance, { ok: false }>["code"]): string {
  if (code === "instance_expired") return "这个页面的应用实例已过期，请刷新";
  if (code === "instance_stale") return "应用已经切换到新的 release，请刷新页面";
  return "应用实例无效，请刷新页面";
}

export class SessionPlusInstances {
  private readonly byHash = new Map<string, StoredInstance>();
  private readonly reservations = new Set<StoredReservation>();
  private reaper: NodeJS.Timeout | null = null;

  /**
   * `stableAppId` is last and defaults to `"session-plus"`, so every existing
   * call site is unchanged.
   *
   * It decides two things: what a binding RECORDS about which App it belongs to,
   * and the domain separator the handle is hashed under. The second one is
   * defence in depth rather than the property that matters — each service owns
   * its own map, so a handle minted by one is simply absent from another's —
   * but a shared separator would make two independent tables look like one
   * namespace to anybody reading a hash.
   */
  constructor(
    private readonly servableDigests: () => ReadonlySet<string>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = SESSION_PLUS_INSTANCE_TTL_MS,
    private readonly onDestroyed: (binding: SessionPlusInstanceBinding, reason: string) => void = () => {},
    private readonly limits: SessionPlusInstanceLimits = SESSION_PLUS_INSTANCE_LIMITS,
    private readonly stableAppId: string = "session-plus",
    private readonly project: (binding: SessionPlusInstanceBinding, projection: RuntimeJson) => RuntimeJson = (_binding, projection) => projection,
  ) {}

  start(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => this.reapExpired(), Math.min(30_000, Math.max(1_000, this.ttlMs / 4)));
    this.reaper.unref?.();
  }

  create(input: CreateInstanceInput): { handle: string; binding: SessionPlusInstanceBinding } {
    this.assertPrincipal(input.principal);
    this.reapExpired();
    this.assertCapacity(input.principal);
    return this.createUnchecked(input);
  }

  /**
   * Atomically hold one admission slot across State/Runtime awaits.
   *
   * Counting only completed instances would let many concurrent page loads all
   * pass the ceiling and consume sandbox work before any of them committed. A
   * reservation participates in every limit immediately; commit swaps it for a
   * live row on the same event-loop turn, and release is idempotent.
   */
  reserve(principal: SessionPlusPrincipal): SessionPlusInstanceReservation {
    this.assertPrincipal(principal);
    this.reapExpired();
    this.assertCapacity(principal);
    const record: StoredReservation = {
      owner: principal.owner,
      credential: principal.credential,
      actorKey: actorKey(principalActor(principal)),
      active: true,
    };
    this.reservations.add(record);
    const release = (): void => {
      if (!record.active) return;
      record.active = false;
      this.reservations.delete(record);
    };
    return {
      commit: (input) => {
        if (!record.active) throw new Error("Session Plus instance reservation ended");
        if (
          actorKey(principalActor(input.principal)) !== record.actorKey
          || input.principal.owner !== record.owner
          || input.principal.credential !== record.credential
        ) {
          release();
          throw new Error("Session Plus instance reservation principal changed");
        }
        release();
        return this.createUnchecked(input);
      },
      release,
    };
  }

  private assertPrincipal(principal: SessionPlusPrincipal): void {
    if (!principal.owner || !principal.credential) {
      throw new Error("Session Plus instances require a named browser session");
    }
    const actor = principalActor(principal);
    if (principal.session && principal.external) {
      // Two presence claims at once is not a wider principal; it is a caller
      // that does not know which one it is.
      throw new Error("a principal cannot be both a browser session and an external host");
    }
    if (actor.kind === "user" && !principal.session && !principal.external) {
      // Unchanged for every ordinary caller: a `session: false` user principal
      // is still refused. The ONLY thing that admits one is the unforgeable
      // external presence, which only `openExternal` can mint.
      throw new Error("Session Plus instances require a named browser session");
    }
    if (actor.kind === "agent" && principal.session) {
      // Refused rather than ignored: a caller that built this principal thinks
      // a browser session is present, and it is not.
      throw new Error("an App agent turn must not claim a browser session");
    }
  }

  private assertCapacity(principal: SessionPlusPrincipal): void {
    let ownerCount = 0;
    let credentialCount = 0;
    for (const row of this.byHash.values()) {
      if (row.owner !== principal.owner) continue;
      ownerCount += 1;
      if (row.credential === principal.credential) credentialCount += 1;
    }
    for (const row of this.reservations) {
      if (row.owner !== principal.owner) continue;
      ownerCount += 1;
      if (row.credential === principal.credential) credentialCount += 1;
    }
    if (
      this.byHash.size + this.reservations.size >= this.limits.global
      || ownerCount >= this.limits.perOwner
      || credentialCount >= this.limits.perCredential
    ) {
      throw new Error("Session Plus instance limit reached");
    }
  }

  /** This registry's domain separator for handle hashing. See the constructor. */
  private hash(handle: string): string {
    return hashHandle(handle, this.stableAppId);
  }

  private createUnchecked(input: CreateInstanceInput): { handle: string; binding: SessionPlusInstanceBinding } {
    const handle = randomBytes(24).toString("hex");
    const at = this.now();
    const actor = cloneActor(principalActor(input.principal));
    const row: StoredInstance = {
      id: `spi_${randomUUID()}`,
      owner: input.principal.owner,
      ...(input.principal.delegation ? { delegation: { ...input.principal.delegation } } : {}),
      credential: input.principal.credential,
      actorKind: actor.kind,
      actor,
      presence: principalPresence(input.principal),
      stableAppId: this.stableAppId,
      ...(input.sharedInstanceKey ? { sharedInstanceKey: input.sharedInstanceKey } : {}),
      packageDigest: input.packageDigest,
      contractDigest: input.contractDigest,
      streamId: input.streamId,
      viewRevision: 0,
      head: input.head,
      projection: input.projection,
      createdAt: at,
      expiresAt: at + this.ttlMs,
      listeners: new Set(),
    };
    row.projection = this.project(row, row.projection);
    this.byHash.set(this.hash(handle), row);
    return { handle, binding: publicBinding(row) };
  }

  resolve(handle: string, principal: SessionPlusPrincipal): ResolveInstance {
    const located = this.locate(handle, principal);
    if (!located.ok) return located;
    const { key, row } = located;
    if (!this.servableDigests().has(row.packageDigest)) {
      this.destroyKey(key, "instance_stale");
      return { ok: false, code: "instance_stale" };
    }
    return { ok: true, binding: publicBinding(row) };
  }

  update(handle: string, projection: RuntimeJson): number | null {
    const row = this.byHash.get(this.hash(handle));
    if (!row) return null;
    row.projection = this.project(row, projection);
    row.viewRevision += 1;
    this.emit(row, { type: "view", revision: row.viewRevision, projection: row.projection });
    return row.viewRevision;
  }

  updateStream(streamId: string, head: number, projection: RuntimeJson): void {
    for (const row of this.byHash.values()) {
      if (row.streamId !== streamId) continue;
      row.head = head;
      // Durable App state and ephemeral resource data have different owners.
      // A pin committed in another tab updates the former without erasing this
      // tab's roster/transcript cache from the instance projection.
      row.projection = this.project(row, mergeProjection(row.projection, projection));
      row.viewRevision += 1;
      this.emit(row, { type: "view", revision: row.viewRevision, projection: row.projection });
    }
  }

  /**
   * A trusted coordinator's read-only inventory for deriving per-viewer frames.
   * The returned ids are not handles and cannot be resolved by a caller; they
   * only let the same coordinator replace each live row after an async fold.
   */
  allBindings(): readonly SessionPlusInstanceBinding[] { return [...this.byHash.values()].map(publicBinding); }

  bindingsForStream(streamId: string): readonly SessionPlusInstanceBinding[] {
    return [...this.byHash.values()]
      .filter((row) => row.streamId === streamId)
      .map(publicBinding);
  }

  /** Replace one viewer's durable projection after a personalised fold. */
  updateStreamBinding(instanceId: string, streamId: string, head: number, projection: RuntimeJson): boolean {
    for (const row of this.byHash.values()) {
      if (row.id !== instanceId || row.streamId !== streamId) continue;
      row.head = head;
      row.projection = this.project(row, projection);
      row.viewRevision += 1;
      this.emit(row, { type: "view", revision: row.viewRevision, projection: row.projection });
      return true;
    }
    return false;
  }

  /**
   * Record one control-plane operation in the tab's ephemeral projection and
   * publish it as its own SSE event. Operation rows are durable in the bot DB,
   * not in the App event log; this mirror only makes reconnect/render cheap.
   */
  recordOperation(instanceId: string, operation: RuntimeJson): boolean {
    for (const row of this.byHash.values()) {
      if (row.id !== instanceId) continue;
      const projection = asObject(row.projection);
      const current = Array.isArray(projection.operations) ? projection.operations : [];
      const opId = asObject(operation).id;
      const next = [operation, ...current.filter((entry) => asObject(entry).id !== opId)].slice(0, 100);
      row.projection = this.project(row, { ...projection, operations: next });
      if (!Array.isArray(asObject(row.projection).operations) || !(asObject(row.projection).operations as RuntimeJson[]).some((entry) => asObject(entry).id === opId)) return true;
      this.emit(row, { type: "op", operation });
      return true;
    }
    return false;
  }

  /**
   * Publish one content-free wake to one instance's listeners.
   *
   * Addressed by instance id like `recordOperation`, because the caller is a
   * trusted seam (the CRDT wake hub via the coordinator) that never holds a
   * handle. Nothing in the projection changes: a wake is a hint about a
   * RESOURCE, not App state, and recording it would turn "allowed to drop"
   * into "something reconnect has to replay".
   */
  wake(instanceId: string, binding: string, ref: string): boolean {
    for (const row of this.byHash.values()) {
      if (row.id !== instanceId) continue;
      this.emit(row, { type: "wake", binding, ref });
      return true;
    }
    return false;
  }

  /**
   * Persist and publish a trusted-chrome-only release transition.
   *
   * Agent turns have no browser chrome, so a release transition closes them
   * immediately instead of leaving a half-old turn alive. A repeated browser
   * transition is a no-op, while promoting a binding's own digest clears an
   * older reconnect marker instead of replaying a false "new version" signal.
   */
  markReleaseAvailable(input: { availableDigest: string; mode: ReleaseAvailabilityMode }): number {
    let notified = 0;
    for (const [key, row] of [...this.byHash]) {
      if (row.actorKind !== "user") {
        if (row.packageDigest !== input.availableDigest) this.destroyKey(key, "instance_stale");
        continue;
      }
      if (row.packageDigest === input.availableDigest) {
        delete row.availableDigest;
        delete row.availableMode;
        continue;
      }
      if (row.availableDigest === input.availableDigest && row.availableMode === input.mode) continue;
      row.availableDigest = input.availableDigest;
      row.availableMode = input.mode;
      this.emit(row, releaseAvailableEvent(row));
      notified += 1;
    }
    return notified;
  }

  subscribe(handle: string, principal: SessionPlusPrincipal, listener: InstanceListener): InstanceSubscription | null {
    const located = this.locate(handle, principal);
    if (!located.ok) return null;
    const { key, row } = located;
    // `refresh_required` deliberately makes the old release unservable for
    // dispatch. Its chrome notification is still reconnectable until the tab
    // closes, submits (and gets stale), or reaches its ordinary TTL.
    if (!this.servableDigests().has(row.packageDigest) && !row.availableDigest) {
      this.destroyKey(key, "instance_stale");
      return null;
    }
    row.listeners.add(listener);
    return {
      initial: { type: "view", revision: row.viewRevision, projection: row.projection },
      releaseAvailable: row.availableDigest && row.availableMode ? releaseAvailableEvent(row) : null,
      close: () => row.listeners.delete(listener),
    };
  }

  destroy(handle: string, principal: SessionPlusPrincipal, reason = "explicit_close"): boolean {
    const resolved = this.resolve(handle, principal);
    if (!resolved.ok) return false;
    return this.destroyKey(this.hash(handle), reason);
  }

  /** Destroy one trusted inventory row without exposing its bearer handle. */
  destroyBinding(instanceId: string, reason: string): boolean {
    for (const [key, row] of this.byHash) {
      if (row.id === instanceId) return this.destroyKey(key, reason);
    }
    return false;
  }

  releaseCredential(owner: string, credential: string): number {
    this.cancelReservations((row) => row.owner === owner && row.credential === credential);
    let count = 0;
    for (const [key, row] of [...this.byHash]) {
      if (row.owner !== owner || row.credential !== credential) continue;
      if (this.destroyKey(key, "credential_ended")) count += 1;
    }
    return count;
  }

  releaseOwner(owner: string, reason = "owner_ended"): number {
    this.cancelReservations((row) => row.owner === owner);
    let count = 0;
    for (const [key, row] of [...this.byHash]) {
      if (row.owner !== owner) continue;
      if (this.destroyKey(key, reason)) count += 1;
    }
    return count;
  }

  /** End live tabs over one durable stream, optionally for only one member. */
  releaseStream(streamId: string, reason: string, owner?: string): number {
    let count = 0;
    for (const [key, row] of [...this.byHash]) {
      if (row.streamId !== streamId || (owner && row.owner !== owner)) continue;
      if (this.destroyKey(key, reason)) count += 1;
    }
    return count;
  }

  reapExpired(): number {
    let count = 0;
    const now = this.now();
    // Also gives a versioned host a bounded sweep even when no tab reconnects
    // or dispatches after a retained Runtime was forcibly retired. A binding
    // carrying a release notification is retained for reconnect; it still has
    // the same TTL and dispatch still destroys it as stale.
    const servableDigests = this.servableDigests();
    for (const [key, row] of [...this.byHash]) {
      if (!servableDigests.has(row.packageDigest) && !row.availableDigest) {
        if (this.destroyKey(key, "instance_stale")) count += 1;
        continue;
      }
      if (row.expiresAt > now) continue;
      if (this.destroyKey(key, "instance_expired")) count += 1;
    }
    return count;
  }

  stop(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    this.cancelReservations(() => true);
    for (const key of [...this.byHash.keys()]) this.destroyKey(key, "service_stopped");
  }

  get size(): number {
    return this.byHash.size;
  }

  private destroyKey(key: string, reason: string): boolean {
    const row = this.byHash.get(key);
    if (!row) return false;
    this.byHash.delete(key);
    try { this.onDestroyed(publicBinding(row), reason); } catch { /* the record is already closed */ }
    this.emit(row, { type: "closed", reason });
    row.listeners.clear();
    return true;
  }

  private cancelReservations(matches: (row: StoredReservation) => boolean): void {
    for (const row of [...this.reservations]) {
      if (!matches(row)) continue;
      row.active = false;
      this.reservations.delete(row);
    }
  }

  private emit(row: StoredInstance, event: InstanceEvent): void {
    for (const listener of [...row.listeners]) {
      try { listener(event); } catch { /* one disconnected stream does not affect its siblings */ }
    }
  }

  /** Resolve identity and TTL without asking whether the bound release may dispatch. */
  private locate(
    handle: string,
    principal: SessionPlusPrincipal,
  ):
    | { ok: true; key: string; row: StoredInstance }
    | { ok: false; code: "invalid_instance" | "instance_expired" } {
    if (!handle || handle.length !== 48) return { ok: false, code: "invalid_instance" };
    const key = this.hash(handle);
    const row = this.byHash.get(key);
    if (!row || row.owner !== principal.owner || row.credential !== principal.credential
      || row.delegation?.shareId !== principal.delegation?.shareId || row.delegation?.viewer !== principal.delegation?.viewer) {
      return { ok: false, code: "invalid_instance" };
    }
    const actor = principalActor(principal);
    // The actor kind is part of the identity, not a decoration: an agent turn's
    // handle must not be resolvable by a browser principal or the reverse, even
    // when the credential strings happen to line up. The presence class is the
    // same statement about the other axis — a browser tab's handle is not
    // resolvable by a non-browser holder, and an external host's handle is not
    // resolvable by a browser principal.
    if (actorKey(actor) !== actorKey(row.actor) || principalPresence(principal) !== row.presence) {
      return { ok: false, code: "invalid_instance" };
    }
    if (row.expiresAt <= this.now()) {
      this.destroyKey(key, "instance_expired");
      return { ok: false, code: "instance_expired" };
    }
    return { ok: true, key, row };
  }
}

function mergeProjection(current: RuntimeJson, durable: RuntimeJson): RuntimeJson {
  if (
    current && durable
    && typeof current === "object" && !Array.isArray(current)
    && typeof durable === "object" && !Array.isArray(durable)
  ) {
    return { ...(current as Record<string, RuntimeJson>), ...(durable as Record<string, RuntimeJson>) };
  }
  return durable;
}

function asObject(value: RuntimeJson): Record<string, RuntimeJson> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, RuntimeJson>
    : {};
}

function hashHandle(handle: string, stableAppId: string): string {
  return createHash("sha256").update(`${stableAppId}-instance:${handle}`).digest("hex");
}

function publicBinding(row: StoredInstance): SessionPlusInstanceBinding {
  return {
    id: row.id,
    owner: row.owner,
    ...(row.delegation ? { delegation: { ...row.delegation } } : {}),
    credential: row.credential,
    actorKind: row.actorKind,
    actor: cloneActor(row.actor),
    presence: row.presence,
    stableAppId: row.stableAppId,
    ...(row.sharedInstanceKey ? { sharedInstanceKey: row.sharedInstanceKey } : {}),
    packageDigest: row.packageDigest,
    contractDigest: row.contractDigest,
    ...(row.availableDigest ? { availableDigest: row.availableDigest } : {}),
    ...(row.availableMode ? { availableMode: row.availableMode } : {}),
    streamId: row.streamId,
    viewRevision: row.viewRevision,
    head: row.head,
    projection: row.projection,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function cloneActor(actor: SessionPlusActor): SessionPlusActor {
  return actor.kind === "user" ? { kind: "user" } : { ...actor };
}

function actorKey(actor: SessionPlusActor): string {
  return actor.kind === "user"
    ? "user"
    : JSON.stringify([actor.kind, actor.app, actor.agent, actor.turnId, actor.role ?? null]);
}

function releaseAvailableEvent(
  row: Pick<StoredInstance, "packageDigest" | "availableDigest" | "availableMode">,
): Extract<InstanceEvent, { type: "release_available" }> {
  if (!row.availableDigest || !row.availableMode) throw new Error("release availability is incomplete");
  return {
    type: "release_available",
    current_package_digest: row.packageDigest,
    available_package_digest: row.availableDigest,
    mode: row.availableMode,
  };
}
