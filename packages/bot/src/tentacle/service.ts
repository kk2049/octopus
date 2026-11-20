import type { PermissionService } from "../permissions/service.js";
import { effectiveOperations } from "../permissions/effective.js";
import type { AuthorizationService } from "../authorization/service.js";
import { resourceUri } from "../authorization/namespace.js";
import type { Store, TentacleObjectRow } from "../store/store.js";
import type { TentaclePeer } from "../runner/gateway.js";
import { TentacleBroker } from "./broker.js";
import {
  TentacleCapabilities,
  isBrokerToolResult,
  normalizeToolSchema,
} from "./capability.js";
import {
  tentacleAuthorizationDomainId,
  tentacleAuthorizationResourceId,
  tentacleShareResourceId,
} from "./catalog.js";
import {
  TENTACLE_INVOKE_OPERATION,
  TENTACLE_READ_EVENT_OPERATION,
  TENTACLE_SUBJECT_ID,
} from "./contract.js";
import {
  TENTACLE_HEAD_USER,
  isPlainRecord,
  jsonValue,
  schemaDigest,
  type JsonObject,
  type TentacleWireMessage,
} from "./protocol.js";
import { SESSION_CHANNEL_TENTACLE_TOOLS } from "@claude-bot/session-channel-contract";

interface CatalogRecord {
  owner: string;
  device: string;
  schemas: unknown[];
  revision: number;
  reportedAt: string;
}

interface ActiveProjection {
  owner: string;
  viewer: string;
  viewerDevice: string;
  objectId: string;
  resourceId: string;
}

interface ActiveScope {
  owner: string;
  viewer: string;
  objectId: string;
  count: number;
}

interface ProjectionTarget {
  viewer: string;
  resourceId: string;
}

const PRIVATE_SESSION_CHANNEL_REASON = "owner-bound session-channel adapter 只能由可信 Octopus 内部路径调用，不可跨用户分享";

/** Every session-channel version's adapter tool (v1, v2) is owner-bound. */
function isSessionChannelToolName(name: string): boolean {
  return SESSION_CHANNEL_TENTACLE_TOOLS.includes(name);
}

function isPrivateSessionChannelTool(row: TentacleObjectRow): boolean {
  return row.kind === "tool" && isSessionChannelToolName(row.resource_key);
}

/**
 * The repository deliberately caps one query at 2,000 rows. Tentacle must never
 * interpret a capped prefix as the complete authorization set: that would make
 * the dashboard lie about shares and, for projections, silently omit viewers.
 * Request the maximum and refuse the whole enumeration when it is reached.
 */
const CANONICAL_INVENTORY_LIMIT = 2_000;

class CanonicalInventoryOverflowError extends Error {}

export interface TentacleShareView {
  owner: string;
  viewer: string;
  objectId: string;
  kind: "tool" | "projection";
  device: string;
  resourceKey: string;
  schemaDigest: string;
  status: string;
  /** Durable configured/canonical intent, kept separate from live effectiveness. */
  mode: "deny" | "ask" | "allow" | "block";
  effective: boolean;
  explanation: string;
}

function parseShareResourceId(resourceId: string): { viewer: string; objectId: string } | null {
  const separator = resourceId.indexOf("|");
  if (separator <= 0 || separator === resourceId.length - 1) return null;
  return { viewer: resourceId.slice(0, separator), objectId: resourceId.slice(separator + 1) };
}

function operationFor(row: TentacleObjectRow): string {
  return row.kind === "tool" ? TENTACLE_INVOKE_OPERATION : TENTACLE_READ_EVENT_OPERATION;
}

/** Cross-user control plane. Every effect is either a Gate request or a refusal. */
export class TentacleService {
  private readonly catalogs = new Map<string, CatalogRecord>();
  private readonly activeProjections = new Map<string, ActiveProjection>();
  /** Live Gate Contexts make revocation teardown precise; versions fence post-Gate disclosure. */
  private readonly activeScopes = new Map<string, ActiveScope>();
  private readonly resourceVersions = new Map<string, number>();
  private closed = false;
  /** Correlation for trusted Head→owner calls; never accepted from a payload. */
  private readonly detachPermissions: () => void;
  private readonly detachAuthorization: () => void;

