/** One live transcript subscription under one instance ControllerRun. */

import { openRunnerTail } from "../sessionhub/runner-tail.js";
import { BOT_HOST_DEVICE, decodeResourceId, withTimeout } from "../sessionhub/core.js";
import { AppAuthorityBundles, type SessionResourcePlane } from "./bundle.js";
import { publicRuntime, runtimeJson } from "./projection.js";
import {
  noResourceAuthority,
  type SessionResourceWatchEvent,
  type SessionResourceWatchResult,
} from "./types.js";

export interface TranscriptWatchOptions {
  bundles: AppAuthorityBundles;
  instanceId: string;
  resource: string;
  timeoutMs: number;
  pollMs: number;
  maxMessages: number;
  audit(owner: string, operation: string, resource: string, decision: string, reason?: string): void;
  projection?: {
    watchTranscript(
      owner: string,
      device: string,
      source: "claude" | "codex" | "omp",
      sessionId: string,
      maxMessages: number,
      listener: () => void,
    ): (() => void) | null;
  };
  isSplitSession?(owner: string, device: string, source: string, id: string): boolean;
  listener(event: SessionResourceWatchEvent): void;
}

/**
 * The polling implementation is shared with Session Hub. Authority is not:
 * this function holds a ControllerRun below the Session Plus App Context for
 * exactly as long as the subscription lives.
 */
export function watchTranscript(o: TranscriptWatchOptions): SessionResourceWatchResult {
  const bundle = o.bundles.get(o.instanceId);
  if (!bundle) return noResourceAuthority();
  const decoded = decodeResourceId(o.resource);
  if (!decoded || decoded.owner !== bundle.owner) {
    o.audit(bundle.owner, "read_session", "subscription", "deny", "resource owner mismatch");
    return { ok: false, code: "invalid_resource", message: "这个会话标识不属于当前账户" };
  }
  const plane: SessionResourcePlane = decoded.device === BOT_HOST_DEVICE ? "local" : "runner";
  const run = o.bundles.openController(o.instanceId, plane, "open_session");
  if (!run) {
    o.audit(bundle.owner, "read_session", plane, "deny", "no authority context");
    return noResourceAuthority();
  }

  let closed = false;
  let fetching = false;
  /** A wake-up arrived during a read; that read may predate the change. */
  let again = false;
  let widened = false;
  let lastState = "";
  let timer: NodeJS.Timeout | null = null;
  let detachProjection: (() => void) | null = null;
  const tail = openRunnerTail(
    async (_operation, args) => {
      const out = await withTimeout(
        run.caps.request("resources", "read_session", {
          ...args,
          ...(plane === "runner" ? { _octopus_include_session_plus: true } : {}),
        }),
        "read_session subscription",
        o.timeoutMs,
      );
      if (out.status === "succeeded") return out.result;
      const error = new Error(out.status === "approval_required" ? "subscription requires approval" : out.reason);
      // A read failure or indeterminate Runner reply is retryable: this is the
      // same idempotent poll the normal chat tail repeats. Only Gate outcomes
      // that say this Context cannot read may end the follow.
      (error as Error & { terminal?: boolean }).terminal =
        out.status === "approval_required" || out.status === "denied";
      throw error;
    },
    decoded.cliKind,
    decoded.sessionId,
    plane === "runner" ? decoded.device : undefined,
    o.maxMessages,
  );

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    detachProjection?.();
    detachProjection = null;
    timer = null;
    tail.close();
    run.close();
  };
  // Device pushes replace most polling, but only once one has actually
  // arrived: a device that never pushes for this session keeps the poll.
  const widen = (): void => {
    if (widened || closed) return;
    widened = true;
    if (timer) clearInterval(timer);
    timer = setInterval(() => void tick(), Math.max(30_000, o.pollMs));
    timer.unref?.();
  };
  const tick = async (): Promise<void> => {
    if (closed) return;
    // One read at a time, but never drop a wake-up: the change it announces
    // may have landed after the running read sampled the file (typically the
    // turn's final answer), and the next poll can be 30 seconds away.
    if (fetching) {
      again = true;
      return;
    }
    fetching = true;
    try {
      const state = await tail.fetch();
      if (closed) return;
      if (plane === "runner" && !detachProjection) {
        // A ControllerRun context alone is not authorization. Subscribe only
        // after a successful exact-resource read through its Gate, including
        // split resources resolved by Runner's launch journal.
        detachProjection = o.projection?.watchTranscript(
          bundle.owner, decoded.device, decoded.cliKind, decoded.sessionId,
          o.maxMessages, () => {
            widen();
            void tick();
          },
        ) ?? null;
      }
      if (!state) {
        // The first successful poll after a transient failure can be byte-for-
        // byte unchanged. Clear "reconnecting" without waiting for a new turn.
        if (lastState === "reconnecting") {
          lastState = "ready";
          o.listener({ type: "status", resource: o.resource, state: "live" });
        }
        return;
      }
      lastState = "ready";
      o.listener({
        type: "data",
        resource: o.resource,
        data: runtimeJson({
          sessionId: decoded.sessionId,
          cliKind: decoded.cliKind,
          deviceLabel: decoded.device === BOT_HOST_DEVICE ? "bot 主机" : decoded.device,
          rich: true,
          messages: state.messages,
          activity: state.activity ?? null,
          // Capability and interaction changes can arrive without new text.
          // Explicit null clears the previous observation; never retain stale rights.
          runtime: publicRuntime(state.runtime),
          offset: state.offset,
          totalMessages: state.total,
          ...(state.version ? { version: state.version } : {}),
        }),
      });
    } catch (error) {
      if (closed) return;
      const terminal = Boolean((error as Error & { terminal?: boolean })?.terminal);
      const nextState = terminal ? "closed" : "reconnecting";
      if (lastState !== nextState) {
        lastState = nextState;
        const raw = error instanceof Error ? error.message : String(error);
        o.audit(bundle.owner, "read_session", plane, terminal ? "deny" : "error", raw);
        o.listener({
          type: "error",
          resource: o.resource,
          terminal,
          message: terminal ? "transcript 权限已经失效" : "transcript 暂时不可用，正在重试",
        });
      }
      if (terminal) close();
    } finally {
      fetching = false;
      if (again && !closed) {
        again = false;
        void tick();
      }
    }
  };
  const pollMs = plane === "local" ? Math.min(2_000, o.pollMs) : o.pollMs;
  timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();
  void tick();
  return { ok: true, subscription: { close } };
}
