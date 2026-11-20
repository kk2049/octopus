import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  promises as fsPromises,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRpc } from "./core.js";
import { MACHINE_LIMITS } from "./limits.js";
import {
  accessOwnerFiles,
  listWorkspaceEntries,
  readWorkspaceBinary,
  readWorkspaceText,
  replaceWorkspaceText,
  replaceOwnerText,
  WORKSPACE_LSTAT_CONCURRENCY,
  workspaceRelativePathProblem,
} from "./workspace-files.js";
import { addWorkspace } from "./workspaces.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp home with one registered workspace, plus a sibling directory OUTSIDE
 * it — several tests are only meaningful when there is somewhere to escape to.
 */
async function fixture(): Promise<{ home: string; workspaceId: string; root: string; outside: string }> {
  const home = mkdtempSync(join(tmpdir(), "runner-wsfiles-"));
  dirs.push(home);
  const root = join(home, "projects", "demo");
  mkdirSync(join(root, "src"), { recursive: true });
  const outside = join(home, "elsewhere");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "not yours\n", "utf8");
  const workspace = await addWorkspace(home, root, "Demo");
  return { home, workspaceId: workspace.id, root, outside };
}

describe("relative path grammar", () => {
  it("accepts the root and canonical POSIX relative paths", () => {
    expect(workspaceRelativePathProblem("")).toBeNull();
    expect(workspaceRelativePathProblem("src")).toBeNull();
    expect(workspaceRelativePathProblem("src/lib/a.ts")).toBeNull();
    expect(workspaceRelativePathProblem("空格 在中间/ok.ts")).toBeNull();
  });

  it("refuses everything that could mean somewhere else", () => {
    for (const bad of [
      "/etc/passwd",
      "../outside",
      "src/../../outside",
      "src/./a.ts",
      "src//a.ts",
      "src/",
      "src\\a.ts",
      "src/a.ts\n",
      " src/a.ts",
      "src/ a.ts",
      "a\0b",
      "x".repeat(MACHINE_LIMITS.workspaceRelativePathMaxBytes + 1),
      42,
      null,
    ]) {
      expect(workspaceRelativePathProblem(bad), String(bad)).not.toBeNull();
    }
  });
});

describe("access_owner_files", () => {
  it("reads an OS-accessible absolute path without a workspace registry lookup", async () => {
    const { home, outside } = await fixture();
    const listing = await accessOwnerFiles({ mode: "list", absolute_path: outside });
    expect(listing).toMatchObject({
      status: "ok",
      mode: "list",
      absolute_path: outside,
      entries: [{ name: "secret.txt", kind: "file", absolute_path: join(outside, "secret.txt") }],
    });
    const read = await accessOwnerFiles({
      mode: "text",
      absolute_path: join(outside, "secret.txt"),
      offset: 0,
      max_bytes: 64,
    });
    expect(read).toMatchObject({ status: "ok", mode: "text", text: "not yours\n", eof: true });

    // The direct branch works even after the workspace registry is removed;
    // its authority is the authenticated Runner OS account, not registration.
    rmSync(join(home, ".octopus-runner", "workspaces.json"), { force: true });
    expect(await accessOwnerFiles({
      mode: "text",
      absolute_path: join(outside, "secret.txt"),
      offset: 0,
      max_bytes: 64,
    })).toMatchObject({ status: "ok", text: "not yours\n" });
  });

  it("keeps the Runner machine-op kill switch as the device-side final door", async () => {
    const { home, outside } = await fixture();
    const request = {
      id: "owner-read",
      method: "access_owner_files",
      args: { mode: "text", absolute_path: join(outside, "secret.txt"), offset: 0, max_bytes: 64 },
    };
    expect(await handleRpc(home, request, {})).toMatchObject({ ok: false });
    expect(await handleRpc(home, request, { allowMachineOps: true }))
      .toMatchObject({ ok: true, result: { status: "ok", text: "not yours\n" } });
  });
});

