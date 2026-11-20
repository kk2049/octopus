/**
 * The trusted provider catalog: what this deployment installed, and the bound
 * handles that serve it.
 *
 * ── Static, sealed, and exact ──────────────────────────────────────────────
 *
 * A composition root registers the providers it composed in and seals the
 * catalog. After that nothing can be added, and there is no watcher, no
 * `npm install`, no URL import and no App-supplied callback — an App declares a
 * NEED (`agent-resource-bindings/v1`) and the deployment decides what satisfies
 * it. Lookup is by exact contract id; an unknown contract is a bounded refusal
 * and never a fallback onto some general-purpose Runner, MCP or HTTP proxy,
 * because a fallback is how "this App has no file access" quietly becomes "this
 * App has whatever the proxy has".
 *
 * ── Identity is bound ONCE, not passed per call ────────────────────────────
 *
 * `openInstance(identity)` registers one (owner, publisher, app, instance) and returns a
 * narrow handle whose only methods are `dispatch(proposal)` and `close()`. There
 * is no public entry point that takes an identity alongside a proposal, and that
 * is the point rather than ergonomics — three things follow from it that a
 * per-call identity cannot give:
 *
 *  · **An instance exists before it reads anything.** A tab that was closed
 *    before its first resource call is a REGISTERED, then RETIRED, instance; a
 *    late message on its channel finds a closed handle. With lazy registration
 *    the same message would have opened a provider for the first time, minutes
 *    after the tab was gone.
 *  · **A device-set change can tell two tabs apart.** `closeOwner` retires every
 *    handle this owner holds, including the ones that never read anything. A
 *    catalog that only knew about OPENED scopes could not distinguish "an old tab
 *    that has not called yet" from "a new tab", because neither has a scope.
 *  · **The plan is a snapshot.** `identity.plan` is read once, into a frozen
 *    binding→contract map. A later mutation of that object — by anything holding
 *    a reference to it — cannot change what an already-bound handle may reach.
 *
 * ── The dispatcher's four questions, in order ──────────────────────────────
 *
 *   1. which binding? — from the handle's SNAPSHOT of the App's plan;
 *   2. which contract? — the one that binding DECLARED, never one the proposal
 *      named;
 *   3. which provider? — the exact installed one, or a refusal;
 *   4. is this action in that provider's closed set?
 *
 * Only then is a scope opened (lazily, on first use, the way an activation
 * condition works) and the action served. A View that forges a wire string
 * therefore reaches step 1 with a name the plan does not contain, and stops.
 *
 * ── What a scope key is ────────────────────────────────────────────────────
 *
 * Derived — `[owner, publisher, app, instance, binding]` — never supplied. A
 * caller that could choose the key could choose another caller's, and refs and
 * streams are scoped by exactly this string inside the provider.
 *
 * The publisher is in it because a stable app id is chosen by whoever publishes
 * one: two publishers may pick `notes`, and without the publisher their
 * instances would collide on one key and share refs, streams and retirement
 * records. Framing is JSON array, so no component can impersonate a boundary.
 *
 * ── Closing ───────────────────────────────────────────────────────────────
 *
 * `handle.close()`, `closeInstance`, `closeOwner` and `shutdown` all funnel into
 * one teardown per instance. The handle is marked closed and its key retired
 * SYNCHRONOUSLY, and the providers' `close` is called synchronously, so by the
 * time any of them RETURNS nothing new can start; the promise they hand back is
 * only the release of what was already open. Every caller of a teardown that is
 * already in flight awaits the SAME promise.
 *
 * A provider's `close` failing does not fail the teardown: it is logged and
 * swallowed. There is nobody left to tell, the instance is already unreachable,
 * and letting it propagate would make a revocation look like it did not happen.
 *
 * A retired instance key cannot open again inside a bounded replay window. The
 * durable invariant lives one layer up: the trusted coordinator issues a fresh,
 * unguessable instance id for every new tab/generation and never deliberately
 * reuses one. Keeping tombstones forever would turn normal tab churn into a
 * process-memory DoS; this catalog therefore retains a 24-hour/16k safety net
 * for late callbacks and accidental immediate reuse, not a persistent nonce
 * database. A handle that was actually closed remains closed forever regardless
 * of tombstone expiry.
 */

import { isContractId, type ResourceBindingPlan } from "@claude-bot/agent-module-contract";
import { createLogger } from "../logger.js";
import {
  resourceRefusal,
  type ResourceAnswer,
  type ResourceProposal,
  type ResourceProviderContext,
  type ResourceProviderDefinition,
  type ResourceScopeIdentity,
} from "./types.js";

