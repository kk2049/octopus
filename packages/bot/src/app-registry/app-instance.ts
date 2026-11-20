import type { AppAgentActivity } from "@claude-bot/dashboard-web/contract";
import type { AppAgentActivityPort, AppAgentActivityScope } from "../app-agents/activity.js";
/** Declared App admission, durable dispatch and per-viewer projection stream.
 * State and Runtime use AppCoordinationEngine; instance and SSE lifecycle use
 * the same registry as Sessions+. Reviewed resource profiles may be installed
 * only by trusted composition. They own ephemeral per-viewer data, Gate/Runner
 * calls and teardown; neither app.yaml nor project mappings install authority.
 * Generic Apps retain their empty permission contract and fail-closed resource
 * actions. Resource-prefixed typed-port calls still require a binding plan and
 * remain unsupported here.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AppRuntimeClient, RuntimeJson } from "@claude-bot/app-runtime";
import type { CommitSummary, StateClient } from "@claude-bot/app-state";
import { canonicalJson } from "@claude-bot/app-state";
import { createLogger } from "../logger.js";
import { eventAuthor, sessionPlusAgentPrincipal } from "../app-core/principal.js";
import { sessionPlusStateAppKey } from "../app-core/identity.js";
import {
  SessionPlusInstances,
  externalPresence,
  instanceMessage,
  principalActor,
  type InstanceEvent,
  type InstanceSubscription,
  type ReleaseAvailabilityMode,
  type SessionPlusInstanceBinding,
  type SessionPlusInstanceLimits,
  type SessionPlusPrincipal,
} from "../app-core/instance.js";
import {
  loadSessionPlusManifest,
  normalizeSessionPlusAction,
  sessionPlusActionsFor,
  type SessionPlusActionSpec,
  type SessionPlusActorKind,
  type SessionPlusManifest,
  type SessionPlusRoleSpec,
} from "../app-core/manifest.js";
import {
  readCachedViewerProjection,
  type CanonicalProjection,
} from "../app-core/projection-cache.js";
import { AppCoordinationEngine, agentInboxText } from "../app-core/coordination-engine.js";
import type { DeclaredResourcePlane } from './resource-plane.js';

const log = createLogger("app-instance");

/** One trusted workbench directory read stays bounded independently of state size. */
const SHARED_PROJECTION_DIRECTORY_MAX = 64;

/**
 * The wire prefix a typed-resource proposal would carry.
 *
 * Named here only so it can be REFUSED with an accurate sentence. Nothing in
 * this file can serve one.
 */
const RESOURCE_ACTION_PREFIX = "resource.";

/**
 * The facts about the release being served that this coordinator needs.
 *
 * Structurally satisfied by `PreparedDeclaredRelease` plus its descriptor, which
 * is why the composition root can supply it with one arrow function and no
 * adapter of its own. Nothing here is a path a browser could name: `appDir` is
 * where the trusted process reads `app.yaml` from and never leaves this process.
 */
export interface AppInstanceRelease {
  stableAppId: string;
  publisher: string;
  packageDigest: string;
  permissionContractDigest: string;
  backendCodeDigest: string;
  appDir: string;
}

/**
 * The membership door's read face (ADR 0007 P1). Store-backed in production;
 * a Map in tests. Read FRESH on every open and every dispatch — a revoked
 * member's next proposal must fail, not their next page load.
 */
export interface SharedInstanceDirectory {
  instance(appId: string, instanceKey: string): { status: string } | undefined;
  member(appId: string, instanceKey: string, username: string): { role: string } | undefined;
}

export interface AppInstanceServiceDeps {
  /** Declaration identity; required when composed before the first activation. */
  stableAppId?: string;
  agentActivity?: AppAgentActivityPort;
  state: StateClient;
  runtime: AppRuntimeClient;
  /** Absent = this deployment serves no shared-scope Apps (open refuses). */
  shared?: SharedInstanceDirectory;
  /** The active release used by every new open, agent turn and management read. */
  activeRelease: () => AppInstanceRelease | null;
  /** Resolve the immutable release one existing binding was opened against. */
  servableRelease: (packageDigest: string) => AppInstanceRelease | null;
  /** Fresh package set used by resolve and SSE reconnect. */
  servablePackageDigests: () => ReadonlySet<string>;
  /** Binding lifecycle seams used to hold/release backend-version references. */
  onInstanceCreated?: (binding: SessionPlusInstanceBinding) => boolean | void;
  onInstanceDestroyed?: (binding: SessionPlusInstanceBinding, reason: string) => void;
  now?: () => number;
  instanceLimits?: SessionPlusInstanceLimits;
  /** Test seam. Production reads `app.yaml` out of the materialised release tree. */
  loadManifest?: (appDir: string, appId: string) => SessionPlusManifest;
  /** Trusted seam into the optional App agent plane. Never exposed to the View. */
  deliverAgent?: (input: {
    appId: string;
    owner: string;
    instanceKey?: string;
    agent: string;
    text: string;
    dispatchId: string;
  }) => Promise<{ ok: true; duplicate: boolean } | { ok: false; message: string }>;
}

export interface OpenAppInstance {
  handle: string;
  projection: RuntimeJson;
  /** Monotonic for every projection frame in this instance. */
  revision: number;
  expiresAt: number;
}

export interface OpenAgentAppInstance extends OpenAppInstance {
  /**
   * The ONE identity this turn's later dispatches must present. Returned
   * rather than respelled by the caller because the agent credential embeds
   * the App's stable id, and the release is the authority on that string.
   */
  principal: SessionPlusPrincipal;
}

/**
 * One viewer-scoped shared projection for trusted navigation chrome.
 *
 * There is deliberately no handle: reading a project label must not create a
 * driveable App tab or leak the shared instance key into the Agent View.
 */
export interface SharedProjectionSnapshot {
  instanceKey: string;
  projection: RuntimeJson;
}

export type AppLogResult =
  | { ok: true; head: number; commits: readonly CommitSummary[] }
  | { ok: false; code: "no_release" | "invalid_instance" | "forbidden" | "unavailable"; message: string };

export type AppDispatchResult =
  | { ok: true; result: RuntimeJson | null; projection: RuntimeJson; revision: number }
  | {
      ok: false;
      code:
        | "unknown_action"
        | "action_rejected"
        | "invalid_instance"
        | "instance_expired"
        | "instance_stale"
        | "state_conflict"
        | "not_supported";
      message: string;
    };

