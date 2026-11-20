import type { AppAgentActivity } from "@claude-bot/dashboard-web/contract";
import type { AppAgentActivityPort, AppAgentActivityScope } from "../app-agents/activity.js";
import { OPEN_SHARED_SESSION_ACTION, readCodexTokenUsage } from "@claude-bot/agent-sessions-contract";
import { SessionSharingService, SHARED_PROMPT_ACTIONS } from "./sharing.js";
import { randomUUID } from "node:crypto";
import { AGENT_SESSIONS_WAKE_REF } from "@claude-bot/agent-sessions-contract";
import type { ResourceBindingPlan } from "@claude-bot/agent-module-contract";
import { RESERVED_PARAMS } from "@claude-bot/typed-port-kit";
import type { AppRuntimeClient, RuntimeJson } from "@claude-bot/app-runtime";
import type { StateClient } from "@claude-bot/app-state";
import {
  RESOURCE_PARAM_COUNT,
  RESOURCE_PARAM_DEFAULT_MAX,
  resourceParamLimits,
} from "../agent-resources/wire-limits.js";
import type {
  SessionResourceExecuteOptions,
  SessionResourcePort,
  SessionResourceSubscription,
  SessionResourceWatchEvent,
} from "../session-resource/types.js";
import {
  mergeTranscriptTail,
  reconcileTranscriptWindows,
  retainTranscripts,
  runtimeJson,
} from "../session-resource/projection.js";
import { sessionPlusStateAppKey, type SessionPlusIdentity } from "../app-core/identity.js";
import {
  SessionPlusInstances,
  instanceMessage,
  principalActor,
  type InstanceEvent,
  type InstanceSubscription,
  type SessionPlusInstanceBinding,
  type SessionPlusInstanceLimits,
  type SessionPlusPrincipal,
} from "../app-core/instance.js";
import { eventAuthor, sessionPlusAgentPrincipal } from "../app-core/principal.js";
import {
  loadSessionPlusManifest,
  normalizeSessionPlusAction,
  type SessionPlusManifest,
} from "../app-core/manifest.js";
import {
  SESSION_PLUS_OPERATION_ACTIONS,
  SessionPlusOperationBinding,
  sessionOperationReceipt,
  type SessionPlusOperationAction,
} from "./operation-binding.js";
import {
  SESSION_PLUS_INTERACTION_ACTION,
  type SessionPlusInteractionBinding,
} from "./interaction-binding.js";
import type { SessionPlusSessionChangeBinding } from "./session-change-binding.js";
import { AppCoordinationEngine, agentInboxText } from "../app-core/coordination-engine.js";

/**
 * One App instance's typed-resource handle, as this coordinator holds it.
 *
 * Two methods and no way to name another instance — the catalog issues it bound
 * to (owner, publisher, app, instance, plan) and never accepts an identity next
 * to a proposal. That is what makes "a tab that never read anything" and "a new
 * tab" two different things when a device credential changes.
 */
interface TranscriptSlot {
  subscription: SessionResourceSubscription | null;
  maxMessages: number;
  generation: number;
  pending: number;
}

export interface SessionPlusResourceHandle {
  dispatch(proposal: { action: string; params: Readonly<Record<string, string>> }): Promise<
    { ok: true; result: unknown } | { ok: false; code: string; message: string }
  >;
  close(): Promise<void>;
}

/**
 * The trusted seam onto the deployment's sealed provider catalog.
 *
 * `planFor` takes the package digest of the release this open CAPTURED, and
 * answers with that release's plan or null. Taking the digest rather than
 * reading "whatever is active" is what keeps an instance from being assembled
 * out of half of each release when an activation lands mid-open.
 */
export interface SessionPlusResourceBinder {
  planFor(packageDigest: string): ResourceBindingPlan | null;
  openInstance(identity: {
    owner: string;
    publisher: string;
    app: string;
    packageDigest: string;
    permissionContractDigest: string;
    instance: string;
    plan: ResourceBindingPlan;
  }): SessionPlusResourceHandle;
}

/**
 * The wire prefix every typed-resource proposal carries.
 *
 * Resource reads do NOT go through the App's declared action surface: an
 * `app.yaml` action is something the App's own backend or the session
 * coordinator implements, while these are served by a provider the DEPLOYMENT
 * installed, selected through the release's binding plan. Routing them by
 * prefix — before manifest normalisation — is what keeps those two vocabularies
 * from having to be merged into one table that both halves must agree about.
 */
const RESOURCE_ACTION_PREFIX = "resource.";

/**
 * Bounds a resource proposal's params without knowing what any of them mean.
 *
 * The count and the default length come from the kit (via `wire-limits.ts`), so
 * a contract declaring its fields against those numbers is measured against the
 * same ones here. Only the key grammar is restated, because it is the one rule
 * that has to hold for a parameter this side has never heard of.
 */
const RESOURCE_PARAM_KEY = /^[a-z][a-z0-9_]{0,63}$/;

export interface SessionPlusAppDeps {
  agentActivity?: AppAgentActivityPort;
  state: StateClient;
  runtime: AppRuntimeClient;
  /**
   * The release being served.
   *
   * A function when the composition can activate another release without
   * restarting: the backend code digest, the package digest and the declared
   * action surface all move together, and a coordinator holding a snapshot of
   * them would keep invoking the previous release's handlers after the swap. A
   * plain object is the single-release deployment and behaves exactly as before.
   */
  identity: SessionPlusIdentity | (() => SessionPlusIdentity | null);
  manifest?: SessionPlusManifest | (() => SessionPlusManifest | null);
  now?: () => number;
  /** Admission limits; injectable for conformance tests and small deployments. */
  instanceLimits?: SessionPlusInstanceLimits;
  /**
   * Legacy rollback releases still declare `attach_image`, which stored one
   * screenshot on the trusted bot host. Keep that exact seam while such a
   * release is active; the current `attach_file` action instead crosses the
   * resource/Gate path to the selected session host.
   */
  attachments?: (input: {
    owner: string;
    name: string;
    mediaType: string;
    data: string;
  }) => Promise<
    | { ok: true; attachment: { label: string; path: string; bytes: number } }
    | { ok: false; message: string }
  >;
}

/** The instance-lifecycle slice of AppAuthorityBundles used by this coordinator. */
export interface SessionPlusAuthorityLifecycle {
  /**
   * `actor` decides one thing and only one: whether auto-allow is inherited.
   * Unsupervised access is a property of a person having pressed a button.
   */
  open(owner: string, instanceId: string, packageDigest: string, actor?: "user" | "agent" | "guest"): unknown;
  contextIds?(instanceId: string): string[];
  destroy(instanceId: string): boolean;
}

export interface OpenSessionPlusResult {
  handle: string;
  /** Trusted parent-only epoch for typed-resource proposals. Never sent to the View. */
  resourceGeneration: number;
  projection: RuntimeJson;
  /** Monotonic for every projection frame in this instance, including resource-only reads. */
  revision: number;
  expiresAt: number;
}

