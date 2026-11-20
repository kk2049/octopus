import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitOrThrow } from "./worktree.js";
import { readTicketFiles, TICKET_DIRECTORY_PAGE, TICKET_FILE_WINDOW_BYTES } from "./ticket-files.js";

describe("ticket source boundary", () => {
  let root: string;
  let repo: string;
  let worktree: string;
  let revision: string;
  const ticket = () => ({ worktree, branch: "ticket/1", commit_sha: null, dev_status: "open" as const });
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ticket-source-"));
    repo = path.join(root, "repo");
    worktree = path.join(root, "ticket");
    await gitOrThrow(root, ["init", "-b", "v4", repo]);
    await gitOrThrow(repo, ["config", "user.email", "test@test"]);
    await gitOrThrow(repo, ["config", "user.name", "test"]);
    await mkdir(path.join(repo, "src"));
    await writeFile(path.join(repo, "src/a.ts"), "  base\n\n");
    await writeFile(path.join(repo, "src/说明.md"), "# 中文\n");
    await writeFile(path.join(repo, "src/binary"), Buffer.from([0xff, 0]));
    // 5 MiB of mixed-width UTF-8, so window edges fall inside characters.
    await writeFile(path.join(repo, "src/large.txt"), `${"ascii line\n中文行😀\n".repeat(5 * 1024 * 1024 / 27 + 1)}END-OF-FILE`);
    await mkdir(path.join(repo, "wide"));
    for (let i = 0; i < 3_000; i++) await writeFile(path.join(repo, "wide", `f${String(i).padStart(4, "0")}.txt`), "");
    await mkdir(path.join(repo, "wide", "zz-dir"));
    await writeFile(path.join(repo, "wide", "zz-dir", "x"), "");
    await writeFile(path.join(repo, "src/back\\slash.txt"), "unaddressable");
    await symlink("/etc/passwd", path.join(repo, "src/link"));
    await symlink("/etc", path.join(repo, "outside"));
    await gitOrThrow(repo, ["add", "."]);
    await gitOrThrow(repo, ["commit", "-m", "base"]);
    await gitOrThrow(repo, ["worktree", "add", "-b", "ticket/1", worktree]);
    await writeFile(path.join(worktree, "src/a.ts"), "  ticket\n\n");
    await gitOrThrow(worktree, ["commit", "-am", "ticket"]);
    revision = await gitOrThrow(worktree, ["rev-parse", "HEAD"]);
    await writeFile(path.join(worktree, "src/a.ts"), "uncommitted");
    await writeFile(path.join(worktree, "token.env"), "private");
  }, 30_000);
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("maps the primary and own worktree paths to the ticket snapshot, preserving whitespace", async () => {
    for (const name of ["src/a.ts", `${repo}/src/a.ts`, `${worktree}/src/a.ts`]) {
      expect(await readTicketFiles(repo, "v4", ticket(), name)).toEqual({ kind: "file", path: "src/a.ts", text: "  ticket\n\n", source: "ticket", revision, size: 10, offset: 0, object: expect.stringMatching(/^[0-9a-f]{40,64}$/) });
    }
  });
  it("lists directories and unicode names while omitting symlinks", async () => {
    const result = await readTicketFiles(repo, "v4", ticket(), "src");
    expect(result.kind).toBe("directory");
    if (result.kind !== "directory") return;
    expect(result.entries.map((e) => e.name)).toContain("说明.md");
    expect(result.entries.map((e) => e.name)).not.toContain("link");
    expect(await readTicketFiles(repo, "v4", ticket(), "src/说明.md")).toMatchObject({ text: "# 中文\n" });
  });
  it.each(["/etc/passwd", `${tmpdir()}/other-ticket/src/a.ts`, "../repo/src/a.ts", "src/../../etc/passwd", ".git/config", "src/../a.ts", "src/a.ts\0", "src\\a.ts", ":(glob)**", "src/*"])("refuses arbitrary paths and pathspecs: %s", async (name) => {
    await expect(readTicketFiles(repo, "v4", ticket(), name)).rejects.toThrow();
  });
  it.each(["src/link", "outside/passwd", "token.env"])("does not follow links or read uncommitted files: %s", async (name) => {
    await expect(readTicketFiles(repo, "v4", ticket(), name)).rejects.toMatchObject({ status: 404 });
  });
  it("refuses binary", async () => {
    await expect(readTicketFiles(repo, "v4", ticket(), "src/binary")).rejects.toMatchObject({ status: 422 });
  });
  it("reads a 5 MiB file whole in windows cut between characters", async () => {
    const expected = await readFile(path.join(repo, "src/large.txt"), "utf8");
    let offset: number | undefined = 0;
    let text = "";
    let windows = 0;
    while (offset !== undefined) {
      const page = await readTicketFiles(repo, "v4", ticket(), "src/large.txt", { offset });
      if (page.kind !== "file") throw new Error("expected a file");
      expect(page.offset).toBe(offset);
      expect(page.size).toBe(Buffer.byteLength(expected));
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(TICKET_FILE_WINDOW_BYTES);
      text += page.text;
      windows++;
      offset = page.next_offset;
    }
    expect(windows).toBeGreaterThanOrEqual(5);
    const first = await readTicketFiles(repo, "v4", ticket(), "src/large.txt");
    const blob = await gitOrThrow(repo, ["rev-parse", "HEAD:src/large.txt"]);
    expect(first.object).toBe(blob);
    expect(text).toBe(expected);
    await expect(readTicketFiles(repo, "v4", ticket(), "src/large.txt", { offset: 13 })).rejects.toMatchObject({ status: 400 });
  }, 30_000);
  it("pages a 3,000-entry directory, directories first, without repeats", async () => {
    const names: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await readTicketFiles(repo, "v4", ticket(), "wide", cursor ? { cursor } : {});
      if (page.kind !== "directory") throw new Error("expected a directory");
      expect(page.total).toBe(3_001);
      expect(page.entries.length).toBeLessThanOrEqual(TICKET_DIRECTORY_PAGE);
      names.push(...page.entries.map((entry) => entry.name));
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(Math.ceil(3_001 / TICKET_DIRECTORY_PAGE));
    expect(names[0]).toBe("zz-dir");
    expect(new Set(names).size).toBe(3_001);
    expect(names.slice(1)).toEqual([...names.slice(1)].sort());
    const root = await readTicketFiles(repo, "v4", ticket(), "");
    expect(root.object).toBe(await gitOrThrow(repo, ["rev-parse", "refs/heads/ticket/1^{tree}"]));
    const src = await readTicketFiles(repo, "v4", ticket(), "src");
    expect(src).toMatchObject({ kind: "directory", unlisted: 1 });
    await expect(readTicketFiles(repo, "v4", ticket(), "wide", { cursor: "bogus" })).rejects.toMatchObject({ status: 400 });
  }, 30_000);
  it("uses the landed sha after branch cleanup and identifies the base for tickets without a branch", async () => {
    expect(await readTicketFiles(repo, "v4", { ...ticket(), branch: "gone", commit_sha: revision, dev_status: "landed" }, "src/a.ts")).toMatchObject({ revision, source: "ticket" });
    expect(await readTicketFiles(repo, "v4", { ...ticket(), branch: null }, "src/a.ts")).toMatchObject({ text: "  base\n\n", source: "base" });
  });
});
