/** A release-bound compute service. Durable state remains outside this process. */

import { AppSandbox } from "@claude-bot/engine/sandbox";
import { backendRelease, type BackendRelease } from "./release.js";
import type {
  AppRuntimeClient,
  InvokeRequest,
  InvokeResult,
  ProjectRequest,
  RuntimeHealth,
  RuntimeJson,
} from "./types.js";

const ACTION = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_EVENTS = 256;

export interface AppRuntimeServiceOptions {
  timeoutMs?: number;
  maxCalls?: number;
  onDiagnostic?: (line: string) => void;
}

export class AppRuntimeError extends Error {
  constructor(message: string, readonly code = "runtime_error") {
    super(message);
    this.name = "AppRuntimeError";
  }
}

export class AppRuntimeService implements AppRuntimeClient {
  readonly release: BackendRelease;
  private readonly sandbox: AppSandbox;
  private closed = false;

  constructor(appDir: string, options: AppRuntimeServiceOptions = {}) {
    this.release = backendRelease(appDir);
    this.sandbox = new AppSandbox({
      appDir: this.release.appDir,
      contextKey: `app-runtime:${this.release.backendCodeDigest.slice(0, 12)}`,
      timeoutMs: options.timeoutMs,
      maxCalls: options.maxCalls,
      onStderr: options.onDiagnostic,
    });
  }

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    this.assertRelease(request.backendCodeDigest);
    if (!ACTION.test(request.action)) throw new AppRuntimeError("invalid action name", "invalid_action");
    if (!isRuntimeJson(request.context) || !isRuntimeJson(request.params)) {
      throw new AppRuntimeError("handler input is not JSON data", "invalid_input");
    }
    // Deliberately no broker argument. The existing AppSandbox still gives the
    // handler a facade, but every request through it returns denied because this
    // runtime was not handed a capability callback.
    let raw: unknown;
    try {
      raw = await this.sandbox.runHandler(
        this.release.actionsFile,
        request.action,
        request.context,
        request.params,
      );
    } catch (error) {
      // Two different failures share this catch. Text the app's own function
      // threw ("it is not white's turn to move") is the rules gate explaining
      // itself (ADR 0007) — it was authored inside a Compartment that holds no
      // paths or host internals, and its audience is that same publisher's
      // View, so a bounded copy travels on as `handler_rejected`. Everything
      // else (loader, timeout, protocol) may name real files or machinery and
      // keeps the stable classification with a constant message.
      if ((error as { code?: unknown })?.code === "app_rejected") {
        const reason = String((error as Error).message ?? "").replace(/[\r\n\t]+/g, " ").slice(0, 240);
        throw new AppRuntimeError(reason || "app handler rejected the action", "handler_rejected");
      }
      throw new AppRuntimeError("app handler rejected the action", "handler_failed");
    }
    if (!raw || typeof raw !== "object" || !isRuntimeJson(raw)) {
      throw new AppRuntimeError("handler returned non-JSON data", "invalid_handler_result");
    }
    const row = raw as unknown as Record<string, unknown>;
    if (!Array.isArray(row.events) || row.events.length > MAX_EVENTS) {
      throw new AppRuntimeError("handler must return an events array", "invalid_handler_result");
    }
    const events = row.events.map((event) => normalizeEvent(event));
    const result = row.result;
    if (result !== undefined && !isRuntimeJson(result)) {
      throw new AppRuntimeError("handler result payload is not JSON data", "invalid_handler_result");
    }
    return { events, ...(result === undefined ? {} : { result }) } as InvokeResult;
  }

  async project(request: ProjectRequest): Promise<RuntimeJson> {
    this.assertRelease(request.backendCodeDigest);
    if (
      !Array.isArray(request.events)
      || !request.events.every((event) => isRuntimeJson(event))
      || (request.snapshot !== undefined && !isRuntimeJson(request.snapshot))
      || (request.context !== undefined && !isRuntimeJson(request.context))
    ) {
      throw new AppRuntimeError("projection input is not JSON data", "invalid_input");
    }
    let view: unknown;
    try {
      view = await this.sandbox.project(
        this.release.projectionFile,
        request.events,
        request.context,
        request.snapshot,
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code === "incremental_projection_unsupported") {
        throw new AppRuntimeError(
          "this projection release does not support snapshot-tail folding",
          "incremental_projection_unsupported",
        );
      }
      throw error;
    }
    if (!isRuntimeJson(view)) throw new AppRuntimeError("projection returned non-JSON data", "invalid_projection");
    return view;
  }

  async health(): Promise<RuntimeHealth> {
    return { ok: !this.closed, backendCodeDigest: this.release.backendCodeDigest };
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sandbox.dispose();
  }

  private assertRelease(digest: string): void {
    if (this.closed) throw new AppRuntimeError("app runtime is closed", "runtime_unavailable");
    if (digest !== this.release.backendCodeDigest) {
      throw new AppRuntimeError("backend release changed; this runtime instance is stale", "stale_backend");
    }
  }
}

function normalizeEvent(value: unknown) {
  if (!value || typeof value !== "object" || !isRuntimeJson(value)) {
    throw new AppRuntimeError("handler emitted a non-JSON event", "invalid_handler_result");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.type !== "string"
    || row.type.length === 0
    || row.type.length > 128
    || typeof row.at !== "string"
    || row.at.length > 64
    || typeof row.by !== "string"
    || row.by.length > 160
    || !isRuntimeJson(row.data)
  ) {
    throw new AppRuntimeError("handler emitted an invalid event", "invalid_handler_result");
  }
  return { type: row.type, data: row.data, at: row.at, by: row.by };
}

/**
 * Plain JSON data, nested at most 32 levels (the validator and canonical
 * encoder recurse). There is deliberately no element-count bound: the bytes a
 * value can occupy are bounded by the channel that carried it (the sandbox
 * message, one State event), and a count limit would only add a cliff at which
 * an otherwise valid list stops rendering.
 */
export function isRuntimeJson(value: unknown, depth = 0): value is RuntimeJson {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isRuntimeJson(entry, depth + 1));
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(value as Record<string, unknown>)
    .every(([key, entry]) => key !== "__proto__" && isRuntimeJson(entry, depth + 1));
}
