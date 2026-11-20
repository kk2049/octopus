/**
 * What a resource provider is, from the catalog's point of view.
 *
 * ── The shape is deliberately small ────────────────────────────────────────
 *
 * A provider says which contract it satisfies, which actions it serves, how to
 * open one scope, how to dispatch one action, and how to close. It is NOT a
 * plugin: nothing here is discovered, downloaded, imported by name or supplied
 * by an App. A deployment `register()`s the ones it composed in and `seal()`s
 * the catalog, which is the same rule Backstage's backend instance follows —
 * plugins declare dependencies, the instance decides what satisfies them.
 *
 * ── Why the context is closure-bound rather than passed per call ────────────
 *
 * `open()` receives the owner, the app, the release digest and the lifetime key
 * ONCE, and the port it returns is bound to them. A dispatcher that passed an
 * owner on every call would be a dispatcher where one forgotten argument is a
 * cross-account read; here there is no argument to forget, because a proposal
 * carries a binding name and an opaque ref and nothing else.
 *
 * The same rule holds one layer up: `ResourceScopeIdentity` is supplied ONCE, to
 * `AgentResourceCatalog.openInstance()`, which snapshots it and returns a handle
 * with `dispatch(proposal)` and `close()`. There is no public entry point that
 * takes an identity next to a proposal.
 */

import type { ResourceBindingPlan } from "@claude-bot/agent-module-contract";

/**
 * Every way the catalog itself can refuse, before any provider is reached.
 *
 * Drawn from the shared refusal vocabulary the typed contracts already use, so a
 * client can render them without a second mapping table:
 *
 *   invalid_request  the proposal named a binding or an action this plan and
 *                    this provider do not have
 *   no_authority     no provider is installed for that contract, or this scope
 *                    holds nothing over it
 *   scope_closed     the scope has ended, or the catalog has
 *   unavailable      a provider failed. Never its message.
 */
export const RESOURCE_REFUSALS = Object.freeze([
  "invalid_request",
  "no_authority",
  "scope_closed",
  "unavailable",
] as const);

export type ResourceRefusalCode = (typeof RESOURCE_REFUSALS)[number];

/** One answer to one proposal. Everything resolves; nothing throws at a View. */
export type ResourceAnswer =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

/** Build a refusal with its text bounded the same way everywhere. */
export function resourceRefusal(code: string, message: string): ResourceAnswer {
  return {
    ok: false,
    code,
    message: message.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD").slice(0, 200),
  };
}

/**
 * The identity a trusted caller supplies ONCE, to `openInstance()`.
 *
 * Every field comes from the trusted side: `owner` from the authenticated
 * principal, `app` and `packageDigest` from the release the instance was bound
 * to, `instance` from the handle the shell issued. A proposal that carried any
 * of them would be ignored — the dispatcher does not read them, which is
 * stronger than checking them.
 *
 * The catalog SNAPSHOTS this: `plan` is read into a frozen binding→contract map
 * at open time, so a later mutation of the plan object cannot widen what an
 * already-bound handle may reach. `plan.app` must equal `app`, because a plan
 * for another App is not a partial match to resolve by precedence.
 */
export interface ResourceScopeIdentity {
  /** Authenticated principal. Never from a proposal. */
  owner: string;
  /**
   * Who vouches for the package. Part of the identity, not decoration.
   *
   * A stable app id is chosen by whoever publishes it, so two publishers may
   * pick the same one — and if the catalog keyed on the id alone, their
   * instances would share refs, streams, scopes and retirement records. It is
   * compared and used as a key component; it is never resolved into anything.
   */
  publisher: string;
  /** Stable app id. Compared, never resolved. */
  app: string;
  /** Release identity of the package this instance is running. */
  packageDigest: string;
  /**
   * WHICH permission contract this release declared, as agreed to.
   *
   * It travels with the instance rather than being looked up per call, and that
   * is the point: a provider that asked "what is the newest contract for this
   * app right now" would silently re-interpret an instance that was opened —
   * and consented to — under an older, narrower ask. An already-open instance
   * keeps the contract it was opened with until it is closed.
   */
  permissionContractDigest: string;
  /**
   * The lifetime this instance belongs to — one browser tab's App instance
   * today.
   *
   * A caller whose lifetime is narrower (per credential, per run) encodes that
   * here; the catalog derives every provider scope key from it together with the
   * owner and the app, so two callers cannot collide on one key by choosing the
   * same string. An instance id is used once: after it closes, it is retired.
   */
  instance: string;
  /**
   * The App's `agent-resource-bindings` plan, as released — either schema.
   *
   * The catalog reads `app` and `bindings` and nothing else. v2's `templates`
   * are a LAYOUT statement: a derived panel inherits an existing binding name,
   * and a provider scope is keyed by `[owner, app, instance, binding]`, so a
   * family of twelve panels is one scope, one ref vault, one grant. Nothing
   * here needs to know they exist, and it stays that way on purpose.
   */
  plan: ResourceBindingPlan;
}

/** What one opened scope was opened FOR. Bound into the port at `open()`. */
export interface ResourceProviderContext {
  readonly owner: string;
  /** The publisher of the release this scope belongs to. Echoed exactly. */
  readonly publisher: string;
  readonly app: string;
  readonly packageDigest: string;
  /**
   * The exact permission contract this instance was opened under. A provider's
   * grant resolver selects a KNOWN contract by this digest; it must not consult
   * whatever contract is active at the moment of a call.
   */
  readonly permissionContractDigest: string;
  readonly instance: string;
  /** The App-local binding name this port satisfies. */
  readonly binding: string;
  /** The contract that binding declared. */
  readonly contract: string;
  /** The key the provider scopes refs and streams by. Derived, never supplied. */
  readonly scope: string;
}

/**
 * A provider the deployment installed.
 *
 * `P` is the provider's own per-scope state. The catalog is type-erased over it
 * internally — it never looks inside — which is what lets one dispatcher serve
 * providers that share nothing.
 */
export interface ResourceProviderDefinition<P = unknown> {
  /** Exact contract id. Looked up by equality; there is no range resolution. */
  readonly contract: string;
  /**
   * The closed action set. An action outside it is refused before the provider
   * is touched, which is why there is no generic `invoke` on this interface: a
   * provider cannot be asked to do something it did not enumerate.
   */
  readonly actions: readonly string[];
  /**
   * Open one scope, or return null when this scope holds nothing.
   *
   * Synchronous on purpose: deriving a capability is a synchronous decision, and
   * an awaited open would create a window in which a close could interleave with
   * a half-opened scope.
   */
  open(context: ResourceProviderContext): P | null;
  /** Serve one action. Must resolve; a throw is turned into `unavailable`. */
  dispatch(
    state: P,
    action: string,
    params: Readonly<Record<string, string>>,
    context: ResourceProviderContext,
  ): Promise<ResourceAnswer>;
  /**
   * End the scope.
   *
   * Whatever makes new work impossible must happen SYNCHRONOUSLY, before the
   * returned promise: the catalog's callers rely on "closed on return" while the
   * release of what is already open continues afterwards.
   */
  close(state: P, context: ResourceProviderContext): void | Promise<void>;
}

/** One proposal, as the trusted shell received it. */
export interface ResourceProposal {
  action: string;
  params: Readonly<Record<string, string>>;
}
