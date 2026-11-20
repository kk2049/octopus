/**
 * Windows, not totals, on the device (2026-10-20): every entry of a directory
 * through a keyset cursor, and a text file of any size saved through a staged
 * upload whose commit is the same compare-and-swap as a one-call replace.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MACHINE_LIMITS } from "./limits.js";
import {
  STAGED_TEXT_IDLE_MS,
  accessOwnerFiles,
  listWorkspaceEntries,
  replaceOwnerText,
  replaceWorkspaceText,
  stagedTextCount,
  sweepStagedTexts,
} from "./workspace-files.js";
import { addWorkspace } from "./workspaces.js";

const dirs: string[] = [];
afterEach(async () => {
  // Leave no staged upload behind for the next test.
  await sweepStagedTexts(Date.now() + STAGED_TEXT_IDLE_MS + 1);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(): Promise<{ home: string; workspaceId: string; root: string }> {
  const home = mkdtempSync(join(tmpdir(), "runner-wswindows-"));
  dirs.push(home);
  const root = join(home, "projects", "demo");
  mkdirSync(root, { recursive: true });
  const workspace = await addWorkspace(home, root, "Demo");
  return { home, workspaceId: workspace.id, root };
}

const sha = (bytes: Buffer | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const uploadId = (): string => randomBytes(16).toString("hex");

describe("listing every entry through a keyset cursor", () => {
  it("lists 1,200 entries completely, in order, each exactly once", async () => {
    const { home, workspaceId, root } = await fixture();
    for (let i = 0; i < 1_000; i += 1) writeFileSync(join(root, `f${String(i).padStart(4, "0")}.txt`), "x");
    for (let i = 0; i < 200; i += 1) mkdirSync(join(root, `d${String(i).padStart(3, "0")}`));

    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await listWorkspaceEntries(home, { workspace_id: workspaceId, ...(after ? { after } : {}) });
      expect(page.status).toBe("ok");
      if (page.status !== "ok") return;
      pages += 1;
      // The Runner says which cursor it honoured; the trusted side refuses an
      // answer without this echo as an older Runner that ignored it.
      expect(page.after).toBe(after);
      expect(page.entries.length).toBeLessThanOrEqual(MACHINE_LIMITS.workspaceListMaxEntries);
      seen.push(...page.entries.map((row) => `${row.kind}/${row.name}`));
      if (!page.truncated) break;
      after = seen.at(-1);
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(1_200);
    expect(new Set(seen).size).toBe(1_200);
    // Directories first, then files, each by name — the contract's order.
    expect(seen.slice(0, 200).every((row) => row.startsWith("directory/d"))).toBe(true);
    expect(seen).toEqual([...seen].sort((a, b) => {
      const rank = (row: string) => (row.startsWith("directory/") ? 0 : row.startsWith("file/") ? 1 : 2);
      return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
    }));
  });

  it("neither skips nor repeats an entry when others are added and removed between pages", async () => {
    const { home, workspaceId, root } = await fixture();
    const stable = Array.from({ length: 900 }, (_, i) => `s${String(i).padStart(4, "0")}.txt`);
    for (const name of stable) writeFileSync(join(root, name), "x");

    const first = await listWorkspaceEntries(home, { workspace_id: workspaceId });
    if (first.status !== "ok") throw new Error("first page refused");
    const seen = first.entries.map((row) => row.name);
    // Between pages: entries appear before the cursor, after it, and some of
    // the already-shown ones disappear. An offset would shift by the net count.
    for (let i = 0; i < 40; i += 1) writeFileSync(join(root, `a${i}.txt`), "x");
    for (let i = 0; i < 40; i += 1) writeFileSync(join(root, `t${i}.txt`), "x");
    for (const name of seen.slice(0, 60)) unlinkSync(join(root, name));

    const second = await listWorkspaceEntries(home, {
      workspace_id: workspaceId,
      after: `file/${seen.at(-1)}`,
    });
    if (second.status !== "ok") throw new Error("second page refused");
    const names = [...seen, ...second.entries.map((row) => row.name)];
    for (const name of stable) expect(names.filter((row) => row === name), name).toHaveLength(1);
    // Rows created before the cursor are not pulled into a later page.
    expect(second.entries.some((row) => row.name.startsWith("a"))).toBe(false);
  });

  it("pages the owner-local listing the same way, and refuses a malformed cursor", async () => {
    const { root } = await fixture();
    for (let i = 0; i < 700; i += 1) writeFileSync(join(root, `n${String(i).padStart(3, "0")}`), "x");
    const first = await accessOwnerFiles({ mode: "list", absolute_path: root });
    if (first.status !== "ok" || first.mode !== "list") throw new Error("refused");
    expect(first.entries).toHaveLength(500);
    expect(first.truncated).toBe(true);
    const after = `file/${first.entries.at(-1)!.name}`;
    const second = await accessOwnerFiles({ mode: "list", absolute_path: root, after });
    if (second.status !== "ok" || second.mode !== "list") throw new Error("refused");
    expect(second.after).toBe(after);
    expect(second.entries).toHaveLength(200);
    expect(second.truncated).toBe(false);
    await expect(accessOwnerFiles({ mode: "list", absolute_path: root, after: "file/a/b" })).rejects.toThrow(/after/);
    await expect(accessOwnerFiles({ mode: "list", absolute_path: root, after: "link/a" })).rejects.toThrow(/after/);
  });
});

describe("saving a text file larger than one call", () => {
  const WINDOW = MACHINE_LIMITS.workspaceWriteMaxBytes;

  /** One 3 MiB UTF-8 text, cut into byte windows on character boundaries. */
  function bigText(): { text: string; windows: string[] } {
    const line = "第 N 行：the quick brown fox 😀\n";
    const text = line.repeat(Math.ceil((3 * 1024 * 1024) / Buffer.byteLength(line)));
    const windows: string[] = [];
    let start = 0;
    let bytes = 0;
    for (let i = 0; i < text.length;) {
      const point = text.codePointAt(i)!;
      const width = point > 0xffff ? 2 : 1;
      const size = Buffer.byteLength(text.slice(i, i + width));
      if (bytes + size > WINDOW) {
        windows.push(text.slice(start, i));
        start = i;
        bytes = 0;
      }
      bytes += size;
      i += width;
    }
    windows.push(text.slice(start));
    return { text, windows };
  }

  async function staged(
    home: string,
    target: Record<string, unknown>,
    expected: string,
    windows: readonly string[],
    id = uploadId(),
  ) {
    const begun = await replaceWorkspaceText(home, { ...target, stage: "begin", upload_id: id, expected_digest: expected });
    expect(begun).toMatchObject({ status: "ok", stage: "begin", upload_id: id, size: 0 });
    let offset = 0;
    for (const window of windows) {
      const appended = await replaceWorkspaceText(home, { ...target, stage: "append", upload_id: id, offset, text: window });
      offset += Buffer.byteLength(window);
      expect(appended).toMatchObject({ status: "ok", stage: "append", size: offset });
    }
    return { id, size: offset };
  }

  const tempsIn = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

  it("stages a 3 MiB file in windows and commits it atomically, keeping its mode", async () => {
    const { home, workspaceId, root } = await fixture();
    const file = join(root, "big.md");
    writeFileSync(file, "旧内容\n");
    chmodSync(file, 0o640);
    const { text, windows } = bigText();
    expect(windows.length).toBeGreaterThan(10);
    const target = { workspace_id: workspaceId, relative_path: "big.md" };

    const { id, size } = await staged(home, target, sha("旧内容\n"), windows);
    // Nothing a staged upload does before commit touches the target.
    expect(readFileSync(file, "utf8")).toBe("旧内容\n");
    expect(tempsIn(root)).toHaveLength(1);

    const committed = await replaceWorkspaceText(home, { ...target, stage: "commit", upload_id: id, expected_digest: sha("旧内容\n"), size });
    expect(committed).toMatchObject({
      status: "ok",
      stage: "commit",
      upload_id: id,
      size: Buffer.byteLength(text),
      digest: sha(text),
      previous_digest: sha("旧内容\n"),
      workspace_id: workspaceId,
      relative_path: "big.md",
    });
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(tempsIn(root)).toEqual([]);
    expect(stagedTextCount()).toBe(0);
    // Consumed: the same commit cannot apply twice.
    expect(await replaceWorkspaceText(home, { ...target, stage: "commit", upload_id: id, expected_digest: sha("旧内容\n"), size }))
      .toEqual({ status: "refused", code: "upload_expired" });
  });

  it("refuses a stale editor at begin, and at commit when the file moved on meanwhile", async () => {
    const { home, workspaceId, root } = await fixture();
    const file = join(root, "a.txt");
    writeFileSync(file, "v1\n");
    const target = { workspace_id: workspaceId, relative_path: "a.txt" };
    const { windows } = bigText();

    expect(await replaceWorkspaceText(home, { ...target, stage: "begin", upload_id: uploadId(), expected_digest: sha("v0\n") }))
      .toEqual({ status: "refused", code: "digest_mismatch" });
    expect(stagedTextCount()).toBe(0);

    const { id, size } = await staged(home, target, sha("v1\n"), windows.slice(0, 3));
    writeFileSync(file, "v2 — somebody else saved first\n");
    expect(await replaceWorkspaceText(home, { ...target, stage: "commit", upload_id: id, expected_digest: sha("v1\n"), size }))
      .toEqual({ status: "refused", code: "digest_mismatch" });
    // Their write survives whole, and nothing of ours is left on disk.
    expect(readFileSync(file, "utf8")).toBe("v2 — somebody else saved first\n");
    expect(tempsIn(root)).toEqual([]);
    expect(stagedTextCount()).toBe(0);
  });

  it("leaves no partial file when an upload is abandoned, and sweeps it once idle", async () => {
    const { home, workspaceId, root } = await fixture();
    const file = join(root, "a.txt");
    writeFileSync(file, "keep me\n");
    const target = { workspace_id: workspaceId, relative_path: "a.txt" };
    const { windows } = bigText();
    const { id } = await staged(home, target, sha("keep me\n"), windows.slice(0, 2));

    expect(await sweepStagedTexts(Date.now())).toBe(0);
    expect(stagedTextCount()).toBe(1);
    expect(await sweepStagedTexts(Date.now() + STAGED_TEXT_IDLE_MS + 1)).toBe(1);
    expect(stagedTextCount()).toBe(0);
    expect(tempsIn(root)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("keep me\n");
    expect(await replaceWorkspaceText(home, { ...target, stage: "append", upload_id: id, offset: 0, text: "x" }))
      .toEqual({ status: "refused", code: "upload_expired" });
  });

  it("is idempotent by offset: a replayed window changes nothing, a gap ends the upload", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "a.txt"), "v1\n");
    const target = { workspace_id: workspaceId, relative_path: "a.txt" };
    const id = uploadId();
    const begin = { ...target, stage: "begin", upload_id: id, expected_digest: sha("v1\n") };
    expect(await replaceWorkspaceText(home, begin)).toMatchObject({ status: "ok", size: 0 });
    // A retried begin answers the upload it already began.
    expect(await replaceWorkspaceText(home, begin)).toMatchObject({ status: "ok", size: 0 });
    expect(await replaceWorkspaceText(home, { ...target, stage: "append", upload_id: id, offset: 0, text: "hello " }))
      .toMatchObject({ status: "ok", size: 6 });
    expect(await replaceWorkspaceText(home, { ...target, stage: "append", upload_id: id, offset: 0, text: "hello " }))
      .toMatchObject({ status: "ok", size: 6 });
    await expect(replaceWorkspaceText(home, { ...target, stage: "append", upload_id: id, offset: 9, text: "x" }))
      .rejects.toThrow(/offset/);
    expect(stagedTextCount()).toBe(0);
    expect(tempsIn(root)).toEqual([]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v1\n");
  });

  it("refuses a commit whose size or precondition disagrees with what was staged", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "a.txt"), "v1\n");
    const target = { workspace_id: workspaceId, relative_path: "a.txt" };
    const { id, size } = await staged(home, target, sha("v1\n"), ["abc"]);
    await expect(replaceWorkspaceText(home, { ...target, stage: "commit", upload_id: id, expected_digest: sha("v1\n"), size: size + 1 }))
      .rejects.toThrow(/size/);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v1\n");
    expect(tempsIn(root)).toEqual([]);
  });

  it("refuses a window that is not text or larger than one call, ending the upload", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "a.txt"), "v1\n");
    const target = { workspace_id: workspaceId, relative_path: "a.txt" };
    const one = await staged(home, target, sha("v1\n"), []);
    expect(await replaceWorkspaceText(home, { ...target, stage: "append", upload_id: one.id, offset: 0, text: "a\u0000b" }))
      .toEqual({ status: "refused", code: "not_text" });
    const two = await staged(home, target, sha("v1\n"), []);
    expect(await replaceWorkspaceText(home, { ...target, stage: "append", upload_id: two.id, offset: 0, text: "x".repeat(WINDOW + 1) }))
      .toEqual({ status: "refused", code: "too_large" });
    expect(stagedTextCount()).toBe(0);
    expect(tempsIn(root)).toEqual([]);
  });

  it("stays bound to the file it began on", async () => {
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "a.txt"), "v1\n");
    writeFileSync(join(root, "b.txt"), "v1\n");
    const { id } = await staged(home, { workspace_id: workspaceId, relative_path: "a.txt" }, sha("v1\n"), ["x"]);
    await expect(replaceWorkspaceText(home, {
      workspace_id: workspaceId, relative_path: "b.txt", stage: "append", upload_id: id, offset: 1, text: "y",
    })).rejects.toThrow(/目标/);
    expect(stagedTextCount()).toBe(0);
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("v1\n");
  });

  it("stages owner-local files through the separate owner write", async () => {
    const { root } = await fixture();
    const file = join(root, "owner.txt");
    writeFileSync(file, "v1\n");
    const id = uploadId();
    const base = { absolute_path: file, upload_id: id };
    expect(await replaceOwnerText({ ...base, stage: "begin", expected_digest: sha("v1\n") }))
      .toMatchObject({ status: "ok", stage: "begin", absolute_path: file });
    const body = "y".repeat(WINDOW);
    await replaceOwnerText({ ...base, stage: "append", offset: 0, text: body });
    await replaceOwnerText({ ...base, stage: "append", offset: WINDOW, text: body });
    expect(await replaceOwnerText({ ...base, stage: "commit", expected_digest: sha("v1\n"), size: 2 * WINDOW }))
      .toMatchObject({ status: "ok", stage: "commit", size: 2 * WINDOW, digest: sha(body + body) });
    expect(readFileSync(file, "utf8")).toBe(body + body);
  });

  it("cannot be misread as a one-call replace by a Runner that ignores `stage`", async () => {
    // What an older Runner sees: the same verb without the stage. A begin or a
    // commit has no body and an append has no precondition, so every one of
    // them is refused before anything is written.
    const { home, workspaceId, root } = await fixture();
    writeFileSync(join(root, "a.txt"), "v1\n");
    const target = { workspace_id: workspaceId, relative_path: "a.txt" };
    await expect(replaceWorkspaceText(home, { ...target, upload_id: uploadId(), expected_digest: sha("v1\n") }))
      .rejects.toThrow(/text/);
    await expect(replaceWorkspaceText(home, { ...target, upload_id: uploadId(), offset: 0, text: "x" }))
      .rejects.toThrow(/expected_digest/);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v1\n");
  });
});
