/**
 * What the provider projects for a `workspace-files/v2` scope, and what a v1
 * scope keeps projecting beside it.
 *
 * The two run against the same service and the same backend, so the difference
 * is only the scope's declaration — which is the property the compatibility
 * story rests on: a v1 binding on a build that also serves v2 sees byte-identical
 * answers.
 */

import { describe, expect, it } from "vitest";
import {
  WORKSPACE_FILES_CONTRACT_V2,
  isWorkspaceDirectoryKey,
  readWorkspaceFilesDirectory,
  readWorkspaceFilesDirectoryV2,
  readWorkspaceFilesRoots,
  readWorkspaceFilesRootsV2,
} from "@claude-bot/workspace-files-contract";
import { WorkspaceDirectoryKeys } from "./directory-key.js";
import { WorkspaceFilesService } from "./service.js";
import type {
  BackendListing,
  BackendResult,
  BackendRoot,
  WorkspaceBinding,
  WorkspaceFilesBackend,
} from "./types.js";

const OCTOPUS: WorkspaceBinding = {
  device: "laptop-routing-id",
  deviceLabel: "我的笔记本",
  workspaceId: "ws_0123456789abcdef01234567",
  workspaceLabel: "octopus",
};

const NOTES: WorkspaceBinding = {
  device: "laptop-routing-id",
  deviceLabel: "我的笔记本",
  workspaceId: "ws_76543210fedcba9876543210",
  workspaceLabel: "notes",
};

function backend(roots: readonly WorkspaceBinding[] = [OCTOPUS, NOTES]): WorkspaceFilesBackend {
  return {
    async listRoots(): Promise<BackendResult<readonly BackendRoot[]>> {
      return { ok: true, value: roots.map((binding) => ({ binding })) };
    },
    async listEntries(_binding, relativePath): Promise<BackendResult<BackendListing>> {
      const prefix = relativePath ? `${relativePath}/` : "";
      return {
        ok: true,
        value: {
          entries: [
            { name: "src", kind: "directory", relativePath: `${prefix}src` },
            { name: "docs", kind: "directory", relativePath: `${prefix}docs` },
            { name: "README.md", kind: "file", relativePath: `${prefix}README.md`, sizeBytes: 12 },
            { name: "link", kind: "other" },
          ],
          truncated: false,
        },
      };
    },
    async readText() {
      return { ok: false as const, code: "unavailable" as const, message: "not used" };
    },
  };
}

function service(): WorkspaceFilesService {
  return new WorkspaceFilesService();
}

const KEYS = new WorkspaceDirectoryKeys();

function v2Scope(files: WorkspaceFilesService, over: { owner?: string; app?: string } = {}) {
  const owner = over.owner ?? "alice";
  const app = over.app ?? "session-plus";
  return files.open({
    scope: `${owner}/${app}/tab-1/workspace`,
    owner,
    backend: backend(),
    contract: WORKSPACE_FILES_CONTRACT_V2,
    directoryKey: (binding, relativePath) => KEYS.mint({
      owner,
      publisher: "octopus:first-party",
      app,
      device: binding.device,
      workspaceId: binding.workspaceId,
      relativePath,
    }),
  });
}

describe("a v1 scope on a build that also serves v2", () => {
  it("projects exactly what it always did", async () => {
    const port = service().open({ scope: "alice/session-plus/tab/workspace", owner: "alice", backend: backend() });
    const roots = await port.refreshRoots();
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(JSON.parse(JSON.stringify(roots.value))).toEqual({
      roots: [
        { ref: expect.any(String), label: "octopus", sourceLabel: "我的笔记本" },
        { ref: expect.any(String), label: "notes", sourceLabel: "我的笔记本" },
      ],
      truncated: false,
    });
    // And it survives the v1 reader, which refuses the field v2 adds.
    expect(readWorkspaceFilesRoots(roots.value).ok).toBe(true);

    const listing = await port.listDirectory(roots.value.roots[0]!.ref);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(readWorkspaceFilesDirectory(listing.value).ok).toBe(true);
    for (const entry of listing.value.entries) {
      expect("directoryKey" in entry).toBe(false);
    }
    expect("directoryKey" in listing.value).toBe(false);
  });
});