interface ResourceHandleSlot {
  generation: number;
  handle: SessionPlusResourceHandle;
  /**
   * This release's binding name → contract id, snapshotted when the handle was
   * opened.
   *
   * A snapshot for the same reason the catalog takes one: the plan belongs to
   * the release this instance CAPTURED, and re-reading "whatever is active"
   * mid-instance is how a call gets assembled out of half of each release. It is
   * read for exactly one purpose — how long a declared parameter may be — and
   * the catalog still resolves the binding itself when it decides what may
   * actually be called.
   */
  contracts: ReadonlyMap<string, string>;
}

/**
 * Why a dispatch did not happen.
 *
 * The first six are this coordinator's own vocabulary. `resource_refused` is
 * different in kind: it means a typed-resource provider answered, and its own
 * domain code travels alongside in `resourceCode`. Flattening those into
 * `action_rejected` would lose exactly the distinctions a person can act on —
 * `approval_required` ("go and approve it"), `too_large`, `not_text` — and the
 * remote port on the other side maps them by code, not by prose.
 */
export type DispatchResult =
  | { ok: true; result: RuntimeJson | null; projection?: RuntimeJson; revision: number }
  | {
      ok: false;
      code: "unknown_action" | "action_rejected" | "invalid_instance" | "instance_expired" | "instance_stale" | "state_conflict" | "resource_refused";
      message: string;
      /** Present only for `resource_refused`: the provider's own bounded code. */
      resourceCode?: string;
    };


/** Historical action id kept only for installed rollback releases. */
const LEGACY_SESSION_PLUS_ATTACH_ACTION = "attach_image";
/** Reads stay available after this live-follow budget is reached. */
const TRANSCRIPT_SUBSCRIPTION_MAX = 64;
const TRANSCRIPT_STATUS_MAX = TRANSCRIPT_SUBSCRIPTION_MAX * 2;

function retainTranscriptStatus(previous: RuntimeJson | undefined, resource: string, status: RuntimeJson): Record<string, RuntimeJson> {
  const entries = Object.entries(asObject(previous ?? null)).filter(([key]) => key !== resource)
    .slice(-(TRANSCRIPT_STATUS_MAX - 1));
  return Object.fromEntries([...entries, [resource, status]]);
}

/** Coordinates one thin App against the two reusable process services. */
export class SessionPlusAppService {
  readonly instances: SessionPlusInstances;
  private readonly coordination: AppCoordinationEngine;
  private readonly manifestOf: () => SessionPlusManifest | null;
  private readonly now: () => number;
  private resourceSubscriptions = new Map<string, Map<string, TranscriptSlot>>();
  /** One typed-resource handle per instance, for releases that declare a plan. */
  private resourceHandles = new Map<string, ResourceHandleSlot>();
  private operationSubscriptions = new Map<string, () => void>();
  private sessionChangeSubscriptions = new Map<string, () => void>();
  /** Latest-start-wins token for roster reads; values never restart per tab. */
  private nextRefreshGeneration = 0;
  private refreshGenerations = new Map<string, number>();
  private authority: SessionPlusAuthorityLifecycle | null = null;
  private resources: SessionResourcePort | null = null;
  private operations: SessionPlusOperationBinding | null = null;
  private interactions: SessionPlusInteractionBinding | null = null;
  private sessionChanges: SessionPlusSessionChangeBinding | null = null;
  /**
   * The sealed provider catalog, when this composition installed one.
   *
   * Null means every `resource.*` proposal is a bounded refusal — which is
   * exactly what the `legacy` and `modular-v1` rollback targets need, since
   * neither ships a binding plan for it to read.
   */
  private resourceBinder: SessionPlusResourceBinder | null = null;
  sharing: SessionSharingService | null = null;
  private sharingUnsubscribe: (() => void) | null = null;
  private readonly shareTimers = new Map<string, NodeJS.Timeout>();

  attachSharing(sharing: SessionSharingService): void {
    this.sharingUnsubscribe?.();
    this.sharing = sharing;
    this.sharingUnsubscribe = sharing.onChanged((id) => {
      const row = sharing.repository.get(id);
      for (const binding of this.instances.allBindings()) {
        if (binding.delegation?.shareId === id && row?.revokedAt !== null) this.instances.destroyBinding(binding.id, "share_revoked");
        else if (binding.delegation?.shareId === id || !binding.delegation && binding.owner === row?.owner) this.instances.updateStreamBinding(binding.id, binding.streamId, binding.head, binding.projection);
      }
    });
  }


  constructor(private readonly deps: SessionPlusAppDeps) {
    const manifest = deps.manifest ?? loadSessionPlusManifest();
    this.manifestOf = typeof manifest === "function" ? manifest : () => manifest;
    this.now = deps.now ?? Date.now;
    this.coordination = new AppCoordinationEngine({
      state: deps.state,
      runtime: deps.runtime,
      now: this.now,
    });
    this.instances = new SessionPlusInstances(
      // Read at every resolve, so an activation makes every open tab's instance
      // `instance_stale` on its next call — a tab must not keep driving the
      // previous release's backend through a handle it already holds.
      () => new Set(this.activeIdentity ? [this.activeIdentity.packageDigest] : []),
      this.now,
      undefined,
      (binding) => {
        this.sharing?.unbind(binding.id);
        clearTimeout(this.shareTimers.get(binding.id));
        this.shareTimers.delete(binding.id);
        this.refreshGenerations.delete(binding.id);
        this.closeResourceSubscription(binding.id);
        this.closeResourceHandle(binding.id);
        this.closeOperationSubscription(binding.id);
        this.closeSessionChangeSubscription(binding.id);
        const contexts = this.authority?.contextIds?.(binding.id) ?? [];
        this.operations?.endContexts(binding.owner, contexts, "会话+ 实例已结束");
        this.authority?.destroy(binding.id);
      },
      deps.instanceLimits,
      "session-plus",
      (binding, projection) => this.sharing?.project(binding, projection) ?? projection,
    );
    this.instances.start();
  }

  /** The release being served right now. Re-read on every use; see the deps. */
  private get activeIdentity(): SessionPlusIdentity | null {
    const source = this.deps.identity;
    return typeof source === "function" ? source() : source;
  }

  /** One-time trusted composition seam; App Runtime never receives this object. */
  attachAuthority(
    authority: SessionPlusAuthorityLifecycle,
    resources?: SessionResourcePort,
    operations?: SessionPlusOperationBinding,
    binder?: SessionPlusResourceBinder,
    interactions?: SessionPlusInteractionBinding,
    sessionChanges?: SessionPlusSessionChangeBinding,
  ): () => void {
    if (this.authority || this.instances.size > 0) {
      throw new Error("Session Plus authority must be attached exactly once before opening an instance");
    }
    this.authority = authority;
    this.resources = resources ?? null;
    this.operations = operations ?? null;
    this.resourceBinder = binder ?? null;
    this.interactions = interactions ?? null;
    this.sessionChanges = sessionChanges ?? null;
    let attached = true;
    return () => {
      if (!attached) return;
      if (this.instances.size > 0) {
        throw new Error("Session Plus authority attachment cannot roll back after opening an instance");
      }
      attached = false;
      if (this.authority !== authority) return;
      this.authority = null;
      this.resources = null;
      this.operations = null;
      this.resourceBinder = null;
      this.interactions = null;
      this.sessionChanges = null;
    };
  }

