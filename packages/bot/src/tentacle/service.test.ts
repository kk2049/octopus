import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { AuthorizationService } from "../authorization/service.js";
import { PermissionService } from "../permissions/service.js";
import type { RunnerTentacleTransport, TentaclePeer } from "../runner/gateway.js";
import { Store } from "../store/store.js";
import { TentacleBroker } from "./broker.js";
import { TentacleCapabilities } from "./capability.js";
import {
  TENTACLE_INVOKE_OPERATION,
  TENTACLE_SUBJECT_ENTRY,
  TENTACLE_SUBJECT_ID,
  tentacleAuthorizationDomainId,
  tentacleAuthorizationResourceId,
  tentacleShareResourceId,
} from "./catalog.js";
import {
  TENTACLE_HEAD_USER,
  TENTACLE_PROTOCOL_VERSION,
  type TentacleWireMessage,
} from "./protocol.js";
import { TentacleService } from "./service.js";
import { SESSION_CHANNEL_TENTACLE_TOOL, SESSION_CHANNEL_V2_TENTACLE_TOOL } from "@claude-bot/session-channel-contract";

const NOW = "2026-08-14T00:00:00.000Z";
const TOOL = {
  name: "bash",
  description: "run after dsh local ask",
  parameters: {
    type: "object",
    properties: { command: { type: "string", maxLength: 2000 } },
    required: ["command"],
    additionalProperties: false,
  },
};
const SESSION_CHANNEL_FIXTURE = {
  name: SESSION_CHANNEL_TENTACLE_TOOL,
  description: "provider-neutral session channel",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["open_session", "send", "stop", "read_activity"] },
      request_json: { type: "string", maxLength: 32768 },
    },
    required: ["action", "request_json"],
    additionalProperties: false,
  },
};

class FakeTentacleTransport implements RunnerTentacleTransport {
  readonly sent: Array<{ username: string; device: string; message: TentacleWireMessage }> = [];
  readonly online = new Map<string, string[]>([
    ["alice", ["dsh:alice"]],
    ["bob", ["dsh:bob"]],
    ["carol", ["dsh:carol"]],
  ]);
  readonly pendingToolInvocations: Array<{ username: string; device: string; message: TentacleWireMessage }> = [];
  deferToolResults = false;
  private readonly listeners = new Set<(peer: TentaclePeer, message: unknown) => void | Promise<void>>();
  private replySeq = 1000;

