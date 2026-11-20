import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  promises as fsPromises,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addWorkspace,
  ensureDefaultWorkspace,
  listRegisteredWorkspaces,
  listSessionWorkspaces,
  removeWorkspace,
  renameWorkspace,
  resolveWorkspace,
  workspaceRegistryPath,
} from "./workspaces.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace registry", () => {
  it("registers the user's home as an idempotent default workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-workspaces-default-"));
    dirs.push(home);

    const first = await ensureDefaultWorkspace(home);
    expect(first).toMatchObject({ label: "Home", display: "~" });
    expect((await listSessionWorkspaces(home)).workspaces).toEqual([first]);

    const again = await ensureDefaultWorkspace(home);
    expect(again).toEqual(first);
    expect((await listRegisteredWorkspaces(home)).map(({ id, label, display }) => ({ id, label, display })))
      .toEqual([first]);
  });

  it("adds the default home without replacing existing project registrations", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-workspaces-default-"));
    dirs.push(home);
    const project = join(home, "project");
    mkdirSync(project);
    const projectWorkspace = await addWorkspace(home, project, "Project");

    const homeWorkspace = await ensureDefaultWorkspace(home);
    expect((await listSessionWorkspaces(home)).workspaces).toEqual([projectWorkspace, homeWorkspace]);
  });

  it("mints one persistent opaque id and never exposes the canonical path", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-workspaces-"));
    dirs.push(home);
    const secret = `canonical-secret-${Math.random().toString(16).slice(2)}`;
    const directory = join(home, "projects", secret);
    mkdirSync(directory, { recursive: true });

    const first = await addWorkspace(home, directory, "Session Plus");
    const again = await addWorkspace(home, directory, "ignored rename");
    expect(again).toEqual(first);
    expect(first.id).toMatch(/^ws_[0-9a-f]{24}$/);
    expect(first.id).not.toContain(secret);
    expect(first.display).toBe(`~/projects/${secret}`);

    const wire = await listSessionWorkspaces(home);
    expect(wire).toEqual({ workspaces: [first], session_directories: [] });
    expect(JSON.stringify(wire)).not.toContain(directory);
    expect(JSON.stringify(wire)).toContain(first.display);
    expect((await resolveWorkspace(home, first.id)).path).toBe(directory);

    expect(statSync(join(home, ".octopus-runner")).mode & 0o777).toBe(0o700);
    expect(statSync(workspaceRegistryPath(home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(workspaceRegistryPath(home), "utf8")).toContain(directory);
  });

  it("flushes the registry file without attempting unsupported Windows directory fsync", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-workspaces-win-")); dirs.push(home);
    const directory = join(home, "project"); mkdirSync(directory);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const originalOpen = fsPromises.open.bind(fsPromises);
    let fileSyncs = 0;
    const opened = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === join(home, ".octopus-runner")) throw Object.assign(new Error("unsupported directory fsync"), { code: "EPERM" });
      const handle = await originalOpen(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { fileSyncs++; await sync(); });
      return handle;
    });
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      const registered = await addWorkspace(home, directory, "Windows");
      expect((await resolveWorkspace(home, registered.id)).path).toBe(directory);
      expect(fileSyncs).toBeGreaterThan(0);
      expect(opened.mock.calls.some(([target]) => String(target) === join(home, ".octopus-runner"))).toBe(false);
    } finally { Object.defineProperty(process, "platform", platform); }
  });

  it("rejects path-shaped ids before touching the registry", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-workspaces-"));
    dirs.push(home);
    await expect(resolveWorkspace(home, "../../etc")).rejects.toThrow(/workspace_id/);
  });

  it("lists, renames and removes durable registrations for the installed CLI", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-workspaces-"));
    dirs.push(home);
    const directory = join(home, "projects", "managed");
    mkdirSync(directory, { recursive: true });
    const added = await addWorkspace(home, directory, "Before");
    expect(await listRegisteredWorkspaces(home)).toEqual([{ ...added, path: directory, available: true }]);
    expect((await renameWorkspace(home, added.id, "After")).label).toBe("After");
    expect(await removeWorkspace(home, added.id)).toBe(true);
    expect(await removeWorkspace(home, added.id)).toBe(false);
    expect(await listRegisteredWorkspaces(home)).toEqual([]);
  });

  it("reuses a parsed registry until its mtime or size changes", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-workspaces-"));
    dirs.push(home);
    const directory = join(home, "projects", "cached");
    mkdirSync(directory, { recursive: true });
    await addWorkspace(home, directory, "Alpha");

    const readFile = vi.spyOn(fsPromises, "readFile");
    const first = await listSessionWorkspaces(home);
    const readsAfterFirst = readFile.mock.calls.length;
    expect(readsAfterFirst).toBe(1);
    expect((await listSessionWorkspaces(home)).workspaces).toEqual(first.workspaces);
    expect(readFile).toHaveBeenCalledTimes(readsAfterFirst);

    const file = workspaceRegistryPath(home);
    const before = statSync(file);
    const changed = readFileSync(file, "utf8").replace('"label": "Alpha"', '"label": "Bravo"');
    writeFileSync(file, changed, "utf8");
    const changedTime = new Date(before.mtimeMs + 10_000);
    utimesSync(file, changedTime, changedTime);
    expect(statSync(file).size).toBe(before.size);

    const refreshed = await listSessionWorkspaces(home);
    expect(refreshed.workspaces[0]?.label).toBe("Bravo");
    expect(readFile).toHaveBeenCalledTimes(readsAfterFirst + 1);
  });

  it("does not infer workspaces from historical session directories", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-workspaces-"));
    dirs.push(home);
    const project = join(home, "projects", "observed");
    mkdirSync(project, { recursive: true });

    const first = await listSessionWorkspaces(home, [
      { cwd: project },
      { cwd: project },
      { cwd: "/definitely/missing" },
    ]);
    expect(first).toEqual({ workspaces: [], session_directories: [] });
    expect(JSON.stringify(first)).not.toContain(project);
    expect(existsSync(workspaceRegistryPath(home))).toBe(false);

    const again = await listSessionWorkspaces(home, [{ cwd: project }]);
    expect(again).toEqual(first);
  });

  it("omits a deleted workspace without deleting its durable registration", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-workspaces-"));
    dirs.push(home);
    const directory = join(home, "projects", "temporary");
    mkdirSync(directory, { recursive: true });
    const workspace = await addWorkspace(home, directory, "Temporary");
    const registered = readFileSync(workspaceRegistryPath(home), "utf8");

    rmSync(directory, { recursive: true, force: true });
    expect(await listSessionWorkspaces(home)).toEqual({ workspaces: [], session_directories: [] });
    expect(readFileSync(workspaceRegistryPath(home), "utf8")).toBe(registered);

    mkdirSync(directory, { recursive: true });
    expect((await listSessionWorkspaces(home)).workspaces).toEqual([workspace]);
  });
});

