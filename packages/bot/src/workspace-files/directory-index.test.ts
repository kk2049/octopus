import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addWorkspace, listSessionWorkspaces } from "@claude-bot/runner/workspaces";
import { WORKSPACE_FILES_CONTRACT_V2, isWorkspaceDirectoryKey } from "@claude-bot/workspace-files-contract";
import { publicWorkspaceSnapshot } from "../session-resource/projection.js";
import {
  WorkspaceDirectorySnapshotIndex,
  readWorkspaceDirectorySnapshot,
  type WorkspaceDirectoryRoot,
  type WorkspaceDirectorySnapshotScope,
} from "./directory-index.js";
import { WorkspaceDirectoryKeys } from "./directory-key.js";
import { WorkspaceFilesService } from "./service.js";
import type { BackendListing, BackendResult, BackendRoot } from "./types.js";

const DEVICE = "laptop";
const ROOT = "ws_0123456789abcdef01234567";
const OTHER_ROOT = "ws_89abcdef0123456701234567";
const homes: string[] = [];

it("projects bounded terminal readiness without carrying device authority fields", () => {
  const snapshot = readWorkspaceDirectorySnapshot({ workspaces: [], terminal: {
    available: false, reason: "x".repeat(300), approved: true, owner: "forged",
  } }, DEVICE)!;
  expect(publicWorkspaceSnapshot(snapshot)).toEqual({
    device: DEVICE, workspaces: [], terminal: { available: false, reason: "x".repeat(240) },
  });
  expect(readWorkspaceDirectorySnapshot({ workspaces: [], terminal: { available: "true" } }, DEVICE))
    .not.toHaveProperty("terminal");
  expect(readWorkspaceDirectorySnapshot({ workspaces: [] }, DEVICE)).not.toHaveProperty("terminal");
});

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function testHome(): string {
  const home = mkdtempSync(join(tmpdir(), "directory-index-"));
  homes.push(home);
  return home;
}

function scope(overrides: Partial<WorkspaceDirectorySnapshotScope> = {}): WorkspaceDirectorySnapshotScope {
  return {
    owner: "alice",
    publisher: "octopus:first-party",
    app: "session-plus",
    instance: "tab-1",
    ...overrides,
  };
}

function answer(input: {
  roots?: unknown[];
  associations?: unknown[];
} = {}): Record<string, unknown> {
  return {
    workspaces: input.roots ?? [{ id: ROOT, label: "Octopus", display: "~/lht/octopus" }],
    session_directories: input.associations ?? [
      { source: "claude", id: "s1", workspace_id: ROOT, relative_path: "packages/bot" },
    ],
  };
}

function directoryKey(
  keys: WorkspaceDirectoryKeys,
  workspaceId: string,
  relativePath: string,
): string | null {
  return keys.mint({
    owner: "alice",
    publisher: "octopus:first-party",
    app: "session-plus",
    device: DEVICE,
    workspaceId,
    relativePath,
  });
}

/** A real workspace-files/v2 projection over roots normalized from Runner wire. */
function filesPort(keys: WorkspaceDirectoryKeys, roots: readonly WorkspaceDirectoryRoot[]) {
  return new WorkspaceFilesService().open({
    scope: "alice/session-plus/tab/workspace",
    owner: "alice",
    contract: WORKSPACE_FILES_CONTRACT_V2,
    directoryKey: (binding, relativePath) => directoryKey(keys, binding.workspaceId, relativePath),
    backend: {
      async listRoots(): Promise<BackendResult<readonly BackendRoot[]>> {
        return {
          ok: true,
          value: roots.map((root) => ({
            binding: {
              device: DEVICE,
              deviceLabel: "我的笔记本",
              workspaceId: root.workspaceId,
              workspaceLabel: root.label,
            },
          })),
        };
      },
      async listEntries(_binding, relativePath): Promise<BackendResult<BackendListing>> {
        const prefix = relativePath ? `${relativePath}/` : "";
        return {
          ok: true,
          value: {
            entries: [
              { name: "src", kind: "directory", relativePath: `${prefix}src` },
              { name: "docs", kind: "directory", relativePath: `${prefix}docs` },
            ],
            truncated: false,
          },
        };
      },
      async readText() {
        return { ok: false as const, code: "unavailable" as const, message: "not used" };
      },
    },
  });
}