export class AppInstanceService {
  private resources: DeclaredResourcePlane | null = null;
  sharedInstanceTitle(key: string, owner: string): string | undefined {
    const app = this.deps.stableAppId ?? this.deps.activeRelease()?.stableAppId;
    if (!app || !this.deps.shared?.member(app, key, owner)) return undefined;
    try { return this.resources?.sharedInstanceTitle?.(key); } catch { return undefined; }
  }
  attachResources(resources: DeclaredResourcePlane): () => void {
    if (this.resources) throw new Error('resource plane already installed');
    this.resources = resources;
    return () => { this.instances.stop(); this.resources = null; };
  }
  readonly instances: SessionPlusInstances;
  private readonly coordination: AppCoordinationEngine;
  private readonly now: () => number;
  /** One parsed `app.yaml` per materialised release tree. A release is immutable. */
  private readonly manifests = new Map<string, SessionPlusManifest>();
  /**
   * streamId → shared instance key, recorded at open. In-memory like the
   * instance registry itself: a restart forgets both together, and dispatch
   * needs the key only to re-ask the membership directory.
   */
  private readonly streamInstanceKeys = new Map<string, string>();

  constructor(private readonly deps: AppInstanceServiceDeps) {
    const stableAppId = deps.stableAppId ?? deps.activeRelease()?.stableAppId;
    if (!stableAppId) throw new Error("an App instance service requires its declared identity before activation");
    this.now = deps.now ?? Date.now;
    this.coordination = new AppCoordinationEngine({
      state: deps.state,
      runtime: deps.runtime,
      now: this.now,
    });
    this.instances = new SessionPlusInstances(
      () => this.deps.servablePackageDigests(),
      this.now,
      undefined,
      (binding, reason) => { this.resources?.close(binding.id, reason); this.deps.onInstanceDestroyed?.(binding, reason); },
      deps.instanceLimits,
      // Recorded on every binding, and the handle-hash domain separator. See
      // the constructor note in `app-core/instance.ts`.
      stableAppId,
    );
    this.instances.start();
  }

  /**
   * One tab's instance. The browser door: a real login, or nothing.
   */
  async open(principal: SessionPlusPrincipal, options: { instanceKey?: string } = {}): Promise<OpenAppInstance> {
    if (!principal.owner || !principal.credential || !principal.session) {
      throw new Error("an App instance requires a named browser session");
    }
    return await this.openFor(principal, options.instanceKey);
  }

  /**
   * Viewer-scoped projections for a trusted shared-instance directory.
   *
   * This is not an App/View API. The Dashboard has already selected keys from
   * this person's membership rows; this method re-asks the membership door for
   * every key, reads the exact schema-3 viewer snapshot an open tab receives,
   * and returns display data without committing a tab handle. A missing empty
   * stream may seed its first snapshot; a historical cache miss never starts a
   * directory-time replay. The 64-row ceiling bounds snapshot/declassification
   * work independently of membership size.
   */
  async readSharedProjections(
    principal: SessionPlusPrincipal,
    instanceKeys: readonly string[],
  ): Promise<SharedProjectionSnapshot[]> {
    if (!principal.owner || !principal.credential || !principal.session) {
      throw new Error("an App projection directory requires a named browser session");
    }
    const release = this.deps.activeRelease();
    if (!release) throw new Error("this App has no active release");
    const manifest = this.manifestOf(release);
    if (manifest.stateScope !== "shared") throw new Error("这个 App 不是共享实例制");

    const keys = [...new Set(instanceKeys)].slice(0, SHARED_PROJECTION_DIRECTORY_MAX);
    if (keys.length === 0) return [];
    const reservation = this.instances.reserve(principal);
    try {
      const snapshots: SharedProjectionSnapshot[] = [];
      for (const instanceKey of keys) {
        let role: string;
        try {
          role = this.sharedMemberRole(manifest, release, principal, instanceKey);
        } catch {
          // Membership may disappear between the Store list and this fresh
          // door. That row disappears from navigation; no projection escapes.
          continue;
        }
        try {
          const stream = await this.deps.state.resolveStream({
            app: sessionPlusStateAppKey(release),
            scope: { kind: "shared", key: instanceKey },
          });
          const context = manifest.schema >= 3
            ? { viewer: { user: principal.owner, kind: principalActor(principal).kind, role } }
            : undefined;
          let projection = await readCachedViewerProjection({
            state: this.deps.state,
            runtime: this.deps.runtime,
            streamId: stream.streamId,
            backendCodeDigest: release.backendCodeDigest,
            head: stream.head,
            ...(context === undefined ? {} : { context }),
          });
          if (projection === null && stream.head === 0) {
            projection = (await this.coordination.project({
              streamId: stream.streamId,
              backendCodeDigest: release.backendCodeDigest,
              ...(context === undefined ? {} : { context }),
            })).projection;
          }
          if (projection === null) continue;
          // Do not return data produced under a seat that changed while the
          // Runtime was projecting it. The next page request can try afresh.
          const currentRole = this.sharedMemberRole(manifest, release, principal, instanceKey);
          if (currentRole !== role) continue;
          snapshots.push({ instanceKey, projection });
        } catch (error) {
          // One corrupt/unavailable project must not hide every other project
          // or block the user from opening an independently healthy one.
          log.warn({ app: release.stableAppId, instanceKey, err: error }, "could not project shared App directory row");
        }
      }
      return snapshots;
    } finally {
      reservation.release();
    }
  }

  /**
   * One agent turn's instance — the same admission, State read and sandbox
   * projection a tab gets, exactly `SessionPlusAppService.openAgentTurn`'s
   * shape. The principal carries `session: false` and an `agent` actor, so the
   * registry, the manifest door (`human_only`) and every future "a person is
   * here" check read it as what it is. A turn's lifetime is one turn: the
   * caller destroys the instance when its work ends, and a revocation or an
   * activation between two turns is honoured because the next turn opens anew.
   */
  async openAgentTurn(
    input: { owner: string; agent: string; turnId: string; instanceKey?: string; useMemberRole?: boolean },
  ): Promise<OpenAgentAppInstance> {
    if (!input.owner) throw new Error("an App agent turn requires an owner");
    const release = this.deps.activeRelease();
    if (!release) throw new Error("this App has no active release");
    const manifest = this.manifestOf(release);
    const declaration = manifest.agents[input.agent];
    if (!declaration) throw new Error("当前 release 没有声明这个 agent");
    if (manifest.stateScope === "shared" && (!input.instanceKey || manifest.schema < 4 || !declaration.role)) {
      throw new Error("共享 App agent 回合需要 schema 4 的实例与角色声明");
    }
    const principal = sessionPlusAgentPrincipal({
      owner: input.owner,
      agent: input.agent,
      turnId: input.turnId,
      app: release.stableAppId,
      // External MCP represents a member's seat. Native App agents keep their
      // declared project role; the transport cannot promote an observer.
      ...(!input.useMemberRole && declaration.role ? { role: declaration.role } : {}),
    });
    return { ...(await this.openFor(principal, input.instanceKey)), principal };
  }