  shareOptions(handle: string, principal: SessionPlusPrincipal) {
    const resolved = this.instances.resolve(handle, principal);
    if (!resolved.ok || !principal.session || principal.delegation || !this.sharing) throw new Error("共享签发需要本人会话");
    return { sessions: asObject(resolved.binding.projection).sessions ?? [], workspaces: this.sharing.workspaceChoices(resolved.binding.projection) };
  }

  createShare(handle: string, principal: SessionPlusPrincipal, input: { resource: string; workspaces: unknown; preset?: string; hours?: number }) {
    const resolved = this.instances.resolve(handle, principal);
    if (!resolved.ok || !principal.session || principal.delegation || !this.sharing) throw new Error("共享签发需要本人会话");
    return this.sharing.create(principal.owner, input.resource, resolved.binding.projection, input.workspaces, input.preset, input.hours);
  }

  async open(principal: SessionPlusPrincipal): Promise<OpenSessionPlusResult> {
    if (!principal.session || !principal.owner) throw new Error("会话+ 需要账户浏览器会话");
    return await this.openFor(principal);
  }

  /**
   * Open one App instance for ONE agent turn.
   *
   * The same admission, the same State stream, the same provider handle and the
   * same operation subscription a tab gets — which is the point: an agent's
   * proposal has to arrive at the identical door, or "the agent goes through the
   * same checks" is a claim with no mechanism behind it.
   *
   * The lifetime is a turn, not a tab, and that is exactly what the provider
   * catalog's "an instance never reopens" rule wants: a revocation that lands
   * between two turns is honoured by the next one because it opens a NEW
   * instance, rather than being outlived by a long-lived handle.
   */
  async openAgentTurn(input: {
    owner: string;
    app: string;
    agent: string;
    turnId: string;
  }): Promise<OpenSessionPlusResult> {
    if (!input.owner) throw new Error("会话+ agent 轮次需要 owner");
    return await this.openFor(sessionPlusAgentPrincipal(input));
  }

  private async openFor(principal: SessionPlusPrincipal): Promise<OpenSessionPlusResult> {
    // Capture one release for the whole open. An activation may complete while
    // State/Runtime calls await, but one instance must never be assembled from
    // half of each release; a captured old one simply becomes stale on use.
    const identity = this.activeIdentity;
    if (!identity) throw new Error("会话+ 当前没有可服务的 release");
    // Admission happens before State reads and sandbox projection. Without the
    // reservation, a caller already at its tab ceiling could still spend all of
    // that work on every rejected GET, and concurrent opens could all pass a
    // late check before any one of them committed.
    const reservation = this.instances.reserve(principal);
    try {
      const stream = await this.deps.state.resolveStream({
        app: sessionPlusStateAppKey(identity),
        scope: { kind: "account", key: principal.owner },
      });
      const durable = await this.coordination.project({
        streamId: stream.streamId,
        backendCodeDigest: identity.backendCodeDigest,
      });
      const durableProjection = durable.projection;
      const projection = this.operations
        ? {
            ...asObject(durableProjection),
            operations: runtimeJson(this.operations.list(principal.owner)),
          } as RuntimeJson
        : durableProjection;
      const created = reservation.commit({
        principal,
        packageDigest: identity.packageDigest,
        contractDigest: identity.permissionContractDigest,
        streamId: stream.streamId,
        head: durable.canonical.head,
        projection,
      });
      try {
        if (principal.delegation && !this.sharing) throw new Error("共享服务未接入");
        this.sharing?.bind(created.binding.id, principal);
        if (principal.delegation) {
          const share = this.sharing!.access(principal.delegation.shareId, principal.delegation.viewer);
          const expire = () => {
            const latest = this.sharing!.repository.get(share.id);
            if (!latest || latest.revokedAt !== null || latest.expiresAt <= this.now()) { this.instances.destroy(created.handle, principal, "share_expired"); return; }
            const timer = setTimeout(expire, Math.min(2_147_483_647, Math.max(1, latest.expiresAt - this.now())));
            timer.unref(); this.shareTimers.set(created.binding.id, timer);
          };
          expire();
        }
        this.authority?.open(
          principal.owner,
          created.binding.id,
          identity.packageDigest,
          // A share guest drives the owner's planes but is not the owner.
          principal.delegation ? "guest" : principalActor(principal).kind,
        );
        // The resource handle is registered HERE, before this tab has read
        // anything — that is what makes a tab closed before its first file
        // request a REGISTERED, then RETIRED instance, so a late proposal on its
        // channel finds a closed handle instead of opening a provider for the
        // first time. Only a release whose inventory carries a binding plan gets
        // one; the rollback targets reach nothing.
        const plan = this.resourceBinder?.planFor(identity.packageDigest) ?? null;
        if (plan && this.resourceBinder) this.openResourceHandle(created.binding, identity, plan, 1);
        this.startOperationSubscription(created.handle, principal, created.binding.id);
        this.startSessionChangeSubscription(created.handle, principal, created.binding.id);
      } catch (error) {
        this.instances.destroy(created.handle, principal, "authority_open_failed");
        throw error;
      }
      return {
        handle: created.handle,
        resourceGeneration: this.resourceHandles.get(created.binding.id)?.generation ?? 0,
        projection: created.binding.projection,
        revision: created.binding.viewRevision,
        expiresAt: created.binding.expiresAt,
      };
    } finally {
      reservation.release();
    }
  }