describe("workspace directory reply normalization", () => {
  it("keeps the public roots and only same-answer canonical associations", () => {
    const snapshot = readWorkspaceDirectorySnapshot(answer({
      associations: [
        { source: "claude", id: "s1", workspace_id: ROOT, relative_path: "packages/bot" },
        { source: "codex", id: "outside", workspace_id: OTHER_ROOT, relative_path: "" },
        { source: "claude", id: "escape", workspace_id: ROOT, relative_path: "../escape" },
        { source: "shell", id: "unknown", workspace_id: ROOT, relative_path: "" },
      ],
    }), DEVICE);

    expect(snapshot).toEqual({
      device: DEVICE,
      roots: [{ workspaceId: ROOT, label: "Octopus", display: "~/lht/octopus" }],
      sessionDirectories: [
        { source: "claude", id: "s1", workspaceId: ROOT, relativePath: "packages/bot" },
      ],
    });
  });

  it("drops both conflicting locations instead of picking one", () => {
    const snapshot = readWorkspaceDirectorySnapshot(answer({
      associations: [
        { source: "codex", id: "same", workspace_id: ROOT, relative_path: "one" },
        { source: "codex", id: "same", workspace_id: ROOT, relative_path: "two" },
      ],
    }), DEVICE);
    expect(snapshot?.sessionDirectories).toEqual([]);
  });

  it("distinguishes a malformed envelope from a successful empty registry", () => {
    expect(readWorkspaceDirectorySnapshot({}, DEVICE)).toBeNull();
    expect(readWorkspaceDirectorySnapshot({ workspaces: [], session_directories: [] }, DEVICE)).toEqual({
      device: DEVICE,
      roots: [],
      sessionDirectories: [],
    });
  });

  it("preserves duplicate roots and applies sessions display slicing before trimming", () => {
    const display = `${" ".repeat(10)}${"x".repeat(240)}`;
    const snapshot = readWorkspaceDirectorySnapshot(answer({
      roots: [
        { id: ROOT, label: "first", display },
        { id: ROOT, label: "second", display: "~/second" },
      ],
      associations: [],
    }), DEVICE);
    expect(snapshot?.roots).toEqual([
      { workspaceId: ROOT, label: "first", display: "x".repeat(230) },
      { workspaceId: ROOT, label: "second", display: "~/second" },
    ]);
  });

  it("skips hostile invalid roots and keeps every valid one after them", () => {
    const invalidPrefix = Array.from({ length: 500 }, (_, index) => ({
      id: `invalid-${index}`,
      label: "ignored",
    }));
    const snapshot = readWorkspaceDirectorySnapshot(answer({
      roots: [...invalidPrefix, { id: ROOT, label: "kept", display: "~/kept" }],
      associations: [],
    }), DEVICE);

    expect(snapshot?.roots).toEqual([
      { workspaceId: ROOT, label: "kept", display: "~/kept" },
    ]);
  });

  it("keeps every valid root and association of one answer, however many (no 500 cut)", () => {
    const roots = Array.from({ length: 1_200 }, (_, index) => ({
      id: `ws_${index.toString(16).padStart(24, "0")}`,
      label: `root-${index}`,
      display: `~/root-${index}`,
    }));
    const associations = Array.from({ length: 1_200 }, (_, index) => ({
      source: "claude",
      id: `session-${index}`,
      workspace_id: roots[index]!.id,
      relative_path: "",
    }));

    const snapshot = readWorkspaceDirectorySnapshot(answer({ roots, associations }), DEVICE)!;
    expect(snapshot.roots).toHaveLength(1_200);
    expect(snapshot.roots.at(-1)?.label).toBe("root-1199");
    expect(snapshot.sessionDirectories).toHaveLength(1_200);
    // An association for a root past the old cut still joins.
    expect(snapshot.sessionDirectories.at(-1)).toMatchObject({ id: "session-1199", workspaceId: roots[1_199]!.id });
  });

  it("does not repair a whitespace-padded session identity", () => {
    const snapshot = readWorkspaceDirectorySnapshot(answer({
      associations: [
        { source: "claude", id: " s1 ", workspace_id: ROOT, relative_path: "packages/bot" },
      ],
    }), DEVICE)!;
    const index = new WorkspaceDirectorySnapshotIndex();
    index.replace(scope(), snapshot);

    expect(snapshot.sessionDirectories[0]?.id).toBe(" s1 ");
    expect(index.location(scope(), DEVICE, "claude", "s1")).toBeNull();
    expect(index.location(scope(), DEVICE, "claude", " s1 ")).not.toBeNull();
  });
});

