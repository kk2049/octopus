/**
 * `workspace-files/v2`'s readers, and v1's continued refusal of them.
 *
 * The pair of assertions is the point of the whole version: v2 accepts a
 * `directoryKey`, v1 refuses one, and neither had to be taught anything about
 * the other. Anything less would mean the two contracts could be handed each
 * other's answers, which is the failure a second contract id exists to prevent.
 */

import { describe, expect, it } from "vitest";
import {
  isWorkspaceDirectoryKey,
  WORKSPACE_DIRECTORY_KEY_MAX_LENGTH,
} from "./directory-key.js";
import {
  readWorkspaceFilesDirectory,
  readWorkspaceFilesEntry,
  readWorkspaceFilesRoot,
  readWorkspaceFilesRoots,
} from "./projection.js";
import {
  WORKSPACE_FILES_CONTRACT_V2,
  readWorkspaceFilesDirectoryV2,
  readWorkspaceFilesEntryV2,
  readWorkspaceFilesRootV2,
  readWorkspaceFilesRootsV2,
} from "./projection-v2.js";
import { WORKSPACE_FILES_CONTRACT } from "./limits.js";

/** What a real mint produces: `dk1_` plus 128 bits of base64url. */
const KEY = `dk1_${"A".repeat(22)}`;
const OTHER_KEY = `dk1_${"B".repeat(22)}`;

const ROOT = { ref: "wf_root", label: "demo", sourceLabel: "我的笔记本" };
const DIR_ENTRY = { ref: "wf_dir", label: "src", kind: "directory" as const };
const FILE_ENTRY = { ref: "wf_file", label: "index.ts", kind: "file" as const };

describe("the directory key's grammar", () => {
  it("accepts what this build mints and nothing that merely looks like it", () => {
    expect(isWorkspaceDirectoryKey(KEY)).toBe(true);
    for (const bad of [
      "",
      "dk1_",
      "dk1_short",
      `dk2_${"A".repeat(22)}`,
      "A".repeat(22),
      `dk1_${"A".repeat(20)}==`,
      "dk1_" + "A".repeat(WORKSPACE_DIRECTORY_KEY_MAX_LENGTH),
      "wf_0123456789abcdefghij",
      42,
      null,
      undefined,
    ]) {
      expect(isWorkspaceDirectoryKey(bad), String(bad)).toBe(false);
    }
  });

  it("is a different contract id, not a widening of v1", () => {
    expect(WORKSPACE_FILES_CONTRACT_V2).toBe("workspace-files/v2");
    expect(WORKSPACE_FILES_CONTRACT_V2).not.toBe(WORKSPACE_FILES_CONTRACT);
  });
});

describe("v1 keeps refusing the field v2 added", () => {
  it("refuses a keyed root, roots envelope, entry and listing", () => {
    expect(readWorkspaceFilesRoot({ ...ROOT, directoryKey: KEY }).ok).toBe(false);
    expect(readWorkspaceFilesRoots({ roots: [{ ...ROOT, directoryKey: KEY }], truncated: false }).ok).toBe(false);
    expect(readWorkspaceFilesEntry({ ...DIR_ENTRY, directoryKey: KEY }).ok).toBe(false);
    expect(readWorkspaceFilesDirectory({
      ref: "wf_dir",
      label: "src",
      entries: [{ ...DIR_ENTRY, directoryKey: KEY }],
      truncated: false,
      directoryKey: KEY,
    }).ok).toBe(false);
  });

  it("still accepts every v1 answer unchanged", () => {
    expect(readWorkspaceFilesRoots({ roots: [ROOT], truncated: false }).ok).toBe(true);
    expect(readWorkspaceFilesDirectory({
      ref: "wf_dir",
      label: "src",
      entries: [DIR_ENTRY, FILE_ENTRY],
      truncated: false,
    }).ok).toBe(true);
  });
});

describe("v2 readers", () => {
  it("reads a root with and without a key, and refuses a malformed one", () => {
    const keyed = readWorkspaceFilesRootV2({ ...ROOT, directoryKey: KEY });
    expect(keyed.ok && keyed.value.directoryKey).toBe(KEY);
    const bare = readWorkspaceFilesRootV2(ROOT);
    expect(bare.ok && "directoryKey" in bare.value).toBe(false);
    expect(readWorkspaceFilesRootV2({ ...ROOT, directoryKey: "nope" }).ok).toBe(false);
  });

  it("inherits every v1 refusal rather than restating it", () => {
    // Unknown field, missing field, and the `other`-with-a-ref rule: all of
    // them are v1's, and v2 gets them by delegating rather than by copying.
    expect(readWorkspaceFilesRootV2({ ...ROOT, device: "laptop" }).ok).toBe(false);
    expect(readWorkspaceFilesRootV2({ ref: "wf_root", label: "demo" }).ok).toBe(false);
    expect(readWorkspaceFilesEntryV2({ ref: "wf_x", label: "link", kind: "other" }).ok).toBe(false);
    expect(readWorkspaceFilesEntryV2({ label: "link", kind: "other" }).ok).toBe(true);
  });

  it("allows a key on a directory only", () => {
    expect(readWorkspaceFilesEntryV2({ ...DIR_ENTRY, directoryKey: KEY }).ok).toBe(true);
    expect(readWorkspaceFilesEntryV2({ ...FILE_ENTRY, directoryKey: KEY }).ok).toBe(false);
    expect(readWorkspaceFilesEntryV2({ label: "link", kind: "other", directoryKey: KEY }).ok).toBe(false);
  });

  it("reads a listing's own key and its entries' keys independently", () => {
    const read = readWorkspaceFilesDirectoryV2({
      ref: "wf_parent",
      label: "octopus",
      entries: [{ ...DIR_ENTRY, directoryKey: OTHER_KEY }, FILE_ENTRY],
      truncated: false,
      directoryKey: KEY,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.directoryKey).toBe(KEY);
    expect(read.value.entries[0]!.directoryKey).toBe(OTHER_KEY);
    expect("directoryKey" in read.value.entries[1]!).toBe(false);
  });

  it("reads a roots envelope with keyed and unkeyed rows side by side", () => {
    const read = readWorkspaceFilesRootsV2({
      roots: [{ ...ROOT, directoryKey: KEY }, { ...ROOT, ref: "wf_root2" }],
      truncated: true,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.truncated).toBe(true);
    expect(read.value.roots.map((row) => row.directoryKey)).toEqual([KEY, undefined]);
  });

  it("refuses a keyed row inside an otherwise valid envelope", () => {
    expect(readWorkspaceFilesRootsV2({
      roots: [{ ...ROOT, directoryKey: "not-a-key" }],
      truncated: false,
    }).ok).toBe(false);
    expect(readWorkspaceFilesDirectoryV2({
      ref: "wf_parent",
      label: "octopus",
      entries: [{ ...FILE_ENTRY, directoryKey: KEY }],
      truncated: false,
    }).ok).toBe(false);
  });
});