  async dispatch(
    handle: string,
    principal: SessionPlusPrincipal,
    proposal: { action?: unknown; params?: unknown },
    resourceGeneration?: number,
  ): Promise<DispatchResult> {
    const resolved = this.instances.resolve(handle, principal);
    if (!resolved.ok) return { ok: false, code: resolved.code, message: instanceMessage(resolved.code) };
    // As with open(), pin every await in this dispatch to one coherent release.
    // A call already in flight may drain on that release; the next call sees a
    // stale instance. Re-reading `this.activeIdentity` after an await would be
    // the forbidden half-old/half-new execution.
    const identity = this.activeIdentity;
    const manifest = this.manifestOf();
    if (!identity || !manifest || identity.packageDigest !== resolved.binding.packageDigest) {
      return { ok: false, code: "instance_stale", message: instanceMessage("instance_stale") };
    }
    if (proposal.action === OPEN_SHARED_SESSION_ACTION && principal.session && this.sharing) {
      const action = normalizeSessionPlusAction(manifest, proposal.action, proposal.params, principalActor(principal).kind);
      if (!action.ok || principal.delegation) return { ok: false, code: "action_rejected", message: "当前界面不能切换共享会话" };
      const shareId = String(asObject(proposal.params as RuntimeJson).share_id ?? "");
      try {
        this.sharing.access(shareId, principal.owner, false);
        return { ok: true, result: { shareId }, projection: resolved.binding.projection, revision: resolved.binding.viewRevision };
      } catch { return { ok: false, code: "action_rejected", message: "共享不存在或无权访问" }; }
    }
    if (typeof proposal.action === "string") {
      try { this.sharing?.check(resolved.binding.id, proposal.action, asObject(proposal.params as RuntimeJson) as Record<string, string>); }
      catch (error) { return { ok: false, code: "action_rejected", message: error instanceof Error ? error.message : "共享访问已失效" }; }
    }
    if (typeof proposal.action === "string" && proposal.action.startsWith(RESOURCE_ACTION_PREFIX)) {
      if (principalActor(principal).kind === "agent") {
        // The agent surface is EXACTLY the declared actions. Typed-port
        // proposals are addressed by an iframe generation the plane never
        // holds, so this was already unreachable — but "unreachable because a
        // number does not match" and "refused because agents do not have this
        // surface" are one edit apart, and only the second one is a sentence.
        return {
          ok: false,
          code: "unknown_action",
          message: "agent 不能直接提议 typed port 资源动作，只能调用 app.yaml 声明的动作",
        };
      }
      return await this.dispatchResource(
        handle,
        principal,
        resolved.binding,
        proposal.action,
        proposal.params,
        resourceGeneration,
      );
    }
    // ONE normaliser, for the button face and the agent face alike. The only
    // thing that differs is the actor, and it comes from the principal the
    // trusted caller built — never from anything a model or a View said.
    const actor = principalActor(principal);
    const normalized = normalizeSessionPlusAction(manifest, proposal.action, proposal.params, actor.kind);
    if (!normalized.ok) {
      return {
        ok: false,
        code: normalized.code === "unknown_action" ? "unknown_action" : "action_rejected",
        message: normalized.message,
      };
    }
    const spec = manifest.actions[normalized.action];
    if (spec.binding === "resource") {
      if (normalized.action === "close_session") {
        const resource = normalized.params.resource;
        if (!this.resourceSubscriptions.get(resolved.binding.id)?.has(resource)) {
          return { ok: true, result: null, projection: resolved.binding.projection, revision: resolved.binding.viewRevision };
        }
        this.closeResourceSubscription(resolved.binding.id, resource);
        const projection = asObject(resolved.binding.projection);
        const status = { resource, state: "closed", message: "" };
        const next = { ...projection,
          transcriptStatuses: retainTranscriptStatus(projection.transcriptStatuses, resource, status),
          transcriptStatus: status,
        } as RuntimeJson;
        const revision = this.instances.update(handle, next);
        return { ok: true, result: null, projection: next, revision: revision ?? resolved.binding.viewRevision };
      }
      if (normalized.action === SESSION_PLUS_INTERACTION_ACTION) {
        if (!this.interactions) {
          return { ok: false, code: "action_rejected", message: "Agent 交互控制面尚未接入" };
        }
        const answered = await this.interactions.submit(resolved.binding, principal, normalized.params);
        if (!answered.ok) return { ok: false, code: "action_rejected", message: answered.error };
        const revision = this.instances.update(handle, answered.projection);
        if (revision === null) {
          return { ok: false, code: "invalid_instance", message: instanceMessage("invalid_instance") };
        }
        return {
          ok: true,
          result: answered.result,
          projection: this.instances.resolve(handle, principal).ok ? this.sharing?.project(resolved.binding, answered.projection) ?? answered.projection : {},
          revision,
        };
      }
      if (normalized.action === LEGACY_SESSION_PLUS_ATTACH_ACTION) {
        if (!this.deps.attachments) {
          return { ok: false, code: "action_rejected", message: "这个部署没有可写的附件目录" };
        }
        const stored = await this.deps.attachments({
          owner: resolved.binding.owner,
          name: normalized.params.name ?? "",
          mediaType: normalized.params.media_type ?? "",
          data: normalized.params.data ?? "",
        });
        if (!stored.ok) return { ok: false, code: "action_rejected", message: stored.message };
        const live = this.instances.resolve(handle, principal);
        if (!live.ok) return { ok: false, code: live.code, message: instanceMessage(live.code) };
        return {
          ok: true,
          result: runtimeJson(stored.attachment),
          projection: live.binding.projection,
          revision: live.binding.viewRevision,
        };
      }
      if (isOperationAction(normalized.action)) {
        if (!this.operations) {
          return { ok: false, code: "action_rejected", message: "操作协调器尚未接入" };
        }
        const sharedPrompt = Boolean(principal.delegation && SHARED_PROMPT_ACTIONS.has(normalized.action));
        if (sharedPrompt) {
          const read = await this.dispatch(handle, principal, { action: "open_session", params: { resource: normalized.params.resource, limit: "1" } });
          if (!read.ok) return read;
          const fresh = this.instances.resolve(handle, principal);
          const transcript = asObject(asObject(fresh.ok ? fresh.binding.projection : {}).transcript)[normalized.params.resource];
          const runtime = asObject(asObject(transcript).runtime);
          const activity = asObject(asObject(transcript).activity);
          if (runtime.turn_state === "working" || runtime.turn_state === "needs_input" || ["thinking", "tool", "working"].includes(String(activity.state))) return { ok: false, code: "action_rejected", message: "请等待当前轮次结束；共享额度按独立轮次结算" };
          if (normalized.action === "append_session" && runtime.control_mode === "external_cli") return { ok: false, code: "action_rejected", message: "请先接管此会话以启用原生 token 结算" };
          const usage = readCodexTokenUsage(asObject(transcript).usage);
          try { this.sharing!.beginPrompt(resolved.binding.id, usage?.totalTokens ?? NaN); }
          catch (error) { return { ok: false, code: "action_rejected", message: error instanceof Error ? error.message : "用量暂不可用" }; }
        }
        const submitted = await this.operations.submit(
          resolved.binding,
          principal,
          normalized.action,
          normalized.params,
        );
        if (sharedPrompt) this.sharing!.promptSubmitted(resolved.binding.id, submitted.ok ? submitted.operation.id : null);
        if (!submitted.ok) {
          return { ok: false, code: "action_rejected", message: submitted.error };
        }
        const receipt = runtimeJson(sessionOperationReceipt(submitted.operation));
        const operation = runtimeJson(submitted.operation);
        this.instances.recordOperation(resolved.binding.id, operation);
        const live = this.instances.resolve(handle, principal);
        // Admission is durable. Losing the view after submission cannot turn
        // that accepted operation into a refusal that invites another send.
        return {
          ok: true,
          result: receipt,
          projection: live.ok ? live.binding.projection : {},
          revision: live.ok ? live.binding.viewRevision : resolved.binding.viewRevision,
        };
      }
      if (!this.resources) return { ok: false, code: "action_rejected", message: "资源控制面尚未接入" };
      const instanceId = resolved.binding.id;
      // Optional action strings normalize to an empty string, not undefined.
      // Explicit "0" is still a history-page offset and must not acquire a watch.
      const tailResource = normalized.action === "open_session" && !normalized.params.offset
        ? normalized.params.resource : undefined;
      const transcriptSlot = tailResource ? this.holdTranscriptSlot(instanceId, tailResource) : null;
      const refreshGeneration = normalized.action === "refresh_sessions"
        ? this.beginRefresh(instanceId)
        : null;
      const refreshOptions: SessionResourceExecuteOptions | undefined = refreshGeneration === null
        ? undefined
        : {
            isCurrent: () => this.isCurrentRefresh(instanceId, refreshGeneration),
            onPatch: (patch) => {
              if (!this.isCurrentRefresh(instanceId, refreshGeneration)) return;
              const live = this.instances.resolve(handle, principal);
              if (!live.ok || live.binding.id !== instanceId) return;
              const projection = { ...asObject(live.binding.projection), ...patch } as RuntimeJson;
              this.instances.update(handle, projection);
            },
          };
      try {
        const resource = await this.resources.execute(
          instanceId,
          normalized.action,
          normalized.params,
          resolved.binding.projection,
          refreshOptions,
        );
        if (refreshGeneration !== null && !this.isCurrentRefresh(instanceId, refreshGeneration)) {
          // This proposal was superseded after it independently crossed Gate.
          // Settle it against the current projection without publishing either
          // an old patch or an old refusal.
          const current = this.instances.resolve(handle, principal);
          if (!current.ok) return { ok: false, code: current.code, message: instanceMessage(current.code) };
          return {
            ok: true,
            result: null,
            projection: current.binding.projection,
            revision: current.binding.viewRevision,
          };
        }
        // Closing this resource retires pending tail opens as well as its live watch.
        // A late successful read may not resurrect a panel the reader already closed.
        if (tailResource && this.resourceSubscriptions.get(instanceId)?.get(tailResource) !== transcriptSlot) {
          const current = this.instances.resolve(handle, principal);
          if (!current.ok) return { ok: false, code: current.code, message: instanceMessage(current.code) };
          return { ok: true, result: null, projection: current.binding.projection, revision: current.binding.viewRevision };
        }
        if (!resource.ok) {
          // A device that cannot answer right now (a Runner reconnecting after
          // a deploy, a flapping link) has not refused anything. Keep the chat
          // following: the follow re-reads through the same Gate, reports
          // "reconnecting", fills the chat in once the device answers, and
          // stops only on a denial or an approval requirement. Without it the
          // panel stayed on its cached text until a manual refresh.
          if (resource.code === "resource_failed" && tailResource && transcriptSlot) {
            this.startTranscriptSubscription(
              handle,
              principal,
              instanceId,
              tailResource,
              transcriptSlot,
              boundedTranscriptWindow(normalized.params.limit),
            );
          }
          return {
            ok: false,
            code: "resource_refused",
            resourceCode: resource.code,
            // A pending id is a trusted approval-plane lookup handle. The shell
            // already owns the approval drawer; the Agent View only needs the
            // disposition and must not receive internal correlation handles.
            message: resource.message,
          };
        }
        // Re-resolve after the resource await: another resource result or an SSE
        // transcript frame may have updated this tab while the device was slow.
        // Merging onto the pre-await projection would silently revert that work.
        const live = this.instances.resolve(handle, principal);
        if (!live.ok) return { ok: false, code: live.code, message: instanceMessage(live.code) };
        const liveProjection = asObject(live.binding.projection);
        try { this.sharing?.scope(live.binding.id); }
        catch { return { ok: false, code: "action_rejected", message: "共享已到期或撤销" }; }
        if (normalized.action === "attach_file") {
          // Each ordered chunk needs only its device receipt. Uploads do not
          // change the projection: updating it here broadcasts the entire
          // roster/transcript over SSE AND includes it in the HTTP response
          // before the browser can send the next chunk (up to 32 times/file).
          // Keep the post-await instance/sharing checks above this fast path.
          return { ok: true, result: resource.result, revision: live.binding.viewRevision };
        }
        let patch = normalized.action === "refresh_workspaces"
          ? this.resources.reconcileWorkspacePatch?.(instanceId, live.binding.projection, resource.patch) ?? resource.patch
          : resource.patch;
        if (normalized.action === "open_session" && normalized.params.resource) {
          const resourceId = normalized.params.resource;
          const data = asObject(resource.patch.transcript)[resourceId];
          if (data !== undefined) {
            const current = asObject(liveProjection.transcript)[resourceId];
            // Reconcile EVERY read against the visible resource window. The
            // stale value may already have poisoned an upstream cache before
            // this request began, so an object-change-during-await test is not
            // a freshness test. Versions choose overlapping content; absolute
            // positions still let a history page extend backwards.
            const settled = current === undefined ? data : runtimeJson(reconcileTranscriptWindows(current, data));
            // The resource service bounded the snapshot it read. Bound it again
            // against the post-await map so two overlapping transcript reads do
            // not replace one another's windows or regress this resource below
            // a live frame that landed during the await.
            patch = {
              ...patch,
              transcript: retainTranscripts(liveProjection.transcript, resourceId, settled),
            };
          }
        }
        const projection = { ...liveProjection, ...patch } as RuntimeJson;
        const revision = this.instances.update(handle, projection);
        if (revision === null) {
          return { ok: false, code: "invalid_instance", message: instanceMessage("invalid_instance") };
        }
        if (tailResource && transcriptSlot) {
          this.startTranscriptSubscription(
            handle,
            principal,
            live.binding.id,
            tailResource,
            transcriptSlot,
            boundedTranscriptWindow(normalized.params.limit),
          );
        }
        const settled = this.instances.resolve(handle, principal);
        return {
          ok: true,
          result: principal.delegation && !["attach_file", "open_terminal", "read_terminal", "send_terminal", "close_terminal"].includes(normalized.action) ? null : resource.result,
          projection: settled.ok ? this.sharing?.project(settled.binding, settled.binding.projection) ?? settled.binding.projection : {},
          revision: settled.ok ? settled.binding.viewRevision : revision,
        };
      } finally {
        if (refreshGeneration !== null) this.finishRefresh(instanceId, refreshGeneration);
        if (tailResource && transcriptSlot) {
          transcriptSlot.pending -= 1;
          if (!transcriptSlot.pending && !transcriptSlot.subscription
            && this.resourceSubscriptions.get(instanceId)?.get(tailResource) === transcriptSlot) {
            this.closeResourceSubscription(instanceId, tailResource);
          }
        }
      }
    }
    if (spec.binding !== "runtime") {
      // Session Plus has its own explicit delivery route. A future manifest
      // must not make the generic binding fall through into the Runtime child.
      return { ok: false, code: "action_rejected", message: "这个 App 没有为该 agent 绑定接入投递面" };
    }
    return await this.coordination.serialize(resolved.binding.streamId, async () => {
      // Resolve again after waiting in the queue: the credential/release may
      // have ended while another pin was committing.
      const live = this.instances.resolve(handle, principal);
      if (!live.ok) return { ok: false, code: live.code, message: instanceMessage(live.code) };
      const outcome = await this.coordination.dispatch({
        streamId: live.binding.streamId,
        backendCodeDigest: identity.backendCodeDigest,
        contractDigest: identity.permissionContractDigest,
        dispatchId: `spd_${randomUUID()}`,
        action: normalized.action,
        params: normalized.params,
        context: ({ state, now }) => ({ now, state }),
        authorizeCommit: () => ({
          ok: true,
          actor: eventAuthor(identity.stableAppId, actor, live.binding.owner),
        }),
      });
      if (!outcome.ok) return outcome;
      this.instances.updateStream(
        live.binding.streamId,
        outcome.canonical.head,
        outcome.canonical.projection,
      );
      // The canonical projection contains durable App state only. Each tab may
      // also hold an ephemeral resource projection, which updateStream keeps.
      const updated = this.instances.resolve(handle, principal);
      if (!updated.ok) {
        return { ok: false, code: updated.code, message: instanceMessage(updated.code) };
      }
      return {
        ok: true,
        result: outcome.result,
        projection: updated.binding.projection,
        revision: updated.binding.viewRevision,
      };
    });
  }

