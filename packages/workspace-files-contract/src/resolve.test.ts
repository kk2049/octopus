/**
 * The resolve verb (ticket #243): the label grammar, the answer reader, and the
 * v2 remote client's half of the round trip.
 *
 * What matters here is the boundary discipline, not the happy path alone: an
 * invalid claim must die BEFORE a proposal exists, a v1 port must not have the
 * method at all, and an answer that does not echo this exact question must be
 * refused — the resolved ref is newly minted, so the echo is the only thing
 * tying answer to request.
 */

import { describe, expect, it } from "vitest";
import {
  RESOURCE_RESOLVE_PATH_ACTION,
  WORKSPACE_RESOLVE_LIMITS,
  readWorkspaceResolvedEntry,
  workspaceResolveLabelsProblem,
} from "./resolve.js";
import { WORKSPACE_FILES_PROPOSAL_ACTIONS, createRemoteWorkspaceFilesPort } from "./remote.js";
import { WORKSPACE_FILES_PROPOSAL_ACTIONS_V2, createRemoteWorkspaceFilesPortV2 } from "./remote-v2.js";

function transport(result: unknown, ok = true, code?: string, message = "") {
  const proposals: Array<{ action: string; params?: Record<string, string> }> = [];
  return {
    proposals,
    propose: async (action: string, params?: Record<string, string>) => {
      proposals.push({ action, params });
      return ok ? { ok: true, result, message: "" } : { ok: false, code, result: null, message };
    },
  };
}

const ANSWER = {
  base: "wf_root",
  path: "src/lib/file.ts",
  ref: "wf_file",
  label: "file.ts",
  kind: "file",
  sizeBytes: 12,
  exceedsTextLimit: false,
};

describe("the label grammar", () => {
  it("accepts ordinary names, including inner spaces and CJK", () => {
    expect(workspaceResolveLabelsProblem(["src", "技术报告 v2.md"])).toBeNull();
  });

  it("refuses navigation, separators, control bytes and whitespace edges", () => {
    expect(workspaceResolveLabelsProblem([])).not.toBeNull();
    expect(workspaceResolveLabelsProblem([""])).not.toBeNull();
    expect(workspaceResolveLabelsProblem(["."])).not.toBeNull();
    expect(workspaceResolveLabelsProblem([".."])).not.toBeNull();
    expect(workspaceResolveLabelsProblem(["a/b"])).not.toBeNull();
    expect(workspaceResolveLabelsProblem(["a\\b"])).not.toBeNull();
    expect(workspaceResolveLabelsProblem(["a\u0000b"])).not.toBeNull();
    expect(workspaceResolveLabelsProblem(["a\nb"])).not.toBeNull();
    expect(workspaceResolveLabelsProblem([" a"])).not.toBeNull();
    expect(workspaceResolveLabelsProblem(["a "])).not.toBeNull();
    expect(workspaceResolveLabelsProblem([12 as unknown as string])).not.toBeNull();
  });

  it("bounds depth and joined length", () => {
    const deep = Array.from({ length: WORKSPACE_RESOLVE_LIMITS.maxDepth + 1 }, () => "d");
    expect(workspaceResolveLabelsProblem(deep)).not.toBeNull();
    expect(workspaceResolveLabelsProblem(deep.slice(1))).toBeNull();
    const wide = ["x".repeat(201), "y".repeat(200)];
    expect(workspaceResolveLabelsProblem(wide)).not.toBeNull();
  });
});

describe("the answer reader", () => {
  it("round-trips a resolved file with no field added or dropped", () => {
    const read = readWorkspaceResolvedEntry(ANSWER);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.parse(JSON.stringify(read.value))).toEqual(ANSWER);
  });

  it("refuses kind other, unknown fields, and a label that is not path's tail", () => {
    expect(readWorkspaceResolvedEntry({ ...ANSWER, kind: "other" }).ok).toBe(false);
    expect(readWorkspaceResolvedEntry({ ...ANSWER, relativePath: "src" }).ok).toBe(false);
    expect(readWorkspaceResolvedEntry({ ...ANSWER, label: "other.ts" }).ok).toBe(false);
    expect(readWorkspaceResolvedEntry({ ...ANSWER, path: "src//file.ts" }).ok).toBe(false);
  });
});

describe("the v2 remote client's resolve", () => {
  it("is absent from a v1 port — v1's surface is frozen", () => {
    const v1 = createRemoteWorkspaceFilesPort(transport(null), "workspace");
    expect("resolvePath" in v1.port).toBe(false);
    expect([...WORKSPACE_FILES_PROPOSAL_ACTIONS]).not.toContain(RESOURCE_RESOLVE_PATH_ACTION);
    expect([...WORKSPACE_FILES_PROPOSAL_ACTIONS_V2]).toEqual([
      ...WORKSPACE_FILES_PROPOSAL_ACTIONS,
      RESOURCE_RESOLVE_PATH_ACTION,
    ]);
  });

  it("sends one proposal with the joined path and accepts the echoed answer", async () => {
    const wire = transport(ANSWER);
    const remote = createRemoteWorkspaceFilesPortV2(wire, "workspace");
    const answer = await remote.port.resolvePath!("wf_root", ["src", "lib", "file.ts"]);
    expect(wire.proposals).toEqual([{
      action: RESOURCE_RESOLVE_PATH_ACTION,
      params: { binding: "workspace", ref: "wf_root", path: "src/lib/file.ts" },
    }]);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.ref).toBe("wf_file");
    expect(answer.value.kind).toBe("file");
  });

  it("refuses an invalid claim before any proposal exists", async () => {
    const wire = transport(ANSWER);
    const remote = createRemoteWorkspaceFilesPortV2(wire, "workspace");
    const answer = await remote.port.resolvePath!("wf_root", ["..", "etc"]);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe("invalid_request");
    expect(wire.proposals).toEqual([]);
  });

  it("refuses an answer that does not echo this question", async () => {
    const wrongBase = await createRemoteWorkspaceFilesPortV2(transport({ ...ANSWER, base: "wf_other" }), "w")
      .port.resolvePath!("wf_root", ["src", "lib", "file.ts"]);
    expect(wrongBase.ok).toBe(false);
    const wrongPath = await createRemoteWorkspaceFilesPortV2(
      transport({ ...ANSWER, path: "src/file.ts", label: "file.ts" }),
      "w",
    ).port.resolvePath!("wf_root", ["src", "lib", "file.ts"]);
    expect(wrongPath.ok).toBe(false);
  });

  it("resolves a transport refusal as the provider's code, and a rejection as unavailable", async () => {
    const refused = await createRemoteWorkspaceFilesPortV2(
      transport(null, false, "approval_required", "要先批准"),
      "w",
    ).port.resolvePath!("wf_root", ["src"]);
    expect(!refused.ok && refused.code).toBe("approval_required");

    const thrown = await createRemoteWorkspaceFilesPortV2(
      { propose: async () => { throw new Error("boom"); } },
      "w",
    ).port.resolvePath!("wf_root", ["src"]);
    expect(!thrown.ok && thrown.code).toBe("unavailable");
  });

  it("hands nothing back after destroy, even for a call already in flight", async () => {
    let release: (() => void) | null = null;
    const remote = createRemoteWorkspaceFilesPortV2({
      propose: () => new Promise((resolveAnswer) => {
        release = () => resolveAnswer({ ok: true, result: ANSWER, message: "" });
      }),
    }, "w");
    const pending = remote.port.resolvePath!("wf_root", ["src", "lib", "file.ts"]);
    remote.destroy();
    release!();
    const answer = await pending;
    expect(!answer.ok && answer.code).toBe("scope_closed");
  });
});