  /**
   * One instance for an EXTERNAL trusted host presenting a bound capability
   * (`app-external/`, `external-app-host/v1`).
   *
   * A third door rather than a flag on the first two, because the sentence each
   * one makes is different. `open` says "a real browser login is here", which is
   * exactly what an external host does not have. `openAgentTurn` says "one turn
   * of one declared App agent", which mints its own per-turn credential and so
   * cannot be torn down by the credential a revocation names. This door says:
   * a person authorised THIS credential id, in their own browser session, for
   * this instance — the caller is not a browser, and every check that matters
   * (App trust, the instance's status, the seat, the active release) was just
   * re-read by the service that called in here and will be re-read on the next
   * call too.
   *
   * The `credential` MUST be the binding's public credential id and never its
   * secret: it is recorded on the binding, is what `releaseCredential` reaps on
   * revocation, and reaching it is not the same as holding the credential.
   *
   * `actor` chooses the evidence the App's rules door and the event log see —
   * a human's move is authored `user:<name>` exactly as their click inside
   * Octopus is, and an agent's proposal is authored as an agent and refused by
   * every `human_only` action. Nothing on the wire can move that dial.
   */
  async openExternal(input: {
    owner: string;
    credential: string;
    /** The allow-listed host id the capability is bound to. */
    host: string;
    actor: "user" | "agent";
    /** Recorded in agent authorship; ignored for a human binding. */
    agent?: string;
    instanceKey?: string;
  }): Promise<OpenAgentAppInstance> {
    if (!input.owner || !input.credential || !input.host) {
      throw new Error("an external App instance requires an owner, a credential id and a bound host");
    }
    const release = this.deps.activeRelease();
    if (!release) throw new Error("this App has no active release");
    return {
      ...(await this.openFor(externalAppPrincipal({ ...input, app: release.stableAppId }), input.instanceKey)),
      principal: externalAppPrincipal({ ...input, app: release.stableAppId }),
    };
  }

  /**
   * The one open path behind all three doors above.
   *
   * The order is the property: admission is reserved BEFORE any State or
   * Runtime work, so a burst of page loads cannot all pass the ceiling and then
   * each spend a projection.
   */
  private async openFor(principal: SessionPlusPrincipal, instanceKey?: string): Promise<OpenAppInstance> {
    const release = this.deps.activeRelease();
    if (!release) throw new Error("this App has no active release");

    // The membership door (ADR 0007 P1): which partition, and may THIS owner
    // enter it. Both are answered before any State or Runtime work is spent.
    const manifest = this.manifestOf(release);
    let scope: { kind: string; key: string };
    let memberRoleAtOpen: string | undefined;
    if (manifest.stateScope === "shared") {
      if (!instanceKey) throw new Error("这个 App 是共享实例制：打开它需要一个实例标识");
      memberRoleAtOpen = this.sharedMemberRole(manifest, release, principal, instanceKey);
      scope = { kind: "shared", key: instanceKey };
    } else {
      if (instanceKey) throw new Error("这个 App 是按账户隔离的，不接受实例标识");
      scope = { kind: "account", key: principal.owner };
    }

    const reservation = this.instances.reserve(principal);
    try {
      const stream = await this.deps.state.resolveStream({
        app: sessionPlusStateAppKey(release),
        scope,
      });
      if (manifest.stateScope === "shared" && instanceKey) {
        this.streamInstanceKeys.set(stream.streamId, instanceKey);
      }
      const projected = await this.coordination.project({
        streamId: stream.streamId,
        backendCodeDigest: release.backendCodeDigest,
        ...(manifest.schema >= 3
          ? { context: { viewer: this.viewerEvidence(manifest, release, principal, instanceKey) } }
          : {}),
      });
      if (this.deps.activeRelease()?.packageDigest !== release.packageDigest) {
        throw new Error("the App release changed while its instance was opening");
      }
      if (
        manifest.stateScope === "shared"
        && instanceKey
        && this.sharedMemberRole(manifest, release, principal, instanceKey) !== memberRoleAtOpen
      ) {
        throw new Error("成员角色在应用打开期间发生了变化，请重试");
      }
      const created = reservation.commit({
        principal,
        ...(manifest.stateScope === 'shared' && instanceKey ? { sharedInstanceKey: instanceKey } : {}),
        packageDigest: release.packageDigest,
        contractDigest: release.permissionContractDigest,
        streamId: stream.streamId,
        head: projected.canonical.head,
        projection: projected.projection,
      });
      const retained = this.deps.onInstanceCreated?.(created.binding) !== false;
      if (!retained || this.deps.activeRelease()?.packageDigest !== release.packageDigest) {
        this.instances.destroyBinding(created.binding.id, "instance_stale");
        throw new Error("the App release was retired while its instance was opening");
      }
      if (this.resources) this.instances.updateStreamBinding(created.binding.id, created.binding.streamId, created.binding.head, this.resources.project(created.binding, created.binding.projection));
      const opened = this.instances.resolve(created.handle, principal);
      if (!opened.ok) throw new Error('App instance closed while opening');
      return {
        handle: created.handle,
        projection: opened.binding.projection,
        revision: opened.binding.viewRevision,
        expiresAt: created.binding.expiresAt,
      };
    } finally {
      reservation.release();
    }
  }

