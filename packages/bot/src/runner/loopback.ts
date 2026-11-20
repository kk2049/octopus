/**
 * Capability loopback — the transport that lets an MCP subprocess reach the
 * capability service without ever holding a Context, a username or a device.
 *
 * The wire shape IS the kernel's untrusted API:
 *
 *     POST /rpc   x-internal-token: <per-grant token>
 *     { "slot": "runner", "operation": "read_file", "args": { … } }
 *
 * The token resolves, server-side, to exactly one bound facade. There is no
 * `user` field: the previous version accepted one and cross-checked it against
 * the grant, which is the pattern the kernel spec forbids outright
 * ("身份根本不应从这些字段进入"). Any body carrying a security claim is
 * rejected at the schema, not reconciled.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { BoundCapabilities } from "@claude-bot/capability-kernel";
import { createLogger } from "../logger.js";
import { parseUnavailable, type ResourceRecoveryService } from "../resources/recovery.js";

const log = createLogger("capability-loopback");

/** Grants outlive one investigation turn, not a login. */
export const LOOPBACK_GRANT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Fields that would let a caller state who it is. Present = reject. */
const FORBIDDEN_BODY_KEYS = new Set([
  "user",
  "username",
  "userId",
  "user_id",
  "appId",
  "app_id",
  "controllerId",
  "contextId",
  "context",
  "principal",
  "role",
  "admin",
  "approved",
  "approval",
  "onBehalfOf",
]);

interface Grant {
  capabilities: BoundCapabilities;
  expiresAt: number;
  label: string;
  /** Runs when the credential dies, so its Context dies with it. Once. */
  onExpire?: () => void;
  released?: boolean;
}

export interface LoopbackGrantKeepalive {
  /** Stop renewing the credential. It still expires at its current deadline. */
  stop(): void;
}

export interface CapabilityLoopbackOptions {
  /**
   * Where an unavailable answer becomes a promise (resources/recovery.ts):
   * the grant's label is the agent scope, so this door is the one place that
   * knows both who asked and which resource was away.
   */
  recovery?: Pick<ResourceRecoveryService, "note">;
}

export class CapabilityLoopback {
  private http: Server | null = null;
  private boundPort = 0;
  private grants = new Map<string, Grant>();

