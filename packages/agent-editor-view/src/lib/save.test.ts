/**
 * The five endings of a save, without a DOM, a port or a clock.
 *
 * They are worth pinning separately from the component because the interesting
 * one is invisible on screen: `approval_required` is the NORMAL answer, and a
 * panel that treated it as an error (or as success) would be reporting something
 * that did not happen. The rest of this file is the boundary around the save
 * control — when it may be offered at all.
 */

import { describe, expect, it } from "vitest";
import type { WorkspaceMutationReceipt } from "@claude-bot/workspace-files-contract";
import { IDLE_SAVE, canSave, saveStateFrom } from "./save.js";

const RECEIPT: WorkspaceMutationReceipt = {
  ref: "f1",
  mutationId: "abcdefgh",
  operation: "replace_text",
  beforeDigest: `sha256:${"a".repeat(64)}`,
  afterDigest: `sha256:${"b".repeat(64)}`,
  sizeBytes: 5,
  committedAt: "2026-08-07T00:00:00.000Z",
  undo: "unsupported",
};

describe("saveStateFrom", () => {
  it("does not promise that approving one staged step completes a large save", () => {
    // A save past one call's window is staged; under per-call approval the
    // first step's card only begins an upload, so "approve, then re-read"
    // would be untrue. It still fails closed: no second card from this panel.
    const state = saveStateFrom({ ok: false, code: "approval_required", message: "需要批准" }, { staged: true });
    expect(state.status).toBe("submitted");
    expect(state.message).toContain("分段保存");
    expect(state.message).not.toContain("批准后请重新读取");
    expect(canSave({ writable: true, scopeReadOnly: false, hasDocument: true, dirty: true, status: state.status })).toBe(false);
  });

  it("treats approval_required as submitted, not as a failure", () => {
    const state = saveStateFrom({ ok: false, code: "approval_required", message: "需要设备主人批准" });
    expect(state.status).toBe("submitted");
    expect(state.code).toBe("approval_required");
    expect(state.message).toContain("关闭不会撤销");
    expect(state.message).toContain("可信审批栏拒绝");
    // Nothing was applied, so there is no receipt to show a digest from.
    expect(state.receipt).toBeNull();
  });

  it("keeps the receipt of an applied write, because the next edit needs it", () => {
    const state = saveStateFrom({ ok: true, value: RECEIPT });
    expect(state.status).toBe("saved");
    expect(state.receipt?.afterDigest).toBe(RECEIPT.afterDigest);
  });

  it("distinguishes a stale edit from every other refusal", () => {
    expect(saveStateFrom({ ok: false, code: "digest_mismatch", message: "" }).status).toBe("conflict");
    expect(saveStateFrom({ ok: false, code: "read_only", message: "" }).status).toBe("refused");
    expect(saveStateFrom({ ok: false, code: "unavailable", message: "" }).status).toBe("refused");
    expect(saveStateFrom({ ok: false, code: "too_large", message: "" }).status).toBe("refused");
  });

  it("prefers the Host's own words when it wrote any", () => {
    // The trusted side writes for a person, in the product's language and about
    // the actual situation. A generic fallback is only for when it said nothing.
    expect(saveStateFrom({ ok: false, code: "unavailable", message: "笔记本离线" }).message).toBe("笔记本离线");
    expect(saveStateFrom({ ok: false, code: "unavailable", message: "" }).message).toContain("没有完成");
  });
});

describe("canSave", () => {
  const base = { writable: true, scopeReadOnly: false, hasDocument: true, dirty: true, status: IDLE_SAVE.status };

  it("is true only when there is a change to submit and a way to submit it", () => {
    expect(canSave(base)).toBe(true);
    expect(canSave({ ...base, writable: false })).toBe(false);
    expect(canSave({ ...base, scopeReadOnly: true })).toBe(false);
    expect(canSave({ ...base, hasDocument: false })).toBe(false);
    expect(canSave({ ...base, dirty: false })).toBe(false);
    expect(canSave({ ...base, status: "saving" })).toBe(false);
  });

  it("requires reload after submission or conflict, but allows an explicit retry after a transient refusal", () => {
    // A second submitted proposal is a second approval card, while the first
    // may still be pending. A digest conflict cannot succeed without a new
    // snapshot. Both therefore fail closed until reload resets the state.
    expect(canSave({ ...base, status: "submitted" })).toBe(false);
    expect(canSave({ ...base, status: "conflict" })).toBe(false);
    expect(canSave({ ...base, status: "refused" })).toBe(true);
  });
});
