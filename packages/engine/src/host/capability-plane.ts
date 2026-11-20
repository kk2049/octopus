/**
 * A `HostCapabilityPlane` backed by the real kernel.
 *
 * The v3 Host owns no physical resource of its own — the Runner lives in the
 * bot process — so what this class contributes is the DERIVATION chain the
 * kernel spec asks for:
 *
 *     account authority (server-only)
 *       -> AppInstance Context   (created by the trusted launcher)
 *            -> ControllerRun Context (one dispatch)
 *            -> AgentRun Context      (one turn)
 *                 -> ControllerRun Context (one tool call)
 *
 * Each arrow is a `derive`, so rights can only stay the same or shrink, and
 * destroying any link kills everything below it. `authorityFor` is where a
 * deployment plugs in the Objects a user actually holds; with none registered
 * every `request()` denies, which is the correct default for a Host whose
 * apps have no business touching anything yet.
 */

import { CapabilityService, type ContextId, type Operation } from "@claude-bot/capability-kernel";
import type { ControllerRun } from "../dispatch.js";
import { DELIVERY_SLOT } from "./delivery.js";
import { contractDigestOf, type ContractVerdict, type GrantResolver, type PermissionContract } from "./versions.js";
import type { HostCapabilityPlane } from "./server.js";

const SLOT = "resources";

/**
 * Where a user's authority already lives.
 *
 * NOT "which Objects they hold" — that would mint a second root over the same
 * Object, and then revoking one root would leave the other working. The plane
 * derives from the account authority the resource's own control plane already
 * owns, so revocation has exactly one place to happen.
 */
export interface HostAuthority {
  /** The server-only account authority Context. Never handed to a browser. */
  contextId: string;
  /** The slot inside it that holds the resource capability. */
  slot: string;
}

export interface CapabilityPlaneOptions {
  service: CapabilityService;
  /**
   * Trusted lookup of what a user's account actually holds. Called once per
   * account; must derive from server-side facts, never from a request.
   */
  authorityFor: (username: string) => HostAuthority | null;
  /**
   * What an app may ask for, by app name. A manifest requirement is an
   * application, not a grant: the launcher intersects it with the account's
   * authority and materialises the result as the App Context.
   */
  appRequirements?: (app: string) => readonly Operation[];
  /** What one Controller may use of its App's rights. Defaults to all of them. */
  controllerRequirements?: (app: string, action: string) => readonly Operation[] | undefined;
  /** What one agent may use of its App's rights. Defaults to all of them. */
  agentRequirements?: (app: string, agent: string) => readonly Operation[] | undefined;
  /**
   * Which of an app's rights it may exercise WITHOUT a per-call human decision.
   *
   * Absent means NONE — every resource call the app makes queues an approval
   * card. That default is the opposite of the account root's, and deliberately:
   * an app here is code an agent wrote, hot-reloaded from a YAML directory,
   * running in a sandbox whose network isolation this host cannot always verify.
   * "It only reads" is not a reassurance when the thing choosing what to read is
   * a language model.
   *
   * An operator who wants a page to render without a click per row says so per
   * app, in the deployment config, where a human is the one typing.
   */
  appAutoAllow?: (app: string) => readonly Operation[];
  /**
   * The SECOND authority a v3 app can hold: controlled cross-scope transfer
   * (`host/delivery.ts`). It is a separate Object, a separate root and a
   * separate slot on purpose — "may reach my laptop" and "may put something in
   * someone else's mailbox" are not the same permission and must be grantable,
   * narrowable and revocable apart from each other.
   *
   * Absent = no app in this Host can send anything anywhere, which is the
   * correct default and the one the backlog asks for until a broker exists.
   */
  delivery?: DeliveryPlaneOptions;
  /**
   * What has actually been AUTHORISED, as opposed to what the app declares
   * (SEC-02). Absent = the declarations below are themselves the grant, which
   * is how this Host behaved before and is still the honest description of a
   * deployment whose only authorisation act is editing a config file.
   *
   * Supplied = every declaration is intersected with the recorded grant, so a
   * contract that WIDENS derives only the previously-agreed subset until
   * the configured resolver records the new one. Narrowing needs no consent
   * and takes effect immediately, because the intersection is smaller. The
   * authenticated account is passed to the resolver; deployment-wide ledgers
   * may deliberately ignore it.
   */
  grants?: GrantResolver;
  /**
   * Who published an app. A change here inherits nothing: a grant is to a
   * publisher and a contract, not to a name. Default: `first-party`, which is
   * the truth for a Host whose apps directory only an administrator can write.
   */
  publisherOf?: (app: string) => string;
}