describe("list_session_workspaces with a path", () => {
  const place = (home: string, args: Record<string, unknown>, opts: Parameters<typeof handleRpc>[2] = { allowMachineOps: true }) =>
    handleRpc(home, { id: "place", method: "list_session_workspaces", args: { device: "d", ...args } }, opts);

  it("names the workspace and the path inside it, for absolute, ~/ and session-relative mentions", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "src", "talk.md"), "# talk\n");
    const placed = { ok: true, result: { placement: { workspace_id: workspaceId, relative_path: "src/talk.md" } } };
    expect(await place(home, { path: join(root, "src", "talk.md") })).toMatchObject(placed);
    expect(await place(home, { path: "~/projects/demo/src/talk.md" })).toMatchObject(placed);
    // A relative mention is taken from the session's own recorded cwd.
    const id = "6f1d2c3b-0000-4000-8000-000000000001";
    mkdirSync(join(home, ".claude", "projects", "demo"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "demo", `${id}.jsonl`),
      `${JSON.stringify({ type: "user", sessionId: id, cwd: join(root, "src"), message: { role: "user", content: "hi" } })}\n`);
    expect(await place(home, { source: "claude", id, path: "talk.md" })).toMatchObject(placed);
    // The absolute path itself never comes back.
    expect(JSON.stringify(await place(home, { path: join(root, "src", "talk.md") }))).not.toContain(home);
  });

  it("says why a path has no place: missing, outside every workspace, or escaping through a link", async () => {
    const { home, root, outside } = await fixture();
    expect(await place(home, { path: join(root, "src", "missing.md") }))
      .toMatchObject({ ok: true, result: { placement: null, reason: "not_found" } });
    expect(await place(home, { path: join(outside, "secret.txt") }))
      .toMatchObject({ ok: true, result: { placement: null, reason: "outside" } });
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.txt"));
    expect(await place(home, { path: join(root, "src", "link.txt") }))
      .toMatchObject({ ok: true, result: { placement: null, reason: "outside" } });
  });

  it("answers nothing while machine operations are off", async () => {
    const { home, root } = await fixture();
    expect(await place(home, { path: join(root, "src") }, {}))
      .toMatchObject({ ok: true, result: { placement: null, reason: "unavailable" } });
  });
});

describe("replace_owner_text", () => {
  it("saves an unregistered owner file atomically, preserves mode and refuses stale content", async () => {
    const { home, outside } = await fixture();
    const file = join(outside, "secret.txt");
    chmodSync(file, 0o640);
    const read = await accessOwnerFiles({ mode: "text", absolute_path: file });
    if (read.status !== "ok" || read.mode !== "text") throw new Error("fixture read failed");
    const args = { absolute_path: file, expected_digest: read.digest, text: "本人修改\n" };
    const request = { id: "owner-write", method: "replace_owner_text", args };
    expect(await handleRpc(home, request, {})).toMatchObject({ ok: false });
    expect(readFileSync(file, "utf8")).toBe("not yours\n");
    expect(await handleRpc(home, request, { allowMachineOps: true, executionOnly: true }))
      .toMatchObject({ ok: true, result: {
        status: "ok", absolute_path: file, previous_digest: read.digest,
        size: Buffer.byteLength(args.text),
        digest: `sha256:${createHash("sha256").update(args.text).digest("hex")}`,
      } });
    expect(readFileSync(file, "utf8")).toBe(args.text);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
    expect(await replaceOwnerText(args)).toEqual({ status: "refused", code: "digest_mismatch" });
    expect(readFileSync(file, "utf8")).toBe(args.text);
  });

  it("refuses missing files, symlinks, non-text and oversized writes without modifying anything", async () => {
    const { outside } = await fixture();
    const file = join(outside, "secret.txt");
    const args = { absolute_path: file, expected_digest: `sha256:${"0".repeat(64)}`, text: "new" };
    await expect(replaceOwnerText({ ...args, absolute_path: "relative.txt" })).rejects.toThrow("absolute_path");
    await expect(replaceOwnerText({ ...args, expected_digest: "" })).rejects.toThrow("expected_digest");
    expect(await replaceOwnerText({ ...args, absolute_path: join(outside, "missing.txt") }))
      .toEqual({ status: "refused", code: "not_found" });
    expect(await replaceOwnerText({ ...args, absolute_path: outside }))
      .toEqual({ status: "refused", code: "not_a_file" });
    symlinkSync(file, join(outside, "link.txt"));
    expect(await replaceOwnerText({ ...args, absolute_path: join(outside, "link.txt") }))
      .toEqual({ status: "refused", code: "not_a_file" });
    expect(await replaceOwnerText({ ...args, text: "x".repeat(MACHINE_LIMITS.workspaceWriteMaxBytes + 1) }))
      .toEqual({ status: "refused", code: "too_large" });
    expect(await replaceOwnerText({ ...args, text: "\u0000" }))
      .toEqual({ status: "refused", code: "not_text" });
    expect(readFileSync(file, "utf8")).toBe("not yours\n");
    writeFileSync(file, Buffer.from([0, 1, 2]));
    expect(await replaceOwnerText(args)).toEqual({ status: "refused", code: "not_text" });
    expect(readFileSync(file)).toEqual(Buffer.from([0, 1, 2]));
  });
});

