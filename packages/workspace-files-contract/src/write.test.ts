/**
 * The write half's declaration and its receipt.
 *
 * Two groups, and the first one is the interesting one: it pins WHY
 * `replace_text` is serviceable over the Agent View's proposal wire — exactly
 * one parameter is declared above the default bound, and it stays under the
 * ceiling the transport can deliver. P6a asserted the opposite here, because the
 * bound had not been raised yet; that reversal is the editor batch's wire
 * ruling, and this file is where it is visible.
 */

import { describe, expect, it } from "vitest";
import { WIRE_PARAM_LIMITS, mcpToolsOf } from "@claude-bot/typed-port-kit";
import {
  WORKSPACE_FILES_ACTIONS,
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_DECLARATION,
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_FILES_REFUSALS,
  WORKSPACE_FILES_REFUSAL_VOCABULARY,
  WORKSPACE_FILES_WIRE_ACTIONS,
  isWorkspaceContentDigest,
  readWorkspaceMutationReceipt,
} from "./index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: "wf_file_1",
    mutationId: "0123456789abcdef",
    operation: "replace_text",
    beforeDigest: DIGEST,
    afterDigest: OTHER,
    sizeBytes: 42,
    committedAt: "2026-08-07T12:34:56.000Z",
    undo: "unsupported",
    ...overrides,
  };
}

describe("the declaration", () => {
  it("states four actions and which permission token each spends", () => {
    expect(WORKSPACE_FILES_DECLARATION.contract).toBe(WORKSPACE_FILES_CONTRACT);
    expect([...WORKSPACE_FILES_DECLARATION.actionIds]).toEqual([
      "refresh_roots",
      "list_directory",
      "open_text",
      "replace_text",
    ]);
    expect([...WORKSPACE_FILES_DECLARATION.operations]).toEqual([
      "list_session_workspaces",
      "list_workspace_entries",
      "read_workspace_text",
      "replace_workspace_text",
    ]);
  });

  it("travels the View wire, on the one raised parameter the ruling allows", () => {
    // P6a reported `replace_text` as unserviceable, because a file body does not
    // fit in a 512-character parameter. The editor batch raised the bound for
    // ONE declared parameter per action (ceiling 384 KiB), so the write is now
    // wire-serviceable — structurally, at declaration time, rather than as a
    // surprise at the first call.
    for (const action of WORKSPACE_FILES_ACTIONS) {
      expect(WORKSPACE_FILES_DECLARATION.wireProblems[action], action).toEqual([]);
    }
    expect([...WORKSPACE_FILES_WIRE_ACTIONS]).toEqual([...WORKSPACE_FILES_ACTIONS]);
  });

  it("raises exactly one parameter, and keeps it under the wire's ceiling", () => {
    // The other two parameters of the write stay at the default. Raising a
    // second one would make the action undeliverable in one message, which the
    // kit reports rather than discovers.
    const params = WORKSPACE_FILES_DECLARATION.byAction.replace_text.params;
    const raised = Object.entries(params).filter(
      ([, field]) => (field.maxLength ?? 0) > WIRE_PARAM_LIMITS.maxValueLength,
    );
    expect(raised.map(([name]) => name)).toEqual(["text"]);
    expect(WORKSPACE_FILES_LIMITS.maxWriteTextBytes).toBeLessThanOrEqual(
      WIRE_PARAM_LIMITS.maxDeclaredValueLength,
    );
  });

  it("bounds the write smaller than the read, and says both numbers", () => {
    // The asymmetry is the point: a read arrives as bounded windows, a write is
    // one whole value on one call.
    expect(WORKSPACE_FILES_LIMITS.maxWriteTextBytes).toBeLessThan(WORKSPACE_FILES_LIMITS.maxTextBytes);
    const text = WORKSPACE_FILES_DECLARATION.byAction.replace_text.params.text;
    expect(text.maxLength).toBe(WORKSPACE_FILES_LIMITS.maxWriteTextBytes);
    expect(text.description).toContain(String(WORKSPACE_FILES_LIMITS.maxWriteTextBytes));
  });

  it("carries every declared bound onto the MCP face", () => {
    // The counter-example this derivation exists for is the hand-written
    // generator that emits `{type}` and drops the limits — a model that cannot
    // see a bound exceeds it and is then refused for a reason nobody told it.
    const tool = mcpToolsOf(WORKSPACE_FILES_DECLARATION).find((row) => row.name.endsWith("replace_text"));
    expect(tool).toBeDefined();
    const properties = tool!.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.text.maxLength).toBe(WORKSPACE_FILES_LIMITS.maxWriteTextBytes);
    expect(properties.expected_digest.pattern).toBe("^sha256:[0-9a-f]{64}$");
    expect(properties.ref.maxLength).toBe(WORKSPACE_FILES_LIMITS.maxRefLength);
    // 2026-10-20: the body and the precondition are per-stage requirements (a
    // staged `append` carries no precondition, `begin`/`commit` no body), so
    // the declaration demands only the ref and the reader checks the rest.
    expect(tool!.inputSchema.required?.slice().sort()).toEqual(["ref"]);
    expect(properties.stage.enum).toEqual(["begin", "append", "commit"]);
    expect(tool!.inputSchema.additionalProperties).toBe(false);
  });

  it("declares one closed refusal set, shared with the read half", () => {
    expect([...WORKSPACE_FILES_REFUSAL_VOCABULARY.codes]).toEqual([...WORKSPACE_FILES_REFUSALS]);
    expect(WORKSPACE_FILES_REFUSAL_VOCABULARY.fallback).toBe("unavailable");
    expect(WORKSPACE_FILES_REFUSAL_VOCABULARY.has("digest_mismatch")).toBe(true);
    expect(WORKSPACE_FILES_REFUSAL_VOCABULARY.has("read_only")).toBe(true);
    // A code from a newer Host folds rather than being rendered as if it meant
    // something.
    expect(WORKSPACE_FILES_REFUSAL_VOCABULARY.fold("quantum_flux", "…", "…").code).toBe("unavailable");
  });
});