/** The delivery source's half of the same four questions, plus the sender. */
export interface DeliveryPlaneOptions {
  /**
   * Usually `broker.authorityFor`. Takes the ACCOUNT authority Context,
   * because the delivery root is minted into it — see `DeliveryBroker`'s
   * docstring for why it cannot live in a Context of its own. Null = no sending.
   */
  authorityFor: (username: string, app: string, accountContextId: string) => HostAuthority | null;
  appRequirements?: (app: string) => readonly Operation[];
  /**
   * Narrow what this app may send without a decision per send.
   *
   * Absent = inherit the delivery root's terms, which are closed unless the
   * broker's `rootAutoAllow` opened them. So the safe default lives in ONE
   * place (the issuing side) instead of being restated here, and this option
   * exists to make one app stricter than the deployment's ceiling.
   */
  appAutoAllow?: (app: string) => readonly Operation[];
  controllerRequirements?: (app: string, action: string) => readonly Operation[] | undefined;
  agentRequirements?: (app: string, agent: string) => readonly Operation[] | undefined;
  /**
   * What an AGENT may send unsupervised. Defaults to NOTHING, and the default
   * is the point: terms attenuate down the derive chain, so an agent's run
   * Context — and every Controller it spawns — is capped here no matter how
   * freely the app itself may send when a human is doing the clicking.
   */
  agentAutoAllow?: (app: string, agent: string) => readonly Operation[];
}

/**
 * One authority a Context can hold, reduced to the questions the plane asks of
 * it. Two of these exist today (resources, delivery); the code below iterates
 * rather than branching so a third cannot be added to two of the three
 * lifecycle methods and forgotten in the fourth.
 */
interface AuthoritySource {
  /** The slot this authority is installed under ON THE APP CONTEXT. */
  slot: string;
  authority(username: string, app: string, accountContextId: string): HostAuthority | null;
  /** Undefined = "everything the parent holds"; a list = intersect with it. */
  appRights(app: string, owner: string): readonly Operation[] | undefined;
  appAutoAllow(app: string, owner: string): readonly Operation[] | undefined;
  controllerRights(app: string, action: string): readonly Operation[] | undefined;
  agentRights(app: string, agent: string): readonly Operation[] | undefined;
  /** Undefined = inherit the parent's terms; a list = narrow to it. */
  agentAutoAllow(app: string, agent: string): readonly Operation[] | undefined;
}

export class HostCapabilities implements HostCapabilityPlane {
  /**
   * (App Context, action) → the ControllerRun Context still waiting on a human.
   * Deliberately narrow: an entry only survives while that Context is live AND
   * has an undecided PendingCall, so it is a way to find one pending decision
   * again, not a cache of authority.
   */
  private pendingRuns = new Map<string, ContextId>();
  private sources: AuthoritySource[];

  constructor(private opts: CapabilityPlaneOptions) {
    this.sources = [
      {
        slot: SLOT,
        authority: (username) => opts.authorityFor(username),
        appRights: (app, owner) => this.granted(app, owner).operations,
        appAutoAllow: (app, owner) => this.granted(app, owner).autoAllow,
        controllerRights: (app, action) => opts.controllerRequirements?.(app, action),
        agentRights: (app, agent) => opts.agentRequirements?.(app, agent),
        // Resources keep the historical shape: an agent inherits the app's
        // terms, which are already closed by default.
        agentAutoAllow: () => undefined,
      },
    ];
    const d = opts.delivery;
    if (d) {
      this.sources.push({
        slot: DELIVERY_SLOT,
        authority: (username, app, accountContextId) => d.authorityFor(username, app, accountContextId),
        appRights: (app, owner) => this.granted(app, owner).delivery,
        // Undefined = inherit the root's terms (closed unless the broker's
        // `rootAutoAllow` opened them for this deployment).
        appAutoAllow: (app) => d.appAutoAllow?.(app),
        controllerRights: (app, action) => d.controllerRequirements?.(app, action),
        agentRights: (app, agent) => d.agentRequirements?.(app, agent),
        // Nothing, unless the deployment names something. An app whose humans
        // may send with one click still cannot let its agent do the same.
        agentAutoAllow: (app, agent) => d.agentAutoAllow?.(app, agent) ?? [],
      });
    }
  }

