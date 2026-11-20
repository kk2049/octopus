/**
 * What a deployment hands one App instance when it may touch documents.
 *
 * The same shape `notify/v1`'s grant has, and for the same reason: the provider
 * is a composition, so everything that constitutes authority arrives in one
 * object built by the composition root, and the provider itself decides nothing
 * about who may do what.
 */

import type { InvokeResult } from "@claude-bot/capability-kernel";
import type { CrdtDocumentStore } from "./store.js";

/**
 * One document this scope may reach.
 *
 * `id` is the store's key and NEVER crosses the port — the provider mints an
 * opaque ref for it, exactly as `workspace-files/v1` does for a file, so a
 * consumer holds something that is meaningless outside the scope that minted it.
 * `label` is display text.
 */
export interface CrdtDocumentDescriptor {
  readonly id: string;
  readonly label: string;
}

/**
 * How far one pending edit-lease approval has come, as the provider reads it.
 *
 * A structural subset of the kernel's own `PendingOutcomeView`, so the provider
 * does not import the kernel: everything it decides on is the state and, once
 * finished, whether the lease call succeeded.
 */
export interface CrdtDocPendingOutcome {
  readonly state: "pending" | "claimed" | "rejected" | "expired" | "finished";
  readonly outcome: "succeeded" | "failed" | "unknown" | null;
}

/**
 * The Gate, as this scope holds it.
 *
 * Three verbs and nothing else: ask the kernel to decide one operation, read
 * back the outcome of a pending decision this same Context created, and check
 * that the Context is still standing. The provider consults `request` before
 * every read and once per (document, sitting) for the edit lease, and `alive`
 * before every merge inside a lease — which is what keeps a mid-sitting
 * revocation from being outlived by a lease boolean.
 */
export interface CrdtDocScopeAuthority {
  request(operation: string, args: Record<string, unknown>): Promise<InvokeResult>;
  result(pendingCallId: string): CrdtDocPendingOutcome | null;
  alive(): boolean;
}

export interface CrdtScopeGrant {
  /** The documents, in a stable order. An empty list means no scope at all. */
  readonly documents: readonly CrdtDocumentDescriptor[];
  /**
   * Whether this scope holds `edit_document` as well as `read_document`.
   *
   * A separate boolean rather than a second grant object, because it is the
   * SAME documents either way: a read-only scope must be able to open and
   * follow exactly what an editing one can, or "read-only" would silently mean
   * "fewer documents".
   */
  readonly mayEdit: boolean;
  /** Where the documents actually live. */
  readonly store: CrdtDocumentStore;
  /**
   * The capability Gate this scope answers to.
   *
   * Since 2026-08-10 a scope without one cannot exist: the provider refuses to
   * serve reads it cannot ask the kernel about, and refuses merges outside a
   * kernel-approved lease. The composition root builds it from a
   * `CrdtDocCapabilities` grant (`session-resource/crdt-grant.ts`).
   */
  readonly authority: CrdtDocScopeAuthority;
  /** Release whatever was taken out to build this scope. Idempotent. */
  close(): void;
}