const log = createLogger("agent-resources");

/**
 * An action id, as a provider may declare it.
 *
 * Bounded and printable so a descriptor cannot smuggle whitespace, a control
 * character or a path-shaped string into a comparison somewhere downstream. It
 * is compared and nothing else.
 */
const ACTION_ID = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * A provider as the catalog holds it: a SNAPSHOT taken at registration.
 *
 * The contract string, the action set and the three methods are all captured
 * here, so mutating the descriptor object afterwards — swapping `actions` for a
 * wider array, repointing `dispatch` — changes nothing about what this catalog
 * serves.
 */
interface InstalledProvider {
  readonly contract: string;
  readonly actions: ReadonlySet<string>;
  readonly open: (context: ResourceProviderContext) => unknown;
  readonly dispatch: (
    state: unknown,
    action: string,
    params: Readonly<Record<string, string>>,
    context: ResourceProviderContext,
  ) => Promise<ResourceAnswer>;
  readonly close: (state: unknown, context: ResourceProviderContext) => void | Promise<void>;
}

interface OpenScope {
  context: ResourceProviderContext;
  provider: InstalledProvider;
  state: unknown;
}

/** One registered App instance: the trusted record everything else hangs off. */
interface BoundInstance {
  readonly key: string;
  readonly owner: string;
  readonly publisher: string;
  readonly app: string;
  readonly packageDigest: string;
  readonly permissionContractDigest: string;
  readonly instance: string;
  /** Frozen at `openInstance`. A later mutation of the plan cannot reach this. */
  readonly bindings: ReadonlyMap<string, string>;
  closed: boolean;
  /** binding → the scope opened for it. */
  readonly scopes: Map<string, OpenScope>;
  /** The one teardown, shared by every caller that asks for it. */
  teardown: Promise<void> | null;
}

/**
 * What a trusted shell holds for one App instance.
 *
 * Two methods, and no way to name another instance, another owner or another
 * plan. Whatever else the shell has, it cannot use THIS object to reach beyond
 * the instance it was issued for.
 */
export interface AgentResourceInstance {
  /** Serve one proposal. Everything resolves; nothing throws at a View. */
  dispatch(proposal: ResourceProposal): Promise<ResourceAnswer>;
  /**
   * End this instance. Idempotent, and it joins a teardown already in flight
   * rather than starting a second one.
   */
  close(): Promise<void>;
}

/** A length-preserving tuple, so no component can impersonate a boundary. */
function instanceKey(owner: string, publisher: string, app: string, instance: string): string {
  return JSON.stringify([owner, publisher, app, instance]);
}

function scopeKey(record: BoundInstance, binding: string): string {
  return JSON.stringify([record.owner, record.publisher, record.app, record.instance, binding]);
}

function required(value: unknown, what: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`资源实例缺少 ${what}`);
  return text;
}

/**
 * A publisher name, as an identity component.
 *
 * Bounded and printable, with no whitespace and no quoting characters, because
 * it goes into a key next to an owner and an app id. It is compared and framed;
 * nothing here resolves it, fetches it, or looks it up in a directory.
 */
const PUBLISHER_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;

/** The registry's package digest: sha256, lower-case hex, spelled one way. */
const PACKAGE_DIGEST = /^[0-9a-f]{64}$/;

/**
 * The permission contract digest, as an OPAQUE identifier.
 *
 * Deliberately not pinned to one width: it is computed by the permission layer
 * (`contractDigestOf`, currently a 32-hex framing), and this layer only ever
 * compares it and passes it to a grant resolver. Asserting a length here would
 * be this file having an opinion about another layer's hash, which is how a
 * correct digest ends up rejected the day that framing changes.
 *
 * What it DOES enforce is that the value is a bounded lower-case hex token —
 * enough that it cannot smuggle whitespace, a separator or a path-shaped string
 * into a key or a log line.
 */
const CONTRACT_DIGEST = /^[0-9a-f]{16,128}$/;

/**
 * Check one identity field's SHAPE, loudly.
 *
 * These arrive from trusted composition code, so a malformed one is a bug in
 * this build rather than hostile input — and the honest reaction to a bug in the
 * thing that decides WHICH release and WHICH permission contract an instance
 * runs under is to refuse to open it. Falling back to a default publisher or a
 * default contract would be inventing an answer to the only two questions the
 * grant resolver has.
 */