describe("the mutation receipt", () => {
  it("reads a well-formed receipt into exactly the declared fields", () => {
    const read = readWorkspaceMutationReceipt(receipt());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual({
      ref: "wf_file_1",
      mutationId: "0123456789abcdef",
      operation: "replace_text",
      beforeDigest: DIGEST,
      afterDigest: OTHER,
      sizeBytes: 42,
      committedAt: "2026-08-07T12:34:56.000Z",
      undo: "unsupported",
    });
  });

  it("refuses anything the trusted side is not supposed to be telling a View", () => {
    for (const extra of [
      { path: "/home/alice/demo/a.ts" },
      { device: "laptop" },
      { workspace_id: "ws_0123456789abcdef01234567" },
      { owner: "alice" },
      { contextId: "ctx_1" },
    ]) {
      const read = readWorkspaceMutationReceipt(receipt(extra));
      expect(read.ok, JSON.stringify(extra)).toBe(false);
      if (!read.ok) expect(read.issues[0].code).toBe("unknown_field");
    }
  });

  it("refuses a malformed digest, id, instant, size or undo state", () => {
    for (const bad of [
      { beforeDigest: "deadbeef" },
      { afterDigest: `md5:${"a".repeat(32)}` },
      { mutationId: "short" },
      { committedAt: "2026-08-07 12:34:56" },
      { sizeBytes: -1 },
      { sizeBytes: WORKSPACE_FILES_LIMITS.maxTextBytes + 1 },
      { undo: "maybe" },
      { operation: "delete_file" },
    ]) {
      expect(readWorkspaceMutationReceipt(receipt(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("recognises exactly the digest form this contract speaks", () => {
    expect(isWorkspaceContentDigest(DIGEST)).toBe(true);
    for (const bad of ["", `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, "sha1:abc", 7, null]) {
      expect(isWorkspaceContentDigest(bad), String(bad)).toBe(false);
    }
  });
});