  /**
   * One proposal from one tab.
   *
   * Every branch below is a refusal except the last, and the last one is the
   * durable loop. What the browser supplies is an action name and flat string
   * params; who is asking, which App, which release and which stream all come
   * from the handle it presented.
   */
  async dispatch(
    handle: string,
    principal: SessionPlusPrincipal,
    proposal: { action?: unknown; params?: unknown },
  ): Promise<AppDispatchResult> {
    const resolved = this.instances.resolve(handle, principal);
    if (!resolved.ok) return { ok: false, code: resolved.code, message: instanceMessage(resolved.code) };

    // Read once, and never re-read after an await: a dispatch that started on
    // one release must not commit under another's digests.
    const release = this.deps.servableRelease(resolved.binding.packageDigest);
    if (!release) {
      this.instances.destroy(handle, principal, "instance_stale");
      return { ok: false, code: "instance_stale", message: instanceMessage("instance_stale") };
    }

    if (typeof proposal.action === "string" && proposal.action.startsWith(RESOURCE_ACTION_PREFIX)) {
      // Named rather than folded into `unknown_action`: "no such action" reads
      // as a typo, and this is a permission fact about declared Apps.
      return {
        ok: false,
        code: "not_supported",
        message: "被声明的 App 不能读取用户资源：它的权限契约是空的，本进程也没有为它安装任何 typed port",
      };
    }

    let manifest: SessionPlusManifest;
    try {
      manifest = this.manifestOf(release);
    } catch (error) {
      log.error({ app: release.stableAppId, err: error }, "could not read this release's app.yaml");
      return { ok: false, code: "action_rejected", message: "当前 release 的动作声明无法读取" };
    }

    const actor = principalActor(principal);
    const normalized = normalizeSessionPlusAction(manifest, proposal.action, proposal.params, actor.kind);
    if (!normalized.ok) {
      return {
        ok: false,
        code: normalized.code === "unknown_action" ? "unknown_action" : "action_rejected",
        message: normalized.message,
      };
    }

    const spec = manifest.actions[normalized.action]!;
    // Door 1's second half (ADR 0007): a shared App's action runs only for a
    // CURRENT member whose role allows it. Membership is read fresh so a
    // revocation lands on the next proposal; "whose turn it is" and every
    // other rule stays in the App's sandboxed handler (door 2).
    const seated = this.seatFor(manifest, release, spec, normalized.action, resolved.binding.streamId, principal);
    if (!seated.ok) return seated;
    const actorRole = seated.role;
    const sponsorRole = seated.memberRole;
    if (spec.binding === "agent") {
      if (!this.deps.deliverAgent || !spec.agent) {
        return { ok: false, code: "not_supported", message: "此部署没有启用 App agent 平面" };
      }
      const agentInstanceKey = manifest.stateScope === "shared"
        ? this.streamInstanceKeys.get(resolved.binding.streamId)
        : undefined;
      if (manifest.stateScope === "shared" && !agentInstanceKey) {
        return { ok: false, code: "invalid_instance", message: "共享实例已失效，请刷新" };
      }
      const delivered = await this.deps.deliverAgent({
        appId: release.stableAppId,
        owner: principal.owner,
        ...(agentInstanceKey ? { instanceKey: agentInstanceKey } : {}),
        agent: spec.agent,
        text: normalized.params.prompt ?? "",
        dispatchId: `agi_${randomUUID()}`,
      });
      if (!delivered.ok) return { ok: false, code: "action_rejected", message: delivered.message };
      const live = this.instances.resolve(handle, principal);
      if (!live.ok) return { ok: false, code: live.code, message: instanceMessage(live.code) };
      return {
        ok: true,
        result: { queued: true, duplicate: delivered.duplicate },
        projection: live.binding.projection,
        revision: live.binding.viewRevision,
      };
    }
    if (spec.binding === 'resource' && this.resources) {
      const resources = this.resources;
      const current = () => {
        const live = this.instances.resolve(handle, principal);
        if (!live.ok || !this.deps.servableRelease(live.binding.packageDigest)) return null;
        const seat = this.seatFor(manifest, release, spec, normalized.action, live.binding.streamId, principal);
        return seat.ok ? live.binding : null;
      };
      const outcome = await resources.dispatch({ binding: resolved.binding, principal, action: normalized.action, params: normalized.params, current,
        publish: () => { const live = current(); if (live) this.instances.updateStreamBinding(live.id, live.streamId, live.head, resources.project(live, live.projection)); },
        operation: value => { const live = current(); if (live) this.instances.recordOperation(live.id, value); },
      });
      const live = current();
      if (!live) return { ok: false, code: 'instance_stale', message: '项目连接或成员权限已经变化，请刷新。' };
      if (!outcome.ok) return { ok: false, code: 'action_rejected', message: outcome.message };
      return { ok: true, result: outcome.result, projection: live.projection, revision: live.viewRevision };
    }
    if (spec.binding !== "runtime") {
      // The FORMAT allows a `binding: resource` declaration; this build has
      // nothing to serve it with for a declared App, and a bounded refusal is
      // better than a handler that quietly does nothing.
      return {
        ok: false,
        code: "not_supported",
        message: `动作 ${normalized.action} 声明的是 resource 绑定，被声明的 App 没有资源平面可以服务它`,
      };
    }

    try {
      return await this.coordination.serialize(resolved.binding.streamId, async () => {
        // Resolve again after waiting in the queue: the credential or the release
        // may have ended while another proposal was committing.
        const live = this.instances.resolve(handle, principal);
        if (!live.ok) return { ok: false, code: live.code, message: instanceMessage(live.code) };
        const outcome = await this.coordination.dispatch<Extract<AppDispatchResult, { ok: false }>>({
          streamId: live.binding.streamId,
          backendCodeDigest: release.backendCodeDigest,
          contractDigest: release.permissionContractDigest,
          dispatchId: `apd_${randomUUID()}`,
          action: normalized.action,
          params: normalized.params,
          ...(spec.historyCursor ? { historyAfter: /^[0-9]{1,12}$/.test(normalized.params[spec.historyCursor] ?? "")
            ? Number(normalized.params[spec.historyCursor]) : Number.NaN } : {}),
          // schema 3 hands the rules door the same trusted actor evidence that
          // the event stamp carries. Older schemas keep their exact context.
          context: ({ state, now }) => ({
            now,
            state,
            ...(manifest.schema >= 3
              ? { actor: this.actorEvidence(principal, actorRole) }
              : {}),
          }),
          // Re-ask handle and membership policy after State and Runtime awaits.
          // Events produced under stale authority are refused, never retried.
          authorizeCommit: () => {
            const stillLive = this.instances.resolve(handle, principal);
            if (!stillLive.ok) {
              return {
                ok: false,
                refusal: { ok: false, code: stillLive.code, message: instanceMessage(stillLive.code) },
              };
            }
            const stillSeated = this.seatFor(
              manifest,
              release,
              spec,
              normalized.action,
              live.binding.streamId,
              principal,
            );
            if (!stillSeated.ok) return { ok: false, refusal: stillSeated };
            if (stillSeated.role !== actorRole || stillSeated.memberRole !== sponsorRole) {
              return {
                ok: false,
                refusal: {
                  ok: false,
                  code: "action_rejected",
                  message: "你的角色刚刚发生了变化，请刷新后重试",
                },
              };
            }
            return {
              ok: true,
              actor: manifest.schema >= 3 && actor.kind === "user"
                ? `user:${principal.owner}`
                : eventAuthor(release.stableAppId, actor, principal.owner),
            };
          },
          // A model-selected action is never reinvoked after a revision
          // conflict. The plane records the refusal and the consumed inbox is
          // not replayed; humans retain the established pure-action retry.
          retryConflict: actor.kind !== "agent",
        });
        if (!outcome.ok) return outcome;
        const after = outcome.canonical;
        // One event log can now have bindings from multiple backend versions.
        // Fold each (backend digest, viewer) group with its own immutable code;
        // one incompatible old projector closes only that cohort.
        const bindings = this.instances.bindingsForStream(live.binding.streamId);
        const instanceKey = this.streamInstanceKeys.get(live.binding.streamId);
        const groups = new Map<string, {
          release: AppInstanceRelease;
          viewer?: RuntimeJson;
          bindings: Array<(typeof bindings)[number]>;
        }>();
        for (const binding of bindings) {
          const bindingRelease = this.deps.servableRelease(binding.packageDigest);
          if (!bindingRelease) {
            this.instances.destroyBinding(binding.id, "instance_stale");
            continue;
          }
          let bindingManifest: SessionPlusManifest;
          try {
            bindingManifest = this.manifestOf(bindingRelease);
          } catch (error) {
            log.warn({ app: bindingRelease.stableAppId, err: error }, "could not reproject one release cohort");
            this.instances.destroyBinding(binding.id, "projection_failed");
            continue;
          }
          const viewer = bindingManifest.schema >= 3
            ? this.viewerEvidence(
                bindingManifest,
                bindingRelease,
                {
                  owner: binding.owner,
                  credential: binding.credential,
                  session: binding.presence === "browser",
                  actor: binding.actor,
                },
                instanceKey,
              )
            : undefined;
          const key = `${bindingRelease.backendCodeDigest}\0${canonicalJson(viewer ?? null)}`;
          const group = groups.get(key);
          if (group) group.bindings.push(binding);
          else groups.set(key, { release: bindingRelease, ...(viewer === undefined ? {} : { viewer }), bindings: [binding] });
        }
        const canonicalByBackend = new Map<string, CanonicalProjection>([
          [release.backendCodeDigest, after],
        ]);
        for (const group of groups.values()) {
          try {
            const groupCanonical = canonicalByBackend.get(group.release.backendCodeDigest);
            const projected = await this.coordination.project({
              streamId: live.binding.streamId,
              backendCodeDigest: group.release.backendCodeDigest,
              ...(groupCanonical ? { canonical: groupCanonical } : {}),
              ...(group.viewer === undefined ? {} : { context: { viewer: group.viewer } }),
            });
            canonicalByBackend.set(group.release.backendCodeDigest, projected.canonical);
            for (const binding of group.bindings) {
              this.instances.updateStreamBinding(
                binding.id,
                live.binding.streamId,
                projected.canonical.head,
                this.resources ? this.resources.project(binding, projected.projection) : projected.projection,
              );
            }
          } catch (error) {
            log.warn(
              { app: group.release.stableAppId, backendCodeDigest: group.release.backendCodeDigest, err: error },
              "one retained release could not project the shared event log",
            );
            for (const binding of group.bindings) this.instances.destroyBinding(binding.id, "projection_failed");
          }
        }
        const updated = this.instances.resolve(handle, principal);
        if (!updated.ok) return { ok: false as const, code: updated.code, message: instanceMessage(updated.code) };
        return {
          ok: true as const,
          result: outcome.result,
          projection: updated.binding.projection,
          revision: updated.binding.viewRevision,
        };
      });
    } catch (error) {
      if ((error as { reason?: unknown })?.reason === "version_retired") {
        this.instances.destroy(handle, principal, "instance_stale");
        return { ok: false, code: "instance_stale", message: instanceMessage("instance_stale") };
      }
      throw error;
    }
  }

