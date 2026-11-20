/**
 * `resolvePath` on the trusted provider (ticket #243): the chat-link walk,
 * executed server-side, one listing per level, one minted ref at the end.
 *
 * The properties that must hold are the ones the per-level View walk had:
 * descent only through entries the backend reported as plain directories, a
 * missing name is `not_found` after exactly the listings the walk needed, a
 * symlinked intermediate refuses rather than resolves, an invalid claim or a
 * bad ref costs ZERO backend calls, and a backend refusal at any level is the
 * verbatim answer. Plus one property only the vault can give: the resolved ref
 * is the SAME ref `listDirectory` would mint for that file.
 */

import { describe, expect, it } from "vitest";
import { WorkspaceFilesService } from "./service.js";
import {
  backendRefusal,
  type BackendListing,
  type BackendResult,
  type BackendRoot,
  type BackendTextWindow,
  type WorkspaceBinding,
  type WorkspaceFilesBackend,
} from "./types.js";

const BINDING: WorkspaceBinding = {
  device: "laptop-routing-id",
  deviceLabel: "我的笔记本",
  workspaceId: "ws_0123456789abcdef01234567",
  workspaceLabel: "demo",
};

/** A tiny tree: "" → src/ + link(other) + note.txt; "src" → file.ts + deep/. */
const TREE: Record<string, BackendListing> = {
  "": {
    entries: [
      { name: "src", kind: "directory", relativePath: "src" },
      { name: "link", kind: "other" },
      { name: "note.txt", kind: "file", relativePath: "note.txt", sizeBytes: 6 },
    ],
    truncated: false,
  },
  "src": {
    entries: [
      { name: "file.ts", kind: "file", relativePath: "src/file.ts", sizeBytes: 12 },
      { name: "deep", kind: "directory", relativePath: "src/deep" },
    ],
    truncated: false,
  },
  "src/deep": { entries: [], truncated: false },
};

function treeBackend(overrides: {
  refuseAt?: string;
  refusal?: BackendResult<BackendListing>;
} = {}): WorkspaceFilesBackend & { listed: string[] } {
  const listed: string[] = [];
  return {
    listed,
    async listRoots(): Promise<BackendResult<readonly BackendRoot[]>> {
      return { ok: true, value: [{ binding: BINDING }] };
    },
    async listEntries(_binding, relativePath): Promise<BackendResult<BackendListing>> {
      listed.push(relativePath);
      if (overrides.refuseAt === relativePath) {
        return overrides.refusal ?? backendRefusal("approval_required", "这次读取需要设备主人先在可信审批栏确认。");
      }
      const listing = TREE[relativePath];
      return listing ? { ok: true, value: listing } : backendRefusal("not_found", "这个文件或目录已经不在了。");
    },
    async readText(): Promise<BackendResult<BackendTextWindow>> {
      return backendRefusal("unavailable", "本测试不读文件");
    },
  };
}

async function rootRef(service: WorkspaceFilesService, backend: WorkspaceFilesBackend, scope = "scope-1") {
  const port = service.open({ scope, owner: "alice", backend });
  const roots = await port.refreshRoots();
  if (!roots.ok) throw new Error("roots refused");
  return { port, root: roots.value.roots[0]!.ref };
}

describe("resolvePath walks listings server-side", () => {
  it("resolves a nested file with one listing per level and echoes the question", async () => {
    const backend = treeBackend();
    const { port, root } = await rootRef(new WorkspaceFilesService(), backend);
    const answer = await port.resolvePath(root, ["src", "file.ts"]);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.base).toBe(root);
    expect(answer.value.path).toBe("src/file.ts");
    expect(answer.value.label).toBe("file.ts");
    expect(answer.value.kind).toBe("file");
    expect(answer.value.sizeBytes).toBe(12);
    expect(answer.value.exceedsTextLimit).toBe(false);
    expect(backend.listed).toEqual(["", "src"]);
  });

  it("mints the SAME ref listDirectory would mint for that file", async () => {
    const backend = treeBackend();
    const { port, root } = await rootRef(new WorkspaceFilesService(), backend);
    const resolved = await port.resolvePath(root, ["src", "file.ts"]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const src = await port.resolvePath(root, ["src"]);
    expect(src.ok && src.value.kind).toBe("directory");
    if (!src.ok) return;
    const listing = await port.listDirectory(src.value.ref);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const row = listing.value.entries.find((entry) => entry.label === "file.ts");
    expect(row?.ref).toBe(resolved.value.ref);
  });

  it("answers a directory endpoint as kind directory, and other as not_a_file", async () => {
    const { port, root } = await rootRef(new WorkspaceFilesService(), treeBackend());
    const directory = await port.resolvePath(root, ["src", "deep"]);
    expect(directory.ok && directory.value.kind).toBe("directory");
    const other = await port.resolvePath(root, ["link"]);
    expect(!other.ok && other.code).toBe("not_a_file");
  });

  it("refuses a symlinked intermediate instead of descending through it", async () => {
    const { port, root } = await rootRef(new WorkspaceFilesService(), treeBackend());
    const answer = await port.resolvePath(root, ["link", "escape.txt"]);
    expect(!answer.ok && answer.code).toBe("not_a_directory");
  });

  it("says not_found with the missing label, after only the listings it needed", async () => {
    const backend = treeBackend();
    const { port, root } = await rootRef(new WorkspaceFilesService(), backend);
    const answer = await port.resolvePath(root, ["src", "gone.ts"]);
    expect(!answer.ok && answer.code).toBe("not_found");
    if (answer.ok) return;
    expect(answer.message).toContain("gone.ts");
    expect(backend.listed).toEqual(["", "src"]);
  });

  it("refuses an invalid claim and a non-directory base with zero backend calls", async () => {
    const backend = treeBackend();
    const { port, root } = await rootRef(new WorkspaceFilesService(), backend);
    backend.listed.length = 0;

    const navigation = await port.resolvePath(root, ["..", "etc"]);
    expect(!navigation.ok && navigation.code).toBe("invalid_request");
    const empty = await port.resolvePath(root, []);
    expect(!empty.ok && empty.code).toBe("invalid_request");
    const forged = await port.resolvePath("wf_forged", ["src"]);
    expect(!forged.ok && forged.code).toBe("unknown_ref");
    expect(backend.listed).toEqual([]);

    const file = await port.resolvePath(root, ["note.txt"]);
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    backend.listed.length = 0;
    const fileAsBase = await port.resolvePath(file.value.ref, ["x"]);
    expect(!fileAsBase.ok && fileAsBase.code).toBe("wrong_kind");
    expect(backend.listed).toEqual([]);
  });

  it("stops at a backend refusal and forwards it verbatim — no second card", async () => {
    const backend = treeBackend({ refuseAt: "src" });
    const { port, root } = await rootRef(new WorkspaceFilesService(), backend);
    const answer = await port.resolvePath(root, ["src", "file.ts"]);
    expect(!answer.ok && answer.code).toBe("approval_required");
    expect(backend.listed).toEqual(["", "src"]);
  });

  it("refuses after the scope is closed", async () => {
    const service = new WorkspaceFilesService();
    const { port, root } = await rootRef(service, treeBackend());
    await service.closeScope("scope-1");
    const answer = await port.resolvePath(root, ["src", "file.ts"]);
    expect(!answer.ok && answer.code).toBe("scope_closed");
  });
});
