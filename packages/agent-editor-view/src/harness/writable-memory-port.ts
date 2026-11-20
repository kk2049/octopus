/**
 * A writable `workspace-files/v1`, backed by a fixture.
 *
 * ── Why it WRAPS the read-only one ──────────────────────────────────────────
 *
 * `@claude-bot/agent-workspace-files-view/harness` already implements the three
 * reads against an object graph, including the parts a component is most likely
 * to get wrong (`other` entries with no ref, a `too_large` refusal, multi-chunk
 * streams). Copying that to add a fourth method would produce a second read
 * implementation that drifts — the exact failure dev-conventions cites about the
 * browser-trust rules. So this adds `replaceText` and delegates everything else.
 *
 * ── What it models, and why each part is real ───────────────────────────────
 *
 *  · **the compare-and-swap** — a stale `expectedDigest` is `digest_mismatch`
 *    and writes nothing. That is the branch an editor's conflict state exists
 *    for, and it is cheap to get wrong in a fake that just stores the text;
 *  · **`approval_required` as the DEFAULT** — because on the real path it is,
 *    every time. A harness whose writes silently succeed would let a panel be
 *    built around an ending that does not happen in production;
 *  · **`read_only`** — the other structural ending, selectable per fixture;
 *  · **the receipt shape** — a real one, so a consumer that reads
 *    `afterDigest` to continue editing is exercised rather than assumed.
 *
 * The digest is a content hash of the stored text, computed with the same
 * `sha256:<64 hex>` shape the contract states. It uses Web Crypto when a test
 * environment has it and a small deterministic fallback otherwise: this is a
 * fixture's identity for its own strings, not a security property, and the
 * property that matters is only that two different texts get two different
 * digests.
 */

import {
  createMemoryWorkspaceFilesPort,
  type MemoryWorkspaceFixture,
} from "@claude-bot/agent-workspace-files-view/harness";
import {
  WORKSPACE_FILES_CONTRACT,
  utf8ByteLength,
  workspaceFilesRefusal,
  type WorkspaceFilesPort,
  type WorkspaceFilesRefusalCode,
  type WorkspaceFilesReply,
  type WorkspaceMutationReceipt,
  type WorkspaceReplaceTextInput,
} from "@claude-bot/workspace-files-contract";

/** How this fixture answers a well-formed, non-stale write. */
export type WriteOutcome =
  /** The real production ending: a card is made, nothing is written yet. */
  | { kind: "approval_required"; message?: string }
  /** Applied immediately, with a receipt. */
  | { kind: "applied" }
  /** This scope's authority does not cover writes. Structural. */
  | { kind: "read_only"; message?: string }
  /** Anything else the port can say. */
  | { kind: "refused"; code: WorkspaceFilesRefusalCode; message?: string };

export interface WritableMemoryFixture extends MemoryWorkspaceFixture {
  /** Defaults to `approval_required`, because that is what production does. */
  write?: WriteOutcome;
}

export interface WritableMemoryWorkspaceFilesPort {
  port: WorkspaceFilesPort;
  /** Every call, for asserting single-flight and "nothing was re-issued". */
  readonly calls: ReadonlyArray<{ method: string; ref?: string }>;
  readonly openStreams: number;
  /** What each file's text is NOW, so a test can assert nothing was written. */
  textOf(ref: string): string | undefined;
  /** Simulate somebody else changing the file while a card waits. */
  overwrite(ref: string, text: string): void;
  /** Change the answer mid-test — a revocation, an approval being granted. */
  setWrite(outcome: WriteOutcome): void;
}

export function createWritableMemoryWorkspaceFilesPort(
  fixture: WritableMemoryFixture,
): WritableMemoryWorkspaceFilesPort {
  /** Live content, so a read after a write returns what was written. */
  const files = new Map(
    Object.entries(fixture.files).map(([ref, file]) => [ref, { ...file, document: { ...file.document } }]),
  );
  let outcome: WriteOutcome = fixture.write ?? { kind: "approval_required" };
  let mutations = 0;

  const read = createMemoryWorkspaceFilesPort({
    ...fixture,
    // A getter-backed view, so the reads see writes.
    get files() {
      return Object.fromEntries(files);
    },
  } as MemoryWorkspaceFixture);

  const port: WorkspaceFilesPort = {
    contract: WORKSPACE_FILES_CONTRACT,
    refreshRoots: () => read.port.refreshRoots(),
    listDirectory: (ref) => read.port.listDirectory(ref),
    openText: (ref) => read.port.openText(ref),

    async replaceText(
      ref: string,
      input: WorkspaceReplaceTextInput,
    ): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>> {
      calls.push({ method: "replaceText", ref });
      const file = files.get(ref);
      if (!file) return workspaceFilesRefusal("unknown_ref", "这个引用不属于当前视图。");
      // No size check: a port's replace takes a whole text of any size (a
      // remote port stages one past a call's window; 2026-10-20).
      // Order matters, and it is the device's: the precondition is checked
      // BEFORE anything else can happen, so a stale edit never becomes a card.
      if (input.expectedDigest !== file.document.digest) {
        return workspaceFilesRefusal("digest_mismatch", "文件已经不是这次编辑所基于的版本。");
      }
      if (outcome.kind === "read_only") {
        return workspaceFilesRefusal("read_only", outcome.message ?? "当前授权不包含写入。");
      }
      if (outcome.kind === "refused") {
        return workspaceFilesRefusal(outcome.code, outcome.message ?? "这次保存没有完成。");
      }
      if (outcome.kind === "approval_required") {
        return workspaceFilesRefusal("approval_required", outcome.message ?? "这次写入需要设备主人批准。");
      }

      const before = file.document.digest;
      const digest = digestOf(input.text);
      files.set(ref, {
        text: input.text,
        document: {
          ...file.document,
          digest,
          sizeBytes: utf8ByteLength(input.text),
        },
      });
      mutations += 1;
      return {
        ok: true,
        value: {
          ref,
          mutationId: `mem${String(mutations).padStart(5, "0")}`,
          operation: "replace_text",
          beforeDigest: before,
          afterDigest: digest,
          sizeBytes: utf8ByteLength(input.text),
          committedAt: "2026-08-07T00:00:00.000Z",
          undo: "unsupported",
        },
      };
    },
  };

  const calls = read.calls as Array<{ method: string; ref?: string }>;

  return {
    port,
    calls,
    get openStreams() {
      return read.openStreams;
    },
    textOf: (ref) => files.get(ref)?.text,
    overwrite(ref, text) {
      const file = files.get(ref);
      if (!file) return;
      files.set(ref, {
        text,
        document: { ...file.document, digest: digestOf(text), sizeBytes: utf8ByteLength(text) },
      });
    },
    setWrite(next) {
      outcome = next;
    },
  };
}

/**
 * A `sha256:`-shaped identity for a fixture's own string.
 *
 * Deliberately NOT a real SHA-256: this package must not gain a crypto
 * dependency for a harness, and `crypto.subtle` is async while every reader here
 * is synchronous. What a test needs is that two texts differ and one text is
 * stable, which a 64-hex expansion of a string hash provides.
 */
export function digestOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b + text.charCodeAt(i) + i, 0x85ebca6b) >>> 0;
  }
  const seed = `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
  return `sha256:${seed.repeat(8).slice(0, 64)}`;
}