  /**
   * The shared-scope membership door, as a value.
   *
   * One implementation, called TWICE per dispatch — once before the work and
   * once immediately before the commit — because a door that is only asked
   * before two awaits is a door that answers a question about the past. An
   * account-scoped App has no seat to check and answers with no role.
   */
  private seatFor(
    manifest: SessionPlusManifest,
    release: AppInstanceRelease,
    spec: SessionPlusActionSpec,
    action: string,
    streamId: string,
    principal: SessionPlusPrincipal,
  ): {
    ok: true;
    /** Role presented to the App rules door. */
    role: string | undefined;
    /** Fresh human membership role that sponsors this headless turn. */
    memberRole: string | undefined;
  } | { ok: false; code: "action_rejected"; message: string } {
    if (manifest.stateScope !== "shared") return { ok: true, role: undefined, memberRole: undefined };
    const instanceKey = this.streamInstanceKeys.get(streamId);
    const member = instanceKey
      ? this.deps.shared?.member(release.stableAppId, instanceKey, principal.owner)
      : undefined;
    if (!member) return { ok: false, code: "action_rejected", message: "你不是这个共享实例的成员" };
    const actor = principalActor(principal);
    const actorRole = actor.kind === "agent" && actor.role ? actor.role : member.role;
    const allowed = roleAllows(manifest, spec, actorRole);
    if (!allowed) {
      return {
        ok: false,
        code: "action_rejected",
        message: spec.roles
          ? `动作 ${action} 只对角色 ${spec.roles.join("/")} 开放`
          : "观战角色只能使用明确对它开放的动作",
      };
    }
    return { ok: true, role: actorRole, memberRole: member.role };
  }

  private activityScope(handle: string, principal: SessionPlusPrincipal): AppAgentActivityScope | null {
    if (!principal.session || principal.delegation || principalActor(principal).kind !== "user") return null;
    const resolved = this.instances.resolve(handle, principal);
    if (!resolved.ok) return null;
    const release = this.deps.servableRelease(resolved.binding.packageDigest);
    if (!release) return null;
    const manifest = this.manifestOf(release);
    const instanceKey = manifest.stateScope === "shared" ? this.streamInstanceKeys.get(resolved.binding.streamId) : undefined;
    if (manifest.stateScope === "shared") {
      if (!instanceKey) return null;
      try { this.sharedMemberRole(manifest, release, principal, instanceKey); } catch { return null; }
    }
    return { appId: release.stableAppId, owner: principal.owner, ...(instanceKey ? { instanceKey } : {}) };
  }

