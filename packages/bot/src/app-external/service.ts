/**
 * `external-app-host/v1` — the trusted service behind the external transport.
 *
 * ── The one property this file exists to hold ───────────────────────────────
 *
 * **Nothing an external caller says about itself is read.** A request carries a
 * capability secret and, at most, a handle and an action with flat parameters.
 * Who is acting, which App, which shared instance, which release and which
 * authority are all read from the stored binding the secret resolves to — and
 * re-read, from their live sources, on EVERY call:
 *
 * ```text
 *   secret → binding row      live? not revoked, not expired
 *   binding.host_origin       equals the request Origin, exactly
 *   binding.authority         permits this operation
 *   App trust (binding.user)  still trusted for the ACTIVE release
 *   active release digest     equals binding.release_digest
 *   instance row              still open
 *   membership row            this user still holds a seat
 * ```
 *
 * The order is deliberate: cheapest and least disclosing first, so a stale
 * credential learns nothing about which instances exist. Every failure is a
 * bounded refusal from the closed vocabulary in `contract.ts`, and the four
 * revocation-shaped ones (`trust_required`, `release_changed`, `instance_closed`,
 * `not_member`) also TEAR DOWN whatever this binding still holds — the handle,
 * the projection stream, the App instance — because a refusal that leaves a live
 * stream fanning out state is not a refusal.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * No App state, no move legality, no seat arithmetic, no second projection and
 * no second event log. Every operation lands on `AppInstanceService`, which is
 * the same coordinator the trusted browser page drives, with the same doors.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import { externalAppPrincipal } from "../app-registry/app-instance.js";
import type { AppInstanceService, AppDispatchResult } from "../app-registry/app-instance.js";
import { createLogger } from "../logger.js";
import type { AppReleaseIdentity, AppTrustStatus } from "../permissions/app-trust.js";
import type { InstanceEvent, InstanceSubscription, SessionPlusPrincipal } from "../app-core/instance.js";
import type { SessionPlusActionSpec } from "../app-core/manifest.js";
import type {
  ExternalAppCapabilityRow,
  ExternalAppLaunchGrantConsumption,
  ExternalAppLaunchGrantRow,
} from "../store/store.js";
import {
  EXTERNAL_APP_FRAME_PROTOCOL,
  EXTERNAL_APP_HOST_PROTOCOL,
  EXTERNAL_APP_OPERATION_AUTHORITY,
  EXTERNAL_APP_VIEW_SANDBOX,
  EXTERNAL_CAPABILITY_PREFIX,
  EXTERNAL_CREDENTIAL_ID_PREFIX,
  EXTERNAL_GRANT_ID_PREFIX,
  EXTERNAL_LAUNCH_FRAGMENT_KEY,
  EXTERNAL_LAUNCH_TOKEN_PREFIX,
  externalAppActionContract,
  isExternalCapabilitySecret,
  isExternalLaunchToken,
  type ExternalAppActionContract,
  type ExternalAppAuthority,
  type ExternalAppBindingView,
  type ExternalAppDescription,
  type ExternalAppOperation,
  type ExternalAppRefusal,
  type ExternalAppViewDescription,
} from "./contract.js";
import { externalLaunchUrl, type ExternalAppHostingSettings, type ExternalAppHostSettings } from "./settings.js";

const log = createLogger("app-external");

/** The store rows this service owns. Narrowed so tests can supply a fake. */
export interface ExternalAppStore {
  reserveExternalAppLaunchGrant(row: ExternalAppLaunchGrantRow, max: number, nowIso: string): boolean;
  consumeExternalAppLaunchGrant(
    tokenHash: string,
    credentialId: string,
    nowIso: string,
    max: number,
  ): ExternalAppLaunchGrantConsumption;
  deleteExpiredExternalAppLaunchGrants(beforeIso: string): number;
  createExternalAppCapability(row: ExternalAppCapabilityRow): void;
  getActiveExternalAppCapability(secretHash: string, nowIso: string): ExternalAppCapabilityRow | undefined;
  getExternalAppCapability(credentialId: string): ExternalAppCapabilityRow | undefined;
  listExternalAppCapabilities(username: string, appId: string): ExternalAppCapabilityRow[];
  revokeExternalAppCapability(
    username: string,
    credentialId: string,
    revokedAt: string,
    reason: string,
  ): ExternalAppCapabilityRow | undefined;
  touchExternalAppCapability(credentialId: string, usedAt: string): void;
  getSharedAppInstance(appId: string, instanceKey: string): { status: string } | undefined;
  getSharedAppMember(appId: string, instanceKey: string, username: string): { role: string } | undefined;
}

