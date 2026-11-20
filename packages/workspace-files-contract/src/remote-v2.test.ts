/**
 * The v2 remote client: same wire, same checks, one extra field.
 *
 * `remote.test.ts` already pins the arrival checks against a lying transport,
 * and v2 goes through the SAME implementation — so what is worth testing here is
 * only what differs: that a key survives the trip, that a v1 client handed a v2
 * answer refuses it rather than dropping the field, and that the two clients
 * speak identical proposals.
 */

import { describe, expect, it } from "vitest";
import { WORKSPACE_FILES_CONTRACT } from "./limits.js";
import { WORKSPACE_FILES_CONTRACT_V2 } from "./projection-v2.js";
import { createRemoteWorkspaceFilesPort } from "./remote.js";
import { createRemoteWorkspaceFilesPortV2 } from "./remote-v2.js";

const KEY = `dk1_${"A".repeat(22)}`;

function transport(result: unknown) {
  const proposals: Array<{ action: string; params?: Record<string, string> }> = [];
  return {
    proposals,
    propose: async (action: string, params?: Record<string, string>) => {
      proposals.push({ action, params });
      return { ok: true, result, message: "" };
    },
  };
}

const KEYED_ROOTS = {
  roots: [{ ref: "wf_root", label: "octopus", sourceLabel: "我的笔记本", directoryKey: KEY }],
  truncated: false,
};

const KEYED_LISTING = {
  ref: "wf_dir",
  label: "src",
  entries: [{ ref: "wf_sub", label: "lib", kind: "directory", directoryKey: KEY }],
  truncated: false,
  directoryKey: KEY,
};

describe("the v2 remote client", () => {
  it("carries the key through roots and listings", async () => {
    const roots = await createRemoteWorkspaceFilesPortV2(transport(KEYED_ROOTS), "workspace")
      .port.refreshRoots();
    expect(roots.ok && roots.value.roots[0]!.directoryKey).toBe(KEY);

    const listing = await createRemoteWorkspaceFilesPortV2(transport(KEYED_LISTING), "workspace")
      .port.listDirectory("wf_dir");
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.value.directoryKey).toBe(KEY);
    expect(listing.value.entries[0]!.directoryKey).toBe(KEY);
  });

  it("refuses a v2 answer when the port is v1 — it does not quietly drop the field", () => {
    // The failure this rules out is the dangerous direction: a v1 module shown a
    // v2 listing, silently missing the field, joining nothing and reporting
    // success.
    return Promise.all([
      createRemoteWorkspaceFilesPort(transport(KEYED_ROOTS), "workspace").port.refreshRoots(),
      createRemoteWorkspaceFilesPort(transport(KEYED_LISTING), "workspace").port.listDirectory("wf_dir"),
    ]).then(([roots, listing]) => {
      expect(roots.ok).toBe(false);
      expect(listing.ok).toBe(false);
    });
  });

  it("still refuses a listing that answers for another directory", async () => {
    const listing = await createRemoteWorkspaceFilesPortV2(transport(KEYED_LISTING), "workspace")
      .port.listDirectory("wf_somewhere_else");
    expect(listing.ok).toBe(false);
  });

  it("sends the same proposals as v1 — no new action, no new parameter", async () => {
    const v1 = transport(null);
    const v2 = transport(null);
    await createRemoteWorkspaceFilesPort(v1, "workspace").port.listDirectory("wf_dir");
    await createRemoteWorkspaceFilesPortV2(v2, "workspace").port.listDirectory("wf_dir");
    expect(v2.proposals).toEqual(v1.proposals);
    expect(v2.proposals).toEqual([
      { action: "resource.list_directory", params: { binding: "workspace", ref: "wf_dir" } },
    ]);
  });

  it("declares which contract it is", () => {
    expect(createRemoteWorkspaceFilesPortV2(transport(null), "w").port.contract)
      .toBe(WORKSPACE_FILES_CONTRACT_V2);
    expect(createRemoteWorkspaceFilesPort(transport(null), "w").port.contract)
      .toBe(WORKSPACE_FILES_CONTRACT);
  });
});