describe("a v2 scope", () => {
  it("keys every root and every directory entry, and no file or symlink", async () => {
    const port = v2Scope(service());
    const roots = await port.refreshRoots();
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(readWorkspaceFilesRootsV2(roots.value).ok).toBe(true);
    for (const root of roots.value.roots) expect(isWorkspaceDirectoryKey(root.directoryKey)).toBe(true);
    // Two workspaces are two directories.
    expect(roots.value.roots[0]!.directoryKey).not.toBe(roots.value.roots[1]!.directoryKey);

    const listing = await port.listDirectory(roots.value.roots[0]!.ref);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(readWorkspaceFilesDirectoryV2(listing.value).ok).toBe(true);
    const byLabel = new Map(listing.value.entries.map((entry) => [entry.label, entry]));
    expect(isWorkspaceDirectoryKey(byLabel.get("src")!.directoryKey)).toBe(true);
    expect(isWorkspaceDirectoryKey(byLabel.get("docs")!.directoryKey)).toBe(true);
    expect("directoryKey" in byLabel.get("README.md")!).toBe(false);
    expect("directoryKey" in byLabel.get("link")!).toBe(false);
    // Siblings are not each other.
    expect(byLabel.get("src")!.directoryKey).not.toBe(byLabel.get("docs")!.directoryKey);
  });

  it("says which directory a listing IS, and matches the root it came from", async () => {
    const port = v2Scope(service());
    const roots = await port.refreshRoots();
    if (!roots.ok) return;
    const root = roots.value.roots[0]!;
    const listing = await port.listDirectory(root.ref);
    expect(listing.ok && listing.value.directoryKey).toBe(root.directoryKey);
  });

  it("keeps same-named directories in two workspaces apart", async () => {
    const port = v2Scope(service());
    const roots = await port.refreshRoots();
    if (!roots.ok) return;
    const [octopus, notes] = await Promise.all([
      port.listDirectory(roots.value.roots[0]!.ref),
      port.listDirectory(roots.value.roots[1]!.ref),
    ]);
    if (!octopus.ok || !notes.ok) throw new Error("listing refused");
    const octopusSrc = octopus.value.entries.find((entry) => entry.label === "src")!.directoryKey;
    const notesSrc = notes.value.entries.find((entry) => entry.label === "src")!.directoryKey;
    expect(isWorkspaceDirectoryKey(octopusSrc)).toBe(true);
    expect(octopusSrc).not.toBe(notesSrc);
  });

  it("keeps a nested directory apart from its namesake one level up", async () => {
    const port = v2Scope(service());
    const roots = await port.refreshRoots();
    if (!roots.ok) return;
    const top = await port.listDirectory(roots.value.roots[0]!.ref);
    if (!top.ok) return;
    const src = top.value.entries.find((entry) => entry.label === "src")!;
    const nested = await port.listDirectory(src.ref!);
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    expect(nested.value.directoryKey).toBe(src.directoryKey);
    const nestedSrc = nested.value.entries.find((entry) => entry.label === "src")!;
    expect(nestedSrc.directoryKey).not.toBe(src.directoryKey);
  });

  it("gives two owners and two apps different keys for one directory", async () => {
    const files = service();
    const [alice, bob, other] = await Promise.all([
      v2Scope(files).refreshRoots(),
      v2Scope(files, { owner: "bob" }).refreshRoots(),
      v2Scope(files, { app: "notes-app" }).refreshRoots(),
    ]);
    if (!alice.ok || !bob.ok || !other.ok) throw new Error("roots refused");
    expect(alice.value.roots[0]!.directoryKey).not.toBe(bob.value.roots[0]!.directoryKey);
    expect(alice.value.roots[0]!.directoryKey).not.toBe(other.value.roots[0]!.directoryKey);
  });

  it("never puts the device, the workspace id or a path on the wire", async () => {
    const port = v2Scope(service());
    const roots = await port.refreshRoots();
    if (!roots.ok) return;
    const listing = await port.listDirectory(roots.value.roots[0]!.ref);
    const wire = JSON.stringify([roots.value, listing.ok ? listing.value : null]);
    expect(wire).not.toContain(OCTOPUS.device);
    expect(wire).not.toContain(OCTOPUS.workspaceId);
    expect(wire).not.toContain(NOTES.workspaceId);
    expect(wire).not.toContain("relative_path");
    expect(wire).not.toContain("relativePath");
  });

  it("does not accept a key as a ref — there is no reverse index to look one up in", async () => {
    // The key is an equality token, not an address. Nothing maps it back, so a
    // consumer submitting one lands in the same place a forged ref does: refused
    // by the vault, with ZERO backend calls, hence no Runner frame and no
    // approval card.
    let listings = 0;
    let reads = 0;
    const port = service().open({
      scope: "alice/session-plus/tab/workspace",
      owner: "alice",
      contract: WORKSPACE_FILES_CONTRACT_V2,
      directoryKey: (binding, relativePath) => KEYS.mint({
        owner: "alice",
        publisher: "octopus:first-party",
        app: "session-plus",
        device: binding.device,
        workspaceId: binding.workspaceId,
        relativePath,
      }),
      backend: {
        async listRoots(): Promise<BackendResult<readonly BackendRoot[]>> {
          return { ok: true, value: [{ binding: OCTOPUS }] };
        },
        async listEntries(): Promise<BackendResult<BackendListing>> {
          listings += 1;
          return { ok: true, value: { entries: [], truncated: false } };
        },
        async readText() {
          reads += 1;
          return { ok: false as const, code: "unavailable" as const, message: "" };
        },
      },
    });
    const roots = await port.refreshRoots();
    if (!roots.ok) throw new Error("roots refused");
    const key = roots.value.roots[0]!.directoryKey!;
    expect(isWorkspaceDirectoryKey(key)).toBe(true);

    const listed = await port.listDirectory(key);
    const opened = await port.openText(key);
    expect(listed.ok).toBe(false);
    expect(opened.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe("unknown_ref");
    if (!opened.ok) expect(opened.code).toBe("unknown_ref");
    expect(listings).toBe(0);
    expect(reads).toBe(0);
  });

  it("omits the key rather than inventing one when the minter declines", async () => {
    const port = service().open({
      scope: "alice/session-plus/tab/workspace",
      owner: "alice",
      backend: backend(),
      contract: WORKSPACE_FILES_CONTRACT_V2,
      directoryKey: () => null,
    });
    const roots = await port.refreshRoots();
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    for (const root of roots.value.roots) expect("directoryKey" in root).toBe(false);
    // And the answer is still a valid v2 answer: the field is optional.
    expect(readWorkspaceFilesRootsV2(roots.value).ok).toBe(true);
  });
});