  // ── the agent inbox, as trusted-side State writes ──
  //
  // Deliberately on this coordinator's engine rather than a second writer with
  // its own StateClient: the per-stream serialisation that keeps a pin and a
  // button from interleaving is the same one an inbox append needs, and
  // `app-state` has no append notification, so a second writer would be
  // invisible to the first until its next read. The write itself is the one
  // `AppCoordinationEngine.appendAgentInbox` every App uses.

  /**
   * Queue one message for an agent, durably.
   *
   * `dispatchId` makes a double-click one message: `app-state` keys idempotency
   * on `(streamId, dispatchId)`, so a retried submit returns the prior revision
   * instead of appending a twin.
   */
  async appendAgentInbox(input: {
    owner: string;
    agent: string;
    text: string;
    /** `user:<name>` / `system:daily` / `system:approval`. Trusted-side only. */
    from: string;
    dispatchId?: string;
  }): Promise<{ ok: true; revision: number; duplicate: boolean } | { ok: false; message: string }> {
    const identity = this.activeIdentity;
    if (!identity) return { ok: false, message: "会话+ 当前没有可服务的 release" };
    const text = agentInboxText(input.text);
    if (!text) return { ok: false, message: "消息不能为空" };
    const stream = await this.streamFor(input.owner, identity);
    return await this.coordination.appendAgentInbox({
      streamId: stream.streamId,
      backendCodeDigest: identity.backendCodeDigest,
      contractDigest: identity.permissionContractDigest,
      agent: input.agent,
      text,
      from: input.from,
      dispatchId: input.dispatchId ?? `agi_${randomUUID()}`,
    });
  }

