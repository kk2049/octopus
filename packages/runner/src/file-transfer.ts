/**
 * Binary streams scoped to a registered workspace and authenticated gateway
 * site. Sequential descriptors and decimal byte counts have no file-size cap.
 * Only one chunk is in flight per handle; final writes publish atomically.
 */
import { createHash, randomUUID, type Hash } from "node:crypto";
import { promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspace } from "./workspaces.js";
import { workspaceRelativePathProblem } from "./workspace-paths.js";

export const FILE_TRANSFER_PROTOCOL = "workspace-file-transfer/v1";
export const FILE_TRANSFER_CHUNK_BYTES = 1024 * 1024;
const ID = /^[a-f0-9-]{36}$/;
const COUNT = /^(0|[1-9][0-9]*)$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

type Phase = "opening" | "reading" | "writing" | "committing" | "completed" | "failed";
interface Stream {
  id: string;
  home: string;
  site: string;
  workspace: string;
  relative: string;
  root: string;
  target: string;
  temporary?: string;
  expected: string;
  mode: "read" | "write";
  phase: Phase;
  handle?: FileHandle;
  original?: BigIntStats;
  bytes: bigint;
  size?: bigint;
  hash: Hash;
  digest?: string;
  error?: string;
  busy: boolean;
  closed: boolean;
  touched: number;
}

export class WorkspaceFileTransferStore {
  private readonly streams = new Map<string, Stream>();
  private readonly sweep: NodeJS.Timeout;

  constructor(private readonly idleMs = 300_000) {
    this.sweep = setInterval(() => {
      for (const stream of this.streams.values()) {
        if (!stream.busy && Date.now() - stream.touched > idleMs) void this.retire(stream);
      }
    }, Math.min(idleMs, 30_000));
    this.sweep.unref?.();
  }

  async rpc(home: string, site: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(args.stream_id ?? "");
    const workspace = String(args.workspace_id ?? "");
    if (!ID.test(id) || !/^ws_[a-f0-9]{24}$/.test(workspace)) throw new Error("invalid transfer identity");
    const action = String(args.action ?? "");
    if (action === "open_read" || action === "open_write") {
      return await this.open(home, site, workspace, id, action === "open_read" ? "read" : "write", args);
    }
    const stream = this.streams.get(id);
    if (!stream || stream.home !== home || stream.site !== site || stream.workspace !== workspace || stream.closed) {
      throw new Error("file transfer is unavailable");
    }
    stream.touched = Date.now();
    if (action === "close") {
      await this.retire(stream);
      return { stream_id: id, workspace_id: workspace, closed: true };
    }
    if (action === "status") {
      try { await this.check(stream); return this.receipt(stream); }
      catch (error) { throw new Error(safeError(error)); }
    }
    if (stream.busy) throw new Error("file transfer already has an in-flight operation");
    stream.busy = true;
    try {
      await this.check(stream);
      if (action === "read" && stream.mode === "read" && stream.phase === "reading") {
        exactOffset(args.offset, stream.bytes);
        const before = await stream.handle!.stat({ bigint: true });
        unchanged(stream.original!, before);
        this.live(stream);
        const buffer = Buffer.allocUnsafe(FILE_TRANSFER_CHUNK_BYTES);
        const { bytesRead } = await stream.handle!.read(buffer, 0, buffer.length, null);
        this.live(stream);
        stream.hash.update(buffer.subarray(0, bytesRead));
        const offset = stream.bytes;
        stream.bytes += BigInt(bytesRead);
        unchanged(stream.original!, await stream.handle!.stat({ bigint: true }));
        await this.check(stream);
        if (stream.bytes > stream.size! || (bytesRead === 0 && stream.bytes !== stream.size)) throw new Error("source changed during transfer");
        const eof = stream.bytes === stream.size;
        if (eof) {
          stream.digest = "sha256:" + stream.hash.digest("hex");
          stream.phase = "completed";
        }
        return { ...this.receipt(stream), offset: offset.toString(), data: buffer.subarray(0, bytesRead).toString("base64"), eof };
      }
      if (action === "write" && stream.mode === "write" && stream.phase === "writing") {
        exactOffset(args.offset, stream.bytes);
        const data = decodeChunk(args.data);
        let position = 0;
        while (position < data.length) {
          const { bytesWritten } = await stream.handle!.write(data, position, data.length - position, null);
          this.live(stream);
          if (!bytesWritten) throw new Error("destination made no write progress");
          position += bytesWritten;
        }
        stream.hash.update(data);
        stream.bytes += BigInt(data.length);
        await this.check(stream);
        return this.receipt(stream);
      }
      if (action === "commit" && stream.mode === "write" && stream.phase === "writing") {
        exactOffset(args.size, stream.bytes);
        const digest = "sha256:" + stream.hash.digest("hex");
        if (!DIGEST.test(String(args.digest)) || args.digest !== digest) throw new Error("transfer checksum mismatch");
        stream.digest = digest;
        stream.phase = "committing";
        // A target preimage may itself be arbitrarily large. Hash it in the
        // background; status is bounded and never imposes a total time limit.
        void this.commit(stream).catch((error) => {
          if (!stream.closed) { stream.phase = "failed"; stream.error = safeError(error); }
        }).finally(() => { stream.busy = false; stream.touched = Date.now(); });
        return this.receipt(stream);
      }
      throw new Error("invalid file transfer action or state");
    } catch (error) {
      if (stream.phase !== "committing") {
        stream.phase = "failed";
        stream.error = safeError(error);
      }
      throw new Error(safeError(error));
    } finally {
      if (stream.phase !== "committing") stream.busy = false;
      stream.touched = Date.now();
    }
  }

