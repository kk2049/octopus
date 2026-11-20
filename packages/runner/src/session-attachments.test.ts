import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRpc } from "./core.js";
import { SessionAttachmentStore } from "./session-attachments.js";
import { addWorkspace } from "./workspaces.js";
import fs from "node:fs/promises";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "session-attachment-test-"));
  roots.push(value);
  return value;
}

function chunk(data: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "session-1",
    name: "notes.txt",
    media_type: "text/plain",
    chunk_index: 0,
    chunk_count: 1,
    data: Buffer.from(data).toString("base64"),
    ...extra,
  };
}

describe("SessionAttachmentStore", () => {
  it("streams more than 8 MiB through more than 32 chunks without buffering the file", async () => {
    const store = new SessionAttachmentStore({ root: root() });
    const data = Buffer.alloc(256 * 1024, 65).toString("base64");
    let result: Record<string, unknown> = {};
    for (let index = 0; index < 65; index += 1) {
      result = await store.accept(chunk("", { data, chunk_index: index, chunk_count: 65,
        ...(index ? { upload_id: result.upload_id } : {}) }));
      if (index < 64) expect(result).toMatchObject({ complete: false, received_bytes: (index + 1) * 256 * 1024 });
    }
    const attachment = result.attachment as { path: string; bytes: number };
    expect(result.complete).toBe(true);
    expect(attachment.bytes).toBe(65 * 256 * 1024);
    expect(statSync(attachment.path).size).toBe(attachment.bytes);
    expect(readFileSync(attachment.path).every((byte) => byte === 65)).toBe(true);
  });

  it("retains the chunk bound and rejects unsafe numeric counts", async () => {
    const base = root();
    const store = new SessionAttachmentStore({ root: base });
    await expect(store.accept(chunk("x", { data: Buffer.alloc(256 * 1024 + 1).toString("base64") }))).rejects.toThrow(/分块/);
    await expect(store.accept(chunk("x", { chunk_count: Number.MAX_SAFE_INTEGER + 1 }))).rejects.toThrow(/chunk_count/);
    expect(await fs.readdir(base)).toEqual([]);
  });

  it("rejects overlapping writes without appending the same chunk twice", async () => {
    const store = new SessionAttachmentStore({ root: root() });
    const first = await store.accept(chunk("first", { chunk_count: 2 }));
    const tail = chunk("last", { chunk_index: 1, chunk_count: 2, upload_id: first.upload_id });
    const results = await Promise.allSettled([store.accept(tail), store.accept(tail)]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const accepted = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Record<string, unknown>>;
    expect(readFileSync((accepted.value.attachment as { path: string }).path, "utf8")).toBe("firstlast");
  });

  it("cleans partial files on low disk space and on a failed append", async () => {
    const base = root();
    const store = new SessionAttachmentStore({ root: base });
    const first = await store.accept(chunk("first", { chunk_count: 2 }));
    const disk = vi.spyOn(fs, "statfs").mockResolvedValue({ bavail: 0n, bsize: 4096n } as never);
    const tail = chunk("last", { chunk_index: 1, chunk_count: 2, upload_id: first.upload_id });
    await expect(store.accept(tail)).rejects.toThrow(/磁盘空间不足/);
    expect(await fs.readdir(base)).toEqual([]);
    await expect(store.accept(chunk("first"))).rejects.toThrow(/磁盘空间不足/);
    expect(await fs.readdir(base)).toEqual([]);
    disk.mockRestore();
    const next = await store.accept(chunk("first", { chunk_count: 2 }));
    vi.spyOn(fs, "appendFile").mockRejectedValueOnce(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
    await expect(store.accept({ ...tail, upload_id: next.upload_id })).rejects.toThrow("ENOSPC");
    expect(await fs.readdir(base)).toEqual([]);
    await expect(store.accept({ ...tail, upload_id: next.upload_id })).rejects.toThrow(/失效/);
  });

  it("expires abandoned uploads without another request, but allows uploads lasting over 30 minutes", async () => {
    vi.useFakeTimers();
    const base = root();
    const store = new SessionAttachmentStore({ root: base });
    const first = await store.accept(chunk("first", { chunk_count: 3 }));
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    await store.accept(chunk("middle", { chunk_count: 3, chunk_index: 1, upload_id: first.upload_id }));
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    const done = await store.accept(chunk("last", { chunk_count: 3, chunk_index: 2, upload_id: first.upload_id }));
    expect(done.complete).toBe(true);
    await store.accept(chunk("abandoned", { chunk_count: 2 }));
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
    // Timer starts asynchronous disk cleanup; wait for its observable completion.
    await vi.waitFor(async () => expect(await fs.readdir(base)).toHaveLength(1));
    expect(readFileSync((done.attachment as { path: string }).path, "utf8")).toBe("firstmiddlelast");
  });

  it("creates a new device-local temp directory and never uses the caller name as a path", async () => {
    const base = root();
    const store = new SessionAttachmentStore({ root: base });
    const result = await store.accept(chunk("hello", { name: "../../notes.txt" }));
    expect(result.complete).toBe(true);
    const attachment = result.attachment as { label: string; path: string; bytes: number };
    expect(attachment.label).toBe("notes.txt");
    expect(path.dirname(attachment.path)).toMatch(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/octopus-session-`));
    expect(readFileSync(attachment.path, "utf8")).toBe("hello");
    expect(attachment.bytes).toBe(5);
    expect(statSync(attachment.path).mode & 0o777).toBe(0o600);
  });

  it("reveals the absolute path only after ordered chunks finish", async () => {
    const base = root();
    const store = new SessionAttachmentStore({ root: base });
    const first = await store.accept(chunk("hello ", { chunk_count: 2 }));
    expect(first).toMatchObject({ complete: false, received_bytes: 6 });
    expect(first).not.toHaveProperty("attachment");

    await expect(store.accept(chunk("world", {
      id: "another-session",
      chunk_index: 1,
      chunk_count: 2,
      upload_id: first.upload_id,
    }))).rejects.toThrow(/不属于当前会话/);

    const completed = await store.accept(chunk("world", {
      chunk_index: 1,
      chunk_count: 2,
      upload_id: first.upload_id,
    }));
    const attachment = completed.attachment as { path: string };
    expect(completed.complete).toBe(true);
    expect(readFileSync(attachment.path, "utf8")).toBe("hello world");
  });

  it("does not let a multipart id cross a trusted caller scope", async () => {
    const base = root();
    const store = new SessionAttachmentStore({ root: base });
    const first = await store.accept(chunk("hello ", { chunk_count: 2 }), "alice");

    await expect(store.accept(chunk("world", {
      chunk_index: 1,
      chunk_count: 2,
      upload_id: first.upload_id,
    }), "bob")).rejects.toThrow(/不属于当前账户/);

    const completed = await store.accept(chunk("world", {
      chunk_index: 1,
      chunk_count: 2,
      upload_id: first.upload_id,
    }), "alice");
    expect(completed.complete).toBe(true);
  });

  it("runs through the machine-op kill switch and audit seam", async () => {
    const base = root();
    const store = new SessionAttachmentStore({ root: base });
    const denied = await handleRpc(base, {
      id: "rpc-denied",
      method: "upload_session_file",
      args: chunk("x"),
    }, { allowMachineOps: false, sessionAttachments: store });
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("RUNNER_ALLOW_MACHINE_OPS=0") });
    expect(existsSync(base)).toBe(true);

    const audit: string[] = [];
    const accepted = await handleRpc(base, {
      id: "rpc-ok",
      method: "upload_session_file",
      args: chunk("x"),
    }, {
      allowMachineOps: true,
      sessionAttachments: store,
      onMachineOp: (_method, summary) => audit.push(summary),
    });
    expect(accepted.ok).toBe(true);
    expect(audit).toEqual(["#session-1: file chunk 0/1"]);
  });
});


describe("registered attachment destinations", () => {
  it("writes on the receiving execution Runner in its own registered workspace, never a supplied path", async () => {
    const home = root();
    const workspaceRoot = root();
    const workspace = await addWorkspace(home, workspaceRoot, "execution workspace");
    const answer = await handleRpc(home, { id: "upload", method: "upload_session_file", args: chunk("image bytes", {
      workspace_id: workspace.id, path: "/service/forged.png", directory: "/model-head/home",
    }) }, { allowMachineOps: true, executionOnly: true, sessionAttachments: new SessionAttachmentStore({ root: home }) });
    expect(answer.ok).toBe(true);
    const result = answer.result as { attachment: { path: string } };
    expect(path.dirname(path.dirname(result.attachment.path))).toBe(workspaceRoot);
    expect(path.basename(path.dirname(result.attachment.path))).toMatch(/^\.octopus-attachment-/);
    expect(readFileSync(result.attachment.path, "utf8")).toBe("image bytes");
    expect(statSync(result.attachment.path).mode & 0o777).toBe(0o600);
  });

  it("refuses a changed workspace between chunks and still completes at the original destination", async () => {
    const home = root();
    const a = await addWorkspace(home, root(), "a");
    const b = await addWorkspace(home, root(), "b");
    const options = { allowMachineOps: true, executionOnly: true, gatewaySite: "site-a", sessionAttachments: new SessionAttachmentStore() };
    const call = (args: Record<string, unknown>) => handleRpc(home, { id: "upload", method: "upload_session_file", args }, options);
    const first = await call(chunk("first", { workspace_id: a.id, chunk_count: 2 }));
    expect(first.ok).toBe(true);
    const uploadId = (first.result as { upload_id: string }).upload_id;
    const tail = chunk("last", { workspace_id: a.id, chunk_count: 2, chunk_index: 1, upload_id: uploadId });
    expect(await call({ ...tail, workspace_id: b.id })).toMatchObject({ ok: false, error: expect.stringContaining("当前执行工作区") });
    const last = await call(tail);
    expect(last.ok).toBe(true);
    expect(readFileSync((last.result as { attachment: { path: string } }).attachment.path, "utf8")).toBe("firstlast");
    expect(await call(chunk("x", { workspace_id: "ws_ffffffffffffffffffffffff" }))).toMatchObject({ ok: false, error: expect.stringContaining("未登记") });
    expect(await call(chunk("x"))).toMatchObject({ ok: false, error: expect.stringContaining("已登记工作区") });
  });

  it("uses a normal same-device session's registered workspace while retaining temporary legacy uploads", async () => {
    const home = root();
    const workspaceRoot = root();
    await addWorkspace(home, workspaceRoot, "ordinary workspace");
    const id = "11111111-0000-0000-0000-000000000001";
    const directory = path.join(home, ".claude", "projects", "fixture");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${id}.jsonl`), JSON.stringify({ type: "user", sessionId: id,
      cwd: workspaceRoot, message: { role: "user", content: "original" } }) + "\n");
    const answer = await handleRpc(home, { id: "upload", method: "upload_session_file", args: chunk("same device", { id }) },
      { allowMachineOps: true, sessionAttachments: new SessionAttachmentStore({ root: home }) });
    expect(answer.ok).toBe(true);
    const stored = (answer.result as { attachment: { path: string } }).attachment;
    expect(path.dirname(path.dirname(stored.path))).toBe(workspaceRoot);
  });
});
