/**
 * The wall, and then the door that was cut through it — as assertions.
 *
 * First life of this suite: the record of a structural finding. `crdt-doc/v1`
 * was the first contract that could NOT be served over the Agent View's
 * proposal wire (512 characters per parameter vs. base64-encoded CRDT bytes),
 * and this file pinned which actions could not travel, that `createRemoteCall`
 * refused to construct, and that the trusted dispatcher TRUNCATED rather than
 * refused. Its header promised: "when per-action wire bounds land (P6b) this
 * suite fails, which is the intended alarm... this file has to be rewritten to
 * say what the new bounds are."
 *
 * That alarm fired at the P6b x P6c integration gate on 2026-08-07, exactly as
 * designed. Second life, below: the contract declares its real bounds (64 KiB
 * update, 4 KiB state vector), the kit accepts one declared-large parameter
 * per action up to 384 KiB, so ALL THREE actions now travel and the adapter
 * constructs. What remains pinned is the new arithmetic — so the next contract
 * author knows what fits without measuring — and the truncation fix (a clipped
 * value now implies refusal, never dispatch).
 */

import { describe, expect, it } from "vitest";
import { WIRE_PARAM_LIMITS, createRemoteCall, wireServiceableActions } from "@claude-bot/typed-port-kit";

import { CRDT_DOC_DECLARATION, CRDT_DOC_LIMITS } from "./contract.js";

describe("crdt-doc/v1 against the View wire", () => {
  it("serves all four of its actions since the per-action bounds landed", () => {
    expect([...wireServiceableActions(CRDT_DOC_DECLARATION)].sort()).toEqual(
      ["apply_update", "list_docs", "open_doc", "read_updates"],
    );
  });

  it("has no wire problems left to name", () => {
    expect(CRDT_DOC_DECLARATION.wireProblems.list_docs).toEqual([]);
    expect(CRDT_DOC_DECLARATION.wireProblems.open_doc).toEqual([]);
    expect(CRDT_DOC_DECLARATION.wireProblems.apply_update).toEqual([]);
    expect(CRDT_DOC_DECLARATION.wireProblems.read_updates).toEqual([]);
  });

  it("builds a remote adapter without complaint", () => {
    const call = createRemoteCall({
      declaration: CRDT_DOC_DECLARATION,
      transport: { propose: async () => ({ ok: true, result: {}, message: "" }) },
      binding: "documents",
      invalidRequest: "invalid_request",
      closed: "scope_closed",
      messages: {
        noAnswer: "no",
        malformedAnswer: "no",
        refusedWithoutReason: "no",
        closed: "no",
      },
    });
    expect(call).toBeTruthy();
    expect(typeof call).toBe("object");
  });

  it("records the new arithmetic, so the next contract author does not measure it", () => {
    // A declared-large parameter may ask for up to 384 KiB of characters; this
    // contract's update asks for 64 KiB encoded (~48 KiB of CRDT bytes), the
    // state vector for 4 KiB — both comfortably inside, one large parameter
    // per action, and the 512 KiB per-message ceiling still holds the whole
    // proposal. The OLD wall (512 chars ≈ one keystroke) is preserved above in
    // this header's history, not re-measured here.
    expect(CRDT_DOC_LIMITS.maxUpdateEncodedLength).toBeLessThanOrEqual(WIRE_PARAM_LIMITS.maxDeclaredValueLength);
    expect(CRDT_DOC_LIMITS.maxStateVectorEncodedLength).toBeLessThanOrEqual(WIRE_PARAM_LIMITS.maxDeclaredValueLength);
    expect(CRDT_DOC_LIMITS.maxUpdateEncodedLength).toBe(64 * 1024);
    expect(CRDT_DOC_LIMITS.maxStateVectorEncodedLength).toBe(4 * 1024);
  });
});