  constructor(private readonly opts: CapabilityLoopbackOptions = {}) {}

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  /** Test/diagnostics: how many grants are currently live. */
  get liveGrants(): number {
    this.prune();
    return this.grants.size;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => sendJson(res, 500, { ok: false, error: (err as Error).message }));
      });
      this.http = server;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : 0;
        log.info(`Capability loopback ready on ${this.url}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const g of this.grants.values()) this.release(g);
    this.grants.clear();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = null;
  }

  /**
   * Mint a transport credential for one bound facade. The token carries no
   * claims of its own — it is an index into this table, exactly like a slot
   * is an index into a Context.
   */
  mint(
    capabilities: BoundCapabilities,
    label: string,
    ttlMs = LOOPBACK_GRANT_TTL_MS,
    onExpire?: () => void,
  ): string {
    this.prune();
    const token = randomBytes(24).toString("hex");
    this.grants.set(token, { capabilities, label, expiresAt: Date.now() + ttlMs, onExpire });
    return token;
  }

  /**
   * Keep one already-minted credential alive while its trusted owner is alive.
   *
   * Dev-ticket turns have no wall-clock limit: progress, rather than age, is
   * their liveness signal. Their machine credential therefore cannot use the
   * two-hour orphan backstop as an absolute turn limit. The composition that
   * owns the turn starts this keepalive and stops it during the same cleanup
   * that revokes the token. If that cleanup or the whole process disappears,
   * renewal disappears too and the ordinary bounded TTL still fails closed.
   */
  keepAlive(token: string, ttlMs = LOOPBACK_GRANT_TTL_MS): LoopbackGrantKeepalive {
    const intervalMs = Math.max(1, Math.floor(ttlMs / 2));
    let stopped = false;
    const timer = setInterval(() => {
      if (!this.renew(token, ttlMs)) stop();
    }, intervalMs);
    timer.unref();
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    };
    return { stop };
  }

  /** Trusted in-process renewal; an expired or revoked credential stays dead. */
  private renew(token: string, ttlMs: number): boolean {
    const grant = this.grants.get(token);
    if (!grant || grant.expiresAt <= Date.now()) {
      if (grant) {
        this.grants.delete(token);
        this.release(grant);
      }
      return false;
    }
    grant.expiresAt = Date.now() + ttlMs;
    return true;
  }

  revoke(token: string): void {
    const g = this.grants.get(token);
    if (!g) return;
    this.grants.delete(token);
    this.release(g);
  }

  /**
   * Run a grant's teardown at most once. Expiry can be noticed three ways —
   * by a request, by the sweep, or by stop() — and a Context released twice
   * is a Context that could be destroyed after being legitimately reused.
   */
  private release(g: Grant): void {
    if (g.released) return;
    g.released = true;
    try {
      g.onExpire?.();
    } catch {
      // teardown must not break whatever noticed the expiry
    }
  }

  /**
   * Expired credentials take their Contexts with them. Without this the
   * Contexts minted for every chat session and every investigation turn would
   * accumulate for the life of the process — a leak, and a set of live
   * authorities nobody is holding.
   */
  private prune(): void {
    const now = Date.now();
    for (const [t, g] of this.grants) {
      if (g.expiresAt <= now) {
        this.grants.delete(t);
        this.release(g);
      }
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = req.url === "/rpc" ? "rpc" : req.url === "/result" ? "result" : null;
    if (req.method !== "POST" || !route) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    const presented = req.headers["x-internal-token"];
    const grant = typeof presented === "string" ? this.grants.get(presented) : undefined;
    if (!grant || grant.expiresAt <= Date.now()) {
      if (grant) {
        this.grants.delete(presented as string);
        this.release(grant);
      }
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      const buf = c as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        sendJson(res, 413, { ok: false, error: "body too large" });
        return;
      }
      chunks.push(buf);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid json" });
      return;
    }
    for (const key of Object.keys(body)) {
      if (FORBIDDEN_BODY_KEYS.has(key)) {
        log.warn({ label: grant.label, key }, "Loopback body carried a security claim; rejected");
        sendJson(res, 400, { ok: false, error: `field "${key}" is not accepted — identity comes from the channel` });
        return;
      }
    }
    if (route === "result") {
      // The id is a lookup key, not a credential: the Context comes from the
      // token's binding, so an id overheard from another grant reads nothing.
      const pendingId = typeof body.pending_call_id === "string" ? body.pending_call_id : "";
      if (!pendingId) {
        sendJson(res, 400, { ok: false, error: "pending_call_id required" });
        return;
      }
      const view = grant.capabilities.result(pendingId);
      if (!view) {
        sendJson(res, 404, { ok: false, error: "没有这条待批准记录(不是你发起的,或已过保留期)" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        state: view.state,
        outcome: view.outcome,
        result: view.result,
        // The Object's declaration, so an `unknown` stops meaning two different
        // things to the caller. Without it "we could not determine the outcome"
        // has to be read as "never ask again", which is right for `exec` and
        // needlessly dead-ends a `read_file` the owner would happily re-approve.
        retry_safe: view.retrySafe,
        error: view.reason ?? undefined,
      });
      return;
    }

    const slot = typeof body.slot === "string" && body.slot ? body.slot : "runner";
    const operation = typeof body.operation === "string" ? body.operation : "";
    if (!operation) {
      sendJson(res, 400, { ok: false, error: "operation required" });
      return;
    }
    const args = (body.args ?? {}) as Record<string, unknown>;

    const out = await grant.capabilities.request(slot, operation, args);
    switch (out.status) {
      case "succeeded":
        sendJson(res, 200, { ok: true, result: out.result });
        return;
      case "approval_required":
        // NOT "try again after they approve". Re-issuing an identical call
        // while this one is undecided merely joins it, but re-issuing after it
        // RAN creates a second card for the same command — and approving that
        // is a second side effect. Point at the read path instead.
        sendJson(res, 202, {
          ok: false,
          approval_required: true,
          pending_call_id: out.pendingCallId,
          result_url: "/result",
          how_to_check: `POST /result {"pending_call_id":"${out.pendingCallId}"}`,
          error:
            `「${operation}」需要设备主人在可信面板(/pending)上批准。已提交待批准 ${out.pendingCallId}；` +
            "请如实告诉用户去批准,然后用查询结果的方式取回执行结果 —— 不要再次发起这个操作。",
        });
        return;
      case "denied":
        sendJson(res, 403, { ok: false, error: out.reason });
        return;
      case "unknown":
        sendJson(res, 504, { ok: false, error: `结果未知(不要自动重试): ${out.reason}` });
        return;
      default: {
        // An away resource is not a broken call. Record that THIS scope is
        // waiting for THAT resource; the text already tells the agent so.
        const unavailable = parseUnavailable(out.reason);
        if (unavailable) {
          this.opts.recovery?.note(grant.label, unavailable.resource, unavailable.detail);
          sendJson(res, 503, { ok: false, error: out.reason, resource_unavailable: unavailable.resource });
          return;
        }
        sendJson(res, 502, { ok: false, error: out.reason });
      }
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