  agentActivity(handle: string, principal: SessionPlusPrincipal): AppAgentActivity[] | null {
    const scope = this.activityScope(handle, principal);
    return scope ? this.deps.agentActivity?.readActivity(scope) ?? [] : null;
  }

  stopAgentActivity(handle: string, principal: SessionPlusPrincipal, turnId: string): boolean {
    const scope = this.activityScope(handle, principal);
    return Boolean(scope && this.deps.agentActivity?.stopActivity(scope, turnId));
  }

  subscribe(
    handle: string,
    principal: SessionPlusPrincipal,
    listener: (event: InstanceEvent) => void,
  ): InstanceSubscription | null {
    return this.instances.subscribe(handle, principal, listener);
  }

  /** Tell this App's live browser chrome that an explicit page reload may move releases. */
  markReleaseAvailable(input: { availableDigest: string; mode: ReleaseAvailabilityMode }): number {
    return this.instances.markReleaseAvailable(input);
  }

  closeInstance(handle: string, principal: SessionPlusPrincipal): boolean {
    return this.instances.destroy(handle, principal);
  }

  /** Every instance one browser login opened. Called when that login ends. */
  releaseCredential(owner: string, credential: string): number {
    return this.instances.releaseCredential(owner, credential);
  }

  /** Every instance one account has, whatever opened it. */
  releaseOwner(owner: string, reason?: string): number {
    return this.instances.releaseOwner(owner, reason);
  }

  /** Close tabs for one shared partition without disturbing other rooms. */
  releaseSharedInstance(instanceKey: string, reason: string, owner?: string): number {
    let count = 0;
    for (const [streamId, key] of this.streamInstanceKeys) {
      if (key === instanceKey) count += this.instances.releaseStream(streamId, reason, owner);
    }
    return count;
  }

  /**
   * The declared action surface of the release being served, for ONE actor
   * kind — the same `app.yaml` table the dispatch door normalises against,
   * filtered the way the agent plane filters it (`human_only` absent here AND
   * refused at the door; both halves, or neither works). Null while no release
   * is active or its manifest is unreadable, which are the same two states in
   * which nothing could be dispatched anyway.
   */
  actionSurface(
    actor: SessionPlusActorKind,
    scope?: { owner: string; agent: string; instanceKey?: string },
  ): {
    release: AppInstanceRelease;
    stateScope: "account" | "shared";
    actions: ReadonlyArray<{ name: string; spec: SessionPlusActionSpec }>;
  } | null {
    const release = this.deps.activeRelease();
    if (!release) return null;
    try {
      const manifest = this.manifestOf(release);
      let actions = sessionPlusActionsFor(manifest, actor);
      if (manifest.stateScope === "shared" && actor === "agent" && scope) {
        if (!scope?.instanceKey) return null;
        const declaration = manifest.agents[scope.agent];
        if (manifest.schema < 4 || !declaration?.role) return null;
        const principal = sessionPlusAgentPrincipal({
          owner: scope.owner,
          app: release.stableAppId,
          agent: scope.agent,
          turnId: "surface",
          role: declaration.role,
        });
        this.sharedMemberRole(manifest, release, principal, scope.instanceKey);
        actions = actions.filter(({ spec }) => roleAllows(manifest, spec, declaration.role!));
      }
      return { release, stateScope: manifest.stateScope, actions };
    } catch (error) {
      log.error({ app: release.stableAppId, err: error }, "could not read this release's app.yaml");
      return null;
    }
  }

  /** Active agent declarations; schema 4 explicitly opts shared releases in. */
  agentDeclarations() {
    const release = this.deps.activeRelease();
    if (!release) return [];
    try {
      const manifest = this.manifestOf(release);
      return manifest.stateScope === "account" || manifest.schema >= 4
        ? Object.values(manifest.agents)
        : [];
    } catch (error) {
      log.error({ app: release.stableAppId, err: error }, "could not read this release's agent declarations");
      return [];
    }
  }

