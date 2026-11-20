/**
 * "May this App instance read workspace files, and unsupervised?" — answered
 * once, here.
 *
 * ── Why it is a function and not four lines in the panel ────────────────────
 *
 * Because it is the whole authorisation decision for a second capability plane,
 * and the test that proves a forged ref reaches no laptop has to exercise the
 * SAME decision the panel makes. Two copies of it would be two answers, and the
 * one under test would be the one that is right.
 *
 * ── The four steps, in order ────────────────────────────────────────────────
 *
 *   1. resolve the EXACT contract this instance was opened under, from its own
 *      digest. Never "the newest one": an activation must not re-interpret a
 *      tab somebody already consented to, and a digest this build does not
 *      implement has no contract at all;
 *   2. intersect that ask with the owner's recorded grant, through the same
 *      `IntentGrantResolver` the sessions plane uses;
 *   3. narrow to the operations THIS plane can serve — the workspace-files
 *      Object's closed table, not the sessions one;
 *   4. derive a capability Context, which is where the Gate takes over.
 *
 * If anything is empty the answer is null, and the catalog turns that into
 * `no_authority`. Nothing here decides something a grant did not already say —
 * in particular `read` does not imply unsupervised: `autoAllow` is intersected
 * too, so an owner who granted the operations without auto-allow gets an
 * approval card per call.
 */

import type { Operation } from "@claude-bot/capability-kernel";
import type { WorkspaceFilesScopeGrant } from "../agent-resources/workspace-files-provider.js";
import type { ResourceProviderContext } from "../agent-resources/types.js";
import { GrantWorkspaceFilesAuthority } from "../workspace-files/authority.js";
import {
  WORKSPACE_FILES_OPERATION_NAMES,
  WORKSPACE_FILES_WRITE_OPERATION,
  OWNER_FILES_WRITE_OPERATION,
  type WorkspaceFilesCapabilities,
} from "../workspace-files/capability.js";
import type { WorkspaceDevice } from "../workspace-files/types.js";
import { sessionPlusContractFor, sessionPlusEngineContract } from "./contract.js";
import type { IntentGrantResolver } from "./intent-resolver.js";

/**
 * Options for the provider-owned workspace capability Context.
 *
 * ── Ownership ───────────────────────────────────────────────────────────────
 *
 * The catalog already binds owner, publisher, App, release, instance and
 * binding before this seam runs. The Context lifetime follows that provider
 * scope and ends when the scope is closed.
 *
 * ── Why this is not pooled ─────────────────────────────────────────────────
 *
 * It deliberately does not use the short-lived account pool: catalog dispatch
 * already reuses this exact Context, while pool pruning is allowed to retire
 * an idle HTTP surface before the App instance itself expires.
 */
export interface SessionPlusWorkspaceGrantOptions {
  /** The workspace-files capability plane, when this deployment has one. */
  capabilities: WorkspaceFilesCapabilities | undefined;
  /** The same resolver the sessions plane uses. One recorded intent, one answer. */
  grants: IntentGrantResolver;
  /**
   * This owner's devices, as gateway-local presence. Trusted composition input:
   * enumerating devices costs no frame on anybody's laptop, so it is not a
   * permission token and has no operation in the closed table.
   */
  devices: (owner: string) => readonly WorkspaceDevice[];
}

/**
 * Build the `openGrant` seam the workspace-files provider is installed with.
 *
 * Returns null for every scope when there is no capability plane at all — a
 * deployment with no Runner still installs a provider that satisfies the
 * contract exactly, so a release declaring it stays activatable and
 * rollback-able while the file panel says it holds nothing.
 */
export function sessionPlusWorkspaceGrant(
  options: SessionPlusWorkspaceGrantOptions,
): (context: ResourceProviderContext) => WorkspaceFilesScopeGrant | null {
  return (context) => {
    const capabilities = options.capabilities;
    if (!capabilities) return null;
    const known = sessionPlusContractFor(context.publisher, context.permissionContractDigest);
    if (!known) return null;
    const effective = options.grants.effective(
      sessionPlusEngineContract(context.publisher, known.contract),
      context.owner,
    );
    const rights = WORKSPACE_FILES_OPERATION_NAMES.filter((operation) =>
      effective.operations.includes(operation)) as Operation[];
    if (!rights.length) return null;
    const autoAllow = rights.filter((operation) => effective.autoAllow.includes(operation));
    // Whether the WRITE survived that intersection. It is read off the same
    // rights the Context is derived with — not decided again — so "the panel
    // offers a save button" and "the Gate would accept a save" cannot disagree.
    const writable = rights.includes(WORKSPACE_FILES_WRITE_OPERATION as Operation);
    const ownerFilesWritable = rights.includes(OWNER_FILES_WRITE_OPERATION as Operation);
    const ownerFiles = rights.includes("access_owner_files" as Operation);
    const grant = capabilities.open({
      username: context.owner,
      purpose: `${context.app} · 工作区文件`,
      kind: "app-instance",
      rights,
      autoAllow,
      // What an approval card and an audit record say this call was for. The
      // publisher is here for the same reason it is in the pool key: "the same
      // operations, vouched for by somebody else" is a different thing, and an
      // owner deciding whether to approve a read is entitled to see which.
      metadata: {
        app: context.app,
        publisher: context.publisher,
        release: context.packageDigest.slice(0, 20),
        contract: context.permissionContractDigest.slice(0, 16),
      },
      // The provider catalog opens this grant exactly once for one live
      // (instance, binding) scope and reuses it for every proposal. Let that
      // scope own the Context directly. AccountAuthority's pool is a short-lived
      // HTTP-surface facility; its pruning window is shorter than an App
      // instance and must not end a Context the provider still holds.
    });
    if (!grant) return null;
    return {
      authority: new GrantWorkspaceFilesAuthority({
        grant,
        devices: () => options.devices(context.owner),
      }),
      writable,
      ownerFilesWritable,
      ownerFiles,
      contextId: grant.contextId,
      close: () => grant.destroy(),
    };
  };
}
