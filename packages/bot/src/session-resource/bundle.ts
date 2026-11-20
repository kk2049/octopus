/**
 * Lifecycle bundle for two independent, ordinary single-root capability
 * planes. It correlates them by instance id; it never combines authority.
 */

import type { ContextId } from "@claude-bot/capability-kernel";
import {
  HostCapabilities,
  type ControllerRun,
  type GrantResolver,
} from "@claude-bot/engine";
import type { RunnerCapabilities } from "../runner/capability.js";
import type { LocalScanCapabilities } from "../sessionhub/local-scan.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_OWNER_ONLY_SILENT,
  SESSION_PLUS_RUNNER_OPERATIONS,
  SESSION_PLUS_RUNNER_OWNER_AUTO_ALLOW,
  SESSION_PLUS_PUBLISHER,
} from "./contract.js";

export type SessionResourcePlane = "runner" | "local";

/**
 * Who this instance's authority was derived for.
 *
 * The only thing it changes is auto-allow. The owner's own page and the
 * owner's own App agents act on the owner's resources, so both are silent for
 * what the owner's grant makes silent (O1: the owner decided agents acting for
 * him need no separate approval). A share `guest` acts on somebody else's
 * resources through the owner's planes, so it keeps the cards the owner alone
 * may skip (opening a terminal).
 */
export type SessionResourceActor = "user" | "agent" | "guest";

export interface AppAuthorityBundle {
  instanceId: string;
  owner: string;
  packageDigest: string;
  actor: SessionResourceActor;
  runnerContextId?: ContextId;
  localContextId?: ContextId;
}

export interface AppAuthorityBundlesOptions {
  /** Agent auto-allow; defaults to the owner's own profile terms (O1). */
  agentAutoAllow?: readonly string[];
  /** Trusted composition identity; never inferred from a proposal or mapping. */
  profile?: { app: string; publisher: string; operations: readonly string[]; autoAllow: readonly string[] };
  runner?: RunnerCapabilities;
  local?: LocalScanCapabilities;
  grants: GrantResolver;
}

export class AppAuthorityBundles {
  readonly profile: NonNullable<AppAuthorityBundlesOptions['profile']>;
  private readonly runnerPlane?: HostCapabilities;
  private readonly localPlane?: HostCapabilities;
  /**
   * The same two planes for an App agent and for a share guest.
   *
   * A separate `HostCapabilities` rather than a flag threaded through the
   * engine: `appAutoAllow` is already a function the composition supplies, so
   * a different silent set is a plane that returns it — which cannot be
   * forgotten at a call site. The grant resolver, the operations, the account
   * root and the Gate are unchanged and shared; only this one answer differs.
   */
  private readonly runnerAgentPlane?: HostCapabilities;
  private readonly localAgentPlane?: HostCapabilities;
  private readonly runnerGuestPlane?: HostCapabilities;
  private readonly localGuestPlane?: HostCapabilities;
  private readonly bundles = new Map<string, AppAuthorityBundle>();

  constructor(private readonly opts: AppAuthorityBundlesOptions) {
    this.profile = opts.profile ?? { app: SESSION_PLUS_APP_ID, publisher: SESSION_PLUS_PUBLISHER, operations: SESSION_PLUS_RUNNER_OPERATIONS, autoAllow: SESSION_PLUS_RUNNER_OWNER_AUTO_ALLOW };
    this.runnerPlane = opts.runner
      ? plane(opts.runner.service, (owner) => opts.runner!.accountAuthority(owner), opts.grants, this.profile)
      : undefined;
    this.localPlane = opts.local
      ? plane(opts.local.service, (owner) => opts.local!.accountAuthority(owner), opts.grants, this.profile)
      : undefined;
    const agentProfile = { ...this.profile, autoAllow: opts.agentAutoAllow ?? this.profile.autoAllow };
    const guestProfile = {
      ...this.profile,
      autoAllow: this.profile.autoAllow.filter((operation) => !SESSION_PLUS_OWNER_ONLY_SILENT.includes(operation)),
    };
    this.runnerAgentPlane = opts.runner
      ? plane(opts.runner.service, (owner) => opts.runner!.accountAuthority(owner), opts.grants, agentProfile)
      : undefined;
    this.localAgentPlane = opts.local
      ? plane(opts.local.service, (owner) => opts.local!.accountAuthority(owner), opts.grants, agentProfile)
      : undefined;
    this.runnerGuestPlane = opts.runner
      ? plane(opts.runner.service, (owner) => opts.runner!.accountAuthority(owner), opts.grants, guestProfile)
      : undefined;
    this.localGuestPlane = opts.local
      ? plane(opts.local.service, (owner) => opts.local!.accountAuthority(owner), opts.grants, guestProfile)
      : undefined;
  }

