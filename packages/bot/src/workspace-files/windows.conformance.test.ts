/**
 * Windows, not totals, through the trusted provider (2026-10-20).
 *
 * The same vertical harness as `conformance.test.ts` — a temp home, the real
 * registry, real `handleRpc`, the real adapter and service — proving that a
 * directory of any length is reached page by page through a keyset cursor, and
 * that a text file of any size is saved through a staged upload whose commit
 * is the same compare-and-swap.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRpc } from "@claude-bot/runner/core";
import { addWorkspace } from "@claude-bot/runner/workspaces";
import { STAGED_TEXT_IDLE_MS, sweepStagedTexts } from "@claude-bot/runner/workspace-files";
import {
  WORKSPACE_FILES_LIMITS,
  replaceWorkspaceTextInWindows,
  workspaceListCursorAfter,
  type WorkspaceFilesEntry,
} from "@claude-bot/workspace-files-contract";
import { RunnerWorkspaceFilesBackend } from "./runner-backend.js";
import { WorkspaceFilesService, type WorkspaceFilesScopePort } from "./service.js";
import type { BackendRoot, RunnerCallOutcome, WorkspaceFilesAuthority, WorkspaceFilesBackend } from "./types.js";

const DEVICE = "laptop";
const dirs: string[] = [];
afterEach(async () => {
  await sweepStagedTexts(Date.now() + STAGED_TEXT_IDLE_MS + 1);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

async function harness(options: { dropEcho?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "wsfiles-windows-"));
  dirs.push(home);
  const root = join(home, "projects", "demo");
  mkdirSync(root, { recursive: true });
  await addWorkspace(home, root, "Demo");
  const frames: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const authority: WorkspaceFilesAuthority = {
    async devices() {
      return [{ device: DEVICE, label: "笔记本" }];
    },
    async call(_device, operation, args): Promise<RunnerCallOutcome> {
      const { device: _selector, ...sent } = args;
      frames.push({ operation, args: sent });
      // An older Runner never heard of `after`: it answers page one, echoing nothing.
      const { after: _ignored, ...older } = sent;
      const rest = options.dropEcho && operation === "list_workspace_entries" ? older : sent;
      const response = await handleRpc(home, { id: String(frames.length), method: operation, args: rest }, {
        allowMachineOps: true,
      });
      return response.ok
        ? { status: "succeeded", result: response.result }
        : { status: "failed", reason: response.error };
    },
  };
  const service = new WorkspaceFilesService();
  const backend = new RunnerWorkspaceFilesBackend(authority);
  const open = (scope = "scope-1"): WorkspaceFilesScopePort =>
    service.open({ scope, owner: "alice", backend, writable: true });
  return { home, root, frames, open };
}

async function rootRef(port: WorkspaceFilesScopePort): Promise<string> {
  const roots = await port.refreshRoots();
  if (!roots.ok) throw new Error(`roots refused: ${roots.code}`);
  return roots.value.roots[0]!.ref;
}

async function listAll(port: WorkspaceFilesScopePort, ref: string): Promise<WorkspaceFilesEntry[]> {
  const rows: WorkspaceFilesEntry[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await port.listDirectory(ref, after);
    if (!page.ok) throw new Error(`listing refused: ${page.code} ${page.message}`);
    expect(page.value.entries.length).toBeLessThanOrEqual(WORKSPACE_FILES_LIMITS.maxEntries);
    rows.push(...page.value.entries);
    if (!page.value.truncated) return rows;
    after = workspaceListCursorAfter(page.value.entries)!;
  }
}

describe("a directory of any length", () => {
  it("is listed completely through the cursor: 1,200 entries, each once, each with its own ref", async () => {
    const { root, open } = await harness();
    for (let i = 0; i < 1_100; i += 1) writeFileSync(join(root, `f${String(i).padStart(4, "0")}.ts`), "x");
    for (let i = 0; i < 100; i += 1) mkdirSync(join(root, `d${String(i).padStart(3, "0")}`));
    const port = open();
    const rows = await listAll(port, await rootRef(port));
    expect(rows).toHaveLength(1_200);
    expect(new Set(rows.map((row) => row.ref)).size).toBe(1_200);
    expect(rows.slice(0, 100).every((row) => row.kind === "directory")).toBe(true);
    // A row past the first page opens like any other.
    const late = rows.find((row) => row.label === "f1099.ts")!;
    expect((await port.openText(late.ref!)).ok).toBe(true);
  });

  it("neither skips nor repeats a surviving entry when others change between pages", async () => {
    const { root, open } = await harness();
    const stable = Array.from({ length: 800 }, (_, i) => `s${String(i).padStart(4, "0")}.ts`);
    for (const name of stable) writeFileSync(join(root, name), "x");
    const port = open();
    const dir = await rootRef(port);
    const first = await port.listDirectory(dir);
    if (!first.ok) throw new Error("refused");
    for (let i = 0; i < 30; i += 1) writeFileSync(join(root, `a${i}.ts`), "x");
    for (let i = 0; i < 30; i += 1) writeFileSync(join(root, `z${i}.ts`), "x");
    for (const row of first.value.entries.slice(0, 50)) unlinkSync(join(root, row.label));
    const second = await port.listDirectory(dir, workspaceListCursorAfter(first.value.entries)!);
    if (!second.ok) throw new Error("refused");
    const labels = [...first.value.entries, ...second.value.entries].map((row) => row.label);
    for (const name of stable) expect(labels.filter((label) => label === name), name).toHaveLength(1);
    expect(second.value.entries.filter((row) => row.label.startsWith("z"))).toHaveLength(30);
  });

  it("resolves a label that lives past the first page", async () => {
    const { root, open } = await harness();
    for (let i = 0; i < 700; i += 1) writeFileSync(join(root, `n${String(i).padStart(3, "0")}.md`), "x");
    const port = open();
    const resolved = await port.resolvePath(await rootRef(port), ["n650.md"]);
    expect(resolved).toMatchObject({ ok: true, value: { label: "n650.md", kind: "file" } });
  });

  it("says to upgrade a Runner that ignored the cursor instead of repeating page one", async () => {
    const { root, open } = await harness({ dropEcho: true });
    for (let i = 0; i < 600; i += 1) writeFileSync(join(root, `f${String(i).padStart(3, "0")}`), "x");
    const port = open();
    const dir = await rootRef(port);
    const first = await port.listDirectory(dir);
    if (!first.ok) throw new Error("refused");
    const next = await port.listDirectory(dir, workspaceListCursorAfter(first.value.entries)!);
    expect(next).toMatchObject({ ok: false, code: "too_large" });
    if (!next.ok) expect(next.message).toContain("升级 Runner");
  });
});

describe("owner-local listings", () => {
  it("page through access_owner_files(list) with the same cursor and echo", async () => {
    const { root, frames } = await harness();
    for (let i = 0; i < 650; i += 1) writeFileSync(join(root, `o${String(i).padStart(3, "0")}`), "x");
    const backend = new RunnerWorkspaceFilesBackend({
      devices: async () => [{ device: DEVICE, label: "笔记本" }],
      async call(_device, operation, args) {
        const { device: _selector, ...rest } = args;
        frames.push({ operation, args: rest });
        const response = await handleRpc(root, { id: "o", method: operation, args: rest }, { allowMachineOps: true });
        return response.ok ? { status: "succeeded", result: response.result } : { status: "failed" };
      },
    }, { ownerFiles: true });
    const binding = { device: DEVICE, deviceLabel: "笔记本", workspaceId: "", workspaceLabel: "/", ownerRoot: true as const };
    const first = await backend.listEntries(binding, root, 500);
    if (!first.ok) throw new Error(first.message);
    expect(first.value.truncated).toBe(true);
    const last = first.value.entries.at(-1)!;
    const second = await backend.listEntries(binding, root, 500, `${last.kind}/${last.name}`);
    if (!second.ok) throw new Error(second.message);
    expect(first.value.entries.length + second.value.entries.length).toBe(650);
    expect(second.value.truncated).toBe(false);
    expect(frames.at(-1)!.args).toMatchObject({ mode: "list", after: `${last.kind}/${last.name}` });
  });
});

describe("roots past one answer", () => {
  function rootsBackend(count: () => number, skip = new Set<number>()): WorkspaceFilesBackend {
    return {
      async listRoots() {
        const roots: BackendRoot[] = [];
        for (let i = 0; i < count(); i += 1) {
          if (skip.has(i)) continue;
          roots.push({ binding: { device: DEVICE, deviceLabel: "笔记本", workspaceId: `ws_${String(i).padStart(24, "0")}`, workspaceLabel: `w${i}` } });
        }
        return { ok: true, value: roots };
      },
      async listEntries() {
        return { ok: true, value: { entries: [], truncated: false } };
      },
      async readText() {
        return { ok: false, code: "unavailable", message: "" };
      },
    };
  }

  it("pages 150 roots in the backend's own order, each once", async () => {
    const service = new WorkspaceFilesService();
    const port = service.open({ scope: "s", owner: "alice", backend: rootsBackend(() => 150) });
    const labels: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await port.refreshRoots(after);
      if (!page.ok) throw new Error(page.message);
      expect(page.value.roots.length).toBeLessThanOrEqual(WORKSPACE_FILES_LIMITS.maxRoots);
      labels.push(...page.value.roots.map((root) => root.label));
      if (!page.value.truncated) break;
      after = page.value.roots.at(-1)!.ref;
    }
    expect(labels).toEqual(Array.from({ length: 150 }, (_, i) => `w${i}`));
  });

  it("reaches every one of 620 workspaces a device registered, through the real adapter", async () => {
    // One device answer, parsed by the shared normalizer: nothing past the
    // 500th row may vanish before the service pages it.
    const workspaces = Array.from({ length: 620 }, (_, i) => ({
      id: `ws_${i.toString(16).padStart(24, "0")}`, label: `p${i}`, display: `~/p${i}`,
    }));
    const authority: WorkspaceFilesAuthority = {
      async devices() { return [{ device: DEVICE, label: "笔记本" }]; },
      async call(_device, operation) {
        expect(operation).toBe("list_session_workspaces");
        return { status: "succeeded", result: { workspaces, session_directories: [] } };
      },
    };
    const port = new WorkspaceFilesService().open({ scope: "s", owner: "alice", backend: new RunnerWorkspaceFilesBackend(authority) });
    const labels: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await port.refreshRoots(after);
      if (!page.ok) throw new Error(page.message);
      labels.push(...page.value.roots.map((root) => root.label));
      if (!page.value.truncated) break;
      after = page.value.roots.at(-1)!.ref;
    }
    expect(labels).toEqual(workspaces.map((row) => row.label));
  });

  it("refuses to guess a position when the cursor root itself was unregistered", async () => {
    const skip = new Set<number>();
    const service = new WorkspaceFilesService();
    const port = service.open({ scope: "s", owner: "alice", backend: rootsBackend(() => 100, skip) });
    const first = await port.refreshRoots();
    if (!first.ok) throw new Error("refused");
    skip.add(63);
    expect(await port.refreshRoots(first.value.roots.at(-1)!.ref)).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("a text file of any size", () => {
  function staged(port: WorkspaceFilesScopePort, ref: string, expectedDigest: string) {
    return {
      whole: (text: string) => port.replaceText(ref, { expectedDigest, text }),
      begin: () => port.beginTextUpload(ref, { expectedDigest }),
      append: (upload: string, offset: number, text: string) => port.appendTextUpload(ref, { upload, offset, text }),
      commit: (upload: string, sizeBytes: number) => port.commitTextUpload(ref, { upload, expectedDigest, sizeBytes }),
    };
  }

  async function fileRef(port: WorkspaceFilesScopePort, label: string): Promise<string> {
    const listing = await port.listDirectory(await rootRef(port));
    if (!listing.ok) throw new Error("refused");
    return listing.value.entries.find((row) => row.label === label)!.ref!;
  }

  it("saves 3 MiB through begin / append / commit, as one receipt, under one write operation", async () => {
    const { root, frames, open } = await harness();
    writeFileSync(join(root, "big.md"), "旧\n");
    const port = open();
    const ref = await fileRef(port, "big.md");
    const text = "第 N 行 the quick brown fox 😀\n".repeat(90_000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(3 * 1024 * 1024);
    const before = frames.length;

    const saved = await replaceWorkspaceTextInWindows(text, staged(port, ref, sha("旧\n")));
    expect(saved).toMatchObject({
      ok: true,
      value: { ref, beforeDigest: sha("旧\n"), afterDigest: sha(text), sizeBytes: Buffer.byteLength(text) },
    });
    expect(readFileSync(join(root, "big.md"), "utf8")).toBe(text);
    const writes = frames.slice(before);
    expect(new Set(writes.map((frame) => frame.operation))).toEqual(new Set(["replace_workspace_text"]));
    expect(writes[0]!.args.stage).toBe("begin");
    expect(writes.at(-1)!.args.stage).toBe("commit");
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a stale editor and leaves the newer file whole", async () => {
    const { root, open } = await harness();
    writeFileSync(join(root, "a.md"), "v1\n");
    const port = open();
    const ref = await fileRef(port, "a.md");
    const steps = staged(port, ref, sha("v1\n"));
    const begun = await steps.begin();
    if (!begun.ok) throw new Error(begun.message);
    await steps.append(begun.value.upload, 0, "x".repeat(WORKSPACE_FILES_LIMITS.maxWriteTextBytes));
    writeFileSync(join(root, "a.md"), "somebody else\n");
    expect(await steps.commit(begun.value.upload, WORKSPACE_FILES_LIMITS.maxWriteTextBytes))
      .toMatchObject({ ok: false, code: "digest_mismatch" });
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("somebody else\n");
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("binds an upload to the scope that began it", async () => {
    const { root, frames, open } = await harness();
    writeFileSync(join(root, "a.md"), "v1\n");
    const mine = open("scope-mine");
    const begun = await mine.beginTextUpload(await fileRef(mine, "a.md"), { expectedDigest: sha("v1\n") });
    if (!begun.ok) throw new Error(begun.message);
    // The device never sees the token a consumer holds, only a scope-bound key.
    expect(frames.at(-1)!.args.upload_id).toMatch(/^[0-9a-f]{32}$/);
    expect(frames.at(-1)!.args.upload_id).not.toBe(begun.value.upload);
    const theirs = open("scope-theirs");
    const out = await theirs.appendTextUpload(await fileRef(theirs, "a.md"), {
      upload: begun.value.upload,
      offset: 0,
      text: "intruder",
    });
    expect(out).toMatchObject({ ok: false, code: "unavailable" });
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("v1\n");
  });

  it("answers read_only before any frame for a scope that does not write", async () => {
    const { root, frames, open } = await harness();
    writeFileSync(join(root, "a.md"), "v1\n");
    const port = open();
    const ref = await fileRef(port, "a.md");
    const service = new WorkspaceFilesService();
    const readOnly = service.open({
      scope: "ro",
      owner: "alice",
      backend: new RunnerWorkspaceFilesBackend({
        devices: async () => [],
        call: async () => ({ status: "failed" }),
      }),
    });
    const before = frames.length;
    expect(await readOnly.beginTextUpload(ref, { expectedDigest: sha("v1\n") })).toMatchObject({ ok: false, code: "read_only" });
    expect(frames).toHaveLength(before);
  });
});
