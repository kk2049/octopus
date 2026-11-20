/**
 * The ref vault: the only place an opaque reference becomes a real location.
 *
 * ── Why a vault and not an encoding ────────────────────────────────────────
 *
 * The tempting shape is to encode `(device, workspace, path)` into the ref and
 * decode it on the way back. That fails in a way that is hard to notice: a ref
 * is then a STATEMENT the consumer makes, so every path afterwards is a checker,
 * and the security of the system becomes "did we remember to check" at each one.
 *
 * A vault inverts it. The ref carries no information at all — 192 bits of
 * randomness — so submitting one is not a claim about anything. Rebinding is a
 * lookup that either finds a record this scope minted or does not, and there is
 * no string a consumer can construct that turns into a path.
 *
 * That is why nothing here parses, base64-decodes, or falls back to matching by
 * label. Four things must all agree before a record is returned: the ref exists,
 * it was minted for THIS scope, for THIS owner, and for the kind of thing the
 * caller is about to do with it. Any mismatch is refused before a Runner frame
 * exists.
 *
 * ── Why refs are stable ────────────────────────────────────────────────────
 *
 * Listing the same directory twice must produce the same refs, or a consumer's
 * selection, expansion state and open panels dissolve on every refresh. So a
 * reverse index keys on everything that identifies the resource within a scope,
 * and re-minting returns the existing ref. Across scopes the same file gets
 * different refs, which is the same property stated from the other side: a ref
 * is meaningless outside the scope that minted it.
 */

import { randomBytes } from "node:crypto";
import { WORKSPACE_FILES_LIMITS } from "@claude-bot/workspace-files-contract";
import type { WorkspaceBinding } from "./types.js";

export type WorkspaceRefKind = "directory" | "file";

export interface WorkspaceRefRecord {
  scope: string;
  owner: string;
  kind: WorkspaceRefKind;
  binding: WorkspaceBinding;
  /** `""` is the workspace root. */
  relativePath: string;
  /** Display label, decided when the ref was minted. */
  label: string;
}

export interface WorkspaceRefVaultOptions {
  /** One view cannot retain an unbounded walk of a very large tree. */
  maxPerScope?: number;
  /** One account cannot consume the process-wide pool and starve its peers. */
  maxPerOwner?: number;
  /** Nor can many abandoned views exhaust the whole coordinator process. */
  maxGlobal?: number;
}

/**
 * Capacity is an operational refusal, not an invalid or forged reference.
 * The service catches this exact type and turns it into a bounded public reply.
 */
export class WorkspaceRefLimitError extends Error {
  constructor() {
    super("workspace ref vault capacity reached");
    this.name = "WorkspaceRefLimitError";
  }
}

/** `wf_` + 192 bits, base64url. Printable, bounded, and never parsed. */
function newRef(): string {
  return `wf_${randomBytes(24).toString("base64url")}`;
}

/** A length-preserving JSON tuple, so no component can impersonate a boundary. */
function identityKey(record: Omit<WorkspaceRefRecord, "label">): string {
  return JSON.stringify([
    record.scope,
    record.owner,
    record.kind,
    record.binding.device,
    record.binding.ownerRoot === true,
    record.binding.workspaceId,
    record.relativePath,
  ]);
}

export class WorkspaceRefVault {
  private readonly byRef = new Map<string, WorkspaceRefRecord>();
  private readonly byIdentity = new Map<string, string>();
  private readonly byScope = new Map<string, Set<string>>();
  private readonly byOwner = new Map<string, number>();
  private readonly maxPerScope: number;
  private readonly maxPerOwner: number;
  private readonly maxGlobal: number;

  constructor(options: WorkspaceRefVaultOptions = {}) {
    this.maxPerScope = positiveInteger(options.maxPerScope, 4_096);
    this.maxPerOwner = positiveInteger(options.maxPerOwner, 16_384);
    this.maxGlobal = positiveInteger(options.maxGlobal, 65_536);
  }