  // Trusted-side inbox writes share the same stream queue as ordinary actions.
  async appendAgentInbox(input: {
    owner: string;
    instanceKey?: string;
    agent: string;
    text: string;
    from: string;
    dispatchId?: string;
  }): Promise<{ ok: true; revision: number; duplicate: boolean } | { ok: false; message: string }> {
    const release = this.deps.activeRelease();
    if (!release) return { ok: false, message: "这个 App 当前没有可服务的 release" };
    const manifest = this.manifestOf(release);
    const declaration = manifest.agents[input.agent];
    if (!declaration) return { ok: false, message: "当前 release 没有声明这个 agent" };
    let scope: { kind: string; key: string };
    let sponsorRole: string | undefined;
    if (manifest.stateScope === "shared") {
      if (manifest.schema < 4 || !declaration.role || !input.instanceKey) {
        return { ok: false, message: "共享 App agent 回合需要 schema 4 的实例与角色声明" };
      }
      try {
        sponsorRole = this.sharedMemberRole(
          manifest,
          release,
          sessionPlusAgentPrincipal({
            owner: input.owner,
            app: release.stableAppId,
            agent: input.agent,
            turnId: "inbox",
            role: declaration.role,
          }),
          input.instanceKey,
        );
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "共享实例不可用" };
      }
      scope = { kind: "shared", key: input.instanceKey };
    } else {
      if (input.instanceKey) return { ok: false, message: "这个 App 是按账户隔离的，不接受实例标识" };
      scope = { kind: "account", key: input.owner };
    }
    const value = agentInboxText(input.text);
    if (!value) return { ok: false, message: "消息不能为空" };
    const stream = await this.deps.state.resolveStream({
      app: sessionPlusStateAppKey(release),
      scope,
    });
    if (manifest.stateScope === "shared" && input.instanceKey) {
      this.streamInstanceKeys.set(stream.streamId, input.instanceKey);
    }
    return await this.coordination.appendAgentInbox({
      streamId: stream.streamId,
      backendCodeDigest: release.backendCodeDigest,
      contractDigest: release.permissionContractDigest,
      agent: input.agent,
      text: value,
      from: input.from,
      ...(manifest.stateScope === "shared" ? { owner: input.owner } : {}),
      dispatchId: input.dispatchId
        ? manifest.stateScope === "shared"
          ? `agi_shared_${createHash("sha256").update(canonicalJson({
              owner: input.owner,
              agent: input.agent,
              dispatchId: input.dispatchId,
            })).digest("hex")}`
          : input.dispatchId
        : `agi_${randomUUID()}`,
      // Re-asked inside the stream's turn, after the State read: an activation
      // or a seat change while this append waited must not commit under it.
      authorizeCommit: () => {
        if (this.deps.activeRelease()?.packageDigest !== release.packageDigest) {
          return { ok: false, message: "应用已经切换到新的 release，请重新发送" };
        }
        if (manifest.stateScope === "shared" && input.instanceKey) {
          try {
            const currentRole = this.sharedMemberRole(
              manifest,
              release,
              sessionPlusAgentPrincipal({
                owner: input.owner,
                app: release.stableAppId,
                agent: input.agent,
                turnId: "inbox",
                role: declaration.role,
              }),
              input.instanceKey,
            );
            if (currentRole !== sponsorRole) {
              return { ok: false, message: "成员角色刚刚发生了变化，请重新发送" };
            }
          } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : "共享实例不可用" };
          }
        }
        return { ok: true };
      },
    });
  }

  async readAgentInbox(
    scope: { kind: "account"; owner: string } | { kind: "shared"; owner: string; instanceKey: string },
    agent: string,
    cursor: number,
  ): Promise<{
    head: number;
    messages: Array<{ seq: number; text: string; from: string; at: string }>;
  }> {
    const release = this.deps.activeRelease();
    if (!release) throw new Error("这个 App 当前没有可服务的 release");
    const manifest = this.manifestOf(release);
    const declaration = manifest.agents[agent];
    if (!declaration) throw new Error("当前 release 没有声明这个 agent");
    let stateScope: { kind: string; key: string };
    if (manifest.stateScope === "shared") {
      if (scope.kind !== "shared" || manifest.schema < 4 || !declaration.role) {
        throw new Error("共享 App agent 回合需要 schema 4 的实例与角色声明");
      }
      this.sharedMemberRole(
        manifest,
        release,
        sessionPlusAgentPrincipal({
          owner: scope.owner,
          app: release.stableAppId,
          agent,
          turnId: "inbox-read",
          role: declaration.role,
        }),
        scope.instanceKey,
      );
      stateScope = { kind: "shared", key: scope.instanceKey };
    } else {
      if (scope.kind !== "account") throw new Error("这个 App 是按账户隔离的，不接受实例标识");
      stateScope = { kind: "account", key: scope.owner };
    }
    const stream = await this.deps.state.resolveStream({
      app: sessionPlusStateAppKey(release),
      scope: stateScope,
    });
    return await this.coordination.readAgentInbox({
      streamId: stream.streamId,
      agent,
      cursor,
      ...(scope.kind === "shared" ? { owner: scope.owner } : {}),
    });
  }

  /**
   * The declared role table of the release being served, or null for an
   * account-scoped App — and while no release is active or its manifest is
   * unreadable, which are the states in which nothing could be opened anyway
   * (`actionSurface` makes the same conflation, for the same reason).
   *
   * This is a READ face for the routes that mint instances and seat members:
   * they need role names, capacity and the observer flag without re-parsing
   * `app.yaml` in the panel. The membership DOOR itself — who may open which
   * instance, which role may drive which action — stays in `openFor` and
   * `dispatch` above and is not exported.
   */
  sharedRoles(): Readonly<Record<string, SessionPlusRoleSpec>> | null {
    const release = this.deps.activeRelease();
    if (!release) return null;
    try {
      const manifest = this.manifestOf(release);
      return manifest.stateScope === "shared" ? manifest.roles : null;
    } catch (error) {
      log.error({ app: release.stableAppId, err: error }, "could not read this release's app.yaml");
      return null;
    }
  }

  /**
   * Which roles a share-link visitor may take for themselves, or null for an
   * account-scoped App. See `sharedJoinPolicy` — the routes that seat members
   * read it; the membership door itself is unchanged.
   */
  sharedJoinPolicy(): SharedJoinPolicy | null {
    const release = this.deps.activeRelease();
    if (!release) return null;
    try {
      const manifest = this.manifestOf(release);
      return manifest.stateScope === "shared" ? sharedJoinPolicy(manifest) : null;
    } catch (error) {
      log.error({ app: release.stableAppId, err: error }, "could not read this release's app.yaml");
      return null;
    }
  }

  /**
   * One owner's commit chain, oldest first — the repair face ADR 0007's
   * acceptance judges by. Evidence summaries only (actor, action, hashes,
   * digests, event count); raw params and event payloads stay in the store.
   * The stream is named by (release identity, owner) exactly as `openFor`
   * names it, so nothing in the arguments can address another owner's stream.
   */
  async readLog(
    owner: string,
    options: { instanceKey?: string; sinceSeq?: number; limit?: number } = {},
  ): Promise<AppLogResult> {
    if (!owner) return { ok: false, code: "unavailable", message: "owner is required" };
    const release = this.deps.activeRelease();
    if (!release) return { ok: false, code: "no_release", message: "这个 App 当前没有正在服务的 release" };
    try {
      const manifest = this.manifestOf(release);
      let scope: { kind: string; key: string };
      if (manifest.stateScope === "shared") {
        if (!options.instanceKey) {
          return { ok: false, code: "invalid_instance", message: "这个 App 是共享实例制：读取日志需要实例标识" };
        }
        const instance = this.deps.shared?.instance(release.stableAppId, options.instanceKey);
        if (!instance || instance.status !== "open") {
          return { ok: false, code: "invalid_instance", message: "共享实例不存在或已关闭" };
        }
        if (!this.deps.shared?.member(release.stableAppId, options.instanceKey, owner)) {
          return { ok: false, code: "forbidden", message: "你不是这个共享实例的成员" };
        }
        scope = { kind: "shared", key: options.instanceKey };
      } else {
        if (options.instanceKey) {
          return { ok: false, code: "invalid_instance", message: "这个 App 是按账户隔离的，不接受实例标识" };
        }
        scope = { kind: "account", key: owner };
      }
      const stream = await this.deps.state.resolveStream({
        app: sessionPlusStateAppKey(release),
        scope,
      });
      const read = await this.deps.state.readCommits(stream.streamId, options.sinceSeq ?? 0, options.limit ?? 50);
      return { ok: true, head: read.head, commits: read.commits };
    } catch (error) {
      log.warn({ app: release.stableAppId, err: error }, "could not read the app-state commit log");
      return { ok: false, code: "unavailable", message: "状态流暂时不可读" };
    }
  }

  async health(): Promise<{ ok: boolean; state: boolean; runtime: boolean }> {
    return await this.coordination.health(this.deps.activeRelease()?.backendCodeDigest);
  }

  stop(): void {
    this.instances.stop();
  }

  // ── internals ──

  /**
   * One parsed `app.yaml` per release tree, cached because a release is
   * immutable and the tree is named by its package digest.
   */
  private manifestOf(release: AppInstanceRelease): SessionPlusManifest {
    const cached = this.manifests.get(release.appDir);
    if (cached) return cached;
    const load = this.deps.loadManifest
      ?? ((appDir: string, appId: string) => loadSessionPlusManifest(appDir, { appId }));
    const manifest = load(release.appDir, release.stableAppId);
    this.manifests.set(release.appDir, manifest);
    return manifest;
  }

  /** One fresh shared-membership decision, reused by tab opens and directory reads. */
  private sharedMemberRole(
    manifest: SessionPlusManifest,
    release: AppInstanceRelease,
    principal: SessionPlusPrincipal,
    instanceKey: string,
  ): string {
    const directory = this.deps.shared;
    if (!directory) throw new Error("此部署没有接入共享实例目录，无法打开共享 App");
    const instance = directory.instance(release.stableAppId, instanceKey);
    if (!instance || instance.status !== "open") throw new Error("共享实例不存在或已关闭");
    const member = directory.member(release.stableAppId, instanceKey, principal.owner);
    if (!member) throw new Error("你不是这个共享实例的成员");
    if (!manifest.roles[member.role]) throw new Error(`成员角色 ${member.role} 不在当前 release 的角色表里`);
    return member.role;
  }

  /** Trusted, read-only evidence for a projection; never sourced from a proposal. */
  private viewerEvidence(
    manifest: SessionPlusManifest,
    release: AppInstanceRelease,
    principal: SessionPlusPrincipal,
    instanceKey?: string,
  ): RuntimeJson {
    const actor = principalActor(principal);
    const memberRole = manifest.stateScope === "shared" && instanceKey
      ? this.deps.shared?.member(release.stableAppId, instanceKey, principal.owner)?.role
      : undefined;
    const role = actor.kind === "agent" && actor.role ? actor.role : memberRole;
    return this.actorEvidence(principal, role);
  }

  /** Actor/viewer evidence is built only from the trusted principal and doors. */
  private actorEvidence(principal: SessionPlusPrincipal, role?: string): RuntimeJson {
    const actor = principalActor(principal);
    if (actor.kind === "agent" && actor.role) {
      return { kind: "agent", app: actor.app, agent: actor.agent, role: actor.role };
    }
    return {
      user: principal.owner,
      kind: actor.kind,
      ...(role ? { role } : {}),
    };
  }
}