describe("the sessions directory snapshot index", () => {
  it("isolates owner, publisher, app, instance and device", () => {
    const index = new WorkspaceDirectorySnapshotIndex();
    const snapshot = readWorkspaceDirectorySnapshot(answer(), DEVICE)!;
    index.replace(scope(), snapshot);

    expect(index.location(scope(), DEVICE, "claude", "s1")?.relativePath).toBe("packages/bot");
    expect(index.location(scope({ owner: "bob" }), DEVICE, "claude", "s1")).toBeNull();
    expect(index.location(scope({ publisher: "another" }), DEVICE, "claude", "s1")).toBeNull();
    expect(index.location(scope({ app: "another" }), DEVICE, "claude", "s1")).toBeNull();
    expect(index.location(scope({ instance: "tab-2" }), DEVICE, "claude", "s1")).toBeNull();
    expect(index.location(scope(), "desktop", "claude", "s1")).toBeNull();
  });

  it("replaces a whole device snapshot instead of accumulating stale associations", () => {
    const index = new WorkspaceDirectorySnapshotIndex();
    index.replace(scope(), readWorkspaceDirectorySnapshot(answer(), DEVICE)!);
    expect(index.location(scope(), DEVICE, "claude", "s1")).not.toBeNull();

    index.replace(
      scope(),
      readWorkspaceDirectorySnapshot(answer({ associations: [
        { source: "codex", id: "s2", workspace_id: ROOT, relative_path: "src" },
      ] }), DEVICE)!,
    );
    expect(index.location(scope(), DEVICE, "claude", "s1")).toBeNull();
    expect(index.location(scope(), DEVICE, "codex", "s2")?.relativePath).toBe("src");
  });

  it("keeps another device when one device is replaced", () => {
    const index = new WorkspaceDirectorySnapshotIndex();
    index.replace(scope(), readWorkspaceDirectorySnapshot(answer(), DEVICE)!);
    index.replace(scope(), readWorkspaceDirectorySnapshot(answer(), "desktop")!);
    index.replace(scope(), readWorkspaceDirectorySnapshot(answer({ associations: [] }), DEVICE)!);

    expect(index.location(scope(), DEVICE, "claude", "s1")).toBeNull();
    expect(index.location(scope(), "desktop", "claude", "s1")).not.toBeNull();
  });

  it("bounds scopes and devices by evicting the oldest successful snapshots", () => {
    const index = new WorkspaceDirectorySnapshotIndex(2, 2);
    const first = scope({ instance: "tab-1" });
    index.replace(first, readWorkspaceDirectorySnapshot(answer(), "laptop")!);
    index.replace(first, readWorkspaceDirectorySnapshot(answer(), "desktop")!);
    index.replace(first, readWorkspaceDirectorySnapshot(answer(), "tablet")!);

    expect(index.size(first)).toBe(2);
    expect(index.snapshot(first, "laptop")).toBeNull();
    expect(index.snapshot(first, "desktop")).not.toBeNull();
    expect(index.snapshot(first, "tablet")).not.toBeNull();

    const second = scope({ instance: "tab-2" });
    const third = scope({ instance: "tab-3" });
    index.replace(second, readWorkspaceDirectorySnapshot(answer(), DEVICE)!);
    index.replace(third, readWorkspaceDirectorySnapshot(answer(), DEVICE)!);
    expect(index.size()).toBe(2);
    expect(index.size(first)).toBe(0);
    expect(index.size(second)).toBe(1);
    expect(index.size(third)).toBe(1);
  });

  it("prunes dead scopes and can synchronously forget a retired instance", () => {
    const index = new WorkspaceDirectorySnapshotIndex();
    const gone = scope({ instance: "gone" });
    const live = scope({ instance: "live" });
    index.replace(gone, readWorkspaceDirectorySnapshot(answer(), DEVICE)!);
    index.replace(live, readWorkspaceDirectorySnapshot(answer(), DEVICE)!);

    index.prune((candidate) => candidate.instance === "live");
    expect(index.size()).toBe(1);
    expect(index.location(gone, DEVICE, "claude", "s1")).toBeNull();
    expect(index.location(live, DEVICE, "claude", "s1")).not.toBeNull();

    index.forget(live);
    expect(index.size()).toBe(0);
  });
});

