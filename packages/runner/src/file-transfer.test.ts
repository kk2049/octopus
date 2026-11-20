import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceFileTransferStore, FILE_TRANSFER_CHUNK_BYTES } from "./file-transfer.js";
import { addWorkspace, removeWorkspace } from "./workspaces.js";
import { handleRpc } from "./core.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "octopus-file-stream-"));
  const root = path.join(home, "workspace");
  await fs.mkdir(root);
  const workspace = await addWorkspace(home, root, "test");
  const store = new WorkspaceFileTransferStore();
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }), () => store.close());
  const call = (id: string, action: string, args: Record<string, unknown> = {}, site = "primary") =>
    store.rpc(home, site, { stream_id: id, workspace_id: workspace.id, action, ...args });
  return { home, root, workspace: workspace.id, store, call };
}
const digest = (data: Buffer | string) => "sha256:" + createHash("sha256").update(data).digest("hex");
async function finish(f: Awaited<ReturnType<typeof fixture>>, id: string, size: number, sha: string) {
  let reply = await f.call(id, "commit", { size: String(size), digest: sha });
  while (reply.state === "committing") {
    await new Promise((resolve) => setTimeout(resolve, 5));
    reply = await f.call(id, "status");
  }
  return reply;
}

describe("workspace binary transfer streams", () => {
  it("streams a sparse file beyond former file limits using one bounded chunk", async () => {
    const f = await fixture();
    const handle = await fs.open(path.join(f.root, "large.bin"), "w");
    await handle.truncate(9 * 1024 ** 3 + 17);
    await handle.close();
    const id = randomUUID();
    expect(await f.call(id, "open_read", { relative_path: "large.bin" })).toMatchObject({ size: String(9 * 1024 ** 3 + 17), bytes: "0" });
    const next = await f.call(id, "read", { offset: "0" });
    expect(Buffer.from(String(next.data), "base64").length).toBe(FILE_TRANSFER_CHUNK_BYTES);
    expect(next).toMatchObject({ eof: false, offset: "0", bytes: String(FILE_TRANSFER_CHUNK_BYTES) });
  });

  it.each([Buffer.alloc(0), Buffer.from([0, 255, 128, 10])])("publishes new binary files only at verified commit (%#)", async (data) => {
    const f = await fixture();
    const id = randomUUID();
    await f.call(id, "open_write", { relative_path: "中文 file.bin" });
    if (data.length) await f.call(id, "write", { offset: "0", data: data.toString("base64") });
    await expect(fs.stat(path.join(f.root, "中文 file.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await finish(f, id, data.length, digest(data))).toMatchObject({ state: "completed", digest: digest(data), bytes: String(data.length) });
    expect(await fs.readFile(path.join(f.root, "中文 file.bin"))).toEqual(data);
    await f.call(id, "close");
    expect(await fs.readdir(f.root)).toEqual(["中文 file.bin"]);
  });

  it("refuses existing destinations by default and refuses stale preimages without changing them", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "out"), "original");
    await expect(f.call(randomUUID(), "open_write", { relative_path: "out" })).rejects.toThrow("digest mismatch");
    const id = randomUUID();
    await f.call(id, "open_write", { relative_path: "out", expected_digest: digest("stale") });
    await f.call(id, "write", { offset: "0", data: Buffer.from("new").toString("base64") });
    expect(await finish(f, id, 3, digest("new"))).toMatchObject({ state: "failed", error: "destination digest mismatch" });
    expect(await fs.readFile(path.join(f.root, "out"), "utf8")).toBe("original");
    await f.call(id, "close");
    expect(await fs.readdir(f.root)).toEqual(["out"]);
  });

  it("atomically replaces an unchanged destination and preserves its mode", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "out"), "original", { mode: 0o640 });
    if (process.platform !== "win32") await fs.chmod(path.join(f.root, "out"), 0o640);
    const id = randomUUID();
    await f.call(id, "open_write", { relative_path: "out", expected_digest: digest("original") });
    await f.call(id, "write", { offset: "0", data: Buffer.from("new").toString("base64") });
    expect(await finish(f, id, 3, digest("new"))).toMatchObject({ state: "completed" });
    expect(await fs.readFile(path.join(f.root, "out"), "utf8")).toBe("new");
    if (process.platform !== "win32") expect((await fs.stat(path.join(f.root, "out"))).mode & 0o777).toBe(0o640);
  });

  it("does not clobber a file created after a create-only transfer opened", async () => {
    const f = await fixture();
    const id = randomUUID();
    await f.call(id, "open_write", { relative_path: "out" });
    await fs.writeFile(path.join(f.root, "out"), "concurrent");
    expect(await finish(f, id, 0, digest(""))).toMatchObject({ state: "failed" });
    expect(await fs.readFile(path.join(f.root, "out"), "utf8")).toBe("concurrent");
  });

  it("refuses replayed writes, checksum corruption, cross-site handles and path escapes", async () => {
    const f = await fixture();
    const id = randomUUID();
    await f.call(id, "open_write", { relative_path: "out" });
    await expect(f.call(id, "write", { offset: "0", data: "YQ==" }, "another-site")).rejects.toThrow("unavailable");
    await f.call(id, "write", { offset: "0", data: "YQ==" });
    await expect(f.call(id, "write", { offset: "0", data: "YQ==" })).rejects.toThrow("offset mismatch");
    await f.call(id, "close");
    const corrupt = randomUUID();
    await f.call(corrupt, "open_write", { relative_path: "out" });
    await expect(f.call(corrupt, "commit", { size: "0", digest: digest("wrong") })).rejects.toThrow("checksum mismatch");
    for (const relative_path of ["../secret", "/etc/passwd", "x\\y", "x/../y", ""]) {
      await expect(f.call(randomUUID(), "open_read", { relative_path })).rejects.toThrow();
    }
    if (process.platform !== "win32") {
      await fs.symlink(f.home, path.join(f.root, "escape"));
      await expect(f.call(randomUUID(), "open_write", { relative_path: "escape/secret" })).rejects.toThrow("symlinks");
    }
  });

  it("detects source changes and registry revocation between chunks", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "source"), Buffer.alloc(FILE_TRANSFER_CHUNK_BYTES + 1));
    const id = randomUUID();
    await f.call(id, "open_read", { relative_path: "source" });
    await f.call(id, "read", { offset: "0" });
    await fs.appendFile(path.join(f.root, "source"), "changed");
    await expect(f.call(id, "read", { offset: String(FILE_TRANSFER_CHUNK_BYTES) })).rejects.toThrow("changed");
    const write = randomUUID();
    await f.call(write, "open_write", { relative_path: "out" });
    await removeWorkspace(f.home, f.workspace);
    await expect(f.call(write, "write", { offset: "0", data: "YQ==" })).rejects.toThrow();
    await f.call(write, "close");
    expect((await fs.readdir(f.root)).some((name) => name.startsWith(".octopus-transfer-"))).toBe(false);
  });

  it("closes only the disconnected gateway site and removes its partial file", async () => {
    const f = await fixture();
    const first = randomUUID(), second = randomUUID();
    await f.call(first, "open_write", { relative_path: "first" });
    await f.call(second, "open_write", { relative_path: "second" }, "mirror");
    await f.store.closeSite("primary");
    await expect(f.call(first, "write", { offset: "0", data: "YQ==" })).rejects.toThrow("unavailable");
    expect(await f.call(second, "write", { offset: "0", data: "YQ==" }, "mirror")).toMatchObject({ bytes: "1" });
    await f.call(second, "close", {}, "mirror");
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  it("exposes binary transfers to execution-only Runners while honoring the machine kill switch", async () => {
    const f = await fixture();
    const request = { id: "rpc", method: "workspace_file_transfer", args: {
      stream_id: randomUUID(), workspace_id: f.workspace, action: "open_write", relative_path: "out",
    } };
    expect(await handleRpc(f.home, request, { executionOnly: true, allowMachineOps: false, fileTransfers: f.store })).toMatchObject({ ok: false });
    expect(await handleRpc(f.home, request, { executionOnly: true, allowMachineOps: true, fileTransfers: f.store })).toMatchObject({ ok: true, result: { state: "writing" } });
  });
});