/** The App this service may bind, exactly as the panel already projects one. */
export interface ExternalAppTarget {
  stableAppId: string;
  publisher: string;
  title: string;
  packageDigest: string | null;
  /** The digest-addressed origin this release's immutable View is served from. */
  viewOrigin: string | null;
  viewUrl?: string;
  service: Pick<
    AppInstanceService,
    "openExternal" | "dispatch" | "subscribe" | "closeInstance" | "releaseCredential" | "actionSurface" | "sharedRoles"
  > | null;
  unavailable: string | null;
}

export interface ExternalAppHostDeps {
  settings: ExternalAppHostingSettings;
  store: ExternalAppStore;
  /** The declared-App directory, narrowed to what a binding needs. */
  app(stableAppId: string): ExternalAppTarget | null;
  /** The publisher-trust door, asked per (owner, release) exactly as pages do. */
  trust(owner: string, release: AppReleaseIdentity): AppTrustStatus;
  /** The permission activity record. External human and agent are distinguishable. */
  audit(entry: {
    owner: string;
    subjectType: string;
    subjectId: string;
    operation: string;
    decision: string;
    reason?: string;
    detail?: string;
  }): void;
  now?: () => number;
}

export type ExternalAppOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: ExternalAppRefusal; message: string };

export interface ExternalAppSession {
  binding: ExternalAppCapabilityRow;
  host: ExternalAppHostSettings;
  target: ExternalAppTarget;
  release: AppReleaseIdentity;
  /** The seat this account currently holds in the bound instance. */
  role: string;
  /** The one identity every call on this binding presents. */
  principalOf(): SessionPlusPrincipal;
}

/**
 * The agent name an external agent binding acts under.
 *
 * One name, not the host's: authorship must say WHAT proposed (an external
 * agent binding of this App) rather than repeat a label the host chose for
 * itself. Which binding it was is in the audit row beside it.
 */
const EXTERNAL_AGENT_NAME = "external";

const REFUSAL_STATUS: Readonly<Record<ExternalAppRefusal, number>> = Object.freeze({
  invalid_credential: 401,
  origin_refused: 403,
  operation_refused: 403,
  not_member: 403,
  trust_required: 403,
  release_changed: 409,
  instance_closed: 409,
  invalid_instance: 404,
  invalid_params: 400,
  unknown_action: 400,
  action_rejected: 400,
  state_conflict: 409,
  not_supported: 400,
  unavailable: 503,
});

function refuse<T>(code: ExternalAppRefusal, message: string): ExternalAppOutcome<T> {
  return { ok: false, status: REFUSAL_STATUS[code], code, message };
}

