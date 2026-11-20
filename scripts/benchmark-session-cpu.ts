/** Synthetic, device-local benchmark. Run on an execution device, never the Head.
 * pnpm exec tsx scripts/benchmark-session-cpu.ts [absolute reader module for baseline]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import * as current from "../plugins/sessions/src/rich-file.js";

const reader: typeof current = process.argv[2]
  ? await import(pathToFileURL(path.resolve(process.argv[2])).href) : current;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "octopus-cpu-bench-"));
const file = path.join(directory, "synthetic.jsonl");
const record = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(16_000) } }) + "\n";
const count = Math.ceil(100 * 1024 * 1024 / Buffer.byteLength(record));
const handle = await fs.open(file, "w");
for (let i = 0; i < count; i++) await handle.write(record);
await handle.close();
let sourceBytes = 0;
const originalOpen = fs.open.bind(fs);
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const fileHandle = await originalOpen(...args);
  if (args[0] === file && args[1] === "r") {
    const originalRead = fileHandle.read.bind(fileHandle);
    fileHandle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await originalRead(buffer, offset, length, position);
      sourceBytes += result.bytesRead;
      return result;
    }) as typeof fileHandle.read;
  }
  return fileHandle;
};
const phases: unknown[] = [];
async function phase(name: string, action: () => Promise<unknown>): Promise<void> {
  const delay = monitorEventLoopDelay({ resolution: 5 }); delay.enable();
  await new Promise(resolve => setTimeout(resolve, 10));
  const cpu = process.cpuUsage(), start = performance.now(), before = sourceBytes;
  await action();
  const elapsedMs = performance.now() - start, usage = process.cpuUsage(cpu);
  await new Promise(resolve => setTimeout(resolve, 10)); delay.disable();
  phases.push({ name, elapsedMs: +elapsedMs.toFixed(2), cpuMs: +((usage.user + usage.system) / 1000).toFixed(2),
    sourceBytes: sourceBytes - before, eventLoopMaxMs: +(delay.max / 1e6).toFixed(2),
    heapMiB: +(process.memoryUsage().heapUsed / 1024 ** 2).toFixed(2),
    maxRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(2) });
}
try {
  await phase("cold", () => reader.readRichTranscriptFile(file, "codex", 20));
  await phase("unchanged-10", async () => { for (let i = 0; i < 10; i++) await reader.readRichTranscriptFile(file, "codex", 20); });
  const added = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "a".repeat(4_000) } }) + "\n";
  await fs.appendFile(file, added);
  await phase("append-4k", () => reader.readRichTranscriptFile(file, "codex", 20));
  await phase("watchers-20", () => Promise.all(Array.from({ length: 20 }, () => reader.readRichTranscriptFile(file, "codex", 20))));
  if (reader.readSessionSummaryFile) await phase("shared-summary", () => reader.readSessionSummaryFile(file, "codex"));
  console.log(JSON.stringify({ node: process.version, bytes: count * Buffer.byteLength(record), appendedBytes: Buffer.byteLength(added), phases }, null, 2));
} finally {
  fs.open = originalOpen;
  reader.resetRichTranscriptFiles();
  await fs.rm(directory, { recursive: true, force: true });
}