  constructor(
    private readonly store: Store,
    private readonly permissions: PermissionService,
    private readonly authorization: AuthorizationService,
    private readonly capabilities: TentacleCapabilities,
    private readonly broker: TentacleBroker,
  ) {
    broker.onApplication((peer, message) => this.receive(peer, message));
    this.detachPermissions = permissions.onRevoked((event) => {
      if (event.subjectType === "service" && event.subjectId === TENTACLE_SUBJECT_ID) {
        this.reconcileRevocation(event.owner);
      }
    });
    this.detachAuthorization = authorization.onChanged((event) => {
      if (event.owner && (event.kind === "permit-revoked" || event.kind === "permit-put")) {
        this.reconcileRevocation(event.owner);
      }
    });
  }

  catalog(owner: string): { devices: Array<{ device: string; online: boolean; tools: unknown[]; revision: number }> } {
    const online = new Set(this.broker.devices(owner));
    const deviceNames = new Set([
      ...this.store.listRunnerTokens(owner).filter((row) => row.device.startsWith("dsh:")).map((row) => row.device),
      ...online,
    ]);
    return {
      devices: [...deviceNames].sort().map((device) => {
        const record = this.catalogs.get(`${owner}\0${device}`);
        return {
          device,
          online: online.has(device),
          revision: record?.revision ?? 0,
          tools: (record?.schemas ?? []).map((schema) => {
            try {
              const normalized = normalizeToolSchema(schema);
              if (isSessionChannelToolName(normalized.name)) {
                return { ...normalized, shareable: false, reason: PRIVATE_SESSION_CHANNEL_REASON };
              }
              return { ...normalized, shareable: true };
            } catch (error) {
              return {
                name: isPlainRecord(schema) && typeof schema.name === "string" ? schema.name : "(invalid)",
                description: isPlainRecord(schema) && typeof schema.description === "string" ? schema.description : "",
                shareable: false,
                reason: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        };
      }),
    };
  }

  shares(owner: string): TentacleShareView[] {
    const out = new Map<string, TentacleShareView>();
    for (const grant of this.permissions.list(owner)) {
      if (grant.subjectType !== "service" || grant.subjectId !== TENTACLE_SUBJECT_ID) continue;
      const parsed = parseShareResourceId(grant.resourceId);
      if (!parsed) continue;
      const row = this.capabilities.get(parsed.objectId);
      if (!row || row.owner !== owner) continue;
      const view = this.permissions.effectiveFor({
        subjectType: "service",
        subjectId: TENTACLE_SUBJECT_ID,
        owner,
        resourceId: grant.resourceId,
        requested: [operationFor(row)],
        contractDigest: row.schema_digest,
      });
      const entry = view.entries[0];
      const privateTool = isPrivateSessionChannelTool(row);
      const canonicalDecision = this.canonicalDecisionAfterHistory(row, parsed.viewer);
      const effective = !privateTool && (canonicalDecision
        ? canonicalDecision.result === "allow" && this.objectDefinitionIsCurrent(row)
        : this.isLegacyEffective(row, grant.resourceId));
      const legacyConfigured = grant.status !== "active" || !grant.operations.includes(operationFor(row))
        ? "deny"
        : grant.autoAllow.includes(operationFor(row))
          ? "allow"
          : "ask";
      const configured = canonicalDecision?.result ?? legacyConfigured;
      out.set(`${parsed.viewer}\0${row.object_id}`, {
        owner,
        viewer: parsed.viewer,
        objectId: row.object_id,
        kind: row.kind,
        device: row.device,
        resourceKey: row.resource_key,
        schemaDigest: row.schema_digest,
        status: grant.status,
        mode: configured,
        effective,
        explanation: privateTool
          ? PRIVATE_SESSION_CHANNEL_REASON
          : !this.objectDefinitionIsCurrent(row)
          ? "dsh catalog 已变化；旧 schema Object 不再可调用，请重新授权新 Object。"
          : canonicalDecision
            ? canonicalDecision.result === "allow"
              ? "这个 viewer/Object 已进入 canonical 权限面；canonical 当前决定为 ALLOW。旧 grant 只保留兼容来源信息。"
              : `这个 viewer/Object 已进入 canonical 权限面；canonical 当前决定为 ${canonicalDecision.result.toUpperCase()}，旧 grant 不会复活。`
            : entry?.explanation ?? "Object 不存在。",
      });
    }
    for (const resource of this.listCanonicalResourcesComplete(owner)) {
      if (resource.externalRef.system !== "tentacle") continue;
      const row = this.capabilities.get(resource.externalRef.id);
      if (!row || row.owner !== owner) continue;
      for (const permit of this.listCanonicalPermitsComplete(resource.id, operationFor(row))) {
        if (permit.subject.type !== "user" || permit.subject.id === owner) continue;
        const decision = this.canonicalDecisionAfterHistory(row, permit.subject.id);
        if (!decision) continue;
        out.set(
          `${permit.subject.id}\0${row.object_id}`,
          this.canonicalShareView(row, permit.subject.id, decision),
        );
      }
    }
    return [...out.values()].sort((a, b) => `${a.viewer}\0${a.objectId}`.localeCompare(`${b.viewer}\0${b.objectId}`));
  }

  share(o: {
    owner: string;
    viewer: string;
    device: string;
    kind: "tool" | "projection";
    resourceKey: string;
    createdBy: string;
  }): TentacleShareView {
    if (!this.store.getUser(o.owner) || !this.store.getUser(o.viewer)) throw new Error("owner 或观看者不是 Octopus 用户");
    if (o.owner === o.viewer) throw new Error("dsh 跨用户共享必须选择另一个用户");
    if (o.kind === "tool" && isSessionChannelToolName(o.resourceKey)) {
      throw new Error(PRIVATE_SESSION_CHANNEL_REASON);
    }
    if (!o.device.startsWith("dsh:") || !this.store.listRunnerTokens(o.owner).some((row) => row.device === o.device)) {
      throw new Error("dsh 设备不属于 owner");
    }
    let row: TentacleObjectRow;
    if (o.kind === "tool") {
      const catalog = this.catalogs.get(`${o.owner}\0${o.device}`);
      const schema = catalog?.schemas.find((candidate) => isPlainRecord(candidate) && candidate.name === o.resourceKey);
      if (!schema) throw new Error("该在线 dsh catalog 里没有这个工具");
      row = this.capabilities.castTool(o.owner, o.device, schema);
    } else {
      row = this.capabilities.castProjection(o.owner, o.device, o.resourceKey);
    }
    const operation = operationFor(row);
    const domainId = tentacleAuthorizationDomainId(o.owner);
    const resourceId = tentacleAuthorizationResourceId(row.object_id);
    this.authorization.upsertDomain({
      id: domainId,
      kind: "personal",
      title: `${o.owner} 的个人域`,
      authority: { kind: "owner", id: o.owner },
      historyPolicy: "all",
    });
    this.authorization.upsertResource({
      id: resourceId,
      uri: resourceUri(
        "tool",
        "dsh",
        o.owner,
        o.device,
        row.kind === "tool" ? "tools" : "projections",
        row.resource_key,
      ),
      owner: o.owner,
      domainId,
      kind: row.kind === "tool" ? "tentacle-tool" : "tentacle-live-view",
      title: row.kind === "tool" ? `dsh 工具 · ${row.resource_key}` : "dsh 会话只读视图",
      sensitivity: "sensitive",
      externalRef: { system: "tentacle", id: row.object_id },
    });
    this.authorization.putPermit({
      subject: { type: "user", id: o.viewer },
      resourceId,
      operation,
      mode: "allow",
      authority: { kind: "owner", id: o.owner },
      source: "user",
      createdBy: o.createdBy,
    });
    this.permissions.audit({
      owner: o.owner,
      subjectType: "user",
      subjectId: o.viewer,
      operation: "(grant)",
      resource: resourceId,
      decision: "grant",
      reason: "canonical-exact-permit",
      detail: JSON.stringify({ operation, objectId: row.object_id }),
    });
    // Returning the row just created must not depend on enumerating every share:
    // a bounded inventory may fail closed, but the API must never report failure
    // after this durable permit has already become effective.
    const decision = this.canonicalDecisionAfterHistory(row, o.viewer);
    if (!decision) throw new Error("canonical permit was not readable after durable write");
    return this.canonicalShareView(row, o.viewer, decision);
  }

  revoke(o: { owner: string; viewer: string; objectId: string; by: string }): boolean {
    const row = this.capabilities.get(o.objectId);
    if (!row || row.owner !== o.owner) return false;
    const operation = operationFor(row);
    const canonicalResourceId = tentacleAuthorizationResourceId(o.objectId);
    const canonical = this.authorization.getResource(canonicalResourceId)
      ? this.authorization.revokePermit({
          subject: { type: "user", id: o.viewer },
          resourceId: canonicalResourceId,
          operation,
          authority: { kind: "owner", id: o.owner },
          revokedBy: o.by,
        })
      : undefined;
    const legacy = this.permissions.revoke({
      subjectType: "service",
      subjectId: TENTACLE_SUBJECT_ID,
      owner: o.owner,
      resourceId: tentacleShareResourceId(o.viewer, o.objectId),
      by: o.by,
    });
    if (canonical) {
      this.permissions.audit({
        owner: o.owner,
        subjectType: "user",
        subjectId: o.viewer,
        operation: "(revoke)",
        resource: canonical.resourceId,
        decision: "revoke",
        reason: `by ${o.by}`,
        detail: JSON.stringify({ operation }),
      });
    }
    return Boolean(canonical) || legacy;
  }

  /** Called after rt_ rotation/removal closed Object roots. */
  deviceChanged(owner: string, device: string): void {
    this.capabilities.revokeDevice(owner, device);
    this.broker.disconnect(owner, device);
    this.reconcileRevocation(owner, (row) => row.device === device);
  }

  credentialRevoked(owner: string, tokenHash: string): void {
    if (this.broker.disconnectCredential(owner, tokenHash) > 0) this.invalidateOwnerResources(owner);
    this.reconcileRevocation();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachPermissions();
    this.detachAuthorization();
    for (const resourceId of this.liveResourceIds()) this.invalidateResource(resourceId);
    this.activeScopes.clear();
    this.activeProjections.clear();
    this.broker.close();
  }

  private async receive(peer: TentaclePeer, message: TentacleWireMessage): Promise<void> {
    if (this.closed) throw new Error("tentacle service is closed");
    if (message.op === "tool.catalog") {
      this.receiveCatalog(peer, message);
      return;
    }
    if (message.op === "tool.invoke") {
      await this.invokeTool(peer, message);
      return;
    }
    if (message.op === "projection.open" || message.op === "projection.event") {
      await this.project(peer, message);
      return;
    }
    throw new Error(`unsupported tentacle operation ${message.op}`);
  }

  private receiveCatalog(peer: TentaclePeer, message: TentacleWireMessage): void {
    if (message.toUser !== TENTACLE_HEAD_USER || !Array.isArray(message.args.schemas)) {
      throw new Error("tool.catalog must target head and contain schemas");
    }
    if (message.args.schemas.length > 128) throw new Error("tool catalog is too large");
    const key = `${peer.username}\0${peer.device}`;
    const previous = this.catalogs.get(key);
    this.catalogs.set(key, {
      owner: peer.username,
      device: peer.device,
      schemas: message.args.schemas,
      revision: (previous?.revision ?? 0) + 1,
      reportedAt: new Date().toISOString(),
    });
  }

  private async invokeTool(peer: TentaclePeer, message: TentacleWireMessage): Promise<void> {
    const row = this.capabilities.get(message.objectId);
    const args = message.args.arguments;
    const operation = TENTACLE_INVOKE_OPERATION;
    const resourceId = row ? tentacleShareResourceId(peer.username, row.object_id) : "missing";
    const gateArgs: Record<string, unknown> = isPlainRecord(args)
      ? { ...args, _octo_from: peer.username, _octo_source_device: peer.device, _octo_seq: message.seq }
      : { _octo_from: peer.username, _octo_source_device: peer.device, _octo_seq: message.seq };
    if (row && isPrivateSessionChannelTool(row)) {
      const denied = await this.capabilities.deny(peer.username, operation, gateArgs);
      const reason = denied.status === "denied" ? denied.reason : PRIVATE_SESSION_CHANNEL_REASON;
      this.audit(row.owner, row.object_id, "deny", PRIVATE_SESSION_CHANNEL_REASON);
      this.refuse(peer, message, reason);
      return;
    }
    if (!row || row.kind !== "tool" || row.owner === peer.username || !isPlainRecord(args)) {
      const denied = await this.capabilities.deny(peer.username, operation, gateArgs);
      this.refuse(peer, message, denied.status === "denied" ? denied.reason : "unknown shared tool Object");
      return;
    }
    const effective = this.isEffective(row, peer.username, resourceId);
    const grant = effective ? this.capabilities.open(row, peer.username, operation, resourceId) : null;
    if (!grant) {
      const denied = await this.capabilities.deny(peer.username, operation, gateArgs);
      this.audit(row.owner, row.object_id, "deny", denied.status === "denied" ? denied.reason : "share is not effective");
      this.refuse(peer, message, denied.status === "denied" ? denied.reason : "share is not effective");
      return;
    }
    this.trackScope(resourceId, row, peer.username);
    const before = this.resourceVersion(resourceId);
    try {
      const result = await grant.request(gateArgs);
      if (result.status !== "succeeded" || !isBrokerToolResult(result.result)) {
        const reason = result.status === "succeeded"
          ? "target returned an invalid tool result"
          : result.status === "approval_required"
            ? "standing dsh grant unexpectedly requested Octopus approval"
            : result.reason;
        this.audit(row.owner, row.object_id, "deny", reason);
        this.refuse(peer, message, reason);
        return;
      }
      if (before !== this.resourceVersion(resourceId) || !this.isEffective(row, peer.username, resourceId)) {
        this.broker.discardToolReply(result.result.replyKey);
        this.refuse(peer, message, "share was revoked while the tool was running");
        return;
      }
      await this.broker.routeToolReply(result.result.replyKey, peer);
      this.audit(row.owner, row.object_id, "allow", `viewer=${peer.username}`);
    } finally {
      grant.destroy();
      this.releaseScope(resourceId);
    }
  }

  private async project(peer: TentaclePeer, message: TentacleWireMessage): Promise<void> {
    const row = this.capabilities.get(message.objectId);
    const operation = TENTACLE_READ_EVENT_OPERATION;
    const payload = JSON.stringify({ op: message.op, args: message.args });
    if (!row || row.kind !== "projection" || row.owner !== peer.username) {
      const denied = await this.capabilities.deny(peer.username, operation, { payload });
      this.refuse(peer, message, denied.status === "denied" ? denied.reason : "unknown projection Object");
      return;
    }
    let targets: ProjectionTarget[];
    try {
      targets = this.projectionTargets(row);
    } catch (error) {
      if (!(error instanceof CanonicalInventoryOverflowError)) throw error;
      const denied = await this.capabilities.deny(peer.username, operation, { payload });
      this.audit(row.owner, row.object_id, "deny", error.message);
      this.refuse(peer, message, denied.status === "denied" ? denied.reason : error.message);
      return;
    }
    if (targets.length === 0) {
      const denied = await this.capabilities.deny(peer.username, operation, { payload });
      this.audit(row.owner, row.object_id, "deny", "projection Object has no effective viewer grants");
      this.refuse(peer, message, denied.status === "denied" ? denied.reason : "projection Object has no effective viewer grants");
      return;
    }

    const outcomes = await Promise.allSettled(
      targets.map((target) => this.projectToViewer(peer, message, row, payload, target)),
    );
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failed) throw failed.reason;
  }

  private async projectToViewer(
    peer: TentaclePeer,
    message: TentacleWireMessage,
    row: TentacleObjectRow,
    payload: string,
    target: ProjectionTarget,
  ): Promise<void> {
    const operation = TENTACLE_READ_EVENT_OPERATION;
    const { viewer, resourceId } = target;
    const viewerDevice = this.broker.onlyDevice(viewer);
    if (!viewerDevice) {
      const denied = await this.capabilities.deny(viewer, operation, { payload });
      this.audit(row.owner, row.object_id, "deny", `viewer=${viewer} has no unique online dsh instance`);
      this.refuse(peer, message, denied.status === "denied" ? denied.reason : `projection target ${viewer} is unavailable`);
      return;
    }
    const grant = this.capabilities.open(row, viewer, operation, resourceId);
    if (!grant) {
      const denied = await this.capabilities.deny(viewer, operation, { payload });
      this.audit(row.owner, row.object_id, "deny", `viewer=${viewer} share is no longer effective`);
      this.refuse(peer, message, denied.status === "denied" ? denied.reason : `projection share for ${viewer} is not effective`);
      return;
    }
    this.trackScope(resourceId, row, viewer);
    const before = this.resourceVersion(resourceId);
    try {
      const result = await grant.request({ payload });
      if (result.status !== "succeeded") {
        this.refuse(
          peer,
          message,
          result.status === "approval_required"
            ? "standing dsh projection grant unexpectedly requested Octopus approval"
            : result.reason,
        );
        return;
      }
      if (before !== this.resourceVersion(resourceId) || !this.isEffective(row, viewer, resourceId)) {
        this.refuse(peer, message, "projection share was revoked");
        return;
      }
      if (result.result !== null) {
        if (!isPlainRecord(result.result) || !isPlainRecord(result.result.args) || typeof result.result.op !== "string") {
          throw new Error("projection Gate returned an invalid cropped event");
        }
        await this.broker.forward(peer, { username: viewer, device: viewerDevice }, {
          ...message,
          toUser: viewer,
          op: result.result.op,
          args: jsonValue(result.result.args) as JsonObject,
        });
      }
      this.activeProjections.set(resourceId, {
        owner: row.owner,
        viewer,
        viewerDevice,
        objectId: row.object_id,
        resourceId,
      });
      this.audit(row.owner, row.object_id, "allow", `projection viewer=${viewer}`);
    } finally {
      grant.destroy();
      this.releaseScope(resourceId);
    }
  }

  private projectionTargets(row: TentacleObjectRow): ProjectionTarget[] {
    const targets = new Map<string, ProjectionTarget>();
    const canonicalResourceId = tentacleAuthorizationResourceId(row.object_id);
    for (const permit of this.listCanonicalPermitsComplete(canonicalResourceId, operationFor(row))) {
      if (permit.subject.type !== "user" || permit.subject.id === row.owner) continue;
      const runtimeResourceId = tentacleShareResourceId(permit.subject.id, row.object_id);
      if (!this.isEffective(row, permit.subject.id, runtimeResourceId)) continue;
      targets.set(permit.subject.id, { viewer: permit.subject.id, resourceId: runtimeResourceId });
    }
    for (const grant of this.permissions.list(row.owner)) {
      if (grant.subjectType !== "service" || grant.subjectId !== TENTACLE_SUBJECT_ID) continue;
      const parsed = parseShareResourceId(grant.resourceId);
      if (!parsed || parsed.objectId !== row.object_id || parsed.viewer === row.owner) continue;
      if (!this.isEffective(row, parsed.viewer, grant.resourceId)) continue;
      targets.set(parsed.viewer, { viewer: parsed.viewer, resourceId: grant.resourceId });
    }
    return [...targets.values()].sort((a, b) => a.viewer.localeCompare(b.viewer));
  }

  private isEffective(row: TentacleObjectRow, viewer: string, resourceId: string): boolean {
    if (isPrivateSessionChannelTool(row)) return false;
    if (!this.objectDefinitionIsCurrent(row)) return false;
    const canonicalDecision = this.canonicalDecisionAfterHistory(row, viewer);
    if (canonicalDecision) return canonicalDecision.result === "allow";
    return this.isLegacyEffective(row, resourceId);
  }

  /**
   * Return the canonical decision only after this exact tuple has entered that
   * plane. Before then, pre-v45 grants retain their compatibility behavior.
   */
  private canonicalDecisionAfterHistory(row: TentacleObjectRow, viewer: string) {
    const operation = operationFor(row);
    const canonical = this.authorization.getResource(tentacleAuthorizationResourceId(row.object_id));
    if (canonical?.owner !== row.owner
      || canonical.externalRef.system !== "tentacle"
      || canonical.externalRef.id !== row.object_id) {
      return null;
    }
    const canonicalHistory = this.authorization.listPermits({
      resourceId: canonical.id,
      subject: { type: "user", id: viewer },
      operation,
      includeRevoked: true,
      // Only existence matters. An explicit limit prevents a future default
      // change from turning this precedence check into a broad enumeration.
      limit: 1,
    });
    if (canonicalHistory.length === 0) return null;
    const decision = this.authorization.decideAccess({
      subject: { type: "user", id: viewer },
      resourceId: canonical.id,
      operation,
    });
    // Tentacle is an exact-permit adapter, not a rule-only subject enumerator.
    // Positive rules may explain policy intent, but cannot resurrect a revoked
    // share or upgrade ASK to a standing capability. Mandatory policy can
    // still narrow an active exact permit through decideAccess().
    if (decision.result === "deny" || decision.result === "block") return decision;
    const active = this.authorization.listPermits({
      resourceId: canonical.id,
      subject: { type: "user", id: viewer },
      operation,
      limit: 1,
    })[0];
    if (!active) {
      return {
        ...decision,
        result: "deny" as const,
        code: "exact_permit_missing",
        steps: [...decision.steps, {
          stage: "permit" as const,
          outcome: "applied" as const,
          effect: "deny" as const,
          message: "Tentacle standing access requires an active exact permit; revoked history cannot be revived by a rule",
        }],
      };
    }
    if (active.mode === "ask") {
      return { ...decision, result: "ask" as const, code: "approval_required" };
    }
    return { ...decision, result: "allow" as const, code: "exact_permit_allow" };
  }

  private isLegacyEffective(row: TentacleObjectRow, resourceId: string): boolean {
    if (!this.objectDefinitionIsCurrent(row)) return false;
    const operation = operationFor(row);
    const view = this.permissions.effectiveFor({
      subjectType: "service",
      subjectId: TENTACLE_SUBJECT_ID,
      owner: row.owner,
      resourceId,
      requested: [operation],
      contractDigest: row.schema_digest,
    });
    return effectiveOperations(view).includes(operation) && view.entries[0]?.autoAllow === true;
  }

  private canonicalShareView(
    row: TentacleObjectRow,
    viewer: string,
    decision: ReturnType<AuthorizationService["decideAccess"]>,
  ): TentacleShareView {
    const currentObject = this.objectDefinitionIsCurrent(row);
    const privateTool = isPrivateSessionChannelTool(row);
    return {
      owner: row.owner,
      viewer,
      objectId: row.object_id,
      kind: row.kind,
      device: row.device,
      resourceKey: row.resource_key,
      schemaDigest: row.schema_digest,
      status: "active",
      mode: decision.result,
      effective: !privateTool && decision.result === "allow" && currentObject,
      explanation: privateTool
        ? PRIVATE_SESSION_CHANNEL_REASON
        : !currentObject
        ? "dsh catalog 已变化；旧 schema Object 不再可调用，请重新授权新 Object。"
        : decision.result === "allow"
          ? "canonical 精确许可有效；实际调用仍会逐次经过 capability-kernel Gate。"
          : decision.result === "ask"
            ? "许可要求 Octopus 逐次批准；standing Tentacle 分享不消费该模式，因此当前关闭。"
            : `canonical 策略裁决为 ${decision.result}。`,
    };
  }

  private listCanonicalResourcesComplete(owner: string) {
    const resources = this.authorization.listResources({ owner, limit: CANONICAL_INVENTORY_LIMIT });
    if (resources.length >= CANONICAL_INVENTORY_LIMIT) {
      throw new CanonicalInventoryOverflowError(
        `Tentacle canonical resource inventory for ${owner} reached the safe limit; refusing a partial result`,
      );
    }
    return resources;
  }

  private listCanonicalPermitsComplete(resourceId: string, operation: string) {
    const permits = this.authorization.listPermits({
      resourceId,
      operation,
      limit: CANONICAL_INVENTORY_LIMIT,
    });
    if (permits.length >= CANONICAL_INVENTORY_LIMIT) {
      throw new CanonicalInventoryOverflowError(
        `Tentacle canonical permit inventory for ${resourceId} reached the safe limit; refusing a partial result`,
      );
    }
    return permits;
  }

  private objectDefinitionIsCurrent(row: TentacleObjectRow): boolean {
    if (row.kind === "projection") return true;
    const catalog = this.catalogs.get(`${row.owner}\0${row.device}`);
    const candidate = catalog?.schemas.find((schema) => isPlainRecord(schema) && schema.name === row.resource_key);
    if (!candidate) return false;
    try {
      return schemaDigest(normalizeToolSchema(candidate)) === row.schema_digest;
    } catch {
      return false;
    }
  }

  private reconcileRevocation(
    owner?: string,
    forceInvalid: (row: TentacleObjectRow) => boolean = () => false,
  ): void {
    for (const resourceId of this.liveResourceIds()) {
      const parsed = parseShareResourceId(resourceId);
      const activeScope = this.activeScopes.get(resourceId);
      const activeProjection = this.activeProjections.get(resourceId);
      const objectId = parsed?.objectId ?? activeScope?.objectId ?? activeProjection?.objectId;
      const row = objectId ? this.capabilities.get(objectId) : null;
      const resourceOwner = row?.owner ?? activeScope?.owner ?? activeProjection?.owner;
      const viewer = parsed?.viewer ?? activeScope?.viewer ?? activeProjection?.viewer;
      if (owner !== undefined && resourceOwner !== owner) continue;
      if (row && viewer && !forceInvalid(row) && this.isEffective(row, viewer, resourceId)) continue;
      this.invalidateResource(resourceId);

      if (!activeProjection) continue;
      this.broker.sendControl(
        { username: activeProjection.viewer, device: activeProjection.viewerDevice },
        activeProjection.objectId,
        "projection.stop",
        { reason: "revoked", owner: activeProjection.owner },
      );
      const ownerDevice = this.broker.onlyDevice(activeProjection.owner);
      if (ownerDevice) {
        this.broker.sendControl(
          { username: activeProjection.owner, device: ownerDevice },
          activeProjection.objectId,
          "projection.stop",
          { reason: "revoked", viewer: activeProjection.viewer },
        );
      }
      this.activeProjections.delete(resourceId);
    }
  }

  private invalidateOwnerResources(owner: string): void {
    for (const resourceId of this.liveResourceIds()) {
      const parsed = parseShareResourceId(resourceId);
      const activeScope = this.activeScopes.get(resourceId);
      const activeProjection = this.activeProjections.get(resourceId);
      const objectId = parsed?.objectId ?? activeScope?.objectId ?? activeProjection?.objectId;
      const row = objectId ? this.capabilities.get(objectId) : null;
      const resourceOwner = row?.owner ?? activeScope?.owner ?? activeProjection?.owner;
      const viewer = parsed?.viewer ?? activeScope?.viewer ?? activeProjection?.viewer;
      if (viewer === owner || resourceOwner === owner) this.invalidateResource(resourceId);
    }
  }

  private liveResourceIds(): Set<string> {
    return new Set([...this.activeScopes.keys(), ...this.activeProjections.keys()]);
  }

  private resourceVersion(resourceId: string): number {
    return this.resourceVersions.get(resourceId) ?? 0;
  }

  private invalidateResource(resourceId: string): void {
    this.resourceVersions.set(resourceId, this.resourceVersion(resourceId) + 1);
    this.capabilities.destroyScope(resourceId);
  }

  private trackScope(resourceId: string, row: TentacleObjectRow, viewer: string): void {
    const active = this.activeScopes.get(resourceId);
    if (active) {
      active.count++;
      return;
    }
    this.activeScopes.set(resourceId, { owner: row.owner, viewer, objectId: row.object_id, count: 1 });
  }

  private releaseScope(resourceId: string): void {
    const active = this.activeScopes.get(resourceId);
    if (!active) return;
    if (active.count > 1) {
      active.count--;
      return;
    }
    this.activeScopes.delete(resourceId);
  }

  private refuse(peer: TentaclePeer, message: TentacleWireMessage, reason: string): void {
    this.broker.sendControl(peer, message.objectId, "gate.refused", {
      requestFrom: peer.username,
      requestSeq: message.seq,
      operation: message.op,
      reason: reason.slice(0, 500),
    });
  }

  private audit(owner: string, objectId: string, decision: string, reason: string): void {
    this.permissions.audit({
      owner,
      subjectType: "service",
      subjectId: TENTACLE_SUBJECT_ID,
      operation: objectId,
      resource: objectId,
      decision,
      reason,
    });
  }
}