  /**
   * The permission contract this app currently DECLARES — assembled from
   * trusted operator config, never from the hot-pluggable manifest.
   *
   * `actions` and `agents` are empty, and deliberately so: the plane is given
   * LOOKUP functions for per-action and per-agent narrowing, not an
   * enumeration, so it cannot honestly digest a table it cannot read. Leaving
   * them out is safe because neither can widen anything — `narrow()`
   * intersects with what the App Context already holds, and that is capped at
   * `operations ∩ granted`. Editing a per-action list can therefore only ever
   * take rights away, which is the case that needs nobody's consent. They stay
   * in the type because a real permission UI will have the enumeration and
   * should fill them in; what must not happen is a digest that claims to cover
   * something it does not.
   */
  contractOf(app: string): PermissionContract {
    const o = this.opts;
    return {
      app,
      publisher: o.publisherOf?.(app) ?? "first-party",
      operations: o.appRequirements?.(app) ?? [],
      autoAllow: o.appAutoAllow?.(app) ?? [],
      actions: {},
      agents: {},
      delivery: o.delivery?.appRequirements?.(app) ?? [],
    };
  }

  /** The declared contract's digest — what a grant is recorded against. */
  contractDigestFor(app: string): string {
    return contractDigestOf(this.contractOf(app));
  }

  /**
   * Declared vs. granted, for the boot log and for a permissions view. When no
   * ledger is wired this is always "ok": the declarations ARE the grant, which
   * is the truthful description of today's config-only deployment.
   */
  contractStatus(app: string, owner?: string): ContractVerdict {
    const ledger = this.opts.grants;
    if (!ledger) {
      return { ok: true, missingOperations: [], missingAutoAllow: [], missingDelivery: [], needsAuthorization: false };
    }
    return ledger.check(this.contractOf(app), owner);
  }

  /**
   * Declared ∩ granted. Everything the plane derives goes through here, so a
   * widened contract cannot take effect by being declared — the extra
   * operations are absent from every Context until someone authorises them.
   */
  private granted(app: string, owner: string): { operations: readonly Operation[]; autoAllow: readonly Operation[]; delivery: readonly Operation[] } {
    const contract = this.contractOf(app);
    const ledger = this.opts.grants;
    if (!ledger) {
      return { operations: contract.operations, autoAllow: contract.autoAllow, delivery: contract.delivery };
    }
    return ledger.effective(contract, owner);
  }

  /**
   * Resolved fresh on every launch: a cached answer to "does this account
   * still hold anything" expires the moment a device is revoked.
   */
  private authorityOf(
    source: AuthoritySource,
    username: string,
    app: string,
    accountContextId: string,
  ): { contextId: ContextId; slot: string } | null {
    const authority = source.authority(username, app, accountContextId);
    if (!authority) return null;
    if (!this.opts.service.contextIsLive(authority.contextId)) return null;
    if (this.opts.service.rightsOf(authority.contextId, authority.slot).length === 0) return null;
    return { contextId: authority.contextId, slot: authority.slot };
  }