  open(
    owner: string,
    instanceId: string,
    packageDigest: string,
    actor: SessionResourceActor = "user",
  ): AppAuthorityBundle {
    if (this.bundles.has(instanceId)) throw new Error(`duplicate Session Plus instance authority: ${instanceId}`);
    const bundle: AppAuthorityBundle = { instanceId, owner, packageDigest, actor };
    try {
      bundle.runnerContextId = this.planeFor("runner", actor)?.openApp({
        username: owner,
        app: this.profile.app,
        scope: instanceId,
        digest: packageDigest,
      }) ?? undefined;
      bundle.localContextId = this.planeFor("local", actor)?.openApp({
        username: owner,
        app: this.profile.app,
        scope: instanceId,
        digest: packageDigest,
      }) ?? undefined;
      this.bundles.set(instanceId, bundle);
      return { ...bundle };
    } catch (error) {
      if (bundle.runnerContextId) this.planeFor("runner", actor)?.destroyContext(bundle.runnerContextId);
      if (bundle.localContextId) this.planeFor("local", actor)?.destroyContext(bundle.localContextId);
      throw error;
    }
  }

  /**
   * Which plane serves one (source, actor) pair.
   *
   * Derived, never passed in: a bundle records the actor it was opened for, so
   * a later controller run or teardown cannot accidentally reach the other
   * plane's Context — which would be a teardown that destroyed nothing.
   */
  private planeFor(source: SessionResourcePlane, actor: SessionResourceActor): HostCapabilities | undefined {
    if (source === "runner") {
      return actor === "agent" ? this.runnerAgentPlane : actor === "guest" ? this.runnerGuestPlane : this.runnerPlane;
    }
    return actor === "agent" ? this.localAgentPlane : actor === "guest" ? this.localGuestPlane : this.localPlane;
  }

  get(instanceId: string): AppAuthorityBundle | null {
    const found = this.bundles.get(instanceId);
    return found ? { ...found } : null;
  }

  contextIds(instanceId: string): string[] {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return [];
    return [bundle.runnerContextId, bundle.localContextId].filter((id): id is string => Boolean(id));
  }

  openController(instanceId: string, source: SessionResourcePlane, action: string): ControllerRun | null {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return null;
    const plane = this.planeFor(source, bundle.actor);
    const parentContextId = source === "runner" ? bundle.runnerContextId : bundle.localContextId;
    if (!plane || !parentContextId) return null;
    return plane.openControllerRun({
      username: bundle.owner,
      app: this.profile.app,
      action,
      parentContextId,
      digest: bundle.packageDigest,
    });
  }

  rights(instanceId: string, source: SessionResourcePlane): string[] {
    const bundle = this.bundles.get(instanceId);
    const plane = bundle ? this.planeFor(source, bundle.actor) : undefined;
    const contextId = source === "runner" ? bundle?.runnerContextId : bundle?.localContextId;
    if (!plane || !contextId) return [];
    return plane.appContextUsable(contextId)
      ? [...this.serviceFor(source)!.rightsOf(contextId, "resources")]
      : [];
  }

  destroy(instanceId: string): boolean {
    const bundle = this.bundles.get(instanceId);
    if (!bundle) return false;
    this.bundles.delete(instanceId);
    if (bundle.runnerContextId) this.planeFor("runner", bundle.actor)?.destroyContext(bundle.runnerContextId);
    if (bundle.localContextId) this.planeFor("local", bundle.actor)?.destroyContext(bundle.localContextId);
    return true;
  }

  destroyOwner(owner: string): number {
    let count = 0;
    for (const bundle of [...this.bundles.values()]) {
      if (bundle.owner === owner && this.destroy(bundle.instanceId)) count += 1;
    }
    return count;
  }

  private serviceFor(source: SessionResourcePlane) {
    return source === "runner" ? this.opts.runner?.service : this.opts.local?.service;
  }
}

function plane(
  service: import("@claude-bot/capability-kernel").CapabilityService,
  authorityFor: (owner: string) => { contextId: ContextId; slot: string } | null,
  grants: GrantResolver,
  profile: NonNullable<AppAuthorityBundlesOptions['profile']>,
): HostCapabilities {
  return new HostCapabilities({
    service,
    authorityFor,
    appRequirements: (app) => app === profile.app ? profile.operations : [],
    appAutoAllow: (app) => app === profile.app ? [...profile.autoAllow] : [],
    grants,
    publisherOf: (app) => app === profile.app ? profile.publisher : "unknown",
  });
}