describe("list_workspace_entries", () => {
  it("lists deterministically, directories first, with relative paths for the provider", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "b.txt"), "b", "utf8");
    writeFileSync(join(root, "a.txt"), "a", "utf8");
    mkdirSync(join(root, "zdir"));

    const listing = await listWorkspaceEntries(home, { workspace_id: workspaceId });
    expect(listing.status).toBe("ok");
    if (listing.status !== "ok") return;
    expect(listing.entries.map((row) => `${row.kind}:${row.name}`)).toEqual([
      "directory:src",
      "directory:zdir",
      "file:a.txt",
      "file:b.txt",
    ]);
    expect(listing.entries.map((row) => row.relative_path)).toEqual(["src", "zdir", "a.txt", "b.txt"]);
    expect(listing.truncated).toBe(false);

    const nested = await listWorkspaceEntries(home, { workspace_id: workspaceId, relative_path: "src" });
    expect(nested.status).toBe("ok");
    if (nested.status === "ok") expect(nested.relative_path).toBe("src");
  });

  it("lstats entries with bounded concurrency and preserves sorted output order", async () => {
    const { home, workspaceId, root } = await fixture();
    const names = Array.from({ length: 24 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
    for (const name of names) writeFileSync(join(root, name), name, "utf8");

    const realLstat = fsPromises.lstat.bind(fsPromises);
    let active = 0;
    let maxActive = 0;
    vi.spyOn(fsPromises, "lstat").mockImplementation(async (target) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await realLstat(target);
      } finally {
        active -= 1;
      }
    });

    const listing = await listWorkspaceEntries(home, { workspace_id: workspaceId });
    expect(listing.status).toBe("ok");
    if (listing.status !== "ok") return;
    expect(listing.entries.map((row) => row.name)).toEqual(["src", ...names]);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(WORKSPACE_LSTAT_CONCURRENCY);
  });

  it("marks a symlink `other` and gives it no relative path to follow", async () => {
    const { home, workspaceId, root, outside } = await fixture();
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(outside, "secret.txt"), join(root, "peek.txt"));

    const listing = await listWorkspaceEntries(home, { workspace_id: workspaceId });
    expect(listing.status).toBe("ok");
    if (listing.status !== "ok") return;
    const links = listing.entries.filter((row) => row.name === "escape" || row.name === "peek.txt");
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.kind).toBe("other");
      expect(link.relative_path).toBeUndefined();
      expect(link.size).toBeUndefined();
    }
  });

  it("refuses a path that resolves outside the workspace, whatever made it", async () => {
    const { home, workspaceId, root } = await fixture();
    symlinkSync(join(home, "elsewhere"), join(root, "escape"));

    expect(await listWorkspaceEntries(home, { workspace_id: workspaceId, relative_path: "escape" }))
      .toEqual({ status: "refused", code: "outside_workspace" });
    await expect(listWorkspaceEntries(home, { workspace_id: workspaceId, relative_path: "../elsewhere" }))
      .rejects.toThrow(/\.\./);
    await expect(listWorkspaceEntries(home, { workspace_id: workspaceId, relative_path: "/etc" }))
      .rejects.toThrow(/相对路径/);
  });

  it("says `not_a_directory` for a file and `not_found` for nothing", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "a.txt"), "a", "utf8");
    expect(await listWorkspaceEntries(home, { workspace_id: workspaceId, relative_path: "a.txt" }))
      .toEqual({ status: "refused", code: "not_a_directory" });
    expect(await listWorkspaceEntries(home, { workspace_id: workspaceId, relative_path: "nope" }))
      .toEqual({ status: "refused", code: "not_found" });
  });

  it("bounds the listing and says so instead of looking complete", async () => {
    const { home, workspaceId, root } = await fixture();
    for (let i = 0; i < 12; i += 1) writeFileSync(join(root, `f${i}.txt`), "x", "utf8");

    const listing = await listWorkspaceEntries(home, { workspace_id: workspaceId, limit: 3 });
    expect(listing.status).toBe("ok");
    if (listing.status !== "ok") return;
    expect(listing.entries).toHaveLength(3);
    expect(listing.truncated).toBe(true);
  });

  it("refuses an unregistered workspace id without touching the filesystem", async () => {
    const { home } = await fixture();
    expect(await listWorkspaceEntries(home, { workspace_id: `ws_${"0".repeat(24)}` }))
      .toEqual({ status: "refused", code: "not_found" });
    expect(await listWorkspaceEntries(home, { workspace_id: "../../etc" }))
      .toEqual({ status: "refused", code: "not_found" });
    await expect(listWorkspaceEntries(home, {})).rejects.toThrow(/workspace_id/);
  });
});