  openApp(o: { username: string; app: string; scope: string; digest: string }): ContextId | null {
    // The resource source stays the one that decides whether this account has
    // ANY authority: it is the account root, and an account with none has no
    // business opening an app Context at all.
    const account = this.authorityOf(this.sources[0], o.username, o.app, "");
    if (!account) return null;
    const grants: Array<{
      from: { contextId: ContextId; slot: string };
      slot: string;
      rights: Operation[];
      autoAllow: readonly Operation[] | undefined;
    }> = [];
    for (const source of this.sources) {
      const from = source.slot === SLOT ? account : this.authorityOf(source, o.username, o.app, account.contextId);
      if (!from) continue;
      const available = this.opts.service.rightsOf(from.contextId, from.slot);
      const wanted = source.appRights(o.app, o.username) ?? available;
      const rights = wanted.filter((r) => available.includes(r));
      if (rights.length === 0) continue;
      // Closed by default: an app auto-allows nothing unless the deployment
      // named it. Everything derived below inherits that ceiling, so a
      // Controller cannot talk itself into acting unsupervised either.
      const asked = source.appAutoAllow(o.app, o.username);
      const autoAllow = asked === undefined ? undefined : asked.filter((r) => rights.includes(r));
      grants.push({ from, slot: source.slot, rights, autoAllow });
    }
    // Both identities travel with the Context, so every audit record and every
    // approval card can answer "which code ran this, and under which permission
    // contract" — the two questions SEC-02 splits apart. The kernel derives no
    // authority from metadata; this is evidence.
    const contract = this.contractOf(o.app);
    const identity = {
      owner: o.username,
      app: o.app,
      scope: o.scope,
      digest: o.digest,
      publisher: contract.publisher,
      contract: contractDigestOf(contract),
    };
    if (grants.length === 0) {
      // An app that asked for nothing it may have gets a Context with no
      // slot at all — it runs, and every resource request denies.
      return this.opts.service.createContext("app-instance", identity);
    }
    const ctx = this.opts.service.createContext(
      "app-instance",
      { ...identity, purpose: `app:${o.app}` },
      account.contextId,
    );
    for (const g of grants) {
      this.opts.service.derive(
        g.from.contextId,
        g.from.slot,
        ctx,
        g.slot,
        g.rights,
        g.autoAllow === undefined ? undefined : { autoAllow: g.autoAllow },
      );
    }
    return ctx;
  }

  /**
   * The two identities SEC-02 keeps apart, as trusted Context metadata.
   *
   * Stamped on the run Contexts as well as the App Context, because that is
   * what an approval card and an audit line actually carry: `requestedBy` is
   * the REQUESTING Context's metadata, and the requester is a ControllerRun or
   * an AgentRun. An auditor could walk the ancestry instead; making them read
   * two rows to answer "which version asked for this" is how the question stops
   * being asked.
   */
  private identityOf(app: string, digest: string | undefined): Record<string, string> {
    const contract = this.contractOf(app);
    return {
      ...(digest ? { digest } : {}),
      publisher: contract.publisher,
      contract: contractDigestOf(contract),
    };
  }

  openControllerRun(o: {
    username: string;
    app: string;
    action: string;
    parentContextId: string;
    /** The code identity this dispatch is bound to, from the Host. */
    digest?: string;
  }): ControllerRun | null {
    // A destroyed parent is an ordinary lifecycle state — a handle from before
    // a logout, a revocation or a code change — not an exception. Letting
    // `createContext` throw here turned it into a 500 whose message carried a
    // server-side Context id out to the browser.
    if (!this.opts.service.contextIsLive(o.parentContextId)) return null;
    const key = `${o.parentContextId}|${o.action}`;
    // Re-attach to the run that is still WAITING for a human.
    //
    // A PendingCall is resumed in the Context that made it — it has to be, or
    // approval would re-check against wider rights than the Controller held.
    // So a retry of the same action has to land in the same Context, otherwise
    // the kernel's (context, slot, operation, args) dedupe sees a stranger and
    // queues a SECOND card for one decision, and approving both would be two
    // side effects. The Context is already being kept alive by
    // `deferWhilePending`; this is what finds it again.
    const waiting = this.pendingRuns.get(key);
    if (waiting) {
      if (this.opts.service.contextIsLive(waiting) && this.opts.service.hasUndecidedPending(waiting)) {
        return { caps: this.facade(waiting, o.parentContextId), close: () => {} };
      }
      this.pendingRuns.delete(key);
    }
    const ctx = this.opts.service.createContext(
      "controller-run",
      {
        ...this.identityOf(o.app, o.digest),
        owner: o.username,
        app: o.app,
        action: o.action,
        purpose: `controller:${o.app}/${o.action}`,
      },
      o.parentContextId,
    );
    for (const source of this.sources) {
      const rights = this.narrow(o.parentContextId, source.slot, source.controllerRights(o.app, o.action));
      if (rights.length) this.opts.service.derive(o.parentContextId, source.slot, ctx, source.slot, rights);
    }
    this.pendingRuns.set(key, ctx);
    return {
      caps: this.facade(ctx, o.parentContextId),
      // Deferred while a PendingCall from this dispatch is still undecided:
      // approving re-runs the original call in this very Context.
      close: () => this.opts.service.destroyContext(ctx, { deferWhilePending: true }),
    };
  }