/** The sha256 of a presented secret. The plaintext never leaves this function. */
export function externalSecretDigest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function mintSecret(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

export class ExternalAppHostService {
  private readonly now: () => number;

  constructor(private readonly deps: ExternalAppHostDeps) {
    this.now = deps.now ?? Date.now;
  }

  get settings(): ExternalAppHostingSettings {
    return this.deps.settings;
  }

  /** The hosts a person may pick, for the trusted page. Secret-free. */
  hosts(): Array<{ id: string; label: string; origin: string }> {
    return [...this.deps.settings.hosts.values()].map((host) => ({
      id: host.id,
      label: host.label,
      origin: host.origin,
    }));
  }

  // ── The trusted side: minting and revoking, by a person, in their session ──

  /**
   * Mint one launch grant. Called ONLY from a route behind the browser identity
   * gate, for the caller's own account — this method never sees a request.
   *
   * The four bindings are resolved here, from live state, and frozen into the
   * grant: an active release digest (so consenting to "this game, this version"
   * means what it says), the seat the person actually holds, the host id they
   * picked from the operator's allowlist, and the authority they chose. Choosing
   * `agent` IS the explicit grant of agent authority; there is no other way to
   * obtain one and no request field that asks for it.
   */
  mintLaunch(input: {
    owner: string;
    appId: string;
    instanceKey: string;
    hostId: string;
    authority: ExternalAppAuthority;
  }): ExternalAppOutcome<{
    grant_id: string;
    launch_url: string;
    host: string;
    host_origin: string;
    authority: ExternalAppAuthority;
    app: string;
    instance: string;
    expires_at: string;
    /** The one-shot secret. Returned once; only its digest is stored. */
    launch_token: string;
  }> {
    const host = this.deps.settings.hosts.get(input.hostId);
    if (!host) return refuse("origin_refused", "这个外部宿主不在本部署的允许列表里");
    const target = this.deps.app(input.appId);
    if (!target) return refuse("invalid_instance", "本进程没有服务这个 App");
    const release = releaseIdentity(target);
    if (!release || !target.service) {
      return refuse("unavailable", target.unavailable ?? "这个 App 当前没有可服务的 release");
    }
    if (!this.deps.trust(input.owner, release).trusted) {
      return refuse("trust_required", "请先在可信外层确认发布者与当前 release");
    }
    const seat = this.seat(input.appId, input.instanceKey, input.owner);
    if (!seat.ok) return seat;
    const nowMs = this.now();
    const token = mintSecret(EXTERNAL_LAUNCH_TOKEN_PREFIX);
    const grantId = EXTERNAL_GRANT_ID_PREFIX + randomUUID().replace(/-/g, "");
    const expiresAt = new Date(nowMs + this.deps.settings.launchTtlSeconds * 1000).toISOString();
    // Housekeeping before the write, so a long-lived process does not keep
    // every dead handoff it ever minted.
    this.deps.store.deleteExpiredExternalAppLaunchGrants(new Date(nowMs - 86_400_000).toISOString());
    // The ceiling is enforced by the WRITE, not by a read before it: an
    // unredeemed grant occupies a slot, and the count and the insert are one
    // transaction, so N concurrent mints cannot all pass a count of N-1.
    const reserved = this.deps.store.reserveExternalAppLaunchGrant({
      grant_id: grantId,
      token_hash: externalSecretDigest(token),
      app_id: target.stableAppId,
      instance_key: input.instanceKey,
      username: input.owner,
      host_id: host.id,
      host_origin: host.origin,
      release_digest: release.packageDigest,
      authority: input.authority,
      created_at: new Date(nowMs).toISOString(),
      expires_at: expiresAt,
      consumed_at: null,
      consumed_credential: null,
    }, this.deps.settings.maxBindingsPerUser, new Date(nowMs).toISOString());
    if (!reserved) {
      return refuse(
        "operation_refused",
        `你在这个 App 上的外部绑定（含尚未兑换的启动链接）已达上限（${this.deps.settings.maxBindingsPerUser} 个），请先撤销一个`,
      );
    }
    this.deps.audit({
      owner: input.owner,
      subjectType: "app",
      subjectId: target.stableAppId,
      operation: `(external_launch.${input.authority})`,
      decision: "grant",
      reason: `host ${host.id}`,
      detail: JSON.stringify({ instance: input.instanceKey, release: release.packageDigest, grant: grantId }),
    });
    return {
      ok: true,
      value: {
        grant_id: grantId,
        launch_url: externalLaunchUrl(host, EXTERNAL_LAUNCH_FRAGMENT_KEY, token),
        host: host.id,
        host_origin: host.origin,
        authority: input.authority,
        app: target.stableAppId,
        instance: input.instanceKey,
        expires_at: expiresAt,
        launch_token: token,
      },
    };
  }

  /** This account's bindings for one App, as the trusted page lists them. */
  bindings(owner: string, appId: string): Array<ExternalAppBindingView & { status: string; last_used_at: string | null }> {
    const nowIso = new Date(this.now()).toISOString();
    return this.deps.store.listExternalAppCapabilities(owner, appId).map((row) => ({
      ...bindingView(row),
      status: row.revoked_at ? "revoked" : row.expires_at <= nowIso ? "expired" : "active",
      last_used_at: row.last_used_at,
    }));
  }

  /**
   * Revoke one binding. Row first, teardown second, and the teardown is
   * idempotent — a request that persisted the revocation and died still reaps
   * this binding's instances on the next click.
   */
  revoke(owner: string, credentialId: string, reason: string): ExternalAppOutcome<{ credential_id: string }> {
    const row = this.deps.store.revokeExternalAppCapability(
      owner,
      credentialId,
      new Date(this.now()).toISOString(),
      reason,
    );
    if (!row) return refuse("invalid_credential", "没有这个可撤销的外部绑定");
    this.tearDown(row, reason);
    this.deps.audit({
      owner,
      subjectType: "app",
      subjectId: row.app_id,
      operation: `(external_revoke.${row.authority})`,
      decision: "revoke",
      reason,
      detail: JSON.stringify({ credential: row.credential_id, host: row.host_id, instance: row.instance_key }),
    });
    return { ok: true, value: { credential_id: row.credential_id } };
  }

  // ── The external side: one exchange, then bounded operations ──

  /**
   * Redeem a launch fragment for the standing credential, ONCE.
   *
   * The origin is checked against the grant's own bound host before the grant is
   * consumed for any other reason, and the store consumes it inside one
   * transaction — so a replay, a race and a wrong-origin attempt are all the
   * same dead end. Every binding fact is COPIED from the grant; nothing in the
   * request contributes one.
   */
  exchange(input: { token: unknown; origin: string | undefined }): ExternalAppOutcome<{
    binding: ExternalAppBindingView;
    /** The standing secret. Returned once, stored only as a digest. */
    credential: string;
    app_title: string;
    role: string;
    view: ExternalAppViewDescription | null;
    actions: readonly ExternalAppActionContract[];
  }> {
    if (!isExternalLaunchToken(input.token)) return refuse("invalid_credential", "启动凭据无效或已失效");
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const credentialId = EXTERNAL_CREDENTIAL_ID_PREFIX + randomUUID().replace(/-/g, "");
    const consumed = this.deps.store.consumeExternalAppLaunchGrant(
      externalSecretDigest(input.token),
      credentialId,
      nowIso,
      this.deps.settings.maxBindingsPerUser,
    );
    if (!consumed.ok) {
      // The grant is left UNCONSUMED when the ceiling refuses it: nothing about
      // this attempt was wrong, and burning the link would punish a person for
      // the order in which their own tabs happened to redeem.
      return consumed.reason === "limit"
        ? refuse(
            "operation_refused",
            `这个账号在该 App 上的外部绑定已达上限（${this.deps.settings.maxBindingsPerUser} 个），请先在 Octopus 页面撤销一个`,
          )
        : refuse("invalid_credential", "启动凭据无效、已过期或已被使用");
    }
    const grant = consumed.row;
    if (!input.origin || input.origin !== grant.host_origin) {
      // Consumed anyway, and deliberately: a token that was presented from the
      // wrong place is a token that has been somewhere it should not have been.
      return refuse("origin_refused", "这个启动凭据只能从它被指定的宿主 origin 兑换");
    }
    const target = this.deps.app(grant.app_id);
    const release = target ? releaseIdentity(target) : null;
    if (!target || !release || !target.service) {
      return refuse("unavailable", target?.unavailable ?? "这个 App 当前没有可服务的 release");
    }
    if (release.packageDigest !== grant.release_digest) {
      return refuse("release_changed", "这个 App 已经切换到新的 release，请在 Octopus 页面重新发起绑定");
    }
    if (!this.deps.trust(grant.username, release).trusted) {
      return refuse("trust_required", "账号对这个 App 的发布者信任已撤销");
    }
    const seat = this.seat(grant.app_id, grant.instance_key, grant.username);
    if (!seat.ok) return seat;
    const authority: ExternalAppAuthority = grant.authority === "agent" ? "agent" : "human";
    const secret = mintSecret(EXTERNAL_CAPABILITY_PREFIX);
    const row: ExternalAppCapabilityRow = {
      credential_id: credentialId,
      secret_hash: externalSecretDigest(secret),
      app_id: grant.app_id,
      instance_key: grant.instance_key,
      username: grant.username,
      host_id: grant.host_id,
      host_origin: grant.host_origin,
      release_digest: grant.release_digest,
      authority,
      grant_id: grant.grant_id,
      created_at: nowIso,
      expires_at: new Date(nowMs + this.deps.settings.capabilityTtlSeconds * 1000).toISOString(),
      last_used_at: null,
      revoked_at: null,
      revoked_reason: null,
    };
    this.deps.store.createExternalAppCapability(row);
    this.deps.audit({
      owner: grant.username,
      subjectType: "app",
      subjectId: grant.app_id,
      operation: `(external_bind.${authority})`,
      decision: "grant",
      reason: `host ${grant.host_id}`,
      detail: JSON.stringify({ credential: credentialId, instance: grant.instance_key, grant: grant.grant_id }),
    });
    return {
      ok: true,
      value: {
        binding: bindingView(row),
        credential: secret,
        app_title: target.title,
        role: seat.value.role,
        view: this.view(target),
        actions: this.actions(target, authority),
      },
    };
  }

  /**
   * Resolve a presented secret into a fully re-checked session, or refuse.
   *
   * Every external operation starts here. There is no cached session object and
   * no "already authorised" path: the seven checks in this file's docstring run
   * again, in order, for every single call.
   */
  session(input: {
    secret: unknown;
    origin: string | undefined;
    operation: ExternalAppOperation;
  }): ExternalAppOutcome<ExternalAppSession> {
    if (!isExternalCapabilitySecret(input.secret)) {
      return refuse("invalid_credential", "缺少或无效的外部凭据");
    }
    const nowIso = new Date(this.now()).toISOString();
    const binding = this.deps.store.getActiveExternalAppCapability(externalSecretDigest(input.secret), nowIso);
    if (!binding) return refuse("invalid_credential", "外部凭据无效、已过期或已被撤销");
    // The Origin the request actually carried, against the origin this binding
    // was minted for. Whether that origin is still ON the allowlist is asked by
    // `bind` below, so removing a host from config ends its bindings on the
    // next call rather than on the next restart.
    if (!input.origin || input.origin !== binding.host_origin) {
      return refuse("origin_refused", "请求的 Origin 与绑定的宿主不一致");
    }
    const allowed = EXTERNAL_APP_OPERATION_AUTHORITY[input.operation];
    if (!allowed.includes(binding.authority as ExternalAppAuthority)) {
      return refuse(
        "operation_refused",
        binding.authority === "human"
          ? "这是一个人类操作绑定：Agent 提议需要单独授予的 agent 绑定"
          : "这是一个 agent 绑定：它不能代替人做棋盘动作",
      );
    }
    const bound = this.bind(binding);
    if (!bound.ok) return bound;
    this.deps.store.touchExternalAppCapability(binding.credential_id, nowIso);
    return bound;
  }

  /**
   * Re-run every live check for a binding named by its PUBLIC id.
   *
   * This is what a held-open SSE stream calls on a timer, and what a completed
   * proposal calls before it reports success. It takes no secret and no Origin
   * because it is not authenticating anybody — the credential already proved
   * itself when the connection was made, and what is being asked now is whether
   * that proof is still TRUE. Expiry, revocation, an emptied allowlist, a lost
   * seat, a closed instance, a withdrawn publisher trust and a moved release
   * all answer no here, and all of them tear the binding's instances down.
   */
  revalidate(credentialId: string): ExternalAppOutcome<ExternalAppSession> {
    const nowIso = new Date(this.now()).toISOString();
    const binding = this.deps.store.getExternalAppCapability(credentialId);
    if (!binding) return refuse("invalid_credential", "外部凭据已不存在");
    if (binding.revoked_at) {
      this.tearDown(binding, "external_binding_revoked");
      return refuse("invalid_credential", "外部凭据已被撤销");
    }
    if (binding.expires_at <= nowIso) {
      // Expiry has no event to listen for, which is exactly why a long-lived
      // stream must ask: a connection opened one second before the deadline
      // would otherwise keep pushing projections forever.
      this.tearDown(binding, "external_binding_expired");
      return refuse("invalid_credential", "外部凭据已过期");
    }
    const host = this.deps.settings.hosts.get(binding.host_id);
    if (!host || host.origin !== binding.host_origin) {
      this.tearDown(binding, "external_host_removed");
      return refuse("origin_refused", "这个绑定的宿主已不在允许列表里");
    }
    return this.bind(binding);
  }

  /**
   * The live half of the checks, shared by `session` and `revalidate`.
   *
   * Order matters and is the same in both: App trust, the exact release digest
   * this binding was minted against, then the seat. Each failure tears down
   * first and refuses second, so a caller can never observe a live stream on a
   * binding that has just been told no.
   */
  private bind(binding: ExternalAppCapabilityRow): ExternalAppOutcome<ExternalAppSession> {
    const host = this.deps.settings.hosts.get(binding.host_id);
    if (!host || host.origin !== binding.host_origin) {
      this.tearDown(binding, "external_host_removed");
      return refuse("origin_refused", "这个绑定的宿主已不在允许列表里");
    }
    const target = this.deps.app(binding.app_id);
    const release = target ? releaseIdentity(target) : null;
    if (!target || !release || !target.service) {
      return refuse("unavailable", target?.unavailable ?? "这个 App 当前没有可服务的 release");
    }
    if (!this.deps.trust(binding.username, release).trusted) {
      this.tearDown(binding, "publisher_trust_revoked");
      return refuse("trust_required", "账号对这个 App 的发布者信任已撤销");
    }
    if (release.packageDigest !== binding.release_digest) {
      this.tearDown(binding, "instance_stale");
      return refuse("release_changed", "这个 App 已经切换到新的 release，请在 Octopus 页面重新发起绑定");
    }
    const seat = this.seat(binding.app_id, binding.instance_key, binding.username);
    if (!seat.ok) {
      this.tearDown(binding, seat.code === "not_member" ? "shared_membership_revoked" : "shared_instance_closed");
      return seat;
    }
    return {
      ok: true,
      value: {
        binding,
        host,
        target,
        release,
        role: seat.value.role,
        // The principal every later call must present, rebuilt from the row —
        // never carried across requests, so a change to the row changes it.
        // Built by the coordinator's own factory so this transport cannot
        // invent a presence class: the branded external evidence is what admits
        // a `user` actor with no browser session, and it makes this handle
        // unresolvable by a browser principal exactly as it makes a browser
        // tab's handle unresolvable by this one.
        principalOf: () => externalAppPrincipal({
          owner: binding.username,
          credential: binding.credential_id,
          host: binding.host_id,
          app: binding.app_id,
          actor: binding.authority === "agent" ? "agent" : "user",
          agent: EXTERNAL_AGENT_NAME,
        }),
      },
    };
  }

  /** What this binding may propose, and where its View may be framed from. */
  describe(session: ExternalAppSession): ExternalAppDescription {
    return {
      protocol: EXTERNAL_APP_HOST_PROTOCOL,
      binding: bindingView(session.binding),
      app_title: session.target.title,
      role: session.role,
      view: this.view(session.target),
      actions: this.actions(session.target, session.binding.authority as ExternalAppAuthority),
    };
  }

  /**
   * Where this release's own View lives, so an external shell can REUSE it
   * instead of reimplementing the App's UI.
   *
   * A read-only display address and nothing more: the origin is digest-
   * addressed, it is already public in the sense that knowing it grants
   * nothing, and the document it serves is inert until a parent hands it a
   * MessagePort. The credential stays in the host's backend and must never be
   * put inside the frame — the frame's whole security property is that it holds
   * no identity, no credential and no network reach (`connect-src 'none'`).
   */
  private view(target: ExternalAppTarget): ExternalAppViewDescription | null {
    if (!target.viewOrigin || !target.packageDigest) return null;
    return {
      origin: target.viewOrigin,
      ...(target.viewUrl ? { url: target.viewUrl } : {}),
      package_digest: target.packageDigest,
      // What the parent shell must speak. Named, not described: the protocol is
      // the existing trusted-shell one (`dashboard-web/src/session-plus/
      // frame-host.ts`), and a second prose copy of it here would be a second
      // source of truth for a handshake that already has one.
      frame_protocol: EXTERNAL_APP_FRAME_PROTOCOL,
      sandbox: EXTERNAL_APP_VIEW_SANDBOX,
    };
  }

  /** One instance for this binding. The handle is this host's, not a person's. */
  async open(session: ExternalAppSession): Promise<ExternalAppOutcome<{
    handle: string;
    revision: number;
    projection: RuntimeJson;
    expires_at: string;
  }>> {
    const service = session.target.service;
    if (!service) return refuse("unavailable", "这个 App 当前没有可服务的 release");
    try {
      const opened = await service.openExternal({
        owner: session.binding.username,
        credential: session.binding.credential_id,
        host: session.binding.host_id,
        actor: session.binding.authority === "agent" ? "agent" : "user",
        agent: EXTERNAL_AGENT_NAME,
        instanceKey: session.binding.instance_key,
      });
      return {
        ok: true,
        value: {
          handle: opened.handle,
          revision: opened.revision,
          projection: opened.projection,
          expires_at: new Date(opened.expiresAt).toISOString(),
        },
      };
    } catch (error) {
      log.warn(
        { err: error, app: session.binding.app_id, owner: session.binding.username },
        "could not open an external App instance",
      );
      return refuse("unavailable", "应用后端暂时不可用");
    }
  }

  /** One proposal, on the operation this binding's authority permits. */
  async propose(
    session: ExternalAppSession,
    handle: string,
    proposal: { action?: unknown; params?: unknown },
  ): Promise<ExternalAppOutcome<{ revision: number; projection: RuntimeJson; result: RuntimeJson | null }>> {
    const service = session.target.service;
    if (!service) return refuse("unavailable", "这个 App 当前没有可服务的 release");
    let answer: AppDispatchResult;
    try {
      answer = await service.dispatch(handle, session.principalOf(), {
        action: proposal.action,
        params: proposal.params,
      });
    } catch (error) {
      log.warn({ err: error, app: session.binding.app_id }, "external App dispatch failed");
      return refuse("unavailable", "应用后端暂时不可用");
    }
    // The window this closes: the binding was live when the request arrived, and
    // a person may have revoked it, lost their seat or activated a new release
    // while the dispatch was awaiting State and the sandbox. The COMMIT is not
    // undone — an append-only log does not get to lie about what happened, and
    // the App's own membership door already refused anything that landed after
    // the seat went away — but the host is told the binding is gone rather than
    // being handed a success it may keep building on, and everything the
    // binding still holds is torn down here.
    const still = this.revalidate(session.binding.credential_id);
    const authority = session.binding.authority;
    this.deps.audit({
      owner: session.binding.username,
      subjectType: "app",
      subjectId: session.binding.app_id,
      operation: authority === "agent" ? "(external_agent_propose)" : "(external_human_propose)",
      decision: answer.ok && still.ok ? "allow" : "deny",
      reason: !still.ok ? `binding_ended:${still.code}` : answer.ok ? `host ${session.binding.host_id}` : answer.code,
      detail: JSON.stringify({
        credential: session.binding.credential_id,
        instance: session.binding.instance_key,
        action: typeof proposal.action === "string" ? proposal.action.slice(0, 64) : null,
        role: session.role,
      }),
    });
    if (!still.ok) return still;
    if (answer.ok) {
      return { ok: true, value: { revision: answer.revision, projection: answer.projection, result: answer.result } };
    }
    return refuse(dispatchRefusal(answer.code), answer.message);
  }

  /** Subscribe one external stream; identical fan-out to the browser page's. */
  subscribe(
    session: ExternalAppSession,
    handle: string,
    listener: (event: InstanceEvent) => void,
  ): InstanceSubscription | null {
    return session.target.service?.subscribe(handle, session.principalOf(), listener) ?? null;
  }

  close(session: ExternalAppSession, handle: string): boolean {
    return session.target.service?.closeInstance(handle, session.principalOf()) ?? false;
  }

  /** The host giving up its own binding — the same teardown a person's revoke does. */
  selfRevoke(session: ExternalAppSession): ExternalAppOutcome<{ credential_id: string }> {
    return this.revoke(session.binding.username, session.binding.credential_id, "external_host");
  }

  // ── internals ──

  private actions(target: ExternalAppTarget, authority: ExternalAppAuthority): readonly ExternalAppActionContract[] {
    // The SAME manifest table the dispatch door normalises against, filtered
    // for the actor kind this authority dispatches as. `human_only` actions are
    // absent from an agent binding's contract AND refused at the door; both
    // halves, or neither works.
    const surface = target.service?.actionSurface(authority === "agent" ? "agent" : "user");
    if (!surface) return [];
    return surface.actions.map((row: { name: string; spec: SessionPlusActionSpec }) =>
      externalAppActionContract(row.name, row.spec),
    );
  }

  /** The membership door's read face, with the two refusals kept apart. */
  private seat(appId: string, instanceKey: string, username: string): ExternalAppOutcome<{ role: string }> {
    const instance = this.deps.store.getSharedAppInstance(appId, instanceKey);
    if (!instance || instance.status !== "open") {
      return refuse("instance_closed", "共享实例不存在或已关闭");
    }
    const member = this.deps.store.getSharedAppMember(appId, instanceKey, username);
    if (!member) return refuse("not_member", "这个账号不再是该共享实例的成员");
    return { ok: true, value: { role: member.role } };
  }

  /**
   * Close everything one binding still holds.
   *
   * `releaseCredential` is exact: an external binding's instances are the ones
   * opened under its credential ID, so this reaps its handles and ends its SSE
   * streams without touching the same person's browser tabs or another host's
   * binding on the same instance.
   */
  private tearDown(binding: ExternalAppCapabilityRow, reason: string): void {
    const target = this.deps.app(binding.app_id);
    const closed = target?.service?.releaseCredential(binding.username, binding.credential_id) ?? 0;
    if (closed > 0) {
      log.info(
        { app: binding.app_id, credential: binding.credential_id, reason, closed },
        "closed external App instances",
      );
    }
  }
}

function bindingView(row: ExternalAppCapabilityRow): ExternalAppBindingView {
  return {
    protocol: EXTERNAL_APP_HOST_PROTOCOL,
    credential_id: row.credential_id,
    app: row.app_id,
    instance: row.instance_key,
    user: row.username,
    authority: row.authority === "agent" ? "agent" : "human",
    host: row.host_id,
    host_origin: row.host_origin,
    release_digest: row.release_digest,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/** The publisher-trust door's key, for one declared App's active release. */
function releaseIdentity(target: ExternalAppTarget): AppReleaseIdentity | null {
  if (!target.packageDigest) return null;
  return {
    appId: target.stableAppId,
    publisher: target.publisher,
    profile: "publisher-js",
    packageDigest: target.packageDigest,
  };
}

/** The coordinator's codes, mapped into this transport's closed vocabulary. */
function dispatchRefusal(code: Exclude<AppDispatchResult, { ok: true }>["code"]): ExternalAppRefusal {
  switch (code) {
    case "unknown_action":
      return "unknown_action";
    case "action_rejected":
      return "action_rejected";
    case "invalid_instance":
    case "instance_expired":
      return "invalid_instance";
    case "instance_stale":
      return "release_changed";
    case "state_conflict":
      return "state_conflict";
    case "not_supported":
      return "not_supported";
    default:
      return "unavailable";
  }
}
