/** Portable native-filesystem smoke fixture; bundle with esbuild and run with Node. */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceFileTransferStore, FILE_TRANSFER_CHUNK_BYTES } from "../file-transfer.js";
import { addWorkspace } from "../workspaces.js";

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "octopus-transfer-smoke-"));
  const root = path.join(home, "workspace");
  const store = new WorkspaceFileTransferStore();
  try {
    await fs.mkdir(root);
    const workspace = await addWorkspace(home, root, "isolated smoke");
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 37, 0xa7);
    bytes[0] = 0; bytes[1] = 255;
    const expected = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(path.join(root, "源文件.bin"), bytes);
    const source = randomUUID(), target = randomUUID();
    const rpc = (stream_id: string, action: string, args: Record<string, unknown> = {}) =>
      store.rpc(home, "primary", { workspace_id: workspace.id, stream_id, action, ...args });
    await rpc(source, "open_read", { relative_path: "源文件.bin" });
    await rpc(target, "open_write", { relative_path: "copied 中文.bin" });
    let offset = 0n, chunks = 0;
    for (;;) {
      const chunk = await rpc(source, "read", { offset: offset.toString() });
      const data = Buffer.from(String(chunk.data), "base64");
      if (data.length > FILE_TRANSFER_CHUNK_BYTES) throw new Error("chunk bound exceeded");
      if (data.length) await rpc(target, "write", { offset: offset.toString(), data: chunk.data });
      offset += BigInt(data.length); chunks++;
      if (chunk.eof) {
        if (chunk.digest !== expected) throw new Error("source checksum mismatch");
        break;
      }
    }
    let result = await rpc(target, "commit", { size: offset.toString(), digest: expected });
    while (result.state === "committing") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result = await rpc(target, "status");
    }
    if (result.state !== "completed" || !(await fs.readFile(path.join(root, "copied 中文.bin"))).equals(bytes)) {
      throw new Error("binary copy failed: " + JSON.stringify(result));
    }
    await rpc(source, "close"); await rpc(target, "close");
    const overwrite = randomUUID();
    await rpc(overwrite, "open_write", { relative_path: "copied 中文.bin", expected_digest: expected });
    const empty = "sha256:" + createHash("sha256").digest("hex");
    result = await rpc(overwrite, "commit", { size: "0", digest: empty });
    while (result.state === "committing") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result = await rpc(overwrite, "status");
    }
    if (result.state !== "completed" || (await fs.stat(path.join(root, "copied 中文.bin"))).size !== 0) throw new Error("CAS overwrite failed");
    await rpc(overwrite, "close");
    if ((await fs.readdir(root)).some((name) => name.endsWith(".part"))) throw new Error("staging leaked");
    console.log(JSON.stringify({ platform: process.platform, bytes: offset.toString(), chunks, sha256: expected, binary: true, atomicCreate: true, casOverwrite: true, cleanup: true }));
  } finally { await store.close(); await fs.rm(home, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
