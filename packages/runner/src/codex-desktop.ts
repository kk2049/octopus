/** Codex Desktop's local follower protocol. The GUI remains the only thread writer. */
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexAppServerTurnResult } from "./codex-app-server.js";
import { inputNotSent } from "./input-handoff.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as ObjectValue : {};
const versions: Record<string, number> = {
  initialize: 0, "thread-owner-discovery": 1, "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1, "thread-follower-interrupt-turn": 4,
};
// State broadcasts have their own version, independent of the request methods.
// v13's consumed fields/control methods were checked against macOS build 27194;
// see doc/worklogs/2026-11-15-codex-desktop-protocol.md for the evidence boundary.
const streamVersions = [11, 13];
class CodexDesktopProtocolError extends Error {
  readonly code = "codex_gui_protocol_unsupported";
  constructor(received: unknown, inputSubmitted: boolean) {
    super(`当前 Runner 不支持此 Codex 桌面端的会话协议：收到版本 ${String(received)}，支持版本 ${streamVersions.join("、")}。`
      + (inputSubmitted ? "消息可能已发送，请核对回执，不要重复发送。" : "消息尚未发送，请更新兼容的 Runner。"));
  }
}
const MAX_FRAME = 16 * 1024 * 1024;
interface Turn { turnId?: string; status?: string; error?: unknown }

export class CodexDesktopSession {
  private clientId = "initializing-client";
  private owner = "";
  private buffer: Buffer = Buffer.alloc(0);
  private revision = 0;
  private readonly pending = new Map<string, { resolve: (m: ObjectValue) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }>();
  private readonly turns = new Map<string, Turn>();
  private snapshotReady?: { resolve: () => void; reject: (e: Error) => void };
  private active?: { id: string; completion: Promise<CodexAppServerTurnResult>; resolve: (r: CodexAppServerTurnResult) => void; timer?: NodeJS.Timeout };
  private closed = false;
  private failure?: Error;
  private inputSubmitted = false;