describe("read_workspace_text", () => {
  it("returns the whole file, its size and a sha256 of the bytes", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const read = await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "src/a.ts" });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.text).toBe("export const a = 1;\n");
    expect(read.size).toBe(20);
    expect(read.offset).toBe(0);
    expect(read.bytes).toBe(20);
    expect(read.eof).toBe(true);
    expect(read.encoding).toBe("utf-8");
    expect(read.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("windows by byte offset and never splits a character", async () => {
    const { home, workspaceId, root } = await fixture();
    // Three-byte characters, so a naive 4-byte window would cut one in half.
    writeFileSync(join(root, "cn.txt"), "中文内容", "utf8");

    let offset = 0;
    const pieces: string[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const read = await readWorkspaceText(home, {
        workspace_id: workspaceId,
        relative_path: "cn.txt",
        offset,
        max_bytes: 4,
      });
      expect(read.status).toBe("ok");
      if (read.status !== "ok") break;
      pieces.push(read.text);
      offset += read.bytes;
      expect(read.bytes).toBeGreaterThan(0);
      if (read.eof) break;
    }
    expect(pieces.join("")).toBe("中文内容");
    expect(pieces.every((piece) => piece.length > 0)).toBe(true);
  });

  it("makes progress even when one character is wider than the window", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "emoji.txt"), "😀", "utf8");

    const read = await readWorkspaceText(home, {
      workspace_id: workspaceId,
      relative_path: "emoji.txt",
      max_bytes: 1,
    });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.text).toBe("😀");
    expect(read.bytes).toBe(4);
    expect(read.eof).toBe(true);
  });

  it("refuses binary, directories and missing files without truncating anything", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x68, 0x00, 0x69]));
    writeFileSync(join(root, "latin1.txt"), Buffer.from([0xff, 0xfe, 0x41]));

    expect(await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "bin.dat" }))
      .toEqual({ status: "refused", code: "not_text" });
    expect(await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "latin1.txt" }))
      .toEqual({ status: "refused", code: "not_text" });
    expect(await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "src" }))
      .toEqual({ status: "refused", code: "not_a_directory" });
    expect(await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "nope.txt" }))
      .toEqual({ status: "refused", code: "not_found" });
  });

  it("reads a text file of any size to its end, window by window, under one digest", async () => {
    const { home, workspaceId, root } = await fixture();
    // Larger than the old 1 MiB ceiling, with multi-byte characters across
    // window edges.
    const original = "日志 line ✓\n".repeat(220_000);
    writeFileSync(join(root, "big.log"), original, "utf8");
    const digest = `sha256:${createHash("sha256").update(original, "utf8").digest("hex")}`;

    let offset = 0;
    let text = "";
    for (;;) {
      const window = await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "big.log", offset });
      expect(window.status).toBe("ok");
      if (window.status !== "ok") return;
      expect(window.digest).toBe(digest);
      expect(window.size).toBe(Buffer.byteLength(original, "utf8"));
      text += window.text;
      offset += window.bytes;
      if (window.eof) break;
    }
    expect(text).toBe(original);
  });

  it("decides not_text about the whole file, not the window being read", async () => {
    const { home, workspaceId, root } = await fixture();
    // Clean UTF-8 for the first window; a NUL far past it.
    writeFileSync(join(root, "late.bin"), Buffer.concat([Buffer.from("a".repeat(600_000)), Buffer.from([0])]));
    expect(await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "late.bin", max_bytes: 16 }))
      .toEqual({ status: "refused", code: "not_text" });
  });

  it("never serves a stale digest after a same-size rewrite", async () => {
    const { home, workspaceId, root } = await fixture();
    const file = join(root, "same.txt");
    writeFileSync(file, "aaaa", "utf8");
    const first = await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "same.txt" });
    writeFileSync(file, "bbbb", "utf8");
    const second = await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "same.txt" });
    expect(first.status === "ok" && first.text).toBe("aaaa");
    expect(second.status === "ok" && second.text).toBe("bbbb");
    expect(second.status === "ok" && second.digest).toBe(`sha256:${createHash("sha256").update("bbbb").digest("hex")}`);
  });

  it("re-derives remembered facts when the version key changes", async () => {
    const { home, workspaceId, root } = await fixture();
    const file = join(root, "old.txt");
    writeFileSync(file, "first", "utf8");
    // Old enough to be remembered (outside the racy window).
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    try {
      const first = await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "old.txt" });
      writeFileSync(file, "other", "utf8");
      // Force a distinct mtime even on a coarse filesystem clock.
      const past = new Date(Date.now() - 3_600_000);
      await fsPromises.utimes(file, past, past);
      const second = await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "old.txt" });
      expect(first.status === "ok" && first.text).toBe("first");
      expect(second.status === "ok" && second.text).toBe("other");
      expect(second.status === "ok" && second.digest).toBe(`sha256:${createHash("sha256").update("other").digest("hex")}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a symlink that leaves the workspace", async () => {
    const { home, workspaceId, root, outside } = await fixture();
    symlinkSync(join(outside, "secret.txt"), join(root, "peek.txt"));

    expect(await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "peek.txt" }))
      .toEqual({ status: "refused", code: "outside_workspace" });
  });

  it("refuses an offset that is not on a character boundary", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "cn.txt"), "中文", "utf8");
    await expect(readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "cn.txt", offset: 1 }))
      .rejects.toThrow(/边界/);
  });
});

describe("read_workspace_binary", () => {
  it("returns bounded base64 windows with one stable digest", async () => {
    const { home, workspaceId, root } = await fixture();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    writeFileSync(join(root, "image.png"), bytes);

    const first = await readWorkspaceBinary(home, {
      workspace_id: workspaceId,
      relative_path: "image.png",
      offset: 0,
      max_bytes: 4,
    });
    const second = await readWorkspaceBinary(home, {
      workspace_id: workspaceId,
      relative_path: "image.png",
      offset: 4,
      max_bytes: 4,
    });
    expect(first).toMatchObject({
      status: "ok",
      offset: 0,
      bytes: 4,
      eof: false,
      data: bytes.subarray(0, 4).toString("base64"),
    });
    expect(second).toMatchObject({
      status: "ok",
      offset: 4,
      bytes: 3,
      eof: true,
      data: bytes.subarray(4).toString("base64"),
    });
    if (first.status === "ok" && second.status === "ok") {
      expect(first.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      expect(second.digest).toBe(first.digest);
    }
  });

  it("keeps workspace containment", async () => {
    const { home, workspaceId, root, outside } = await fixture();
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.bin"));
    expect(await readWorkspaceBinary(home, { workspace_id: workspaceId, relative_path: "escape.bin" }))
      .toEqual({ status: "refused", code: "outside_workspace" });
  });

  it("streams a binary file past the old 8 MiB ceiling, byte for byte", async () => {
    const { home, workspaceId, root } = await fixture();
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 17);
    for (let index = 0; index < bytes.length; index += 4093) bytes[index] = index & 0xff;
    writeFileSync(join(root, "video.mp4"), bytes);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const window = await readWorkspaceBinary(home, { workspace_id: workspaceId, relative_path: "video.mp4", offset });
      expect(window.status).toBe("ok");
      if (window.status !== "ok") return;
      expect(window.digest).toBe(digest);
      expect(window.bytes).toBeLessThanOrEqual(MACHINE_LIMITS.workspaceMediaChunkMaxBytes);
      parts.push(Buffer.from(window.data, "base64"));
      offset += window.bytes;
      if (window.eof) break;
    }
    expect(Buffer.concat(parts).equals(bytes)).toBe(true);
  });

  it("reports a changed file as a different version instead of splicing two", async () => {
    const { home, workspaceId, root } = await fixture();
    const file = join(root, "grow.bin");
    writeFileSync(file, Buffer.alloc(300_000, 1));
    const first = await readWorkspaceBinary(home, { workspace_id: workspaceId, relative_path: "grow.bin" });
    writeFileSync(file, Buffer.alloc(300_001, 2));
    const second = await readWorkspaceBinary(home, { workspace_id: workspaceId, relative_path: "grow.bin", offset: 262_144 });
    expect(first.status === "ok" && second.status === "ok").toBe(true);
    if (first.status !== "ok" || second.status !== "ok") return;
    expect(second.size).not.toBe(first.size);
    expect(second.digest).not.toBe(first.digest);
  });
});

describe("replace_workspace_text", () => {
  /** The digest of what is on disk right now, via the read path itself. */
  async function digestOf(home: string, workspaceId: string, relativePath: string): Promise<string> {
    const read = await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: relativePath });
    if (read.status !== "ok") throw new Error(`read refused: ${read.code}`);
    return read.digest;
  }

  it("replaces the whole file and reports the new digest, size and mtime", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const before = await digestOf(home, workspaceId, "src/a.ts");

    const written = await replaceWorkspaceText(home, {
      workspace_id: workspaceId,
      relative_path: "src/a.ts",
      expected_digest: before,
      text: "export const a = 2;\n",
    });

    expect(written.status).toBe("ok");
    if (written.status !== "ok" || !("digest" in written)) return;
    expect(written.previous_digest).toBe(before);
    expect(written.size).toBe(20);
    expect(written.encoding).toBe("utf-8");
    expect(written.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(written.digest).not.toBe(before);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    // And the file the device now reports IS the one the receipt describes.
    expect(await digestOf(home, workspaceId, "src/a.ts")).toBe(written.digest);
  });

  it("refuses a stale digest and leaves the file exactly as it was", async () => {
    const { home, workspaceId, root } = await fixture();
    const target = join(root, "notes.md");
    writeFileSync(target, "第一版\n", "utf8");
    const stale = await digestOf(home, workspaceId, "notes.md");
    // Somebody else saves in between — the ordinary case this refusal is for.
    writeFileSync(target, "第二版（别人改的）\n", "utf8");

    const written = await replaceWorkspaceText(home, {
      workspace_id: workspaceId,
      relative_path: "notes.md",
      expected_digest: stale,
      text: "我的版本\n",
    });

    expect(written).toEqual({ status: "refused", code: "digest_mismatch" });
    expect(readFileSync(target, "utf8")).toBe("第二版（别人改的）\n");
    // Nothing was staged either: a refusal must not leave litter in a project.
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  // Directory permissions do not bind root, and there is no honest way to make
  // them: a test that silently proved nothing would be worse than one that says
  // it was skipped.
  const asUser = process.getuid?.() === 0 ? it.skip : it;
  asUser("leaves the old content whole when the write itself cannot happen", async () => {
    const { home, workspaceId, root } = await fixture();
    const dir = join(root, "locked");
    mkdirSync(dir);
    const target = join(dir, "a.txt");
    writeFileSync(target, "原始内容\n", "utf8");
    const before = await digestOf(home, workspaceId, "locked/a.txt");
    // Read+execute but not write: the temp file cannot be created, so the swap
    // fails at the first step that touches the filesystem.
    chmodSync(dir, 0o555);
    try {
      const written = await replaceWorkspaceText(home, {
        workspace_id: workspaceId,
        relative_path: "locked/a.txt",
        expected_digest: before,
        text: "新内容\n",
      });

      expect(written).toEqual({ status: "refused", code: "denied" });
      expect(readFileSync(target, "utf8")).toBe("原始内容\n");
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readdirSync(dir).sort()).toEqual(["a.txt"]);
  });

  it("keeps the file's permission bits", async () => {
    const { home, workspaceId, root } = await fixture();
    const target = join(root, "run.sh");
    writeFileSync(target, "#!/bin/sh\necho old\n", "utf8");
    chmodSync(target, 0o750);
    const before = await digestOf(home, workspaceId, "run.sh");

    const written = await replaceWorkspaceText(home, {
      workspace_id: workspaceId,
      relative_path: "run.sh",
      expected_digest: before,
      text: "#!/bin/sh\necho new\n",
    });

    expect(written.status).toBe("ok");
    // A replaced script that quietly lost its executable bit is data loss of the
    // kind nobody looks for until the next time it is run.
    expect(statSync(target).mode & 0o777).toBe(0o750);
  });

  it("refuses to create a file, to write a directory, or to leave the workspace", async () => {
    const { home, workspaceId, root, outside } = await fixture();
    symlinkSync(join(outside, "secret.txt"), join(root, "peek.txt"));
    const any = `sha256:${"a".repeat(64)}`;

    expect(await replaceWorkspaceText(home, {
      workspace_id: workspaceId,
      relative_path: "brand-new.txt",
      expected_digest: any,
      text: "x",
    })).toEqual({ status: "refused", code: "not_found" });
    expect(await replaceWorkspaceText(home, {
      workspace_id: workspaceId,
      relative_path: "src",
      expected_digest: any,
      text: "x",
    })).toEqual({ status: "refused", code: "not_a_directory" });
    expect(await replaceWorkspaceText(home, {
      workspace_id: workspaceId,
      relative_path: "peek.txt",
      expected_digest: any,
      text: "x",
    })).toEqual({ status: "refused", code: "outside_workspace" });
    // `..`, absolute paths and NUL are not refusals here either — they are
    // rejected as malformed before anything is resolved.
    for (const bad of ["../elsewhere/secret.txt", "/etc/passwd", "a\u0000b", ""]) {
      await expect(replaceWorkspaceText(home, {
        workspace_id: workspaceId,
        relative_path: bad,
        expected_digest: any,
        text: "x",
      })).rejects.toThrow();
    }
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("not yours\n");
  });

  it("will not turn a binary file into a text file, or a text file into binary", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x68, 0x00, 0x69]));
    writeFileSync(join(root, "ok.txt"), "hi\n", "utf8");
    const okDigest = await digestOf(home, workspaceId, "ok.txt");

    // A caller that computed the digest of a binary file elsewhere still cannot
    // use this verb on it: "is it text" is decided about the file, not the ask.
    expect(await replaceWorkspaceText(home, {
      workspace_id: workspaceId,
      relative_path: "bin.dat",
      expected_digest: `sha256:${createHash("sha256").update(Buffer.from([0x68, 0x00, 0x69])).digest("hex")}`,
      text: "now i am text\n",
    })).toEqual({ status: "refused", code: "not_text" });
    // And a replacement carrying a NUL, or a lone surrogate that would not
    // survive UTF-8, is refused rather than written as something else.
    for (const bad of ["a\u0000b", "\ud800"]) {
      expect(await replaceWorkspaceText(home, {
        workspace_id: workspaceId,
        relative_path: "ok.txt",
        expected_digest: okDigest,
        text: bad,
      })).toEqual({ status: "refused", code: "not_text" });
    }
    expect(readFileSync(join(root, "ok.txt"), "utf8")).toBe("hi\n");
  });

  it("refuses a replacement over the write cap, and a malformed precondition", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "ok.txt"), "hi\n", "utf8");
    const digest = await digestOf(home, workspaceId, "ok.txt");

    expect(await replaceWorkspaceText(home, {
      workspace_id: workspaceId,
      relative_path: "ok.txt",
      expected_digest: digest,
      text: "x".repeat(MACHINE_LIMITS.workspaceWriteMaxBytes + 1),
    })).toEqual({ status: "refused", code: "too_large" });
    for (const bad of ["", "deadbeef", `md5:${"a".repeat(32)}`, `sha256:${"A".repeat(64)}`]) {
      await expect(replaceWorkspaceText(home, {
        workspace_id: workspaceId,
        relative_path: "ok.txt",
        expected_digest: bad,
        text: "x",
      })).rejects.toThrow(/expected_digest/);
    }
    expect(readFileSync(join(root, "ok.txt"), "utf8")).toBe("hi\n");
  });

  it("round-trips an empty replacement, which is an edit and not a mistake", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "ok.txt"), "hi\n", "utf8");
    const digest = await digestOf(home, workspaceId, "ok.txt");

    const written = await replaceWorkspaceText(home, {
      workspace_id: workspaceId,
      relative_path: "ok.txt",
      expected_digest: digest,
      text: "",
    });
    expect(written.status).toBe("ok");
    if (written.status !== "ok") return;
    expect(written.size).toBe(0);
    expect(readFileSync(join(root, "ok.txt"), "utf8")).toBe("");
  });

  it("is not applicable twice: the second run of the same call refuses", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "ok.txt"), "one\n", "utf8");
    const digest = await digestOf(home, workspaceId, "ok.txt");
    const call = {
      workspace_id: workspaceId,
      relative_path: "ok.txt",
      expected_digest: digest,
      text: "two\n",
    };

    expect((await replaceWorkspaceText(home, call)).status).toBe("ok");
    // This is what makes the operation `retrySafe` despite being a `modify`:
    // replaying it cannot double-apply, so an interrupted call can go back to
    // the owner as a decision instead of being written off as indeterminate.
    expect(await replaceWorkspaceText(home, call)).toEqual({ status: "refused", code: "digest_mismatch" });
    expect(readFileSync(join(root, "ok.txt"), "utf8")).toBe("two\n");
  });
});

describe("through handleRpc", () => {
  it("serves the write, and refuses it when the machine-op kill switch is off", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "a.txt"), "old\n", "utf8");
    const read = await readWorkspaceText(home, { workspace_id: workspaceId, relative_path: "a.txt" });
    if (read.status !== "ok") throw new Error("read refused");
    const args = {
      workspace_id: workspaceId,
      relative_path: "a.txt",
      expected_digest: read.digest,
      text: "new\n",
    };

    const off = await handleRpc(home, { id: "1", method: "replace_workspace_text", args }, {});
    expect(off.ok).toBe(false);
    expect(off.error).toMatch(/RUNNER_ALLOW_MACHINE_OPS/);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("old\n");

    const summaries: string[] = [];
    const on = await handleRpc(home, { id: "2", method: "replace_workspace_text", args }, {
      allowMachineOps: true,
      onMachineOp: (_method, summary) => summaries.push(summary),
    });
    expect(on).toMatchObject({ ok: true, result: { status: "ok" } });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new\n");
    // The owner's own log line says what was asked for and how much, and never
    // the content or the canonical root.
    expect(summaries).toEqual([`${workspaceId}:a.txt ← 4 bytes`]);
    expect(JSON.stringify(on)).not.toContain(root);
    expect(JSON.stringify(on)).not.toContain(home);
  });


  it("serves both operations and keeps the canonical path out of every answer", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "src", "a.ts"), "hello\n", "utf8");

    const listing = await handleRpc(home, {
      id: "1",
      method: "list_workspace_entries",
      args: { workspace_id: workspaceId },
    }, { allowMachineOps: true });
    const read = await handleRpc(home, {
      id: "2",
      method: "read_workspace_text",
      args: { workspace_id: workspaceId, relative_path: "src/a.ts" },
    }, { allowMachineOps: true });

    expect(listing.ok).toBe(true);
    expect(read.ok).toBe(true);
    for (const response of [listing, read]) {
      const wire = JSON.stringify(response);
      expect(wire).not.toContain(root);
      expect(wire).not.toContain(home);
      expect(wire).not.toContain(tmpdir());
    }
  });

  it("keeps the canonical path out of REFUSALS and out of thrown errors too", async () => {
    const { home, workspaceId, root } = await fixture();
    const responses = await Promise.all([
      handleRpc(home, {
        id: "1",
        method: "read_workspace_text",
        args: { workspace_id: workspaceId, relative_path: "nope.txt" },
      }, { allowMachineOps: true }),
      handleRpc(home, {
        id: "2",
        method: "read_workspace_text",
        args: { workspace_id: workspaceId, relative_path: "../elsewhere/secret.txt" },
      }, { allowMachineOps: true }),
      handleRpc(home, {
        id: "3",
        method: "list_workspace_entries",
        args: { workspace_id: `ws_${"1".repeat(24)}` },
      }, { allowMachineOps: true }),
    ]);
    expect(responses[1].ok).toBe(false);
    expect(responses[2]).toMatchObject({ ok: true, result: { status: "refused", code: "not_found" } });
    for (const response of responses) {
      const wire = JSON.stringify(response);
      expect(wire).not.toContain(root);
      expect(wire).not.toContain(home);
      expect(wire).not.toContain(tmpdir());
    }
  });

  it("drops canonical paths when a registered workspace disappears", async () => {
    const { home, workspaceId, root } = await fixture();
    rmSync(root, { recursive: true, force: true });
    const summaries: string[] = [];
    const response = await handleRpc(home, {
      id: "1",
      method: "list_workspace_entries",
      args: { workspace_id: workspaceId, relative_path: "" },
    }, { allowMachineOps: true, onMachineOp: (_method, summary) => summaries.push(summary) });

    expect(response).toMatchObject({ ok: true, result: { status: "refused", code: "not_found" } });
    expect(JSON.stringify({ response, summaries })).not.toContain(root);
    expect(JSON.stringify({ response, summaries })).not.toContain(home);
  });

  it("does not copy an invalid absolute path into the machine-op audit summary", async () => {
    const { home, workspaceId } = await fixture();
    const summaries: string[] = [];
    const attempted = "/tmp/private/canonical-path";
    await handleRpc(home, {
      id: "1",
      method: "read_workspace_text",
      args: { workspace_id: workspaceId, relative_path: attempted },
    }, { allowMachineOps: true, onMachineOp: (_method, summary) => summaries.push(summary) });

    expect(summaries).toEqual([`${workspaceId}:(invalid relative path)`]);
    expect(JSON.stringify(summaries)).not.toContain(attempted);
  });

  it("is off when the device's machine-op kill switch is off", async () => {
    const { home, workspaceId } = await fixture();
    for (const method of ["list_workspace_entries", "read_workspace_text"]) {
      const response = await handleRpc(home, {
        id: "1",
        method,
        args: { workspace_id: workspaceId, relative_path: "src" },
      }, { allowMachineOps: false });
      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/RUNNER_ALLOW_MACHINE_OPS/);
    }
  });
});