  onMessage(listener: (peer: TentaclePeer, message: unknown) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listDevices(username: string): string[] {
    return [...(this.online.get(username) ?? [])];
  }

  disconnect(username: string, device: string): boolean {
    const devices = this.online.get(username) ?? [];
    if (!devices.includes(device)) return false;
    this.online.set(username, devices.filter((candidate) => candidate !== device));
    return true;
  }

  disconnectCredential(username: string): number {
    const count = this.online.get(username)?.length ?? 0;
    this.online.set(username, []);
    return count;
  }

  send(username: string, device: string, raw: unknown): boolean {
    if (!this.listDevices(username).includes(device)) return false;
    const message = raw as TentacleWireMessage;
    const frame = { username, device, message };
    this.sent.push(frame);
    if (message.op === "delivery.ack" || message.fromUser === TENTACLE_HEAD_USER) return true;
    void Promise.resolve().then(async () => {
      await this.emit({ username, device }, {
        version: TENTACLE_PROTOCOL_VERSION,
        fromUser: username,
        toUser: TENTACLE_HEAD_USER,
        objectId: message.objectId,
        op: "delivery.ack",
        args: { fromUser: message.fromUser, seq: message.seq },
        seq: this.replySeq++,
      });
      if (username === "alice" && message.op === "tool.invoke") {
        if (this.deferToolResults) this.pendingToolInvocations.push(frame);
        else await this.replyToTool(frame);
      }
    });
    return true;
  }

  async releaseToolResult(requestFrom: string, requestSeq: number): Promise<void> {
    const index = this.pendingToolInvocations.findIndex((frame) =>
      frame.message.args.requestFrom === requestFrom && frame.message.args.requestSeq === requestSeq
    );
    if (index < 0) throw new Error(`no pending tool invocation for ${requestFrom}/${requestSeq}`);
    const [frame] = this.pendingToolInvocations.splice(index, 1);
    await this.replyToTool(frame);
  }

  async emit(peer: TentaclePeer, message: TentacleWireMessage): Promise<void> {
    for (const listener of [...this.listeners]) await listener(peer, message);
  }

  private async replyToTool(frame: { username: string; device: string; message: TentacleWireMessage }): Promise<void> {
    const { username, device, message } = frame;
    const toolName = message.args.name;
    const toolArguments = message.args.arguments;
    let result: unknown = { stdout: "approved locally\n", code: 0 };
    if (toolName === SESSION_CHANNEL_TENTACLE_TOOL && typeof toolArguments === "object" && toolArguments !== null) {
      const requestJson = (toolArguments as Record<string, unknown>).request_json;
      const request = JSON.parse(String(requestJson)) as Record<string, unknown>;
      if (request.action === "open_session") {
        result = { sessionRef: `sch_${"a".repeat(40)}`, activityCursor: 0 };
      }
    }
    await this.emit({ username, device }, {
      version: TENTACLE_PROTOCOL_VERSION,
      fromUser: username,
      toUser: String(message.args.requestFrom),
      objectId: message.objectId,
      op: "tool.result",
      args: {
        ok: true,
        requestFrom: String(message.args.requestFrom),
        requestSeq: Number(message.args.requestSeq),
        result: result as import("./protocol.js").JsonValue,
      },
      seq: this.replySeq++,
    });
  }
}

function message(o: Partial<TentacleWireMessage> & Pick<TentacleWireMessage, "objectId" | "op" | "seq">): TentacleWireMessage {
  return {
    version: TENTACLE_PROTOCOL_VERSION,
    fromUser: o.fromUser ?? "bob",
    toUser: o.toUser ?? TENTACLE_HEAD_USER,
    objectId: o.objectId,
    op: o.op,
    args: o.args ?? {},
    seq: o.seq,
  };
}

describe("TentacleService real capability Gate", () => {
  let store: Store;
  let kernel: CapabilityService;
  let transport: FakeTentacleTransport;
  let broker: TentacleBroker;
  let capabilities: TentacleCapabilities;
  let permissions: PermissionService;
  let authorization: AuthorizationService;
  let tentacle: TentacleService;
  let permissionListenerDetach: () => void;

  beforeEach(() => {
    store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: NOW });
    store.saveUser({ username: "carol", uid: 5003, home_dir: "/x/c", created_at: NOW });
    store.saveRunnerToken("rt-a", "alice", "dsh:alice", NOW);
    store.saveRunnerToken("rt-b", "bob", "dsh:bob", NOW);
    store.saveRunnerToken("rt-c", "carol", "dsh:carol", NOW);
    kernel = new CapabilityService();
    transport = new FakeTentacleTransport();
    broker = new TentacleBroker(transport);
    capabilities = new TentacleCapabilities(store, kernel, broker);
    permissions = new PermissionService({
      store,
      bootstrapSessionHub: false,
      subjects: [TENTACLE_SUBJECT_ENTRY],
      extraAccountOperations: [(owner) => capabilities.accountOperations(owner)],
    });
    const subscribePermissionRevocation = permissions.onRevoked.bind(permissions);
    permissionListenerDetach = vi.fn();
    vi.spyOn(permissions, "onRevoked").mockImplementation((listener) => {
      const detach = subscribePermissionRevocation(listener);
      return () => {
        permissionListenerDetach();
        detach();
      };
    });
    authorization = new AuthorizationService({ repository: store.authorization });
    tentacle = new TentacleService(store, permissions, authorization, capabilities, broker);
  });

  afterEach(() => {
    tentacle.close();
    authorization.close();
    permissions.close();
    kernel.close();
    store.close();
  });

