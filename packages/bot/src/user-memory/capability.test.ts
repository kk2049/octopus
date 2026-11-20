/**
 * The user-memory capability plane, against the real kernel and a real
 * temporary filesystem.
 *
 * What is pinned:
 *  - the closed table's shape (no identity fields; write/append are `modify`;
 *    the retrySafe declarations are the ones interrupt recovery reads);
 *  - the jail: `../`, absolute paths, symlinks out and writes through
 *    symlinked directories all refuse WITHOUT touching the other account's
 *    bytes;
 *  - approvals: a write queues a card only the owner may approve, approving
 *    executes the original call, a grant cannot smuggle `write_memory` into
 *    its own auto-allow;
 *  - bounds are per call: content over the schema cap is denied before the
 *    adapter, while a file or directory of any size is read in windows/pages
 *    and written in chunks;
 *  - revocation and account removal fail closed.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import {
  USER_MEMORY_LIMITS,
  USER_MEMORY_OPERATIONS,
  USER_MEMORY_OPERATION_NAMES,
  UserMemoryCapabilities,
} from "./capability.js";

const READ_OPS = ["list_memory", "read_memory", "search_memory"] as const;

let dir: string;
let svc: CapabilityService;
let plane: UserMemoryCapabilities;
let users: Set<string>;

const memDir = (name: string) => path.join(dir, name, "memory");

function openAlice(autoAllow: readonly string[] = READ_OPS) {
  const grant = plane.open({
    username: "alice",
    purpose: "test",
    rights: USER_MEMORY_OPERATION_NAMES,
    autoAllow,
  });
  expect(grant).not.toBeNull();
  return grant!;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "user-memory-"));
  users = new Set(["alice", "bob"]);
  for (const u of users) mkdirSync(memDir(u), { recursive: true });
  writeFileSync(path.join(memDir("alice"), "MEMORY.md"), "alice head facts");
  mkdirSync(path.join(memDir("alice"), "machines"), { recursive: true });
  writeFileSync(path.join(memDir("alice"), "machines", "laptop.md"), "laptop has the photos");
  writeFileSync(path.join(memDir("bob"), "MEMORY.md"), "bob secret facts");
  svc = new CapabilityService();
  plane = new UserMemoryCapabilities({
    service: svc,
    userExists: (u) => users.has(u),
    memoryDirFor: (u) => (users.has(u) ? memDir(u) : undefined),
  });
});

afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the closed table", () => {
  it("declares no identity or root fields anywhere", () => {
    const allowed = new Set(["path", "content", "query", "limit", "offset", "max_bytes", "cursor"]);
    for (const spec of Object.values(USER_MEMORY_OPERATIONS)) {
      for (const key of Object.keys(spec.args)) expect(allowed.has(key)).toBe(true);
    }
  });

  it("writes are modify; overwrite is retry-safe, append is explicitly not", () => {
    expect(USER_MEMORY_OPERATIONS.write_memory.effect).toBe("modify");
    expect(USER_MEMORY_OPERATIONS.append_memory.effect).toBe("modify");
    expect(USER_MEMORY_OPERATIONS.write_memory.retrySafe).toBe(true);
    expect(USER_MEMORY_OPERATIONS.append_memory.retrySafe).toBe(false);
  });
});

describe("reads", () => {
  it("list / read / search answer the owner's own directory", async () => {
    const grant = openAlice();
    const listed = await grant.request("list_memory", {});
    expect(listed.status).toBe("succeeded");
    const files = (listed as { result: { files: Array<{ path: string }> } }).result.files.map((f) => f.path).sort();
    expect(files).toEqual(["MEMORY.md", "machines/laptop.md"]);

    const read = await grant.request("read_memory", { path: "machines/laptop.md" });
    expect(read.status).toBe("succeeded");
    expect((read as { result: { content: string } }).result.content).toBe("laptop has the photos");

    const found = await grant.request("search_memory", { query: "PHOTOS" });
    expect(found.status).toBe("succeeded");
    expect((found as { result: { hits: Array<{ path: string }> } }).result.hits[0].path).toBe("machines/laptop.md");
  });

  it("reads bob's content only through bob's own grant", async () => {
    const alice = openAlice();
    const aliceRead = await alice.request("read_memory", { path: "MEMORY.md" });
    expect((aliceRead as { result: { content: string } }).result.content).toBe("alice head facts");
    const bob = plane.open({ username: "bob", purpose: "test", rights: READ_OPS, autoAllow: READ_OPS })!;
    const bobRead = await bob.request("read_memory", { path: "MEMORY.md" });
    expect((bobRead as { result: { content: string } }).result.content).toBe("bob secret facts");
  });

  it("an unknown account opens nothing", () => {
    expect(plane.open({ username: "mallory", purpose: "test", rights: READ_OPS })).toBeNull();
  });
});

describe("the jail", () => {
  it("refuses ../ and absolute paths", async () => {
    writeFileSync(path.join(dir, "alice", "outside.txt"), "outside");
    const grant = openAlice();
    for (const escape of ["../outside.txt", path.join(dir, "alice", "outside.txt"), "/etc/passwd"]) {
      const out = await grant.request("read_memory", { path: escape });
      expect(out.status).toBe("failed");
    }
  });

  it("refuses a symlink pointing at another account's memory", async () => {
    symlinkSync(path.join(memDir("bob"), "MEMORY.md"), path.join(memDir("alice"), "link.md"));
    const grant = openAlice();
    const out = await grant.request("read_memory", { path: "link.md" });
    expect(out.status).toBe("failed");
    expect(JSON.stringify(out)).not.toContain("bob secret");
  });

  it("refuses a write through a symlinked directory, leaving the target untouched", async () => {
    symlinkSync(memDir("bob"), path.join(memDir("alice"), "evil"));
    const grant = openAlice([...READ_OPS, "write_memory"]);
    const out = await grant.request("write_memory", { path: "evil/planted.md", content: "poison" });
    expect(out.status).not.toBe("succeeded");
    expect(readFileSync(path.join(memDir("bob"), "MEMORY.md"), "utf8")).toBe("bob secret facts");
    rmSync(path.join(memDir("bob"), "planted.md"), { force: true });
  });
});

describe("writes and approvals", () => {
  it("a write queues a card; the owner's approval executes the ORIGINAL call", async () => {
    const grant = openAlice();
    const asked = await grant.request("write_memory", { path: "notes.md", content: "v1" });
    expect(asked.status).toBe("approval_required");
    const pendingId = (asked as { pendingCallId: string }).pendingCallId;

    // Not the owner: denied, and nothing was written.
    const denied = await svc.approve(pendingId, "bob");
    expect(denied.status).toBe("denied");

    const approved = await svc.approve(pendingId, "alice");
    expect(approved.status).toBe("succeeded");
    expect(readFileSync(path.join(memDir("alice"), "notes.md"), "utf8")).toBe("v1");
  });

  it("lets a grant that states it make the owner's own writes silent (O1)", async () => {
    // The account root now admits the owner's memory writes as silent terms;
    // a grant that asks for them gets them, and one that does not still asks.
    const silent = openAlice([...USER_MEMORY_OPERATION_NAMES]);
    const out = await silent.request("write_memory", { path: "a.md", content: "x" });
    expect(out.status).toBe("succeeded");
    expect(readFileSync(path.join(memDir("alice"), "a.md"), "utf8")).toBe("x");
  });

  it("append is a separate approval and preserves the original content", async () => {
    writeFileSync(path.join(memDir("alice"), "log.md"), "day1\n");
    const grant = openAlice();
    const asked = await grant.request("append_memory", { path: "log.md", content: "day2\n" });
    expect(asked.status).toBe("approval_required");
    await svc.approve((asked as { pendingCallId: string }).pendingCallId, "alice");
    expect(readFileSync(path.join(memDir("alice"), "log.md"), "utf8")).toBe("day1\nday2\n");
  });
});

describe("bounds", () => {
  it("content over the schema cap is denied before the adapter", async () => {
    const grant = openAlice();
    const out = await grant.request("write_memory", {
      path: "big.md",
      content: "x".repeat(USER_MEMORY_LIMITS.writeMaxBytes + 1),
    });
    expect(out.status).toBe("denied");
  });

  it("reads a file over 1 MiB in windows that reassemble it exactly", async () => {
    const big = "开头\n" + "记忆行 memory line 😀\n".repeat(80_000) + "结尾";
    expect(Buffer.byteLength(big)).toBeGreaterThan(2 * 1024 * 1024);
    writeFileSync(path.join(memDir("alice"), "big.md"), big);
    const grant = openAlice();
    let offset: number | undefined = 0;
    let text = "";
    let windows = 0;
    while (offset !== undefined) {
      const out = await grant.request("read_memory", { path: "big.md", offset });
      expect(out.status).toBe("succeeded");
      const window = (out as { result: { content: string; size: number; eof: boolean; next_offset?: number } }).result;
      expect(window.size).toBe(Buffer.byteLength(big));
      expect(Buffer.byteLength(window.content)).toBeLessThanOrEqual(USER_MEMORY_LIMITS.readWindowBytes);
      expect(window.eof).toBe(window.next_offset === undefined);
      text += window.content;
      offset = window.next_offset;
      windows++;
    }
    expect(windows).toBeGreaterThanOrEqual(3);
    expect(text).toBe(big);
  });

  it("lists 2,500 files through cursor pages without repeats or gaps", async () => {
    for (let i = 0; i < 2_500; i++) {
      const sub = path.join(memDir("alice"), `d${i % 7}`);
      mkdirSync(sub, { recursive: true });
      writeFileSync(path.join(sub, `f${i}.md`), "x");
    }
    const grant = openAlice();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out = await grant.request("list_memory", cursor ? { cursor, limit: 400 } : { limit: 400 });
      expect(out.status).toBe("succeeded");
      const page = (out as { result: { files: Array<{ path: string }>; next_cursor?: string } }).result;
      expect(page.files.length).toBeLessThanOrEqual(400);
      seen.push(...page.files.map((f) => f.path));
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(Math.ceil(2_502 / 400));
    expect(seen).toHaveLength(2_502); // plus MEMORY.md and machines/laptop.md
    expect(new Set(seen).size).toBe(2_502);
    expect(seen).toEqual([...seen].sort());
  });

  it("searches every file across pages, including a hit beyond the first 1 MiB of a file", async () => {
    writeFileSync(path.join(memDir("alice"), "deep.md"), "x".repeat(3 * 1024 * 1024) + " the NEEDLE-TOKEN is here");
    for (let i = 0; i < 5; i++) writeFileSync(path.join(memDir("alice"), `n${i}.md`), `needle-token ${i}`);
    const grant = openAlice();
    const hits: string[] = [];
    let cursor: string | undefined;
    do {
      const out = await grant.request("search_memory", { query: "needle-token", limit: 2, ...(cursor ? { cursor } : {}) });
      const page = (out as { result: { hits: Array<{ path: string; excerpt: string }>; next_cursor?: string } }).result;
      hits.push(...page.hits.map((h) => h.path));
      if (page.hits.some((h) => h.path === "deep.md")) {
        expect(page.hits.find((h) => h.path === "deep.md")!.excerpt).toContain("NEEDLE-TOKEN is here");
      }
      cursor = page.next_cursor;
    } while (cursor);
    expect(hits.sort()).toEqual(["deep.md", "n0.md", "n1.md", "n2.md", "n3.md", "n4.md"]);
  });

  it("writes a file larger than one call in retry-safe chunks and appends past 1 MiB", async () => {
    const grant = openAlice([...USER_MEMORY_OPERATION_NAMES]);
    const chunk = (n: number) => String(n).repeat(USER_MEMORY_LIMITS.writeMaxBytes);
    let size = 0;
    for (let n = 0; n < 6; n++) {
      const out = await grant.request("write_memory", { path: "chunked.md", content: chunk(n), offset: size });
      expect(out.status).toBe("succeeded");
      size = (out as { result: { size: number } }).result.size;
    }
    // A repeated chunk lands the same bytes (retry-safe).
    await grant.request("write_memory", { path: "chunked.md", content: chunk(5), offset: 5 * USER_MEMORY_LIMITS.writeMaxBytes });
    const expected = [0, 1, 2, 3, 4, 5].map(chunk).join("");
    expect(readFileSync(path.join(memDir("alice"), "chunked.md"), "utf8")).toBe(expected);
    const gap = await grant.request("write_memory", { path: "chunked.md", content: "x", offset: expected.length + 1 });
    expect(gap.status).toBe("failed");
    const appended = await grant.request("append_memory", { path: "chunked.md", content: "tail" });
    expect((appended as { result: { size: number } }).result.size).toBe(expected.length + 4);
  });

  it("creates files beyond the old 1000-file mark", async () => {
    for (let i = 0; i < 1_000; i++) writeFileSync(path.join(memDir("alice"), `f${i}.md`), "x");
    const grant = openAlice([...USER_MEMORY_OPERATION_NAMES]);
    const out = await grant.request("write_memory", { path: "onemore.md", content: "x" });
    expect(out.status).toBe("succeeded");
  });
});

describe("revocation", () => {
  it("revokeAccount fails every held grant closed", async () => {
    const grant = openAlice();
    expect((await grant.request("list_memory", {})).status).toBe("succeeded");
    plane.revokeAccount("alice");
    expect((await grant.request("list_memory", {})).status).toBe("denied");
  });

  it("deleting the account fails the very next adapter call, then the root", async () => {
    const grant = openAlice();
    users.delete("alice");
    // The binding closure re-asks the trusted facts at call time.
    expect((await grant.request("list_memory", {})).status).toBe("failed");
    // And the next open re-reads bindingFor, revoking what still stands.
    expect(plane.open({ username: "alice", purpose: "test", rights: READ_OPS })).toBeNull();
    expect((await grant.request("list_memory", {})).status).toBe("denied");
    expect(plane.accountOperations("alice")).toEqual([]);
  });
});