  private async open(home: string, site: string, workspace: string, id: string, mode: "read" | "write", args: Record<string, unknown>) {
    if (this.streams.has(id) || this.streams.size >= 32) throw new Error("file transfer handle capacity reached or duplicate identity");
    const relative = String(args.relative_path ?? "");
    validatePath(relative);
    const expected = String(args.expected_digest ?? "absent");
    if (expected !== "absent" && !DIGEST.test(expected)) throw new Error("invalid expected destination digest");
    const stream: Stream = {
      id, home, site, workspace, relative, root: "", target: "", expected, mode, phase: "opening",
      bytes: 0n, hash: createHash("sha256"), busy: true, closed: false, touched: Date.now(),
    };
    this.streams.set(id, stream);
    try {
      const registered = await resolveWorkspace(home, workspace).catch(() => { throw new Error("workspace is unavailable"); });
      this.live(stream);
      stream.root = registered.path;
      stream.target = await safeTarget(stream.root, relative);
      this.live(stream);
      if (mode === "read") {
        stream.handle = await fs.open(stream.target, "r");
        this.live(stream);
        const stat = await stream.handle.stat({ bigint: true });
        if (!stat.isFile()) throw new Error("source is not a regular file");
        stream.original = stat;
        stream.size = stat.size;
        stream.phase = "reading";
      } else {
        const previous = await optionalStat(stream.target);
        this.live(stream);
        if (previous && !previous.isFile()) throw new Error("destination is not a regular file");
        if ((expected === "absent") !== !previous) throw new Error("destination digest mismatch");
        stream.original = previous;
        stream.temporary = path.join(path.dirname(stream.target), ".octopus-transfer-" + randomUUID() + ".part");
        stream.handle = await fs.open(stream.temporary, "wx", 0o600);
        this.live(stream);
        stream.phase = "writing";
      }
      await this.check(stream);
      return this.receipt(stream);
    } catch (error) {
      await this.retire(stream);
      throw new Error(safeError(error));
    } finally {
      stream.busy = false;
    }
  }

  private live(stream: Stream): void {
    if (stream.closed || this.streams.get(stream.id) !== stream) throw new Error("file transfer was closed");
  }

  private async check(stream: Stream): Promise<void> {
    this.live(stream);
    const registered = await resolveWorkspace(stream.home, stream.workspace).catch(() => { throw new Error("workspace is unavailable"); });
    this.live(stream);
    if (registered.path !== stream.root) throw new Error("workspace changed during transfer");
    const target = await safeTarget(stream.root, stream.relative);
    this.live(stream);
    if (target !== stream.target) throw new Error("file path changed during transfer");
  }