  /** Mint, or return the ref this scope already has for the same resource. */
  mint(record: WorkspaceRefRecord): string {
    return this.mintMany([record])[0]!;
  }

  /**
   * Mint one projection atomically.
   *
   * Directory replies are batches. Preflighting the whole batch avoids the
   * awkward state where a refused reply consumed half its remaining capacity
   * with refs the consumer never received.
   */
  mintMany(records: readonly WorkspaceRefRecord[]): string[] {
    const newKeys = new Set<string>();
    const additionsByScope = new Map<string, number>();
    const additionsByOwner = new Map<string, number>();
    for (const record of records) {
      const key = identityKey(record);
      if (this.byIdentity.has(key) || newKeys.has(key)) continue;
      newKeys.add(key);
      additionsByScope.set(record.scope, (additionsByScope.get(record.scope) ?? 0) + 1);
      additionsByOwner.set(record.owner, (additionsByOwner.get(record.owner) ?? 0) + 1);
    }
    if (this.byRef.size + newKeys.size > this.maxGlobal) throw new WorkspaceRefLimitError();
    for (const [scope, additions] of additionsByScope) {
      if ((this.byScope.get(scope)?.size ?? 0) + additions > this.maxPerScope) {
        throw new WorkspaceRefLimitError();
      }
    }
    for (const [owner, additions] of additionsByOwner) {
      if ((this.byOwner.get(owner) ?? 0) + additions > this.maxPerOwner) {
        throw new WorkspaceRefLimitError();
      }
    }

    return records.map((record) => this.mintUnchecked(record));
  }

  private mintUnchecked(record: WorkspaceRefRecord): string {
    const key = identityKey(record);
    const existing = this.byIdentity.get(key);
    if (existing) return existing;

    let ref = newRef();
    while (this.byRef.has(ref)) ref = newRef();
    this.byRef.set(ref, { ...record, binding: { ...record.binding } });
    this.byIdentity.set(key, ref);
    const held = this.byScope.get(record.scope);
    if (held) held.add(ref);
    else this.byScope.set(record.scope, new Set([ref]));
    this.byOwner.set(record.owner, (this.byOwner.get(record.owner) ?? 0) + 1);
    return ref;
  }

  /**
   * Rebind a ref, or refuse.
   *
   * `unknown_ref` covers forged, cross-scope, cross-owner and closed-scope refs
   * alike, on purpose: distinguishing them would tell a caller which of its
   * guesses was closest. `wrong_kind` is separate because it is a genuine
   * mistake a well-behaved consumer can make — opening a directory as text.
   */
  resolve(
    scope: string,
    owner: string,
    ref: unknown,
    kind: WorkspaceRefKind,
  ): { ok: true; record: WorkspaceRefRecord } | { ok: false; code: "unknown_ref" | "wrong_kind" } {
    if (typeof ref !== "string" || ref.length === 0 || ref.length > WORKSPACE_FILES_LIMITS.maxRefLength) {
      return { ok: false, code: "unknown_ref" };
    }
    const record = this.byRef.get(ref);
    if (!record || record.scope !== scope || record.owner !== owner) return { ok: false, code: "unknown_ref" };
    if (record.kind !== kind) return { ok: false, code: "wrong_kind" };
    return { ok: true, record };
  }

  /** Forget every ref this scope minted. Returns how many were dropped. */
  closeScope(scope: string): number {
    const held = this.byScope.get(scope);
    if (!held) return 0;
    for (const ref of held) {
      const record = this.byRef.get(ref);
      if (record) {
        this.byIdentity.delete(identityKey(record));
        const left = (this.byOwner.get(record.owner) ?? 1) - 1;
        if (left > 0) this.byOwner.set(record.owner, left);
        else this.byOwner.delete(record.owner);
      }
      this.byRef.delete(ref);
    }
    this.byScope.delete(scope);
    return held.size;
  }

  /** Diagnostics and tests. */
  size(scope?: string): number {
    if (scope === undefined) return this.byRef.size;
    return this.byScope.get(scope)?.size ?? 0;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
