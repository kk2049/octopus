/**
 * The write half of `workspace-files/v1`, declared with `@claude-bot/typed-port-kit`.
 *
 * ── One verb, and why it is a compare-and-swap ─────────────────────────────
 *
 * `replace_text(ref, {expectedDigest, text})` replaces the WHOLE content of one
 * existing text file, and only if that file is still the version the caller read.
 * There is no `write_text`, no `append`, no `patch` and no `create`:
 *
 *  · a write with no precondition silently loses whichever edit lands second,
 *    and the person who lost it finds out later or never;
 *  · a patch needs a diff algorithm on both sides, and the two must agree about
 *    line endings, encoding and context — which is a whole contract of its own;
 *  · a create is a different authority question ("may this App bring files into
 *    existence?") and belongs to whichever release asks for it.
 *
 * The precondition is a digest of the whole file rather than an mtime or a size
 * because those two are what a filesystem happens to record, not what the caller
 * actually based its edit on. `open_text` already hands out that digest.
 *
 * ── What a receipt is, and what it deliberately is not ─────────────────────
 *
 * §8 of the module system design describes one `MutationReceipt` envelope shared
 * by files, CRDT documents and deck models. This build ships the part that is
 * REAL today: the echoed ref, an opaque mutation id, the before/after digests,
 * the size and the instant the swap committed. It does not ship `groupId`,
 * `actor`, `summary` or `status`, because each of those describes a mutation
 * LEDGER — a durable thing with a lifecycle — and there is not one yet. Emitting
 * fields a ledger would fill in, filled in by nobody, would make an activity feed
 * that reports operations no system is tracking.
 *
 * `undo` is the exception: it is declared with §8's three-value vocabulary and
 * this build always answers `unsupported`, because no preimage is retained. That
 * is a fact a consumer needs in order to decide whether to offer an undo button,
 * and it is one word rather than a subsystem.
 *
 * ── How a file body travels ────────────────────────────────────────────────
 *
 * A resource proposal carries eight parameters of at most 512 characters, and a
 * contract may raise ONE parameter of one action to 384 KiB — `text`, here. The
 * editor batch made that wire decision; 2026-10-20 added the other one it named,
 * a staged upload (`stage`/`upload`/`offset`/`size`, see `upload.ts`), so the
 * raised parameter is a per-call WINDOW and a file of any size can be saved
 * through the same action, token and compare-and-swap.
 */

import {
  ID_PATTERNS,
  declareContract,
  refusalVocabulary,
  wireServiceableActions,
  IssueBag,
  boundedIntAt,
  boundedStringAt,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
} from "@claude-bot/typed-port-kit";

import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_FILES_OPERATIONS,
  WORKSPACE_FILES_REFUSALS,
  type WorkspaceFilesActionId,
  type WorkspaceFilesRefusalCode,
} from "./limits.js";
import { WORKSPACE_LIST_CURSOR_MAX_LENGTH } from "./paging.js";

/**
 * The closed refusal set, as a kit vocabulary.
 *
 * Built from `WORKSPACE_FILES_REFUSALS` rather than restated, so there is one
 * list: a code the array has and this vocabulary does not would be a code the
 * type system accepts and the folder drops.
 */
export const WORKSPACE_FILES_REFUSAL_VOCABULARY = refusalVocabulary<WorkspaceFilesRefusalCode>(
  [...WORKSPACE_FILES_REFUSALS],
  { fallback: "unavailable", maxMessageLength: WORKSPACE_FILES_LIMITS.maxMessageLength },
);

/** `sha256:<64 hex>`. Anchored and flagless: JSON Schema `pattern` is both. */
const CONTENT_DIGEST = /^sha256:[0-9a-f]{64}$/;

const REF_FIELD = Object.freeze({
  type: "string" as const,
  description: "资源引用：由可信侧铸出、只对它有意义的不透明串。不是路径，也不是文件名。",
  maxLength: WORKSPACE_FILES_LIMITS.maxRefLength,
  pattern: ID_PATTERNS.resourceRef,
});

/**
 * The contract as data: four actions, one declaration.
 *
 * The three reads are declared here even though their remote adapter is still
 * the hand-written one in `remote.ts` — "既有只读部分不强迁". Declaring them costs
 * nothing and buys the two things a partial declaration cannot have: the MCP face
 * covers the whole port, and `WORKSPACE_FILES_OPERATIONS` can be cross-checked
 * against what the declaration says each action spends.
 */