  private receipt(stream: Stream): Record<string, unknown> {
    return {
      protocol: FILE_TRANSFER_PROTOCOL, stream_id: stream.id, workspace_id: stream.workspace,
      state: stream.phase, bytes: stream.bytes.toString(),
      ...(stream.size === undefined ? {} : { size: stream.size.toString() }),
      ...(stream.digest ? { digest: stream.digest } : {}),
      ...(stream.error ? { error: stream.error } : {}),
    };
  }

  private async commit(stream: Stream): Promise<void> {
    await stream.handle!.sync();
    this.live(stream);
    if (stream.expected !== "absent") {
      const target = await fs.open(stream.target, "r");
      try {
        const before = await target.stat({ bigint: true });
        unchanged(stream.original!, before);
        if (!before.isFile()) throw new Error("destination is not a regular file");
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(FILE_TRANSFER_CHUNK_BYTES);
        for (;;) {
          await this.check(stream);
          const { bytesRead } = await target.read(buffer, 0, buffer.length, null);
          this.live(stream);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead));
        }
        unchanged(before, await target.stat({ bigint: true }));
        this.live(stream);
        unchanged(before, await fs.lstat(stream.target, { bigint: true }));
        if ("sha256:" + hash.digest("hex") !== stream.expected) throw new Error("destination digest mismatch");
        await stream.handle!.chmod(Number(before.mode & 0o777n));
      } finally { await target.close(); }
    }
    await this.check(stream);
    await stream.handle!.close();
    stream.handle = undefined;
    await this.check(stream);
    if (stream.expected === "absent") {
      // link publishes without overwriting a concurrent creation; rename would
      // overwrite on Unix. NTFS and ordinary Unix filesystems support this.
      await fs.link(stream.temporary!, stream.target);
      // Publication happened. Record it before any cleanup await.
      stream.phase = "completed";
      await fs.unlink(stream.temporary!).catch(() => undefined);
    } else {
      unchanged(stream.original!, await fs.lstat(stream.target, { bigint: true }));
      this.live(stream);
      await fs.rename(stream.temporary!, stream.target);
      stream.phase = "completed";
    }
    stream.temporary = undefined;
  }

  private async retire(stream: Stream): Promise<void> {
    stream.closed = true;
    this.streams.delete(stream.id);
    await stream.handle?.close().catch(() => undefined);
    if (stream.temporary) await fs.unlink(stream.temporary).catch(() => undefined);
  }

  async closeSite(site: string): Promise<void> {
    await Promise.allSettled([...this.streams.values()].filter((stream) => stream.site === site).map((stream) => this.retire(stream)));
  }

  async close(): Promise<void> {
    clearInterval(this.sweep);
    await Promise.allSettled([...this.streams.values()].map((stream) => this.retire(stream)));
  }
}

function exactOffset(value: unknown, expected: bigint): void {
  if (typeof value !== "string" || !COUNT.test(value) || BigInt(value) !== expected) throw new Error("file transfer offset mismatch");
}
function decodeChunk(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(FILE_TRANSFER_CHUNK_BYTES / 3) * 4) throw new Error("invalid transfer chunk");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > FILE_TRANSFER_CHUNK_BYTES || bytes.toString("base64") !== value) throw new Error("invalid transfer chunk");
  return bytes;
}
function validatePath(relative: string): void {
  if (!relative || workspaceRelativePathProblem(relative)) throw new Error("invalid workspace file path");
  if (process.platform === "win32" && relative.split("/").some((part) =>
    /[:<>|"?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("invalid Windows file path");
  }
}
async function safeTarget(root: string, relative: string): Promise<string> {
  const parts = relative.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await optionalStat(current);
    if (stat?.isSymbolicLink()) throw new Error("symlinks are not file transfer targets");
    if (index < parts.length - 1 && !stat?.isDirectory()) throw new Error("destination parent must exist");
  }
  const parent = await fs.realpath(path.dirname(current));
  const rel = path.relative(root, parent);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("path is outside the workspace");
  return current;
}
async function optionalStat(target: string): Promise<BigIntStats | undefined> {
  try { return await fs.lstat(target, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function unchanged(before: BigIntStats, after: BigIntStats): void {
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("file changed during transfer");
}
function safeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ? "file transfer filesystem error: " + code : error instanceof Error ? error.message : "file transfer failed";
}
