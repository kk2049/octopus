import { randomInt } from "node:crypto";
import type { RunnerTentacleTransport, TentaclePeer } from "../runner/gateway.js";
import {
  TENTACLE_HEAD_USER,
  TENTACLE_PROTOCOL_VERSION,
  parseTentacleMessage,
  type JsonObject,
  type TentacleWireMessage,
} from "./protocol.js";

interface Route {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ExpectedReply {
  promise: Promise<HeldReply>;
  resolve: (reply: HeldReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface HeldReply {
  key: string;
  peer: TentaclePeer;
  message: TentacleWireMessage;
}

export interface BrokerToolResult {
  replyKey: string;
  message: TentacleWireMessage;
}

type ApplicationHandler = (peer: TentaclePeer, message: TentacleWireMessage) => void | Promise<void>;

const DELIVERY_TIMEOUT_MS = 190_000;
/** A fresh Head process must not reuse control-frame ids still cached by live dsh peers. */
const SEQUENCE_EPOCH_LIMIT = 2 ** 48;
const EARLY_REPLY_LIMIT = 128;
const COMPLETED_INBOUND_LIMIT = 4_096;

function routeKey(target: TentaclePeer, fromUser: string, seq: number): string {
  return `${target.username}\0${target.device}\0${fromUser}\0${seq}`;
}

function requestKey(target: TentaclePeer, requestFrom: string, requestSeq: number, objectId: string): string {
  return `${target.username}\0${target.device}\0${requestFrom}\0${requestSeq}\0${objectId}`;
}

function inboundKey(peer: TentaclePeer, seq: number): string {
  return `${peer.username}\0${peer.device}\0${seq}`;
}

/** Reliable, identity-bound routing over the Runner Gateway's dsh subprotocol. */
export class TentacleBroker {
  private readonly routes = new Map<string, Route>();
  private readonly expected = new Map<string, ExpectedReply>();
  private readonly early = new Map<string, HeldReply>();
  private readonly held = new Map<string, HeldReply>();
  /** Source replay suppression; the target still keeps its own durable-view dedupe across restarts. */
  private readonly completedInbound = new Set<string>();
  private handler: ApplicationHandler | null = null;
  private readonly detach: () => void;
  private headSeq = randomInt(1, SEQUENCE_EPOCH_LIMIT);
  private closed = false;

  constructor(private readonly transport: RunnerTentacleTransport) {
    this.detach = transport.onMessage((peer, raw) => this.receive(peer, raw));
  }

  onApplication(handler: ApplicationHandler): void {
    if (this.handler) throw new Error("tentacle application handler already installed");
    this.handler = handler;
  }

  devices(username: string): string[] {
    return this.transport.listDevices(username);
  }

  onlyDevice(username: string): string | null {
    const devices = this.devices(username);
    return devices.length === 1 ? devices[0] : null;
  }

  disconnect(username: string, device: string): boolean {
    return this.transport.disconnect(username, device);
  }

  disconnectCredential(username: string, tokenHash: string): number {
    return this.transport.disconnectCredential(username, tokenHash);
  }

  async forward(source: TentaclePeer, target: TentaclePeer, message: TentacleWireMessage): Promise<void> {
    const key = routeKey(target, message.fromUser, message.seq);
    const existing = this.routes.get(key);
    if (existing) return await existing.promise;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => {
      this.routes.delete(key);
      reject(new Error(`tentacle delivery timed out for ${message.objectId}`));
    }, DELIVERY_TIMEOUT_MS);
    this.routes.set(key, { promise, resolve, reject, timer });
    if (!this.transport.send(target.username, target.device, message)) {
      clearTimeout(timer);
      this.routes.delete(key);
      throw new Error(`tentacle target ${target.username}/${target.device} is offline`);
    }
    // Source is deliberately not stored: the application handler owns its
    // inbound acknowledgement and sends it only after this Promise resolves.
    void source;
    return await promise;
  }

  async invokeTool(o: {
    source: TentaclePeer;
    target: TentaclePeer;
    objectId: string;
    sourceSeq: number;
    tool: string;
    args: JsonObject;
  }): Promise<BrokerToolResult> {
    const key = requestKey(o.target, o.source.username, o.sourceSeq, o.objectId);
    let reply = this.early.get(key);
    if (reply) this.early.delete(key);
    let expected: ExpectedReply | null = null;
    if (!reply) {
      let resolve!: (value: HeldReply) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<HeldReply>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const timer = setTimeout(() => {
        this.expected.delete(key);
        reject(new Error(`remote dsh tool timed out for ${o.objectId}`));
      }, DELIVERY_TIMEOUT_MS);
      expected = { promise, resolve, reject, timer };
      this.expected.set(key, expected);
    }

    const invocation: TentacleWireMessage = {
      version: TENTACLE_PROTOCOL_VERSION,
      fromUser: o.source.username,
      toUser: o.target.username,
      objectId: o.objectId,
      op: "tool.invoke",
      args: {
        name: o.tool,
        arguments: o.args,
        requestFrom: o.source.username,
        requestSeq: o.sourceSeq,
      },
      seq: o.sourceSeq,
    };
    const delivered = this.forward(o.source, o.target, invocation);
    if (reply) {
      await delivered;
    } else {
      const waiting = expected!;
      try {
        // Observe both branches immediately. The target may fail to ACK at
        // the same moment its tool-result wait expires (or broker.close may
        // reject both); awaiting them serially leaves the second rejection
        // unhandled after the first one has already unwound the request.
        const [received] = await Promise.all([waiting.promise, delivered]);
        reply = received;
      } finally {
        // A synchronous/offline delivery failure has no reply to wait for.
        // Retire that timer now instead of retaining a dead request for the
        // full remote-tool timeout.
        if (this.expected.get(key) === waiting) {
          clearTimeout(waiting.timer);
          this.expected.delete(key);
        }
      }
    }
    return { replyKey: reply.key, message: reply.message };
  }

  /** Route the target's original result, then release its durable client outbox. */
  async routeToolReply(replyKey: string, caller: TentaclePeer): Promise<void> {
    const held = this.held.get(replyKey);
    if (!held) throw new Error("tentacle tool reply is no longer held");
    await this.forward(held.peer, caller, { ...held.message, toUser: caller.username });
    this.ackInbound(held.peer, held.message);
    this.markCompleted(inboundKey(held.peer, held.message.seq));
    this.held.delete(replyKey);
  }

  /** A Gate/revocation refused disclosure after the target answered. */
  discardToolReply(replyKey: string): void {
    const held = this.held.get(replyKey);
    if (!held) return;
    this.ackInbound(held.peer, held.message);
    this.markCompleted(inboundKey(held.peer, held.message.seq));
    this.held.delete(replyKey);
  }

  sendControl(to: TentaclePeer, objectId: string, op: "projection.stop" | "gate.refused", args: JsonObject): boolean {
    return this.transport.send(to.username, to.device, {
      version: TENTACLE_PROTOCOL_VERSION,
      fromUser: TENTACLE_HEAD_USER,
      toUser: to.username,
      objectId,
      op,
      args,
      seq: this.headSeq++,
    } satisfies TentacleWireMessage);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    for (const route of this.routes.values()) {
      clearTimeout(route.timer);
      route.reject(new Error("tentacle broker closed"));
    }
    for (const reply of this.expected.values()) {
      clearTimeout(reply.timer);
      reply.reject(new Error("tentacle broker closed"));
    }
    this.routes.clear();
    this.expected.clear();
    this.early.clear();
    this.held.clear();
    this.completedInbound.clear();
  }

  private async receive(peer: TentaclePeer, raw: unknown): Promise<void> {
    const parsed = parseTentacleMessage(raw);
    // The authenticated connection is the only source of identity.
    const message = { ...parsed, fromUser: peer.username };
    if (message.op === "delivery.ack") {
      this.receiveAck(peer, message);
      return;
    }
    if (message.seq === 0) throw new Error("tentacle application seq must be positive");
    const key = inboundKey(peer, message.seq);
    if (this.completedInbound.has(key)) {
      this.ackInbound(peer, message);
      return;
    }
    if (message.op === "tool.result") {
      this.receiveToolResult(peer, message);
      return;
    }
    if (!this.handler) throw new Error("tentacle application handler is unavailable");
    await this.handler(peer, message);
    this.markCompleted(key);
    this.ackInbound(peer, message);
  }

  private receiveAck(peer: TentaclePeer, message: TentacleWireMessage): void {
    const fromUser = message.args.fromUser;
    const seq = message.args.seq;
    if (typeof fromUser !== "string" || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
      throw new Error("invalid tentacle delivery acknowledgement");
    }
    // Best-effort head controls have no source outbox and need no route entry.
    if (fromUser === TENTACLE_HEAD_USER) return;
    const key = routeKey(peer, fromUser, seq);
    const route = this.routes.get(key);
    // A target may produce its ACK just as the delivery timer expires or after
    // a reconnect has already retired the in-memory route. It is an idempotent
    // confirmation, not an application request; an absent route has nothing
    // left to release and must not tear down an otherwise healthy peer.
    if (!route) return;
    clearTimeout(route.timer);
    this.routes.delete(key);
    route.resolve();
  }

  private receiveToolResult(peer: TentaclePeer, message: TentacleWireMessage): void {
    const requestFrom = message.args.requestFrom;
    const requestSeq = message.args.requestSeq;
    if (typeof requestFrom !== "string" || typeof requestSeq !== "number" || !Number.isSafeInteger(requestSeq)) {
      throw new Error("tool.result is missing its trusted request correlation");
    }
    const key = requestKey(peer, requestFrom, requestSeq, message.objectId);
    const replyKey = routeKey(peer, peer.username, message.seq);
    if (this.held.has(replyKey)) return;
    const held: HeldReply = { key: replyKey, peer, message };
    this.held.set(replyKey, held);
    const waiting = this.expected.get(key);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.expected.delete(key);
      waiting.resolve(held);
      return;
    }
    if (this.early.size >= EARLY_REPLY_LIMIT) throw new Error("too many unmatched tentacle tool replies");
    this.early.set(key, held);
  }

  private ackInbound(peer: TentaclePeer, message: TentacleWireMessage): void {
    if (!this.transport.send(peer.username, peer.device, {
      version: TENTACLE_PROTOCOL_VERSION,
      fromUser: TENTACLE_HEAD_USER,
      toUser: peer.username,
      objectId: message.objectId,
      op: "delivery.ack",
      args: { seq: message.seq },
      seq: this.headSeq++,
    } satisfies TentacleWireMessage)) {
      throw new Error("tentacle source disconnected before acknowledgement");
    }
  }

  private markCompleted(key: string): void {
    this.completedInbound.add(key);
    if (this.completedInbound.size <= COMPLETED_INBOUND_LIMIT) return;
    const oldest = this.completedInbound.values().next().value as string | undefined;
    if (oldest) this.completedInbound.delete(oldest);
  }
}