describe("one directory identity across the two projections", () => {
  it("mints the same key from a sessions association and a file root", () => {
    // A fixed test secret makes this an equality proof, not a snapshot of a
    // process-random value.
    const keys = new WorkspaceDirectoryKeys(createHash("sha256").update("directory-index-test").digest());
    const snapshot = readWorkspaceDirectorySnapshot(answer({
      associations: [
        { source: "claude", id: "s1", workspace_id: ROOT, relative_path: "" },
      ],
    }), DEVICE)!;
    const identity = {
      owner: "alice",
      publisher: "octopus:first-party",
      app: "session-plus",
      device: DEVICE,
      workspaceId: ROOT,
      relativePath: "",
    };
    const fromSession = keys.mint({
      ...identity,
      workspaceId: snapshot.sessionDirectories[0]!.workspaceId,
      relativePath: snapshot.sessionDirectories[0]!.relativePath,
    });
    const fromFiles = keys.mint({ ...identity, workspaceId: snapshot.roots[0]!.workspaceId });
    expect(fromSession).toBe(fromFiles);
  });

  it("keeps a real Runner workspace root equal through the sessions and files projections", async () => {
    const keys = new WorkspaceDirectoryKeys(createHash("sha256").update("real-root-vertical").digest());
    const home = testHome();
    const project = join(home, "octopus");
    mkdirSync(project, { recursive: true });
    await addWorkspace(home, project, "Octopus");
    const wire = await listSessionWorkspaces(home, [{ source: "claude", id: "root-session", cwd: project }]);
    const snapshot = readWorkspaceDirectorySnapshot(wire, DEVICE)!;
    const index = new WorkspaceDirectorySnapshotIndex();
    index.replace(scope(), snapshot);

    const location = index.location(scope(), DEVICE, "claude", "root-session")!;
    const fromSession = directoryKey(keys, location.workspaceId, location.relativePath);
    const sessionRows = publicWorkspaceSnapshot(
      snapshot,
      (workspaceId) => directoryKey(keys, workspaceId, ""),
    ).workspaces as unknown as Array<Record<string, string>>;
    const files = await filesPort(keys, snapshot.roots).refreshRoots();
    if (!files.ok) throw new Error("files projection refused");

    expect(isWorkspaceDirectoryKey(fromSession)).toBe(true);
    expect(sessionRows[0]?.directoryKey).toBe(fromSession);
    expect(files.value.roots[0]?.directoryKey).toBe(fromSession);
  });

  it("keeps a real nested session equal to the corresponding file directory", async () => {
    const keys = new WorkspaceDirectoryKeys(createHash("sha256").update("real-nested-vertical").digest());
    const home = testHome();
    const project = join(home, "octopus");
    mkdirSync(join(project, "src"), { recursive: true });
    await addWorkspace(home, project, "Octopus");
    const wire = await listSessionWorkspaces(home, [{
      source: "codex",
      id: "nested-session",
      cwd: join(project, "src"),
    }]);
    const snapshot = readWorkspaceDirectorySnapshot(wire, DEVICE)!;
    const index = new WorkspaceDirectorySnapshotIndex();
    index.replace(scope(), snapshot);

    const location = index.location(scope(), DEVICE, "codex", "nested-session")!;
    expect(location.relativePath).toBe("src");
    const fromSession = directoryKey(keys, location.workspaceId, location.relativePath);
    const port = filesPort(keys, snapshot.roots);
    const roots = await port.refreshRoots();
    if (!roots.ok) throw new Error("files roots refused");
    const listing = await port.listDirectory(roots.value.roots[0]!.ref);
    if (!listing.ok) throw new Error("files listing refused");
    const src = listing.value.entries.find((entry) => entry.label === "src");

    expect(isWorkspaceDirectoryKey(fromSession)).toBe(true);
    expect(src?.directoryKey).toBe(fromSession);
    expect(roots.value.roots[0]?.directoryKey).not.toBe(fromSession);
  });
});