  private constructor(private readonly socket: Socket, readonly sessionId: string, private readonly timeoutMs: number) {
    socket.on("data", chunk => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const size = this.buffer.readUInt32LE(0);
          if (size > MAX_FRAME) throw new Error("Codex GUI IPC frame exceeds limit");
          if (this.buffer.length < size + 4) break;
          const message = object(JSON.parse(this.buffer.subarray(4, size + 4).toString("utf8")));
          this.buffer = this.buffer.subarray(size + 4);
          this.receive(message);
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on("error", error => this.fail(error));
    socket.on("close", () => this.fail(new Error("Codex GUI connection closed; input is not retried")));
  }

  /** Absence is the only fallback. A live incompatible/ambiguous GUI fails closed. */
  static async connect(sessionId: string, options: { codexHome?: string; timeoutMs: number }): Promise<CodexDesktopSession | null> {
    if (process.platform === "win32") return null;
    const directory = join(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "ipc");
    const endpoint = join(directory, "ipc.sock");
    try {
      const [dir, file] = await Promise.all([lstat(directory), lstat(endpoint)]);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o022)
        || !file.isSocket() || file.uid !== process.getuid?.() || (file.mode & 0o022)) {
        throw new Error("Codex GUI socket is not private to this user");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const socket = connect(endpoint);
    const client = new CodexDesktopSession(socket, sessionId, options.timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Codex GUI connect timeout")), 5000);
        socket.once("connect", () => { clearTimeout(timer); resolve(); });
        socket.once("error", error => { clearTimeout(timer); reject(error); });
      });
      const initialized = await client.request("initialize", { clientType: "octopus" });
      const id = object(initialized.result).clientId;
      if (typeof id !== "string" || !id) throw new Error("Invalid Codex GUI initialization");
      client.clientId = id;
      const owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: sessionId }, true);
      if (owner.resultType === "error" && owner.error === "no-client-found") { await client.close(); return null; }
      if (owner.resultType !== "success" || typeof owner.handledByClientId !== "string") throw new Error("Codex GUI owner discovery failed: " + String(owner.error));
      client.owner = owner.handledByClientId;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Codex GUI snapshot timeout")), 5000);
        client.snapshotReady = { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
        client.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
          targetClientIds: [client.owner], params: { hostId: "local", conversationId: sessionId, following: true } });
      });
      return client;
    } catch (error) {
      await client.close();
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") return null;
      // Only connection preparation proves that dispatch has not run. The
      // same receive/fail path also handles errors after an input was sent.
      if (error instanceof CodexDesktopProtocolError) throw inputNotSent(error);
      throw error;
    }
  }

  get turnActive(): boolean { return Boolean(this.active); }

  async dispatch(prompt: string) {
    if (this.closed) throw new Error("Codex GUI follower is closed");
    const current = [...this.turns.values()].find(turn => turn.status === "inProgress");
    const kind = current ? "steered" as const : "started" as const;
    if (current && !current.turnId) throw inputNotSent(new Error("Codex GUI is still starting its turn; input was not sent"));
    const input = [{ type: "text", text: prompt, text_elements: [] }];
    this.inputSubmitted = true;
    const response = await this.request(current ? "thread-follower-steer-turn" : "thread-follower-start-turn", current
      ? { conversationId: this.sessionId, input }
      : { conversationId: this.sessionId, turnStart: {
        request: { threadId: this.sessionId, input },
        context: { inheritThreadSettings: true, localTurnMetadata: { fileAttachmentCount: 0 }, attachments: [], commentAttachments: [] },
      } });
    const result = object(object(response.result).result);
    const turnId = object(result.turn).id ?? result.turnId ?? current?.turnId;
    if (typeof turnId !== "string" || !turnId) throw new Error("Codex GUI accepted input without a turn id; input is not retried");
    // An acknowledgement and a broken state update can arrive in one frame
    // batch, before this continuation runs. Retain acceptance without leaving
    // a newly created completion pending on an already closed connection.
    if (this.failure) return { kind, turnId, completion: Promise.resolve({ started: true, ok: false, error: this.failure.message }) };
    if (!this.active) {
      let resolve!: (r: CodexAppServerTurnResult) => void;
      const completion = new Promise<CodexAppServerTurnResult>(done => { resolve = done; });
      this.active = { id: turnId, completion, resolve };
      if (this.timeoutMs > 0) this.active.timer = setTimeout(() => {
        void this.interrupt().catch(() => {}).finally(() => this.fail(new Error("Codex GUI turn timed out")));
      }, this.timeoutMs);
    }
    const completion = this.active.completion;
    this.settle();
    return { kind, turnId, completion };
  }

  async steer(prompt: string): Promise<boolean> {
    if (!this.active) return false;
    const current = [...this.turns.values()].find(turn => turn.turnId === this.active!.id);
    if (current?.status !== "inProgress") return false;
    return (await this.dispatch(prompt)).kind === "steered";
  }

  async interrupt(): Promise<void> {
    const turnId = this.active?.id;
    if (!turnId) return;
    await this.request("thread-follower-interrupt-turn", { conversationId: this.sessionId, mode: "user-stop", expectedTurnId: turnId });
  }

  /** Closing a follower never kills the GUI or removes its writer lock. */
  async close(): Promise<void> { this.fail(new Error("Codex GUI follower detached")); }

  private send(message: ObjectValue): void {
    if (this.closed) throw new Error("Codex GUI follower is closed");
    const body = Buffer.from(JSON.stringify({ sourceClientId: this.clientId, ...message }));
    if (body.length > MAX_FRAME) throw new Error("Codex GUI input exceeds frame limit");
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  private request(method: string, params: ObjectValue, allowError = false): Promise<ObjectValue> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("Codex GUI " + method + " timed out; input is not retried")); }, 5000);
      this.pending.set(requestId, { timer, method, reject, resolve: response => {
        if (!allowError && response.resultType !== "success") reject(new Error("Codex GUI " + method + ": " + String(response.error)));
        else resolve(response);
      } });
      try { this.send({ type: "request", requestId, method, params, version: versions[method], timeoutMs: 4500,
        ...(this.owner ? { targetClientId: this.owner } : {}) }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  private receive(message: ObjectValue): void {
    if (message.type === "response") {
      const pending = this.pending.get(String(message.requestId));
      if (!pending) return;
      if (message.resultType === "success" && (message.method !== pending.method || (this.owner && message.handledByClientId !== this.owner))) {
        throw new Error("Codex GUI response identity mismatch");
      }
      clearTimeout(pending.timer); this.pending.delete(String(message.requestId)); pending.resolve(message);
      return;
    }
    if (message.type === "client-discovery-request") {
      this.send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }); return;
    }
    if (message.type !== "broadcast" || message.sourceClientId !== this.owner) return;
    if (message.method === "client-status-changed" && object(message.params).status === "disconnected") throw new Error("Codex GUI owner disconnected");
    if (message.method !== "thread-stream-state-changed") return;
    const params = object(message.params);
    if (params.conversationId !== this.sessionId || params.hostId !== "local") return;
    if (typeof message.version !== "number" || !streamVersions.includes(message.version)) {
      throw new CodexDesktopProtocolError(message.version, this.inputSubmitted);
    }
    const change = object(params.change);
    if (typeof change.revision !== "number") throw new Error("Missing Codex GUI stream revision");
    if (change.type === "snapshot") {
      const state = object(change.conversationState);
      if (state.id !== this.sessionId) throw new Error("Codex GUI snapshot identity mismatch");
      this.turns.clear();
      const canonical = object(object(state.turnHistory).history).entitiesByKey;
      if (canonical && typeof canonical === "object") {
        for (const [key, value] of Object.entries(object(canonical))) this.turns.set(key, this.turn(value));
      } else if (Array.isArray(state.turns)) {
        state.turns.forEach((turn, index) => this.turns.set(String(index), this.turn(turn)));
      } else throw new Error("Unsupported Codex GUI turn state");
      this.snapshotReady?.resolve(); this.snapshotReady = undefined;
    } else if (change.type === "patches" && Array.isArray(change.patches)) {
      if (change.baseRevision !== this.revision) throw new Error("Codex GUI stream revision gap");
      // Retain only identity/lifecycle. Never apply arbitrary GUI patches to an
      // object graph or evaluate/copy its transcript and tool payloads.
      for (const value of change.patches) {
        const patch = object(value);
        const path = patch.path;
        if (!Array.isArray(path)) continue;
        const offset = path[0] === "turns" ? 1 : path[0] === "turnHistory" && path[1] === "history" && path[2] === "entitiesByKey" ? 3 : -1;
        if (offset < 0 || path.length <= offset) continue;
        const key = String(path[offset]);
        if (path.length === offset + 1) {
          if (patch.op === "remove") this.turns.delete(key); else this.turns.set(key, this.turn(patch.value));
        } else if (path.length === offset + 2 && ["turnId", "status", "error"].includes(String(path[offset + 1]))) {
          const turn = this.turns.get(key) ?? {};
          Object.assign(turn, { [String(path[offset + 1])]: patch.value }); this.turns.set(key, turn);
        }
      }
    } else throw new Error("Unsupported Codex GUI stream change");
    this.revision = change.revision;
    this.settle();
  }

  private turn(value: unknown): Turn {
    const row = object(value);
    return { ...(typeof row.turnId === "string" ? { turnId: row.turnId } : {}),
      ...(typeof row.status === "string" ? { status: row.status } : {}), error: row.error };
  }

  private settle(): void {
    if (!this.active) return;
    const turn = [...this.turns.values()].find(turn => turn.turnId === this.active!.id);
    if (!turn || !["completed", "interrupted", "failed"].includes(turn.status ?? "")) return;
    clearTimeout(this.active.timer);
    this.active.resolve({ started: true, ok: turn.status === "completed", status: turn.status,
      ...(turn.error ? { error: String(object(turn.error).message ?? turn.error) } : {}) });
    this.active = undefined;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.snapshotReady?.reject(error); this.snapshotReady = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); clearTimeout(this.active?.timer);
    this.active?.resolve({ started: true, ok: false, error: error.message }); this.active = undefined;
    this.socket.destroy();
  }
}
