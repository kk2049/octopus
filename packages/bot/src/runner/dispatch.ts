/**
 * The one place a capability adapter turns an authorised operation into a
 * Runner frame.
 *
 * ── Why this is a shared function rather than a line in each adapter ────────
 *
 * There is now more than one capability Object over the same laptops: the
 * account's Runner Object (`runner-account-v2`) and the Workspace Files Object
 * (`workspace-files-runner-v2`). They are deliberately separate — separate
 * operation identity, separate root, separate slot, separate revocation — but
 * they talk to the SAME trusted transport, and the socket protocol is not the
 * thing that differs between them.
 *
 * Two copies of "how do I reach a device, and what does a dead link mean" is the
 * shape this repository has been burned by before, and here the drift would be
 * a security-adjacent one: `runner_timeout` and `runner_gone` mean "we do not
 * know whether it ran", and an adapter that classified them as an ordinary
 * failure would let a caller conclude that nothing happened.
 *
 * ── Why the caller decides whether loss is indeterminate ────────────────────
 *
 * Because only the caller has the operation table. `exec` losing its link is
 * indeterminate; a directory listing losing its link is simply a failed read
 * with no side effect to be unsure about. Passing a boolean keeps that judgment
 * where the effect declaration lives instead of importing one plane's table
 * into another's.
 */

import { IndeterminateOutcome, type Operation } from "@claude-bot/capability-kernel";
import { ResourceUnavailableError, resourceTransportFailure, runnerResource } from "../resources/recovery.js";
import type { RunnerTransport } from "./gateway.js";
import type { RunnerProjectionReadCache } from "./session-projection.js";

/** What an adapter over the Runner transport holds. Never reachable by a caller. */
export interface RunnerDispatchBinding {
  /** Fixed at registration from the trusted user row. Never from arguments. */
  owner: string;
  transport: RunnerTransport;
  /** Optional caller-owned read cache; reached only after the capability Gate. */
  projectionReadCache?: RunnerProjectionReadCache;
}

/**
 * Send one already-authorised operation to this owner's devices.
 *
 * `device` selection happens inside the gateway, within this owner's own
 * connection set — there is no code path here that takes a username from
 * arguments.
 */
export async function dispatchToRunner(
  binding: RunnerDispatchBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
  options: { indeterminateOnLinkLoss?: boolean } = {},
): Promise<unknown> {
  try {
    const readDevice = operation === "list_recent_sessions" && args.device === undefined && args.cursor === undefined
      ? binding.projectionReadCache?.readRosterDevice?.bind(binding.projectionReadCache) : undefined;
    if (readDevice) {
      return await binding.transport.dispatch(binding.owner, operation, { ...args },
        (device) => readDevice(binding.owner, device, args));
    }
    return await binding.transport.dispatch(binding.owner, operation, { ...args });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    // The device never received the frame: a clean, attributable failure, and
    // the one the recovery service turns into a waiter (resources/recovery.ts).
    // Named before the link-loss check because an offline device is never
    // indeterminate — nothing ran.
    if (code === "runner_offline") {
      const device = typeof args.device === "string" && args.device.trim() ? args.device.trim() : "*";
      throw new ResourceUnavailableError(
        runnerResource(binding.owner, device),
        error instanceof Error ? error.message : "设备不在线",
      );
    }
    if (options.indeterminateOnLinkLoss && (code === "runner_timeout" || code === "runner_gone")) {
      throw new IndeterminateOutcome(error instanceof Error ? error.message : "Runner 执行结果无法确认");
    }
    // Read-only transport loss remains retryable across the Gate's text error
    // boundary. Effectful requests above remain indeterminate, never replayable.
    const device = typeof args.device === "string" && args.device.trim() ? args.device.trim() : "*";
    throw resourceTransportFailure(error, runnerResource(binding.owner, device)) ?? error;
  }
}