  it("sends an ungranted cross-user invocation through the deny Gate without touching the owner dsh", async () => {
    const object = capabilities.castTool("alice", "dsh:alice", TOOL);
    await transport.emit({ username: "bob", device: "dsh:bob" }, message({
      objectId: object.object_id,
      op: "tool.invoke",
      args: { name: "bash", arguments: { command: "echo blocked" } },
      seq: 1,
    }));
    expect(transport.sent.some((frame) => frame.username === "alice" && frame.message.op === "tool.invoke")).toBe(false);
    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "bob",
      message: expect.objectContaining({ op: "gate.refused", objectId: object.object_id }),
    }));
  });

  it.each([SESSION_CHANNEL_TENTACLE_TOOL, SESSION_CHANNEL_V2_TENTACLE_TOOL])("keeps the owner-bound session channel %s private", async (toolName) => {
    const SESSION_CHANNEL_TOOL = { ...SESSION_CHANNEL_FIXTURE, name: toolName };
    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      objectId: "session-channel-catalog",
      op: "tool.catalog",
      args: { schemas: [SESSION_CHANNEL_TOOL] },
      seq: 10,
    }));

    expect(tentacle.catalog("alice").devices[0]?.tools).toContainEqual(expect.objectContaining({
      name: toolName,
      shareable: false,
      reason: expect.stringContaining("owner-bound"),
    }));
    expect(() => tentacle.share({
      owner: "alice",
      viewer: "bob",
      device: "dsh:alice",
      kind: "tool",
      resourceKey: toolName,
      createdBy: "alice",
    })).toThrow(/不可跨用户分享/);

    // Defense in depth: even a stale/forged standing grant for the private
    // Object is refused before the authenticated owner dsh sees a tool call.
    const privateObject = capabilities.castTool("alice", "dsh:alice", SESSION_CHANNEL_TOOL);
    const forgedResourceId = tentacleShareResourceId("bob", privateObject.object_id);
    permissions.grant({
      subjectType: "service",
      subjectId: TENTACLE_SUBJECT_ID,
      owner: "alice",
      resourceType: "runner-device",
      resourceId: forgedResourceId,
      operations: [TENTACLE_INVOKE_OPERATION],
      autoAllow: [TENTACLE_INVOKE_OPERATION],
      source: "user",
      createdBy: "alice",
      contractDigest: privateObject.schema_digest,
      publisher: "dsh:alice",
    });
    expect(tentacle.shares("alice")).toContainEqual(expect.objectContaining({
      objectId: privateObject.object_id,
      viewer: "bob",
      effective: false,
      explanation: expect.stringContaining("owner-bound"),
    }));
    const callsBeforeForgedWire = transport.sent.filter((frame) => (
      frame.username === "alice" && frame.message.op === "tool.invoke"
      && frame.message.args.name === toolName
    )).length;
    await transport.emit({ username: "bob", device: "dsh:bob" }, message({
      objectId: privateObject.object_id,
      op: "tool.invoke",
      args: {
        name: toolName,
        arguments: { action: "open_session", request_json: "{}" },
      },
      seq: 77,
    }));
    expect(transport.sent.filter((frame) => (
      frame.username === "alice" && frame.message.op === "tool.invoke"
      && frame.message.args.name === toolName
    ))).toHaveLength(callsBeforeForgedWire);
    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "bob",
      message: expect.objectContaining({ op: "gate.refused", objectId: privateObject.object_id }),
    }));
  });

  it("keeps a pre-v45 exact grant effective without copying it into canonical storage", async () => {
    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      objectId: "legacy-catalog",
      op: "tool.catalog",
      args: { schemas: [TOOL] },
      seq: 10,
    }));
    const object = capabilities.castTool("alice", "dsh:alice", TOOL);
    permissions.grant({
      subjectType: "service",
      subjectId: "tentacle",
      owner: "alice",
      resourceType: "runner-device",
      resourceId: tentacleShareResourceId("bob", object.object_id),
      operations: ["invoke"],
      autoAllow: ["invoke"],
      source: "user",
      createdBy: "alice",
      contractDigest: object.schema_digest,
      publisher: "dsh:alice",
    });
    expect(authorization.getResource(tentacleAuthorizationResourceId(object.object_id))).toBeUndefined();
    expect(tentacle.shares("alice")).toEqual([
      expect.objectContaining({ viewer: "bob", objectId: object.object_id, effective: true }),
    ]);
    await transport.emit({ username: "bob", device: "dsh:bob" }, message({
      objectId: object.object_id,
      op: "tool.invoke",
      args: { name: "bash", arguments: { command: "printf legacy" } },
      seq: 11,
    }));
    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "bob",
      message: expect.objectContaining({ op: "tool.result", objectId: object.object_id }),
    }));
  });

  it("shows canonical absence as DENY after revoke without reviving a legacy ALLOW", async () => {
    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      objectId: "legacy-canonical-catalog",
      op: "tool.catalog",
      args: { schemas: [TOOL] },
      seq: 12,
    }));
    const object = capabilities.castTool("alice", "dsh:alice", TOOL);
    const legacyResourceId = tentacleShareResourceId("bob", object.object_id);
    permissions.grant({
      subjectType: "service",
      subjectId: "tentacle",
      owner: "alice",
      resourceType: "runner-device",
      resourceId: legacyResourceId,
      operations: ["invoke"],
      autoAllow: ["invoke"],
      source: "user",
      createdBy: "alice",
      contractDigest: object.schema_digest,
      publisher: "dsh:alice",
    });
    permissions.grant({
      subjectType: "service",
      subjectId: "tentacle",
      owner: "alice",
      resourceType: "runner-device",
      resourceId: tentacleShareResourceId("carol", object.object_id),
      operations: ["invoke"],
      autoAllow: ["invoke"],
      source: "user",
      createdBy: "alice",
      contractDigest: object.schema_digest,
      publisher: "dsh:alice",
    });
    const domainId = tentacleAuthorizationDomainId("alice");
    const resourceId = tentacleAuthorizationResourceId(object.object_id);
    authorization.upsertDomain({
      id: domainId,
      kind: "personal",
      title: "Alice personal",
      authority: { kind: "owner", id: "alice" },
      historyPolicy: "all",
    });
    authorization.upsertResource({
      id: resourceId,
      uri: "tool://dsh/alice/laptop/tools/bash",
      owner: "alice",
      domainId,
      kind: "tentacle-tool",
      title: "bash",
      sensitivity: "sensitive",
      externalRef: { system: "tentacle", id: object.object_id },
    });
    authorization.putPermit({
      subject: { type: "user", id: "bob" },
      resourceId,
      operation: "invoke",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "migration",
      createdBy: "system:migration",
    });
    expect(tentacle.shares("alice")).toContainEqual(expect.objectContaining({
      viewer: "bob",
      mode: "allow",
      effective: true,
    }));

    authorization.revokePermit({
      subject: { type: "user", id: "bob" },
      resourceId,
      operation: "invoke",
      authority: { kind: "owner", id: "alice" },
      revokedBy: "alice",
    });

    expect(permissions.get("service", "tentacle", "alice", legacyResourceId)).toMatchObject({
      status: "active",
      autoAllow: ["invoke"],
    });
    expect(tentacle.shares("alice")).toContainEqual(expect.objectContaining({
      viewer: "bob",
      mode: "deny",
      effective: false,
      explanation: expect.stringContaining("旧 grant 不会复活"),
    }));
    expect(tentacle.shares("alice")).toContainEqual(expect.objectContaining({
      viewer: "carol",
      mode: "allow",
      effective: true,
    }));

    authorization.putPermit({
      subject: { type: "user", id: "bob" },
      resourceId,
      operation: "invoke",
      mode: "ask",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    expect(tentacle.shares("alice")).toContainEqual(expect.objectContaining({
      viewer: "bob",
      mode: "ask",
      effective: false,
    }));
  });

  it("requires an active exact ALLOW even when a positive rule matches the viewer", async () => {
    tentacle.close();
    authorization.close();
    authorization = new AuthorizationService({
      repository: store.authorization,
      rules: [{
        id: "alice:bob-tools",
        title: "Bob tool rule",
        authority: { kind: "owner", id: "alice" },
        effect: "allow",
        match: {
          subjectTypes: ["user"],
          subjectIds: ["bob"],
          resourceKinds: ["tentacle-tool"],
          operations: ["invoke"],
        },
        explanation: "positive rules cannot replace the Tentacle exact-permit ceiling",
      }],
    });
    transport = new FakeTentacleTransport();
    broker = new TentacleBroker(transport);
    capabilities = new TentacleCapabilities(store, kernel, broker);
    tentacle = new TentacleService(store, permissions, authorization, capabilities, broker);
    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      objectId: "positive-rule-catalog",
      op: "tool.catalog",
      args: { schemas: [TOOL] },
      seq: 13,
    }));
    const share = tentacle.share({
      owner: "alice",
      viewer: "bob",
      device: "dsh:alice",
      kind: "tool",
      resourceKey: "bash",
      createdBy: "alice",
    });
    expect(share).toMatchObject({ mode: "allow", effective: true });

    const resourceId = tentacleAuthorizationResourceId(share.objectId);
    authorization.revokePermit({
      subject: { type: "user", id: "bob" },
      resourceId,
      operation: "invoke",
      authority: { kind: "owner", id: "alice" },
      revokedBy: "alice",
    });
    expect(tentacle.shares("alice")).not.toContainEqual(expect.objectContaining({ viewer: "bob" }));
    transport.sent.length = 0;
    await transport.emit({ username: "bob", device: "dsh:bob" }, message({
      objectId: share.objectId,
      op: "tool.invoke",
      args: { name: "bash", arguments: { command: "echo must-not-run" } },
      seq: 14,
    }));
    expect(transport.sent.some((frame) => frame.username === "alice" && frame.message.op === "tool.invoke")).toBe(false);
    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "bob",
      message: expect.objectContaining({ op: "gate.refused", objectId: share.objectId }),
    }));

    authorization.putPermit({
      subject: { type: "user", id: "bob" },
      resourceId,
      operation: "invoke",
      mode: "ask",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    expect(tentacle.shares("alice")).toContainEqual(expect.objectContaining({
      viewer: "bob",
      mode: "ask",
      effective: false,
    }));
  });

  it("enumerates resources and permits beyond the old 1,000-row boundary", async () => {
    authorization.upsertDomain({
      id: "a-fixtures",
      kind: "personal",
      title: "Fixture resources",
      authority: { kind: "owner", id: "alice" },
      historyPolicy: "all",
    });
    for (let index = 0; index < 1_001; index++) {
      const suffix = String(index).padStart(4, "0");
      authorization.upsertResource({
        id: `fixture:resource:${suffix}`,
        uri: `object://fixtures/alice/${suffix}`,
        owner: "alice",
        domainId: "a-fixtures",
        kind: "fixture",
        title: `A fixture ${suffix}`,
        sensitivity: "normal",
        externalRef: { system: "fixture", id: `fixture:${suffix}` },
      });
    }
    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      objectId: "large-canonical-catalog",
      op: "tool.catalog",
      args: { schemas: [TOOL] },
      seq: 13,
    }));
    const share = tentacle.share({
      owner: "alice",
      viewer: "bob",
      device: "dsh:alice",
      kind: "tool",
      resourceKey: "bash",
      createdBy: "alice",
    });
    expect(share).toMatchObject({ viewer: "bob", mode: "allow", effective: true });

    const resourceId = tentacleAuthorizationResourceId(share.objectId);
    for (let index = 0; index < 1_000; index++) {
      authorization.putPermit({
        subject: { type: "user", id: `viewer-${String(index).padStart(4, "0")}` },
        resourceId,
        operation: "invoke",
        mode: "allow",
        authority: { kind: "owner", id: "alice" },
        source: "migration",
        createdBy: "system:migration",
      });
    }
    const views = tentacle.shares("alice");
    expect(views).toHaveLength(1_001);
    expect(views).toContainEqual(expect.objectContaining({ viewer: "viewer-0999", mode: "allow" }));
  });

  it("fails a capped projection inventory before forwarding and still acknowledges the source", async () => {
    const share = tentacle.share({
      owner: "alice",
      viewer: "bob",
      device: "dsh:alice",
      kind: "projection",
      resourceKey: "overflow-projection",
      createdBy: "alice",
    });
    const resourceId = tentacleAuthorizationResourceId(share.objectId);
    const permit = authorization.listPermits({ resourceId })[0]!;
    const listPermits = authorization.listPermits.bind(authorization);
    vi.spyOn(authorization, "listPermits").mockImplementation((query = {}) => {
      if (query.resourceId === resourceId && query.operation === "read_event"
        && !query.includeRevoked && query.limit === 2_000) {
        return Array.from({ length: 2_000 }, (_, index) => ({
          ...permit,
          id: `overflow:${index}`,
          subject: { type: "user" as const, id: `overflow-viewer-${index}` },
        }));
      }
      return listPermits(query);
    });
    const forwardedBefore = transport.sent.filter((frame) => frame.message.op === "projection.open").length;
    const refusedBefore = transport.sent.filter((frame) => frame.message.op === "gate.refused").length;
    const acknowledgementsBefore = transport.sent.filter((frame) => frame.message.op === "delivery.ack").length;

    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      objectId: share.objectId,
      op: "projection.open",
      args: { sourceSessionId: "overflow-projection" },
      seq: 14,
    }));

    expect(transport.sent.filter((frame) => frame.message.op === "projection.open")).toHaveLength(forwardedBefore);
    expect(transport.sent.filter((frame) => frame.message.op === "gate.refused")).toHaveLength(refusedBefore + 1);
    expect(transport.sent.filter((frame) => frame.message.op === "delivery.ack"))
      .toHaveLength(acknowledgementsBefore + 1);
  });

  it("returns a newly durable share without depending on a full inventory read", async () => {
    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      objectId: "share-return-catalog",
      op: "tool.catalog",
      args: { schemas: [TOOL] },
      seq: 15,
    }));
    vi.spyOn(authorization, "listResources").mockImplementation(() => {
      throw new Error("full inventory unavailable");
    });

    const share = tentacle.share({
      owner: "alice",
      viewer: "bob",
      device: "dsh:alice",
      kind: "tool",
      resourceKey: "bash",
      createdBy: "alice",
    });

    expect(share).toMatchObject({ viewer: "bob", mode: "allow", effective: true });
    expect(authorization.listPermits({
      resourceId: tentacleAuthorizationResourceId(share.objectId),
      subject: { type: "user", id: "bob" },
      operation: "invoke",
    })).toHaveLength(1);
  });

  it("detaches its PermissionService listener exactly once on standalone close", () => {
    const reconcile = vi.spyOn(
      tentacle as unknown as { reconcileRevocation(owner?: string): void },
      "reconcileRevocation",
    );
    tentacle.close();
    tentacle.close();
    expect(permissionListenerDetach).toHaveBeenCalledOnce();
    permissions.grant({
      subjectType: "service",
      subjectId: "tentacle",
      owner: "alice",
      resourceType: "runner-device",
      resourceId: "bob|closed-object",
      operations: ["invoke"],
      autoAllow: ["invoke"],
      source: "user",
      createdBy: "alice",
    });
    permissions.revoke({
      subjectType: "service",
      subjectId: "tentacle",
      owner: "alice",
      resourceId: "bob|closed-object",
      by: "alice",
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("routes a pinned tool after grant, then revocation refuses the next call", async () => {
    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      objectId: "catalog",
      op: "tool.catalog",
      args: { schemas: [TOOL] },
      seq: 1,
    }));
    const share = tentacle.share({
      owner: "alice",
      viewer: "bob",
      device: "dsh:alice",
      kind: "tool",
      resourceKey: "bash",
      createdBy: "alice",
    });
    expect(permissions.get("service", "tentacle", "alice", tentacleShareResourceId("bob", share.objectId))).toBeNull();
    expect(authorization.listPermits({ resourceId: tentacleAuthorizationResourceId(share.objectId) })).toEqual([
      expect.objectContaining({
        subject: { type: "user", id: "bob" },
        operation: "invoke",
        mode: "allow",
      }),
    ]);
    await transport.emit({ username: "bob", device: "dsh:bob" }, message({
      objectId: share.objectId,
      op: "tool.invoke",
      args: { name: "bash", arguments: { command: "printf ok" } },
      seq: 2,
    }));
    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "alice",
      message: expect.objectContaining({ op: "tool.invoke", objectId: share.objectId }),
    }));
    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "bob",
      message: expect.objectContaining({ op: "tool.result", objectId: share.objectId }),
    }));

    expect(tentacle.revoke({ owner: "alice", viewer: "bob", objectId: share.objectId, by: "alice" })).toBe(true);
    const callsBefore = transport.sent.filter((frame) => frame.username === "alice" && frame.message.op === "tool.invoke").length;
    await transport.emit({ username: "bob", device: "dsh:bob" }, message({
      objectId: share.objectId,
      op: "tool.invoke",
      args: { name: "bash", arguments: { command: "printf denied" } },
      seq: 3,
    }));
    expect(transport.sent.filter((frame) => frame.username === "alice" && frame.message.op === "tool.invoke")).toHaveLength(callsBefore);
    expect(transport.sent.at(-2)?.message.op).toBe("gate.refused");
  });

  it("hard-destroys only the revoked tool scope and preserves another viewer's in-flight result", async () => {
    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      objectId: "catalog-concurrent",
      op: "tool.catalog",
      args: { schemas: [TOOL] },
      seq: 30,
    }));
    const bobShare = tentacle.share({
      owner: "alice",
      viewer: "bob",
      device: "dsh:alice",
      kind: "tool",
      resourceKey: "bash",
      createdBy: "alice",
    });
    const carolShare = tentacle.share({
      owner: "alice",
      viewer: "carol",
      device: "dsh:alice",
      kind: "tool",
      resourceKey: "bash",
      createdBy: "alice",
    });
    expect(carolShare.objectId).toBe(bobShare.objectId);

    transport.deferToolResults = true;
    const bobCall = transport.emit({ username: "bob", device: "dsh:bob" }, message({
      objectId: bobShare.objectId,
      op: "tool.invoke",
      args: { name: "bash", arguments: { command: "printf bob" } },
      seq: 31,
    }));
    const carolCall = transport.emit({ username: "carol", device: "dsh:carol" }, message({
      objectId: carolShare.objectId,
      op: "tool.invoke",
      args: { name: "bash", arguments: { command: "printf carol" } },
      seq: 32,
    }));
    await vi.waitFor(() => expect(transport.pendingToolInvocations).toHaveLength(2));

    const destroyScope = vi.spyOn(capabilities, "destroyScope");
    expect(tentacle.revoke({ owner: "alice", viewer: "bob", objectId: bobShare.objectId, by: "alice" })).toBe(true);
    expect(destroyScope).toHaveBeenCalledWith(tentacleShareResourceId("bob", bobShare.objectId));
    expect(destroyScope).not.toHaveBeenCalledWith(tentacleShareResourceId("carol", carolShare.objectId));

    await transport.releaseToolResult("carol", 32);
    await carolCall;
    await transport.releaseToolResult("bob", 31);
    await bobCall;

    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "carol",
      message: expect.objectContaining({ op: "tool.result", args: expect.objectContaining({ requestSeq: 32 }) }),
    }));
    expect(transport.sent).not.toContainEqual(expect.objectContaining({
      username: "bob",
      message: expect.objectContaining({ op: "tool.result", args: expect.objectContaining({ requestSeq: 31 }) }),
    }));
    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "bob",
      message: expect.objectContaining({ op: "gate.refused", objectId: bobShare.objectId }),
    }));
  });

  it("returns a Gate refusal when the granted owner device goes offline", async () => {
    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      objectId: "catalog-offline",
      op: "tool.catalog",
      args: { schemas: [TOOL] },
      seq: 20,
    }));
    const share = tentacle.share({
      owner: "alice",
      viewer: "bob",
      device: "dsh:alice",
      kind: "tool",
      resourceKey: "bash",
      createdBy: "alice",
    });
    transport.online.set("alice", []);

    await transport.emit({ username: "bob", device: "dsh:bob" }, message({
      objectId: share.objectId,
      op: "tool.invoke",
      args: { name: "bash", arguments: { command: "printf unavailable" } },
      seq: 21,
    }));

    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "bob",
      message: expect.objectContaining({
        op: "gate.refused",
        objectId: share.objectId,
        args: expect.objectContaining({ requestFrom: "bob", requestSeq: 21 }),
      }),
    }));
  });

  it("stops an active projection on revoke and never forwards the later event", async () => {
    const share = tentacle.share({
      owner: "alice",
      viewer: "bob",
      device: "dsh:alice",
      kind: "projection",
      resourceKey: "session-a",
      createdBy: "alice",
    });
    const open = message({
      fromUser: "alice",
      toUser: "bob",
      objectId: share.objectId,
      op: "projection.open",
      args: { sourceSessionId: "session-a", cwd: "/private" },
      seq: 4,
    });
    await transport.emit({ username: "alice", device: "dsh:alice" }, open);
    await transport.emit({ username: "alice", device: "dsh:alice" }, open);
    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "bob",
      message: expect.objectContaining({ op: "projection.open", args: { sourceSessionId: "session-a" } }),
    }));
    expect(transport.sent.filter((frame) => frame.username === "bob" && frame.message.op === "projection.open")).toHaveLength(1);
    tentacle.revoke({ owner: "alice", viewer: "bob", objectId: share.objectId, by: "alice" });
    expect(transport.sent).toContainEqual(expect.objectContaining({
      username: "bob",
      message: expect.objectContaining({ op: "projection.stop", objectId: share.objectId }),
    }));
    const projectionsBefore = transport.sent.filter((frame) => frame.username === "bob" && frame.message.op === "projection.event").length;
    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      toUser: "bob",
      objectId: share.objectId,
      op: "projection.event",
      args: {
        sourceSessionId: "session-a",
        event: { type: "assistant/message", seq: 1, data: { text: "must not cross" } },
      },
      seq: 5,
    }));
    expect(transport.sent.filter((frame) => frame.username === "bob" && frame.message.op === "projection.event")).toHaveLength(projectionsBefore);
  });

  it("fans a projection out to the effective object grants and ignores the wire toUser", async () => {
    const bobShare = tentacle.share({
      owner: "alice",
      viewer: "bob",
      device: "dsh:alice",
      kind: "projection",
      resourceKey: "session-fanout",
      createdBy: "alice",
    });
    const carolShare = tentacle.share({
      owner: "alice",
      viewer: "carol",
      device: "dsh:alice",
      kind: "projection",
      resourceKey: "session-fanout",
      createdBy: "alice",
    });
    expect(carolShare.objectId).toBe(bobShare.objectId);

    await transport.emit({ username: "alice", device: "dsh:alice" }, message({
      fromUser: "alice",
      toUser: "ungranted-wire-target",
      objectId: bobShare.objectId,
      op: "projection.open",
      args: { sourceSessionId: "session-fanout", cwd: "/private" },
      seq: 40,
    }));

    for (const viewer of ["bob", "carol"]) {
      expect(transport.sent).toContainEqual(expect.objectContaining({
        username: viewer,
        message: expect.objectContaining({
          toUser: viewer,
          op: "projection.open",
          objectId: bobShare.objectId,
          args: { sourceSessionId: "session-fanout" },
        }),
      }));
    }
    expect(transport.sent.some((frame) => frame.username === "ungranted-wire-target")).toBe(false);
  });
});