/**
 * The association half.
 *
 * Every assertion here is about the ONE question the bot cannot answer for
 * itself: which registered workspace, and where inside it. The canonical path
 * is checked to be absent from every response, because the whole reason this
 * computation happens on the device is that the answer must travel as
 * `(workspace_id, relative_path)` and nothing else.
 */
describe("session directory associations", () => {
  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), "runner-assoc-"));
    dirs.push(dir);
    return dir;
  }

  it("names a session at the workspace root with an empty relative path", async () => {
    const root = home();
    const project = join(root, "projects", "octopus");
    mkdirSync(project, { recursive: true });
    const workspace = await addWorkspace(root, project, "Octopus");

    const wire = await listSessionWorkspaces(root, [{ source: "claude", id: "sess-1", cwd: project }]);
    expect(wire.session_directories).toEqual([
      { source: "claude", id: "sess-1", workspace_id: workspace.id, relative_path: "" },
    ]);
    expect(JSON.stringify(wire)).not.toContain(project);
  });

  it("associates a nested cwd with its container instead of registering a second workspace", async () => {
    const root = home();
    const project = join(root, "projects", "octopus");
    const nested = join(project, "packages", "bot");
    mkdirSync(nested, { recursive: true });
    const workspace = await addWorkspace(root, project, "Octopus");

    const wire = await listSessionWorkspaces(root, [{ source: "codex", id: "sess-2", cwd: nested }]);
    expect(wire.workspaces).toHaveLength(1);
    expect(wire.session_directories).toEqual([
      { source: "codex", id: "sess-2", workspace_id: workspace.id, relative_path: "packages/bot" },
    ]);
  });

  it("picks the deepest container when workspaces nest", async () => {
    const root = home();
    const outer = join(root, "work");
    const inner = join(outer, "octopus");
    const leaf = join(inner, "src");
    mkdirSync(leaf, { recursive: true });
    await addWorkspace(root, outer, "Work");
    const innerWorkspace = await addWorkspace(root, inner, "Octopus");

    const wire = await listSessionWorkspaces(root, [{ source: "claude", id: "sess-3", cwd: leaf }]);
    expect(wire.session_directories).toEqual([
      { source: "claude", id: "sess-3", workspace_id: innerWorkspace.id, relative_path: "src" },
    ]);
  });

  it("keeps same-named siblings and same-named directories in two workspaces apart", async () => {
    const root = home();
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    mkdirSync(join(alpha, "src"), { recursive: true });
    mkdirSync(join(beta, "src"), { recursive: true });
    mkdirSync(join(alpha, "docs"), { recursive: true });
    const alphaWorkspace = await addWorkspace(root, alpha, "Alpha");
    const betaWorkspace = await addWorkspace(root, beta, "Beta");

    const wire = await listSessionWorkspaces(root, [
      { source: "claude", id: "a", cwd: join(alpha, "src") },
      { source: "claude", id: "b", cwd: join(beta, "src") },
      { source: "claude", id: "c", cwd: join(alpha, "docs") },
    ]);
    expect(wire.session_directories).toEqual([
      { source: "claude", id: "c", workspace_id: alphaWorkspace.id, relative_path: "docs" },
      { source: "claude", id: "a", workspace_id: alphaWorkspace.id, relative_path: "src" },
      { source: "claude", id: "b", workspace_id: betaWorkspace.id, relative_path: "src" },
    ]);
  });

  it("does not associate unregistered directories inside or outside the scan root", async () => {
    const root = home();
    const outside = mkdtempSync(join(tmpdir(), "runner-outside-"));
    dirs.push(outside);
    const loose = join(root, "loose");
    mkdirSync(loose, { recursive: true });

    const wire = await listSessionWorkspaces(root, [
      { source: "claude", id: "in", cwd: loose },
      { source: "claude", id: "out", cwd: outside },
    ]);
    expect(wire).toEqual({ workspaces: [], session_directories: [] });
  });

  it("does not turn ancestor or descendant session paths into workspaces", async () => {
    const root = home();
    const project = join(root, "project");
    const nested = join(project, "deep", "deeper");
    mkdirSync(nested, { recursive: true });

    const wire = await listSessionWorkspaces(root, [
      { source: "claude", id: "deep", cwd: nested },
      { source: "claude", id: "shallow", cwd: project },
    ]);
    expect(wire).toEqual({ workspaces: [], session_directories: [] });
  });

  it("drops a session that claims two different directories", async () => {
    const root = home();
    const one = join(root, "one");
    const two = join(root, "two");
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    const workspace = await addWorkspace(root, root, "Home");

    const wire = await listSessionWorkspaces(root, [
      { source: "claude", id: "same", cwd: one },
      { source: "claude", id: "same", cwd: two },
      { source: "claude", id: "other", cwd: one },
    ]);
    expect(wire.session_directories).toEqual([
      { source: "claude", id: "other", workspace_id: workspace.id, relative_path: "one" },
    ]);
  });

  it("ignores candidate directories that do not name a session", async () => {
    const root = home();
    const project = join(root, "unnamed");
    mkdirSync(project, { recursive: true });

    const wire = await listSessionWorkspaces(root, [
      { cwd: project },
      { source: "shell", id: "x", cwd: project },
      { source: "claude", cwd: project },
    ]);
    expect(wire).toEqual({ workspaces: [], session_directories: [] });
  });

  it("deduplicates cwd checks per request with bounded concurrency and revalidates on the next request", async () => {
    const root = home();
    const project = join(root, "many");
    mkdirSync(project);
    await addWorkspace(root, project);
    const children = Array.from({ length: 12 }, (_, index) => join(project, String(index)));
    for (const child of children) mkdirSync(child);
    const original = fsPromises.realpath.bind(fsPromises);
    let active = 0;
    let peak = 0;
    const realpath = vi.spyOn(fsPromises, "realpath").mockImplementation(async (file) => {
      active++; peak = Math.max(peak, active);
      try { return await original(file); } finally { active--; }
    });
    const candidates = children.flatMap((cwd, index) => Array.from({ length: 20 }, (_, copy) =>
      ({ cwd, source: "claude", id: String(index) + "-" + String(copy) })));
    const first = await listSessionWorkspaces(root, candidates);
    expect(first.session_directories).toHaveLength(240);
    for (const child of children) expect(realpath.mock.calls.filter((args) => args[0] === child)).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    await listSessionWorkspaces(root, candidates);
    for (const child of children) expect(realpath.mock.calls.filter((args) => args[0] === child)).toHaveLength(2);
  });

  it("follows a symlinked cwd to the registered root it really lives in", async () => {
    const root = home();
    const project = join(root, "real");
    mkdirSync(join(project, "sub"), { recursive: true });
    const workspace = await addWorkspace(root, project, "Real");
    const link = join(root, "link");
    symlinkSync(join(project, "sub"), link, "dir");

    const wire = await listSessionWorkspaces(root, [{ source: "claude", id: "linked", cwd: link }]);
    expect(wire.session_directories).toEqual([
      { source: "claude", id: "linked", workspace_id: workspace.id, relative_path: "sub" },
    ]);
  });

  it("reports nothing for a directory whose name cannot be a relative path", async () => {
    const root = home();
    const project = join(root, "project");
    const odd = join(project, "we\\ird");
    mkdirSync(odd, { recursive: true });
    await addWorkspace(root, project, "Project");

    const wire = await listSessionWorkspaces(root, [{ source: "claude", id: "odd", cwd: odd }]);
    expect(wire.session_directories).toEqual([]);
  });
});