  /** Everything queued for one agent after `cursor`, plus the stream head. */
  async readAgentInbox(owner: string, agent: string, cursor: number): Promise<{
    streamId: string;
    head: number;
    messages: Array<{ seq: number; text: string; from: string; at: string }>;
  }> {
    const identity = this.activeIdentity;
    if (!identity) throw new Error("会话+ 当前没有可服务的 release");
    const stream = await this.streamFor(owner, identity);
    const read = await this.coordination.readAgentInbox({ streamId: stream.streamId, agent, cursor });
    return { streamId: stream.streamId, ...read };
  }

  private async streamFor(owner: string, identity: SessionPlusIdentity) {
    return await this.deps.state.resolveStream({
      app: sessionPlusStateAppKey(identity),
      scope: { kind: "account", key: owner },
    });
  }

  private activityScope(handle: string, principal: SessionPlusPrincipal): AppAgentActivityScope | null {
    if (!principal.session || principal.delegation || principalActor(principal).kind !== "user") return null;
    const resolved = this.instances.resolve(handle, principal);
    if (!resolved.ok) return null;
    return { appId: "session-plus", owner: principal.owner };
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

  /**
   * Deliver one content-free wake to the tab whose CURRENT resource
   * generation opened the given catalog scope.
   *
   * `resourceInstanceKey` is the `${instanceId}:resource:${generation}` string
   * this coordinator itself minted in `openResourceHandle` — a provider seam
   * hands it back verbatim, and only an entry whose LIVE generation matches
   * is woken. A key from a retired generation names a scope that has already
   * been closed, and waking the tab about it would invite a proposal the
   * catalog is guaranteed to refuse.
   */
  wakeResource(resourceInstanceKey: string, binding: string, ref: string): boolean {
    for (const [instanceId, slot] of this.resourceHandles) {
      if (`${instanceId}:resource:${slot.generation}` !== resourceInstanceKey) continue;
      return this.instances.wake(instanceId, binding, ref);
    }
    return false;
  }

  closeInstance(handle: string, principal: SessionPlusPrincipal): boolean {
    return this.instances.destroy(handle, principal);
  }

  /**
   * Retire one iframe generation's provider scopes and issue its successor.
   *
   * The expected generation comes from the trusted parent, not the View. Closing
   * synchronously makes old refs/streams unreachable before the replacement
   * handle is published; a late HTTP request carrying the old number is refused.
   */
  resetResourceGeneration(
    handle: string,
    principal: SessionPlusPrincipal,
    expectedGeneration: number,
  ): number | null {
    const resolved = this.instances.resolve(handle, principal);
    if (!resolved.ok) return null;
    const current = this.resourceHandles.get(resolved.binding.id);
    if (!current) return expectedGeneration === 0 ? 0 : null;
    if (!Number.isSafeInteger(expectedGeneration)) return null;
    // The HTTP response may be lost after the server completed a reset. Treat
    // an exact retry as the same transition; older generations still conflict.
    if (current.generation === expectedGeneration + 1) return current.generation;
    if (current.generation !== expectedGeneration) return null;
    const identity = this.activeIdentity;
    const plan = identity && this.resourceBinder?.planFor(identity.packageDigest);
    if (!identity || identity.packageDigest !== resolved.binding.packageDigest || !plan || !this.resourceBinder) {
      return null;
    }
    // A reconstructed iframe is a new read generation. Any roster result still
    // draining for the retired frame may finish, but cannot publish afterwards.
    this.refreshGenerations.delete(resolved.binding.id);
    this.closeResourceHandle(resolved.binding.id);
    const next = expectedGeneration + 1;
    this.openResourceHandle(resolved.binding, identity, plan, next);
    return next;
  }

  releaseCredential(owner: string, credential: string): number {
    let count = this.instances.releaseCredential(owner, credential);
    for (const binding of this.instances.allBindings()) {
      if (binding.delegation?.viewer === owner && binding.credential === `${credential}:share:${binding.delegation.shareId}` && this.instances.destroyBinding(binding.id, "credential_ended")) count++;
      // An administrator's instances opened as another account end with the
      // administrator's login (`<credential>:as:<account>`).
      else if (binding.credential.startsWith(`${credential}:as:`) && this.instances.destroyBinding(binding.id, "credential_ended")) count++;
    }
    return count;
  }

  releaseOwner(owner: string, reason?: string): number {
    let count = this.instances.releaseOwner(owner, reason);
    for (const binding of this.instances.allBindings()) if (binding.delegation?.viewer === owner && this.instances.destroyBinding(binding.id, reason ?? "viewer_ended")) count++;
    return count;
  }

  async health(): Promise<{ ok: boolean; state: boolean; runtime: boolean }> {
    return await this.coordination.health(this.activeIdentity?.backendCodeDigest);
  }

  stop(): void {
    this.instances.stop();
    this.sharingUnsubscribe?.();
    this.sharingUnsubscribe = null;
  }

  private beginRefresh(instanceId: string): number {
    if (this.nextRefreshGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Session Plus refresh generation exhausted");
    }
    const generation = ++this.nextRefreshGeneration;
    this.refreshGenerations.set(instanceId, generation);
    return generation;
  }

  private isCurrentRefresh(instanceId: string, generation: number): boolean {
    return this.refreshGenerations.get(instanceId) === generation;
  }

  private finishRefresh(instanceId: string, generation: number): void {
    if (this.isCurrentRefresh(instanceId, generation)) this.refreshGenerations.delete(instanceId);
  }

  private holdTranscriptSlot(instanceId: string, resource: string): TranscriptSlot {
    let slots = this.resourceSubscriptions.get(instanceId);
    if (!slots) { slots = new Map(); this.resourceSubscriptions.set(instanceId, slots); }
    let slot = slots.get(resource);
    if (!slot) {
      slot = { subscription: null, maxMessages: 0, generation: 0, pending: 0 };
      slots.set(resource, slot);
    }
    slot.pending += 1;
    return slot;
  }

  private startTranscriptSubscription(
    handle: string,
    principal: SessionPlusPrincipal,
    instanceId: string,
    resource: string,
    slot: TranscriptSlot,
    maxMessages: number,
  ): void {
    if (this.resourceSubscriptions.get(instanceId)?.get(resource) !== slot || !this.resources?.watchTranscript) return;
    if (slot.subscription && slot.maxMessages >= maxMessages) return;
    const slots = this.resourceSubscriptions.get(instanceId)!;
    const followed = [...slots.entries()].filter(([, held]) => held.subscription !== null);
    if (!slot.subscription && followed.length >= TRANSCRIPT_SUBSCRIPTION_MAX) {
      const paused = followed[0][0];
      this.closeResourceSubscription(instanceId, paused);
      const live = this.instances.resolve(handle, principal);
      if (live.ok) {
        const projection = asObject(live.binding.projection);
        const status = { resource: paused, state: "paused", message: "实时读取已暂停；刷新此会话可继续跟随。" };
        this.instances.update(handle, { ...projection,
          transcriptStatuses: retainTranscriptStatus(projection.transcriptStatuses, paused, status),
          transcriptStatus: status,
        } as RuntimeJson);
      }
    }
    const generation = ++slot.generation;
    slot.subscription?.close();
    slot.subscription = null;
    const watched = this.resources.watchTranscript(instanceId, resource, (event) => {
      if (event.resource !== resource || slot.generation !== generation
        || this.resourceSubscriptions.get(instanceId)?.get(resource) !== slot) return;
      this.applyTranscriptEvent(handle, principal, instanceId, event);
    }, maxMessages);
    if (watched.ok) {
      // A terminal synchronous listener may already have retired this slot.
      if (this.resourceSubscriptions.get(instanceId)?.get(resource) !== slot) watched.subscription.close();
      else { slot.subscription = watched.subscription; slot.maxMessages = maxMessages; }
    } else {
      this.applyTranscriptEvent(handle, principal, instanceId, {
        type: "error", resource, terminal: true, message: watched.message,
      });
    }
  }

  private applyTranscriptEvent(
    handle: string,
    principal: SessionPlusPrincipal,
    instanceId: string,
    event: SessionResourceWatchEvent,
  ): void {
    const live = this.instances.resolve(handle, principal);
    if (!live.ok || live.binding.id !== instanceId) {
      this.closeResourceSubscription(instanceId);
      return;
    }
    const projection = asObject(live.binding.projection);
    const status = {
      resource: event.resource,
      state: event.type === "error" ? event.terminal ? "closed" : "reconnecting" : "live",
      message: event.type === "error" ? event.message : "",
    };
    const next = {
      ...projection,
      ...(event.type === "data" ? {
        transcript: retainTranscripts(projection.transcript, event.resource,
          runtimeJson(mergeTranscriptTail(asObject(projection.transcript)[event.resource], event.data))),
      } : {}),
      transcriptStatuses: retainTranscriptStatus(projection.transcriptStatuses, event.resource, status),
      transcriptStatus: status,
    };
    this.instances.update(handle, next as RuntimeJson);
    if (event.type === "error" && event.terminal) this.closeResourceSubscription(instanceId, event.resource);
  }

  /**
   * Serve one typed-resource proposal.
   *
   * Everything identity-shaped is the handle's, bound once when the instance was
   * created; what arrives from the View is a verb and a few bounded strings. The
   * provider's refusal code is passed through rather than collapsed, because the
   * remote port on the other side maps by code — and `approval_required` is an
   * instruction, not a failure.
   *
   * A file read NEVER writes the projection: its bytes are this panel's, while
   * the projection is the tab-wide view every surface shares. But the reply
   * still carries one, because the frame host replaces the View's projection
   * with whatever a reply contains — so it has to be re-read AFTER the await.
   * Returning the copy captured before a multi-second read would silently
   * revert a transcript update that arrived over SSE in the meantime, which is
   * the same hazard the durable path documents one screen down.
   */
  private async dispatchResource(
    handle: string,
    principal: SessionPlusPrincipal,
    binding: SessionPlusInstanceBinding,
    action: string,
    rawParams: unknown,
    generation: number | undefined,
  ): Promise<DispatchResult> {
    const resource = this.resourceHandles.get(binding.id);
    if (!resource) {
      return { ok: false, code: "action_rejected", message: "当前 release 没有声明资源绑定" };
    }
    if (!Number.isSafeInteger(generation) || generation !== resource.generation) {
      return { ok: false, code: "resource_refused", message: "这次操作没有执行：视图已重建或已更新。请在当前视图重新操作；仍出现时刷新页面。", resourceCode: "scope_closed" };
    }
    // How long each parameter may be comes from the contract THIS release's plan
    // binds — trusted data, resolved before anything is copied. See
    // `agent-resources/wire-limits.ts` for why a view cannot influence it.
    const bounded = boundedResourceParams(rawParams, resource, action);
    if (!bounded.ok) {
      return { ok: false, code: "resource_refused", message: bounded.message, resourceCode: "invalid_request" };
    }
    const answer = await resource.handle.dispatch({ action, params: bounded.params });
    // The credential, the release or the tab may have ended while the device was
    // being read. This check deliberately precedes BOTH success and provider
    // refusal: a late `approval_required` from an old generation is still an
    // answer from a scope that no longer exists and must become `scope_closed`.
    const live = this.instances.resolve(handle, principal);
    if (!live.ok) return { ok: false, code: live.code, message: instanceMessage(live.code) };
    try { this.sharing?.scope(live.binding.id); }
    catch { return { ok: false, code: "action_rejected", message: "共享已到期或撤销" }; }
    if (this.resourceHandles.get(binding.id) !== resource) {
      return { ok: false, code: "resource_refused", message: "这次操作没有执行：视图已重建或已更新。请在当前视图重新操作；仍出现时刷新页面。", resourceCode: "scope_closed" };
    }
    if (!answer.ok) {
      return { ok: false, code: "resource_refused", message: answer.message, resourceCode: answer.code };
    }
    // Still through the RuntimeJson boundary: the provider is trusted code, but
    // "trusted" is not "may hand the View an object graph nobody bounded".
    return {
      ok: true,
      result: runtimeJson(answer.result ?? null),
      projection: live.binding.projection,
      revision: live.binding.viewRevision,
    };
  }

  private closeResourceHandle(instanceId: string): void {
    const slot = this.resourceHandles.get(instanceId);
    if (!slot) return;
    this.resourceHandles.delete(instanceId);
    // The catalog's teardown is synchronous where it matters: on return nothing
    // new can start, and the promise is only the release of what was open.
    void slot.handle.close().catch(() => undefined);
  }

  private openResourceHandle(
    binding: SessionPlusInstanceBinding,
    identity: SessionPlusIdentity,
    plan: ResourceBindingPlan,
    generation: number,
  ): void {
    if (!this.resourceBinder) throw new Error("Session Plus resource binder is not attached");
    const handle = this.resourceBinder.openInstance({
      owner: binding.owner,
      publisher: identity.publisher,
      app: identity.stableAppId,
      packageDigest: identity.packageDigest,
      permissionContractDigest: identity.permissionContractDigest,
      // Catalog identities are one-shot. A server-authored generation suffix
      // gives each rebuilt iframe a fresh lifetime without trusting a View field.
      instance: `${binding.id}:resource:${generation}`,
      plan,
    });
    this.resourceHandles.set(binding.id, {
      generation,
      handle,
      contracts: new Map(plan.bindings.map((row) => [row.binding, row.contract])),
    });
  }

  private closeResourceSubscription(instanceId: string, resource?: string): void {
    const slots = this.resourceSubscriptions.get(instanceId);
    if (!slots) return;
    const closing = resource === undefined ? [...slots.values()] : [slots.get(resource)].filter((slot): slot is TranscriptSlot => Boolean(slot));
    if (resource === undefined) this.resourceSubscriptions.delete(instanceId);
    else { slots.delete(resource); if (!slots.size) this.resourceSubscriptions.delete(instanceId); }
    for (const slot of closing) {
      slot.generation += 1;
      slot.subscription?.close();
      slot.subscription = null;
    }
  }

  private startOperationSubscription(
    handle: string,
    principal: SessionPlusPrincipal,
    instanceId: string,
  ): void {
    this.closeOperationSubscription(instanceId);
    if (!this.operations) return;
    const close = this.operations.subscribe(principal.owner, (operation) => {
      const live = this.instances.resolve(handle, principal);
      if (!live.ok || live.binding.id !== instanceId) {
        this.closeOperationSubscription(instanceId);
        return;
      }
      this.instances.recordOperation(instanceId, runtimeJson(operation));
    });
    this.operationSubscriptions.set(instanceId, close);
  }

  private closeOperationSubscription(instanceId: string): void {
    const close = this.operationSubscriptions.get(instanceId);
    if (!close) return;
    this.operationSubscriptions.delete(instanceId);
    close();
  }

  private startSessionChangeSubscription(
    handle: string,
    principal: SessionPlusPrincipal,
    instanceId: string,
  ): void {
    this.closeSessionChangeSubscription(instanceId);
    if (!this.sessionChanges) return;
    const close = this.sessionChanges.subscribe(principal.owner, () => {
      const live = this.instances.resolve(handle, principal);
      if (!live.ok || live.binding.id !== instanceId) {
        this.closeSessionChangeSubscription(instanceId);
        return;
      }
      this.instances.wake(instanceId, AGENT_SESSIONS_WAKE_REF, AGENT_SESSIONS_WAKE_REF);
    });
    this.sessionChangeSubscriptions.set(instanceId, close);
  }

  private closeSessionChangeSubscription(instanceId: string): void {
    const close = this.sessionChangeSubscriptions.get(instanceId);
    if (!close) return;
    this.sessionChangeSubscriptions.delete(instanceId);
    close();
  }
}

function asObject(value: RuntimeJson): Record<string, RuntimeJson> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, RuntimeJson>
    : {};
}