export const WORKSPACE_FILES_DECLARATION = declareContract({
  contract: WORKSPACE_FILES_CONTRACT,
  summary:
    "浏览并改写已登记工作区里的 UTF-8 文本文件。它说不出路径、设备或工作区 id，"
    + "只能提交可信侧铸给它的引用。",
  refusals: WORKSPACE_FILES_REFUSAL_VOCABULARY,
  actions: {
    refresh_roots: {
      summary: "重新枚举这个视图可以看到的已登记工作区；truncated 时用 after 继续下一页",
      operation: WORKSPACE_FILES_OPERATIONS.refresh_roots,
      params: {
        after: {
          ...REF_FIELD,
          optional: true,
          description: "上一页最后一个工作区的 ref；给出时只返回排在它之后的工作区。",
        },
      },
    },
    list_directory: {
      summary: "列出一个目录的直接子项；truncated 时用 after 继续下一页",
      operation: WORKSPACE_FILES_OPERATIONS.list_directory,
      params: {
        ref: REF_FIELD,
        after: {
          type: "string",
          optional: true,
          description:
            "上一页最后一个条目的位置：`<kind>/<label>`。给出时只返回在目录序（目录、文件、其它；"
            + "同类按 label 的 UTF-16 码元序）中排在它之后的条目，增删不会让翻页重复或跳过。",
          maxLength: WORKSPACE_LIST_CURSOR_MAX_LENGTH,
        },
      },
    },
    open_text: {
      summary: "打开一个文本文件：返回文件头，内容按有界流分块拉取",
      operation: WORKSPACE_FILES_OPERATIONS.open_text,
      params: { ref: REF_FIELD },
    },
    replace_text: {
      summary:
        "整份改写一个已存在的文本文件。必须给出这次编辑所基于的整份文件摘要；"
        + "文件已经变了就拒绝并且不写入。超过一次调用窗口的内容按 begin / append / commit 分段提交，"
        + "commit 时才做同样的比对与原子替换。",
      operation: WORKSPACE_FILES_OPERATIONS.replace_text,
      params: {
        ref: REF_FIELD,
        expected_digest: {
          type: "string",
          optional: true,
          description:
            "这次编辑所基于的整份文件摘要（open_text 给出的那一个）。一次性替换、begin 与 commit 必填；"
            + "与设备上的实际内容不符时返回 digest_mismatch，一个字节都不会写。",
          maxLength: WORKSPACE_FILES_LIMITS.maxDigestLength,
          pattern: CONTENT_DIGEST,
        },
        text: {
          type: "string",
          optional: true,
          description:
            `一次调用携带的文本，UTF-8，最多 ${WORKSPACE_FILES_LIMITS.maxWriteTextBytes} 字节：`
            + "不带 stage 时是文件的新全文；stage=append 时是从 offset 起的一段。这是整份替换，不是补丁。",
          maxLength: WORKSPACE_FILES_LIMITS.maxWriteTextBytes,
        },
        stage: {
          type: "string",
          optional: true,
          enum: ["begin", "append", "commit"],
          description:
            "分段提交的步骤。begin 给出 expected_digest 并取得 upload；append 带 upload、offset 与一段 text；"
            + "commit 带 upload、expected_digest 与总字节数 size，比对通过才原子替换。",
        },
        upload: {
          type: "string",
          optional: true,
          description: "begin 返回的分段令牌。",
          maxLength: 32,
          pattern: /^[0-9a-f]{32}$/,
        },
        offset: {
          type: "integer",
          optional: true,
          description: "append 这一段在新全文中的起始字节；必须等于已暂存的字节数。",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        size: {
          type: "integer",
          optional: true,
          description: "commit 时新全文的总字节数；必须等于已暂存的字节数。",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
    },
  },
});

/**
 * Which actions a View proposal can actually carry — the three reads.
 *
 * Exported rather than derived at each call site so that "the write is not on
 * this wire" is a value somebody can assert about, and so that the day the wire
 * grows a body, exactly one thing changes.
 */
export const WORKSPACE_FILES_WIRE_ACTIONS: readonly WorkspaceFilesActionId[] =
  wireServiceableActions(WORKSPACE_FILES_DECLARATION);

/** What a caller submits with a replace. */
export interface WorkspaceReplaceTextInput {
  /** The whole-file digest this edit was based on. `sha256:<64 hex>`. */
  readonly expectedDigest: string;
  /** The file's new full content. UTF-8, and a replacement rather than a patch. */
  readonly text: string;
}

/** §8's vocabulary. This build only ever says `unsupported`; see the docstring. */
export const WORKSPACE_MUTATION_UNDO = Object.freeze(["available", "expired", "unsupported"] as const);

export type WorkspaceMutationUndo = (typeof WORKSPACE_MUTATION_UNDO)[number];

/**
 * What the trusted side answers when a replace has committed.
 *
 * The field list IS the boundary, same as every other projection here: no path,
 * no device, no workspace id, no owner, no context. `beforeDigest` is the
 * precondition that was verified, echoed so a consumer can tell that the swap it
 * asked for is the swap that happened.
 */
export interface WorkspaceMutationReceipt {
  /** The file this was for, echoed back. */
  readonly ref: string;
  /** Opaque, minted by the trusted side, meaningful only to it. */
  readonly mutationId: string;
  /** Which verb produced it. One value today; a vocabulary when there are more. */
  readonly operation: "replace_text";
  /** The whole-file digest that was verified before writing. */
  readonly beforeDigest: string;
  /** The whole-file digest afterwards. */
  readonly afterDigest: string;
  /** Size of the whole file afterwards, in bytes. */
  readonly sizeBytes: number;
  /**
   * When the new content became the file's content, as the machine that holds
   * the file recorded it. Not this process's clock, and not when anybody looked.
   */
  readonly committedAt: string;
  /** Whether this mutation can be undone. Always `unsupported` in this build. */
  readonly undo: WorkspaceMutationUndo;
}

const RECEIPT_FIELDS = [
  "ref",
  "mutationId",
  "operation",
  "beforeDigest",
  "afterDigest",
  "sizeBytes",
  "committedAt",
  "undo",
] as const;

/** `2026-08-07T12:34:56.000Z`. An instant, never a locale-formatted string. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** An opaque mutation id. Bounded, compared, never parsed. */
const MUTATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function readWorkspaceMutationReceipt(
  value: unknown,
  at = "receipt",
): ContractResult<WorkspaceMutationReceipt> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, RECEIPT_FIELDS, at);

  const ref = boundedStringAt(bag, row, "ref", at, WORKSPACE_FILES_LIMITS.maxRefLength);
  if (ref !== null && !ID_PATTERNS.resourceRef.test(ref)) {
    bag.add("identifier", "ref must be a bounded printable reference", `${at}.ref`);
  }
  const mutationId = boundedStringAt(bag, row, "mutationId", at, WORKSPACE_FILES_LIMITS.maxMutationIdLength);
  if (mutationId !== null && !MUTATION_ID.test(mutationId)) {
    bag.add("identifier", "mutationId must be a bounded opaque token", `${at}.mutationId`);
  }
  if (row.operation !== "replace_text") {
    bag.add("schema", "operation must be replace_text", `${at}.operation`);
  }
  const before = boundedStringAt(bag, row, "beforeDigest", at, WORKSPACE_FILES_LIMITS.maxDigestLength);
  if (before !== null && !CONTENT_DIGEST.test(before)) {
    bag.add("identifier", "beforeDigest must be sha256:<64 hex>", `${at}.beforeDigest`);
  }
  const after = boundedStringAt(bag, row, "afterDigest", at, WORKSPACE_FILES_LIMITS.maxDigestLength);
  if (after !== null && !CONTENT_DIGEST.test(after)) {
    bag.add("identifier", "afterDigest must be sha256:<64 hex>", `${at}.afterDigest`);
  }
  const size = boundedIntAt(bag, row, "sizeBytes", at, WORKSPACE_FILES_LIMITS.maxTextBytes, { min: 0 });
  if (typeof row.committedAt !== "string" || !ISO_INSTANT.test(row.committedAt)) {
    bag.add("field_type", "committedAt must be an ISO-8601 instant in UTC", `${at}.committedAt`);
  }
  if (typeof row.undo !== "string" || !(WORKSPACE_MUTATION_UNDO as readonly string[]).includes(row.undo)) {
    bag.add("schema", "undo must be available, expired or unsupported", `${at}.undo`);
  }

  if (!bag.empty) return bag.fail();
  // One fixed field order, so `encode(read(x)) === x` is an equality a test can
  // assert rather than a claim about a sorting function.
  return {
    ok: true,
    value: {
      ref: ref!,
      mutationId: mutationId!,
      operation: "replace_text",
      beforeDigest: before!,
      afterDigest: after!,
      sizeBytes: size!,
      committedAt: row.committedAt as string,
      undo: row.undo as WorkspaceMutationUndo,
    },
  };
}

/** Is this a well-formed whole-file digest? The one operation performed on one. */
export function isWorkspaceContentDigest(value: unknown): value is string {
  return typeof value === "string" && CONTENT_DIGEST.test(value);
}