function checked(value: unknown, pattern: RegExp, what: string): string {
  const text = required(value, what);
  if (!pattern.test(text)) throw new Error(`资源实例的 ${what} 格式非法`);
  return text;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export class AgentResourceCatalog {
  private readonly providers = new Map<string, InstalledProvider>();
  private readonly instances = new Map<string, BoundInstance>();
  /** Records whose teardown has started and not finished. */
  private readonly settling = new Set<BoundInstance>();
  /** Recently closed keys: a bounded late-callback/accidental-reuse window. */
  private readonly retired = new Map<string, number>();
  private sealed = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly retiredTtlMs: number;
  private readonly maxRetired: number;

  constructor(options: { now?: () => number; retiredTtlMs?: number; maxRetired?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.retiredTtlMs = positiveInteger(options.retiredTtlMs, 24 * 60 * 60_000);
    this.maxRetired = positiveInteger(options.maxRetired, 16_384);
  }

  /**
   * Install one provider. Startup only.
   *
   * Duplicates, late registrations and malformed descriptors throw rather than
   * refuse: all three are programming errors in trusted composition code, and a
   * deployment that silently ran with the wrong provider — or without one it
   * thought it had — is worse than one that does not start.
   */
  register<P>(definition: ResourceProviderDefinition<P>): void {
    if (this.sealed) throw new Error(`资源目录已封存，不能再注册 ${String(definition?.contract ?? "")}`);
    const contract = String(definition?.contract ?? "").trim();
    if (!contract || !isContractId(contract)) {
      throw new Error(`provider 的契约 id 非法：${JSON.stringify(definition?.contract ?? null)}`);
    }
    if (this.providers.has(contract)) throw new Error(`资源契约 ${contract} 已经有一个 provider`);
    const declared = definition.actions;
    if (!Array.isArray(declared) || declared.length === 0) {
      throw new Error(`provider ${contract} 必须声明至少一个 action`);
    }
    const actions = new Set<string>();
    for (const action of declared) {
      if (typeof action !== "string" || !ACTION_ID.test(action)) {
        throw new Error(`provider ${contract} 声明了一个非法 action：${JSON.stringify(action)}`);
      }
      if (actions.has(action)) throw new Error(`provider ${contract} 的 action 列表里有重复项：${action}`);
      actions.add(action);
    }
    for (const method of ["open", "dispatch", "close"] as const) {
      if (typeof definition[method] !== "function") {
        throw new Error(`provider ${contract} 缺少 ${method}()`);
      }
    }
    // Snapshot, including WHICH functions these are: the references are read
    // once, here, so repointing `definition.dispatch` after `seal()` changes
    // nothing. `.call(definition, …)` keeps `this` working for a provider
    // written as a class, without making the lookup late.
    const openFn = definition.open as (this: unknown, context: ResourceProviderContext) => unknown;
    const dispatchFn = definition.dispatch as (
      this: unknown,
      state: unknown,
      action: string,
      params: Readonly<Record<string, string>>,
      context: ResourceProviderContext,
    ) => Promise<ResourceAnswer>;
    const closeFn = definition.close as (
      this: unknown,
      state: unknown,
      context: ResourceProviderContext,
    ) => void | Promise<void>;
    this.providers.set(contract, {
      contract,
      actions,
      open: (context) => openFn.call(definition, context),
      dispatch: (state, action, params, context) => dispatchFn.call(definition, state, action, params, context),
      close: (state, context) => closeFn.call(definition, state, context),
    });
  }

  /** No more registration. Called once the composition root has finished. */
  seal(): void {
    this.sealed = true;
  }

  /** Diagnostics and startup inventory: which contracts this build can serve. */
  contracts(): string[] {
    return [...this.providers.keys()].sort();
  }

  /**
   * Whether a plan's every declared binding can be satisfied by this catalog.
   *
   * For a release adapter: a plan naming a contract nobody installed is a
   * candidate that would half-work, and half-working is the outcome the whole
   * fail-closed posture exists to avoid. It is a QUESTION, not a grant — being
   * able to serve a contract is not the same as any account being allowed to.
   */
  missingContracts(plan: ResourceBindingPlan): string[] {
    return plan.bindings.filter((row) => !this.providers.has(row.contract)).map((row) => row.contract);
  }

  /** Test/diagnostics: how many instances are registered, and scopes open. */
  get openInstances(): number {
    return this.instances.size;
  }

  get openScopes(): number {
    let total = 0;
    for (const record of this.instances.values()) total += record.scopes.size;
    return total;
  }

  /** Diagnostics/tests: bounded recent one-shot identities. */
  get retiredInstances(): number {
    this.pruneRetired();
    return this.retired.size;
  }

  /**
   * Register one App instance and hand back its handle.
   *
   * Throws rather than refusing, in every case: the caller is trusted
   * composition code, and each of these is a bug in it — an unsealed catalog, a
   * stopped process, a plan that belongs to another App, a blank identity, or an
   * instance id that has already been used. Refusing quietly would leave a shell
   * believing it had resources it does not have.
   */
  openInstance(identity: ResourceScopeIdentity): AgentResourceInstance {
    if (!this.sealed) throw new Error("资源目录尚未封存，不能打开实例");
    if (this.stopped) throw new Error("资源目录已经停止");
    const owner = required(identity?.owner, "owner");
    const publisher = checked(identity?.publisher, PUBLISHER_ID, "publisher");
    const app = required(identity?.app, "app");
    const packageDigest = checked(identity?.packageDigest, PACKAGE_DIGEST, "packageDigest");
    const permissionContractDigest = checked(
      identity?.permissionContractDigest,
      CONTRACT_DIGEST,
      "permissionContractDigest",
    );
    const instance = required(identity?.instance, "instance");
    const plan = identity?.plan;
    if (!plan || plan.app !== app) {
      // A plan for another App is not a partial match to resolve by precedence.
      // It is this instance being handed somebody else's wiring.
      throw new Error(`资源计划属于 ${String(plan?.app ?? "")}，与实例的 app ${app} 不符`);
    }
    const key = instanceKey(owner, publisher, app, instance);
    this.pruneRetired();
    if (this.retired.has(key)) throw new Error("这个资源实例已经结束，不能重开");
    if (this.instances.has(key)) throw new Error("这个资源实例已经打开过");

    const bindings = new Map<string, string>();
    for (const row of plan.bindings) bindings.set(row.binding, row.contract);
    const record: BoundInstance = {
      key,
      owner,
      publisher,
      app,
      packageDigest,
      permissionContractDigest,
      instance,
      bindings,
      closed: false,
      scopes: new Map(),
      teardown: null,
    };
    this.instances.set(key, record);

    return {
      dispatch: (proposal) => this.serve(record, proposal),
      close: () => this.closeRecord(record),
    };
  }

  /**
   * End every resource this App instance holds, whether or not it ever read
   * anything. A no-op for an instance that was never opened.
   */
  closeInstance(identity: {
    owner: string;
    publisher: string;
    app: string;
    instance: string;
  }): Promise<void> {
    const record = this.instances.get(
      instanceKey(
        String(identity.owner ?? ""),
        String(identity.publisher ?? ""),
        String(identity.app ?? ""),
        String(identity.instance ?? ""),
      ),
    );
    return record ? this.closeRecord(record) : Promise.resolve();
  }

  /**
   * End every instance this owner holds, across Apps and tabs.
   *
   * The teardown half of a revocation and of a device-set change. It is
   * synchronous in the sense that matters: on return, no handle of this owner
   * answers — including one that had never read anything — whatever the returned
   * promise is still releasing.
   */
  closeOwner(owner: string): Promise<void> {
    const name = String(owner ?? "");
    return this.closeWhere((record) => record.owner === name);
  }

  /** Stop for good. After this the catalog refuses everything, permanently. */
  shutdown(): Promise<void> {
    this.stopped = true;
    return this.closeWhere(() => true);
  }

  // ── the dispatcher ──

  private async serve(record: BoundInstance, proposal: ResourceProposal): Promise<ResourceAnswer> {
    if (this.stopped || record.closed) {
      return resourceRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
    }
    const binding = String(proposal?.params?.binding ?? "");
    // From the SNAPSHOT, not from a plan object somebody else may still hold.
    const contract = binding ? record.bindings.get(binding) : undefined;
    if (!contract) {
      return resourceRefusal("invalid_request", "这个视图请求了一个本应用没有声明的资源绑定。");
    }
    const provider = this.providers.get(contract);
    if (!provider) {
      // Installed, not authorised: this deployment composed no provider for the
      // contract the App asked for. There is deliberately no generic fallback.
      return resourceRefusal("no_authority", "本部署没有为这个资源契约安装 provider。");
    }
    const action = String(proposal?.action ?? "");
    if (!provider.actions.has(action)) {
      return resourceRefusal("invalid_request", "这个资源不支持被请求的动作。");
    }

    let open = record.scopes.get(binding);
    if (!open) {
      // Lazy: a scope exists from its first use, not from the moment a plan
      // mentions it. Opening derives a capability, and deriving one for a panel
      // nobody looked at is authority nobody asked for.
      const context: ResourceProviderContext = Object.freeze({
        owner: record.owner,
        publisher: record.publisher,
        app: record.app,
        packageDigest: record.packageDigest,
        permissionContractDigest: record.permissionContractDigest,
        instance: record.instance,
        binding,
        contract,
        scope: scopeKey(record, binding),
      });
      let state: unknown;
      try {
        state = provider.open(context);
      } catch (err) {
        log.error({ err, contract, owner: record.owner }, "resource provider failed to open");
        return resourceRefusal("unavailable", "这个资源暂时无法打开。");
      }
      if (state === null || state === undefined) {
        return resourceRefusal("no_authority", "当前登录没有读取这个资源的权限。");
      }
      // `open()` is synchronous, so nothing could have closed in between — but
      // the check costs a comparison and removes the question.
      if (this.stopped || record.closed) {
        void Promise.resolve(provider.close(state, context)).catch(() => undefined);
        return resourceRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
      }
      open = { context, provider, state };
      record.scopes.set(binding, open);
    }

    try {
      return await open.provider.dispatch(open.state, action, proposal.params ?? {}, open.context);
    } catch (err) {
      // A provider that throws is a bug, and its message must not reach a View:
      // an exception on this path is the one field that reliably carries a
      // canonical path out of the trusted side.
      log.error({ err, contract, action, owner: record.owner }, "resource provider threw");
      return resourceRefusal("unavailable", "这个资源暂时无法完成这次读取。");
    }
  }

  // ── teardown ──

  private closeWhere(match: (record: BoundInstance) => boolean): Promise<void> {
    const waiting: Promise<void>[] = [];
    for (const record of [...this.instances.values()]) {
      if (match(record)) waiting.push(this.closeRecord(record));
    }
    // Join teardowns already in flight for instances this call also matched: a
    // caller that awaits "this owner is closed" must have waited for the whole
    // release, not only for the ones it happened to start itself.
    for (const record of this.settling) {
      if (record.teardown && match(record)) waiting.push(record.teardown);
    }
    return Promise.all(waiting).then(() => undefined);
  }

  private closeRecord(record: BoundInstance): Promise<void> {
    if (record.teardown) return record.teardown;
    // Everything that makes new work impossible happens HERE, synchronously,
    // before the first await anywhere: mark closed, retire the key, drop the
    // registration, and take the scopes out of the record.
    record.closed = true;
    this.retire(record.key);
    this.instances.delete(record.key);
    const scopes = [...record.scopes.values()];
    record.scopes.clear();

    // Publish the shared teardown BEFORE calling any provider. `close()` is a
    // trusted callback, but it may synchronously trigger another lifecycle
    // close (for example, a provider wrapper asking the catalog to close its
    // instance). That re-entrant caller must join this release rather than see
    // `teardown === null`, start a second close and return early.
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    record.teardown = settled;
    this.settling.add(record);

    const releases = scopes.map((scope) => this.release(scope));
    void Promise.all(releases).then(() => finish());
    void settled.then(() => this.settling.delete(record));
    return settled;
  }

  private retire(key: string): void {
    this.pruneRetired();
    while (this.retired.size >= this.maxRetired) {
      const oldest = this.retired.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
    }
    this.retired.set(key, this.now() + this.retiredTtlMs);
  }

  private pruneRetired(): void {
    const at = this.now();
    for (const [key, expiresAt] of this.retired) {
      if (expiresAt <= at) this.retired.delete(key);
    }
  }

  /**
   * Release one scope. A provider that fails to close is logged and swallowed:
   * the instance is already unreachable, so there is nothing a caller could do
   * with the error except mistake a completed revocation for a failed one.
   */
  private release(scope: OpenScope): Promise<void> {
    try {
      return Promise.resolve(scope.provider.close(scope.state, scope.context))
        .then(() => undefined)
        .catch((err: unknown) => {
          log.error({ err, contract: scope.context.contract }, "resource provider close rejected");
        });
    } catch (err) {
      log.error({ err, contract: scope.context.contract }, "resource provider failed to close");
      return Promise.resolve();
    }
  }
}