/**
 * The ONE principal an external trusted host acts under.
 *
 * Exported so the external host service rebuilds the identical principal for
 * every later call on the same binding rather than keeping one alive across
 * requests — a principal that outlived the row it came from would be exactly
 * the stale authority this surface exists to avoid. It is deterministic in its
 * inputs for the same reason: two calls of one binding must produce the same
 * identity, or a handle would stop resolving mid-session.
 *
 * `externalPresence` is what admits a `user` actor with no browser session, and
 * it is unforgeable outside `app-core/instance.ts`. A plain
 * `{session: false}` user principal is still refused by `assertPrincipal`.
 */
export function externalAppPrincipal(input: {
  owner: string;
  credential: string;
  host: string;
  app: string;
  actor: "user" | "agent";
  agent?: string;
}): SessionPlusPrincipal {
  const presence = externalPresence(input.host);
  return input.actor === "agent"
    ? {
        owner: input.owner,
        credential: input.credential,
        session: false,
        external: presence,
        actor: {
          kind: "agent",
          app: input.app,
          agent: input.agent || "external",
          // The binding IS the turn: an external agent binding is long-lived and
          // revocable, so naming a fresh uuid here would make two calls of one
          // binding read as two unrelated turns in the trusted record.
          turnId: input.credential,
        },
      }
    : { owner: input.owner, credential: input.credential, session: false, external: presence };
}

function roleAllows(
  manifest: SessionPlusManifest,
  spec: SessionPlusActionSpec,
  roleName: string,
): boolean {
  const role = manifest.roles[roleName];
  return spec.roles ? spec.roles.includes(roleName) : Boolean(role) && !role.observer;
}

/** The roles a share-link visitor may seat themselves in, and the default one. */
export interface SharedJoinPolicy {
  /** The App's least-privileged member role: what a join without a role takes. */
  defaultRole: string;
  /** `defaultRole` plus every role that may drive no human action beyond it. */
  joinable: readonly string[];
}

/**
 * Self-service seating is bounded by privilege (B5).
 *
 * A share link is the bare instance key, so whoever holds it must not be able
 * to pick an approver's or a game's first player's seat for themselves. The
 * platform's own privilege vocabulary is the per-action role allowlist (the
 * door every dispatch passes), so "least privileged" is decided on it: among
 * member (non-observer) roles, the one allowed the fewest human actions — more
 * seats, then declaration order, break ties — is the default, and a visitor may
 * take it or any role whose human actions are a subset of it (an observer, an
 * equivalent peer). Every other role is granted only by the instance's creator
 * through member management.
 */
export function sharedJoinPolicy(manifest: SessionPlusManifest): SharedJoinPolicy {
  const names = Object.keys(manifest.roles);
  const actionsOf = new Map(names.map((role) => [role, new Set(
    Object.entries(manifest.actions)
      .filter(([, spec]) => !spec.agentOnly && roleAllows(manifest, spec, role))
      .map(([id]) => id),
  )]));
  const members = names.filter((role) => !manifest.roles[role]!.observer);
  const ranked = (members.length ? members : names).slice().sort((a, b) =>
    actionsOf.get(a)!.size - actionsOf.get(b)!.size
    || manifest.roles[b]!.max - manifest.roles[a]!.max
    || names.indexOf(a) - names.indexOf(b));
  const defaultRole = ranked[0]!;
  const ceiling = actionsOf.get(defaultRole)!;
  return {
    defaultRole,
    joinable: names.filter((role) => [...actionsOf.get(role)!].every((action) => ceiling.has(action))),
  };
}