/**
 * Copy a resource proposal's parameters into bounded strings.
 *
 * This layer deliberately does not know what any of them MEAN — `ref`, `handle`
 * and `seq` belong to the contract's own vocabulary, and a table of them here
 * would be a second declaration of the wire that has to be kept in step. What it
 * does is bound everything before it reaches a provider: bounded key grammar,
 * bounded count, bounded length, strings only.
 *
 * ── Refused, not clipped ───────────────────────────────────────────────────
 *
 * An over-long value used to be `slice`d and passed on. With every parameter
 * bounded at 512 characters that was harmless — a clipped ref resolves to
 * nothing — but one of them is now a whole file body under a compare-and-swap,
 * and a silently shortened body is a write of something nobody asked for. A
 * value over its bound is therefore the whole proposal's refusal, and it never
 * reaches a provider, a Gate or a device.
 *
 * ── Which bound ────────────────────────────────────────────────────────────
 *
 * The default, unless the contract that this release's plan binds to this
 * binding name declares this action's parameter larger. Every unknown — an
 * invented binding name, an unknown action, a contract with no declaration —
 * lands on the default, which is the narrow answer.
 */
function boundedResourceParams(
  raw: unknown,
  slot: ResourceHandleSlot,
  action: string,
): { ok: true; params: Record<string, string> } | { ok: false; message: string } {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: true, params: out };
  // The binding name is itself an ordinary parameter, so it is read under the
  // default bound before it is used to look anything up.
  const asked = (raw as Record<string, unknown>)[RESERVED_PARAMS.binding];
  const contract = typeof asked === "string" && asked.length <= RESOURCE_PARAM_DEFAULT_MAX
    ? slot.contracts.get(asked)
    : undefined;
  const limits = resourceParamLimits(contract, action);

  let taken = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (taken >= RESOURCE_PARAM_COUNT) break;
    if (!RESOURCE_PARAM_KEY.test(key) || typeof value !== "string") continue;
    const limit = limits?.get(key) ?? RESOURCE_PARAM_DEFAULT_MAX;
    if (value.length > limit) {
      return { ok: false, message: `参数 ${key} 超过了这个动作声明的 ${limit} 字符上限` };
    }
    out[key] = value;
    taken += 1;
  }
  return { ok: true, params: out };
}

function boundedTranscriptWindow(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(500, Math.max(1, parsed)) : 200;
}

function isOperationAction(action: string): action is SessionPlusOperationAction {
  return (SESSION_PLUS_OPERATION_ACTIONS as readonly string[]).includes(action);
}
