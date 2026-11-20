/**
 * A deliberately small request/reply layer over Node's inherited IPC channel.
 *
 * Node owns framing, back-pressure and descriptor inheritance. This class only
 * supplies the pieces two supervised services need in common: a ready
 * handshake, correlated replies, bounded frames, request timeouts and a
 * graceful stop that escalates to signals. It never opens a socket and it has
 * no bearer token because the child descriptor itself is the channel binding.
 *
 * The frame bound is a window, not a size limit on what a call may carry: a
 * request or response larger than one frame is sent as ordered `part` frames
 * and reassembled (see `wireFrames`). A single frame over the bound is still a
 * protocol violation and stops the child.
 */

import { fork, type ChildProcess } from "node:child_process";
import {
  CHILD_RPC_VERSION,
  isWireMessage,
  PartAssembler,
  wireFrames,
  type RpcWireMessage,
} from "./protocol.js";

export interface ChildRpcLaunch {
  modulePath: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  /**
   * Ceiling on one IPC frame in either direction. Larger requests and
   * responses travel as several `part` frames; the bound is a window, not a
   * ceiling on the value carried.
   */
  maxMessageBytes?: number;
  maxPending?: number;
  onDiagnostic?: (stream: "stdout" | "stderr", line: string) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_READY_MS = 10_000;
const DEFAULT_REQUEST_MS = 20_000;
const DEFAULT_STOP_MS = 5_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 128;

export class ChildRpcError extends Error {
  constructor(message: string, readonly code = "child_rpc_error") {
    super(message);
    this.name = "ChildRpcError";
  }
}

export class ChildRpcClient {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private parts = new PartAssembler();
  private nextId = 1;
  private ready = false;
  private stopping = false;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly launch: ChildRpcLaunch) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isReady(): boolean {
    return this.ready && Boolean(this.child?.connected);
  }

  async start(): Promise<void> {
    if (this.isReady) return;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startOnce().finally(() => {
      this.startPromise = null;
    });
    return await this.startPromise;
  }

  private async startOnce(): Promise<void> {
    if (this.child) throw new ChildRpcError("child RPC process is already starting");
    this.stopping = false;
    const child = fork(this.launch.modulePath, [...(this.launch.args ?? [])], {
      cwd: this.launch.cwd,
      env: this.launch.env,
      execArgv: [...(this.launch.execArgv ?? [])],
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;

    const diagnostics = (stream: "stdout" | "stderr", chunk: unknown): void => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) this.launch.onDiagnostic?.(stream, line.slice(0, 4000));
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => diagnostics("stdout", chunk));
    child.stderr?.on("data", (chunk) => diagnostics("stderr", chunk));
    const ignorePipeError = (): void => {};
    child.stdout?.on("error", ignorePipeError);
    child.stderr?.on("error", ignorePipeError);
    child.stdin?.on("error", ignorePipeError);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new ChildRpcError(`child did not become ready within ${this.launch.readyTimeoutMs ?? DEFAULT_READY_MS}ms`, "child_not_ready")),
        this.launch.readyTimeoutMs ?? DEFAULT_READY_MS,
      );
      timer.unref?.();

      let violated = false;
      child.on("message", (message) => {
        // After one violation nothing else from this child is interpreted: a
        // later, smaller frame could otherwise complete a transfer whose
        // earlier parts were discarded.
        if (violated) return;
        if (!this.messageWithinLimit(message)) {
          violated = true;
          finish(new ChildRpcError("child sent an oversized message", "child_oversized_message"));
          void this.forceStop();
          return;
        }
        if (isWireMessage(message) && message.t === "ready") {
          this.ready = true;
          finish();
          return;
        }
        this.onMessage(message);
      });
      child.once("error", (error) => finish(new ChildRpcError(error.message, "child_spawn_error")));
      child.once("exit", (code, signal) => {
        const expected = this.stopping;
        this.ready = false;
        this.child = null;
        finish(new ChildRpcError(`child exited before ready (code ${code ?? "null"}${signal ? `, ${signal}` : ""})`, "child_exited"));
        this.rejectAll(`child exited (code ${code ?? "null"}${signal ? `, ${signal}` : ""})`);
        this.launch.onExit?.({ code, signal, expected });
      });
    }).catch(async (error) => {
      await this.forceStop();
      throw error;
    });
  }

  private messageWithinLimit(message: unknown): boolean {
    try {
      return Buffer.byteLength(JSON.stringify(message), "utf8") <= (this.launch.maxMessageBytes ?? DEFAULT_MAX_BYTES);
    } catch {
      return false;
    }
  }

  private onMessage(frame: unknown): void {
    if (!isWireMessage(frame)) return;
    if (frame.t === "stopped") return;
    let message: RpcWireMessage | null = frame;
    if (frame.t === "part") {
      // A part for a request that already timed out has nobody to deliver to.
      if (!this.pending.has(frame.id)) {
        this.parts.drop(frame.id);
        return;
      }
      try {
        message = this.parts.accept(frame);
      } catch {
        this.settle(frame.id, new ChildRpcError("child sent malformed response parts", "child_protocol_error"));
        return;
      }
      if (!message) return;
    }
    if (message.t !== "response") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new ChildRpcError(message.error, message.code));
  }

  private settle(id: number, error: ChildRpcError): void {
    this.parts.drop(id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.isReady || !this.child) throw new ChildRpcError("child service is unavailable", "child_unavailable");
    if (!method || method.length > 128) throw new ChildRpcError("invalid child RPC method", "invalid_method");
    if (this.pending.size >= (this.launch.maxPending ?? DEFAULT_MAX_PENDING)) {
      throw new ChildRpcError("child service is saturated", "child_saturated");
    }
    const id = this.nextId++;
    let frames: RpcWireMessage[];
    try {
      frames = wireFrames(
        { v: CHILD_RPC_VERSION, t: "request", id, method, params },
        this.launch.maxMessageBytes ?? DEFAULT_MAX_BYTES,
      );
    } catch {
      throw new ChildRpcError("child RPC request cannot be encoded", "request_unencodable");
    }
    const child = this.child;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.parts.drop(id);
        reject(new ChildRpcError(`child RPC request "${method}" timed out`, "child_timeout"));
      }, this.launch.requestTimeoutMs ?? DEFAULT_REQUEST_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      // Parts are written back-to-back in this synchronous loop, so no other
      // request's frames can interleave with them on the ordered channel.
      for (const frame of frames) {
        child.send(frame, (error) => {
          if (error) this.settle(id, new ChildRpcError(error.message, "child_send_error"));
        });
      }
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.ready = false;
    try {
      if (child.connected) child.send({ v: CHILD_RPC_VERSION, t: "stop" } satisfies RpcWireMessage);
    } catch {
      // The escalation below is the fallback.
    }
    const exited = await this.waitForExit(child, this.launch.stopTimeoutMs ?? DEFAULT_STOP_MS);
    if (!exited) {
      child.kill("SIGTERM");
      if (!(await this.waitForExit(child, 1_000))) child.kill("SIGKILL");
      await this.waitForExit(child, 1_000);
    }
  }

  private async forceStop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.ready = false;
    child.kill("SIGKILL");
    await this.waitForExit(child, 1_000);
  }

  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private rejectAll(reason: string): void {
    this.parts.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ChildRpcError(reason, "child_exited"));
      this.pending.delete(id);
    }
  }
}
