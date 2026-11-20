/**
 * The production `WorkspaceFilesAuthority`: the seam, closed onto the Gate.
 *
 * `types.ts` declares two questions and keeps them apart — WHICH devices this
 * scope may address, and what happens when it addresses one. The vertical
 * conformance harness answers the second with `handleRpc` so it can drive the
 * real Runner adapter without a kernel. This file answers it the way production
 * has to: with a capability grant over `workspace-files-runner-v2:<owner>`, so
 * every read is one `gate.invoke` and the kernel is the only authoriser.
 *
 * ── Two facts that are deliberately not the same call ──────────────────────
 *
 * `devices()` does NOT go through the Gate, and that is not a gap. The roster is
 * gateway-local presence — device name, online, last seen — and answering it
 * costs no frame on anybody's laptop. `__list_devices` is therefore absent from
 * this plane's closed table entirely: an operation that never reaches a device
 * would be a permission token that grants nothing, and having one would invite
 * the reading that this plane can enumerate more than it can read.
 *
 * What the roster IS, then, is trusted composition input: whoever constructs
 * this object supplies a function bound to one owner, and there is no code path
 * from an argument to a global device lookup.
 *
 * ── Why the refusal vocabulary narrows here ────────────────────────────────
 *
 * `InvokeResult` has five shapes and the backend has four. `unknown` — the
 * kernel's honest answer for an execute call whose outcome nobody can determine
 * — collapses into `failed`, because this plane has no execute operation: a read
 * that lost its link simply did not happen, and there is no side effect to be
 * unsure about. The `reason` strings never travel: they are written for an
 * operator's log, and they are the one field on this path with no bound on what
 * they might contain.
 */

import type { Operation } from "@claude-bot/capability-kernel";
import type { WorkspaceFilesGrant } from "./capability.js";
import type { RunnerCallOutcome, WorkspaceDevice, WorkspaceFilesAuthority } from "./types.js";

export interface GrantAuthorityOptions {
  /**
   * The grant this scope holds. One per scope, derived by the trusted caller
   * with the rights and terms it decided; nothing here can widen either.
   */
  grant: WorkspaceFilesGrant;
  /**
   * The devices this owner has, as gateway-local presence. Bound to one owner
   * by the composition that supplies it.
   */
  devices: () => readonly WorkspaceDevice[];
}

/**
 * One scope's authority: a fixed grant, a fixed owner, and no way to name
 * another account.
 */
export class GrantWorkspaceFilesAuthority implements WorkspaceFilesAuthority {
  constructor(private readonly options: GrantAuthorityOptions) {}

  async devices(): Promise<readonly WorkspaceDevice[]> {
    return this.options.devices();
  }

  async call(
    device: string,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<RunnerCallOutcome> {
    // `device` is already inside `args` — the backend puts it there because the
    // schema requires it, so the approval card and the args hash name the same
    // machine the transport will reach. It is passed separately as well because
    // the seam's shape says which device a call is FOR, and a future authority
    // that routed differently would still have to be told.
    const outcome = await this.options.grant.request(operation as Operation, { ...args, device });
    switch (outcome.status) {
      case "succeeded":
        return { status: "succeeded", result: outcome.result };
      case "approval_required":
        return { status: "approval_required", pendingCallId: outcome.pendingCallId };
      case "denied":
        return { status: "denied" };
      default:
        // `failed` and `unknown` alike. See the file docstring for why a
        // read-only plane may collapse them, and why no `reason` crosses.
        return { status: "failed" };
    }
  }
}
