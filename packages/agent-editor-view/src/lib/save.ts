/**
 * What happens after somebody presses 保存 — as a state machine, because the
 * honest answer has five endings and only one of them is "saved".
 *
 * ── The product rule this encodes ───────────────────────────────────────────
 *
 * A write on `workspace-files/v1` is approved individually, every time
 * (`alwaysApprove`, and `modify` is outside the account root's auto-allow). So
 * the NORMAL answer to a save is `approval_required`: the edit has been
 * submitted, a person has to press a button somewhere else, and the result of
 * running it goes to that person rather than back to this panel. A panel that
 * rendered "已保存" there would be reporting something that has not happened, and
 * one that rendered an error would be reporting a failure that is not one.
 *
 * Hence `submitted`: a state, with a re-read button, and no clock.
 *
 * ── Why nothing here retries, polls or re-asks ──────────────────────────────
 *
 * Because every one of those calls goes through a capability Gate, and a call
 * the Gate answers with `approval_required` MAKES AN APPROVAL CARD. Automatic
 * re-issue is therefore not "eventual consistency", it is a stream of cards in
 * front of a person who already has one — the same rule the read path is
 * written to (`useWorkspaceText` has no retry either) and the same rule
 * dev-conventions states in red for the panel's capability-backed GETs. The only
 * thing that starts a second call is a person pressing something.
 *
 * ── Why `read_only` is remembered and the others are not ────────────────────
 *
 * `read_only` is structural: this scope's authority covers the reads and not the
 * write, and nothing the reader does in this panel will change that. Once seen,
 * the panel stops offering to save — the same "nothing to submit" discipline
 * that makes an `other` entry render without a button. Every other refusal is
 * about THIS attempt (the file moved on, the device is unreachable, the body is
 * too big), so the button stays.
 */

import type { WorkspaceFilesRefusalCode, WorkspaceMutationReceipt } from "@claude-bot/workspace-files-contract";

export type SaveStatus =
  /** Nothing has been submitted since the buffer was last loaded or saved. */
  | "idle"
  /** A proposal is in flight. */
  | "saving"
  /** Accepted and applied — a scope where the write is not card-gated. */
  | "saved"
  /** Accepted and waiting for a person. The normal outcome. */
  | "submitted"
  /** The file is no longer the version this edit was based on. */
  | "conflict"
  /** Anything else the port said no to. */
  | "refused";

export interface SaveState {
  status: SaveStatus;
  /** Bounded text somebody wrote for a person to read. */
  message: string;
  /** The port's own code, for a consumer that wants to branch machine-readably. */
  code: WorkspaceFilesRefusalCode | "";
  /**
   * The receipt of the last applied write, when there was one.
   *
   * Its `afterDigest` becomes the next edit's precondition, which is why the
   * receipt is worth keeping rather than reducing to a boolean: it is what lets
   * a second save proceed without re-reading the whole file.
   */
  receipt: WorkspaceMutationReceipt | null;
}

export const IDLE_SAVE: SaveState = Object.freeze({ status: "idle", message: "", code: "", receipt: null });

/** The sentence each ending shows. Written here so the component has none. */
const MESSAGES: Readonly<Record<Exclude<SaveStatus, "idle">, string>> = Object.freeze({
  saving: "正在提交…",
  saved: "已保存。",
  submitted:
    "已提交，等待批准。重新读取或关闭不会撤销这次待批准写入；若不希望写入，请在可信审批栏拒绝。批准后请重新读取确认结果。",
  conflict: "文件已被别处修改，这次编辑没有写入。请重新读取后再改一次。",
  refused: "这次保存没有完成。",
});

/**
 * Turn one port answer into the next state.
 *
 * A pure function, so the four endings are testable without a DOM, a port or a
 * clock — and so the component below cannot grow a sixth ending by accident.
 */
/**
 * A save past one call's window is a staged upload (2026-10-20), and each step
 * is its own Gate call. Where writes are approved per call, the first step's
 * card cannot complete the save — approving it only begins an upload nobody
 * continues — so the panel must not say "approve, then re-read". It still
 * fails closed like `submitted`: another press would mint another card.
 */
const STAGED_SUBMITTED =
  "这个文件超过单次调用的窗口，需要分段保存；当前授权下每一步写入都要单独批准，所以这次保存无法在这里完成。"
  + "已生成的批准卡只会开始分段、不会改动文件，请在可信审批栏拒绝它。";

export function saveStateFrom(
  answer:
    | { ok: true; value: WorkspaceMutationReceipt }
    | { ok: false; code: WorkspaceFilesRefusalCode; message: string },
  options: { staged?: boolean } = {},
): SaveState {
  if (answer.ok) {
    return { status: "saved", message: MESSAGES.saved, code: "", receipt: answer.value };
  }
  if (answer.code === "approval_required") {
    // The trusted pending call outlives this untrusted View. In particular,
    // closing/reloading the panel only discards its local buffer; it cannot
    // cancel the approval card. Keep that lifecycle warning fixed here instead
    // of allowing a shorter provider message to accidentally hide it.
    return {
      status: "submitted",
      message: options.staged ? STAGED_SUBMITTED : MESSAGES.submitted,
      code: answer.code,
      receipt: null,
    };
  }
  if (answer.code === "digest_mismatch") {
    return { status: "conflict", message: answer.message || MESSAGES.conflict, code: answer.code, receipt: null };
  }
  return { status: "refused", message: answer.message || MESSAGES.refused, code: answer.code, receipt: null };
}

export const SAVING: SaveState = Object.freeze({
  status: "saving",
  message: MESSAGES.saving,
  code: "",
  receipt: null,
});

/**
 * May this panel offer to save right now?
 *
 * Four conditions, and each one is a different sentence a person would
 * otherwise have to guess at:
 *
 *  · the port does not write at all (a read-only composition, a harness);
 *  · this scope may not write (learned from one `read_only` refusal);
 *  · there is nothing to save (no document, or no change since it loaded);
 *  · a save is already in flight, awaiting approval, or based on a stale
 *    digest. Submitted/conflict states require an explicit reload before a
 *    second proposal can be honest.
 */
export function canSave(input: {
  writable: boolean;
  scopeReadOnly: boolean;
  hasDocument: boolean;
  dirty: boolean;
  status: SaveStatus;
}): boolean {
  if (!input.writable || input.scopeReadOnly) return false;
  if (!input.hasDocument || !input.dirty) return false;
  return input.status !== "saving" && input.status !== "submitted" && input.status !== "conflict";
}