  /**
   * What a handler holds: `request` in its OWN narrow Context, and `result`
   * resolved against the AppInstance Context above it.
   *
   * `result` has to be answered at the instance level, because the run that
   * created a PendingCall is not the run that comes back to look at it — the
   * next dispatch is a sibling, and siblings cannot see each other's calls. The
   * instance is their nearest common ancestor and is exactly the right scope:
   * one launch's own dangerous calls, nobody else's. The pending id stays a
   * lookup key — presenting one from another instance or another user reads
   * nothing at all.
   */
  private facade(runCtx: ContextId, appCtx: ContextId): ControllerRun["caps"] {
    const bound = this.opts.service.bind(runCtx);
    return {
      request: (slot, operation, args) => bound.request(slot, operation, args),
      result: (pendingCallId) => this.pendingResult(appCtx, pendingCallId),
    };
  }

  /** The recorded outcome of a dangerous call made by ONE app instance. */
  pendingResult(appContextId: string, pendingCallId: string): {
    state: string;
    outcome: string | null;
    result: unknown;
    reason: string | null;
    /** Whether re-issuing this exact call is safe — see `OperationSpec.retrySafe`. */
    retrySafe: boolean;
  } | null {
    const view = this.opts.service.resultOf(appContextId, String(pendingCallId ?? ""));
    return view
      ? { state: view.state, outcome: view.outcome, result: view.result, reason: view.reason, retrySafe: view.retrySafe }
      : null;
  }

  openAgentRun(o: {
    username: string;
    app: string;
    agent: string;
    parentContextId: string;
    digest?: string;
  }): { contextId: string; close(): void } | null {
    if (!this.opts.service.contextIsLive(o.parentContextId)) return null;
    const ctx = this.opts.service.createContext(
      "agent-run",
      {
        ...this.identityOf(o.app, o.digest),
        owner: o.username,
        app: o.app,
        agent: o.agent,
        purpose: `agent-run:${o.app}/${o.agent}`,
      },
      o.parentContextId,
    );
    for (const source of this.sources) {
      const rights = this.narrow(o.parentContextId, source.slot, source.agentRights(o.app, o.agent));
      if (!rights.length) continue;
      // `undefined` inherits the parent's terms; a list narrows them. Delivery
      // returns `[]` by default, which is how "a human may send with one click,
      // an agent may not send at all unsupervised" is expressed without a
      // branch — terms attenuate, so every Controller this agent spawns is
      // capped here too.
      const autoAllow = source.agentAutoAllow(o.app, o.agent);
      this.opts.service.derive(
        o.parentContextId,
        source.slot,
        ctx,
        source.slot,
        rights,
        autoAllow === undefined ? undefined : { autoAllow: autoAllow.filter((r) => rights.includes(r)) },
      );
    }
    return { contextId: ctx, close: () => this.opts.service.destroyContext(ctx, { deferWhilePending: true }) };
  }

  destroyContext(contextId: string): void {
    this.opts.service.destroyContext(contextId);
  }

  /**
   * Whether a previously derived App Context is still worth reusing.
   *
   * "Live" is not enough: revoking a device revokes the account root, which
   * kills every descendant's capability CHAIN while leaving the descendant
   * Contexts themselves live. A Host that reused one on the next page load
   * would deny forever — including after the user re-registered the laptop,
   * because the fresh root is not what the cached Context descends from.
   */
  appContextUsable(contextId: string): boolean {
    if (!this.opts.service.contextIsLive(contextId)) return false;
    // Any slot still holding something means the chain above it is intact.
    for (const source of this.sources) {
      if (this.opts.service.rightsOf(contextId, source.slot).length > 0) return true;
    }
    // A Context deliberately derived with no rights (the app applied for
    // nothing it may have) has no slot to check; it is stable, not stale.
    return this.opts.service.slotsOf(contextId).length === 0;
  }

  /** Requirement ∩ what the parent actually holds in that slot. Never a superset. */
  private narrow(parent: ContextId, slot: string, requested: readonly Operation[] | undefined): Operation[] {
    const available = this.opts.service.rightsOf(parent, slot);
    if (!requested) return available;
    return requested.filter((r) => available.includes(r));
  }
}
