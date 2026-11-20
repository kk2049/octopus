import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { gitOrThrow } from "../devpipe/worktree.js";
import { shellQuote, type MachineExec } from "../devpipe/runner-machine-sync.js";
import type { WorkspaceProvider } from "../devpipe/workspace-provider.js";
import { createLogger } from "../logger.js";
import { ANALYZER_TIMEOUT_MS, type ArchitectureServiceOptions } from "./architecture.js";

const log = createLogger("architecture-runner");
const CHUNK = 65536;
interface Manifest { version: number; repoSha: string; bytes: number; sha256: string; compressedBytes: number; compressedSha256: string; inputFingerprint: string }

function manifest(raw: string, sha: string): Manifest {
  const value = JSON.parse(raw) as Manifest;
  if (!value || value.version !== 1 || value.repoSha !== sha
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 128 * 1024 * 1024
    || !Number.isSafeInteger(value.compressedBytes) || value.compressedBytes < 1 || value.compressedBytes > 16 * 1024 * 1024
    || ![value.sha256, value.compressedSha256, value.inputFingerprint].every((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) {
    throw new Error("architecture artifact has invalid source, digest or size");
  }
  return value;
}

/** Existing owner-bound exec transports bounded bytes; no new public download endpoint or credentials. */
async function readRemote(exec: MachineExec, file: string, offset: number, length: number): Promise<{ data: Buffer; total: number }> {
  const script = `const fs=require('node:fs');const [file,offset,length]=JSON.parse(process.argv[1]);`
    + `const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);`
    + `if(!stat.isFile())throw Error('not a file');const data=Buffer.alloc(length);const bytes=fs.readSync(fd,data,0,length,offset);`
    + `console.log(JSON.stringify({offset,total:stat.size,bytes,data:data.subarray(0,bytes).toString('base64')}));}finally{fs.closeSync(fd)}`;
  const result = await exec({ command: `node -e ${shellQuote(script)} ${shellQuote(JSON.stringify([file, offset, length]))}`, timeout_ms: 30000 });
  if (!result.ok) throw new Error("architecture artifact Runner read unavailable; original task remains resumable");
  const row = JSON.parse(result.stdout) as { offset: number; total: number; bytes: number; data: string };
  if (!row || row.offset !== offset || !Number.isSafeInteger(row.total) || row.total < 0
    || !Number.isInteger(row.bytes) || row.bytes < 0 || row.bytes > length || typeof row.data !== "string") throw new Error("invalid architecture chunk receipt");
  const data = Buffer.from(row.data, "base64");
  if (data.length !== row.bytes || offset + data.length > row.total) throw new Error("architecture chunk size mismatch");
  return { data, total: row.total };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Automatic and manual refresh share this exact-SHA durable task. Offline never invokes a local analyzer. */
export function runnerArchitectureAnalyzer(opts: {
  provider: Pick<WorkspaceProvider, "wait" | "target">; exec: MachineExec; checkoutDir: string;
}): NonNullable<ArchitectureServiceOptions["runAnalyzer"]> {
  return async ({ repoDir, outFile, signal }) => {
    signal.throwIfAborted();
    const sha = await gitOrThrow(repoDir, ["rev-parse", "HEAD"]);
    const key = `architecture:${sha}`;
    const remote = path.posix.join(opts.checkoutDir, ".octopus-ci", "architecture-artifacts", sha);
    const command = "pnpm install --frozen-lockfile --prefer-offline && nice -n 10 node scripts/ops/architecture-artifact-build.mjs"
      + ` --sha ${shellQuote(sha)} --out ${shellQuote(remote)}`;
    const started = Date.now();
    log.info({ sha, key, device: opts.provider.target.device, phase: "remote" }, "architecture analysis requested on Runner");
    const result = await opts.provider.wait({ key, workspaceKey: "architecture", sha, sourceDir: repoDir, command, timeoutMs: ANALYZER_TIMEOUT_MS }, signal);
    signal.throwIfAborted();
    if (result.state !== "succeeded") return { ok: false, log: `architecture Runner ${opts.provider.target.device}: ${result.state} (${result.error ?? result.exit_code ?? ""}); previous snapshot retained` };
    const metadata = await readRemote(opts.exec, path.posix.join(remote, "manifest.json"), 0, 8192);
    if (metadata.total !== metadata.data.length) throw new Error("architecture manifest exceeds 8 KiB");
    const expected = manifest(metadata.data.toString("utf8"), sha);
    const receiptFile = `${outFile}.remote.json`;
    try {
      const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8")) as { sha256: string; mtimeMs: number; size: number };
      const stat = await fs.stat(outFile);
      if (receipt.sha256 === expected.sha256 && receipt.mtimeMs === stat.mtimeMs && receipt.size === stat.size && stat.size === expected.bytes) {
        log.info({ sha, job: result.job_id, reused: true, ms: Date.now() - started }, "architecture snapshot already installed");
        return { ok: true, log: `architecture snapshot reused: ${sha}, job ${result.job_id}` };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    const compressed = path.join(path.dirname(outFile), `.atlas-${expected.compressedSha256}.gz.partial`);
    const output = `${outFile}.${randomUUID()}.partial`;
    let offset = await fs.stat(compressed).then((stat) => stat.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0; throw error;
    });
    if (offset > expected.compressedBytes) { await fs.rm(compressed); offset = 0; }
    const handle = await fs.open(compressed, "a", 0o600);
    try {
      while (offset < expected.compressedBytes) {
        signal.throwIfAborted();
        const chunk = await readRemote(opts.exec, path.posix.join(remote, "atlas.json.gz"), offset, Math.min(CHUNK, expected.compressedBytes - offset));
        if (chunk.total !== expected.compressedBytes || !chunk.data.length) throw new Error("architecture artifact changed or truncated during transfer");
        await handle.writeFile(chunk.data); offset += chunk.data.length;
      }
    } finally { await handle.close(); }
    if (await hashFile(compressed) !== expected.compressedSha256) { await fs.rm(compressed); throw new Error("architecture compressed digest mismatch"); }
    let bytes = 0;
    const hash = createHash("sha256");
    try {
      await pipeline(createReadStream(compressed), createGunzip(), new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > expected.bytes) { callback(new Error("architecture decompression exceeds declared bytes")); return; }
        hash.update(chunk); callback(null, chunk);
      } }), createWriteStream(output, { flags: "wx", mode: 0o600 }), { signal });
      if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256) throw new Error("architecture atlas digest mismatch");
      const atlas = JSON.parse(await fs.readFile(output, "utf8")) as { schemaVersion?: number; meta?: { commit?: string; dirty?: boolean; inputFingerprint?: string } };
      if (atlas.schemaVersion !== 1 || atlas.meta?.commit !== sha || atlas.meta.dirty !== false || atlas.meta.inputFingerprint !== expected.inputFingerprint) throw new Error("architecture atlas source identity mismatch");
      signal.throwIfAborted();
      await fs.rename(output, outFile);
      const stat = await fs.stat(outFile);
      await fs.writeFile(receiptFile, JSON.stringify({ sha256: expected.sha256, mtimeMs: stat.mtimeMs, size: stat.size }), { mode: 0o600 });
      await fs.rm(compressed);
    } finally { await fs.rm(output, { force: true }); }
    log.info({ sha, job: result.job_id, direction: "inbound", compressedBytes: expected.compressedBytes, bytes: expected.bytes, ms: Date.now() - started }, "architecture Runner snapshot installed");
    return { ok: true, log: `architecture ${sha} installed from ${opts.provider.target.device}; job ${result.job_id}` };
  };
}
