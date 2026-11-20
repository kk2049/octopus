/** Run on the execution provider: node --import tsx .../session-observation.bench.ts */
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { SessionObservationIndex } from "./session-observation.js";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
for (const count of [1_000, 10_000]) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "observed-roster-bench-"));
  const homes = Array.from({ length: 1_024 }, (_, n) => ({ label: "", codexHome: path.join(home, `worker-${n}`, "home") }));
  const roots = { home, codexHomes: homes };
  const stateFile = path.join(home, ".octopus", "session-observation-v1.jsonl");
  const lines: string[] = [];
  for (let n = 0; n < count; n++) {
    const root = path.join(homes[n % homes.length].codexHome, "sessions");
    const dir = path.join(root, "2026", "09", "17"); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-${id(n)}.jsonl`);
    const data = JSON.stringify({ type: "session_meta", payload: { id: id(n), source: "cli", cwd: home } }) + "\n"
      + JSON.stringify({ type: "event_msg", timestamp: "2026-09-17T00:00:00Z", payload: { type: "user_message", message: `task ${n}` } }) + "\n";
    await fs.writeFile(file, data);
    lines.push(JSON.stringify({ root, version: "warm-metadata", mtime: 1,
      summary: { source: "codex", id: id(n), path: file, last_activity: "2026-09-17T00:00:00Z", message_count: 1, preview: `task ${n}` } }));
  }
  await fs.mkdir(path.dirname(stateFile), { recursive: true }); await fs.writeFile(stateFile, lines.join("\n") + "\n");
  const observer = new SessionObservationIndex({ home, roots: async () => roots });
  try {
    const start = performance.now(); await observer.start();
    for (let i = 0; i < 5_000; i++) {
      await observer.tick();
      if (!(await observer.list({ limit: 200, primary_window: true }) as { index_pending: boolean }).index_pending) break;
    }
    const coldMs = performance.now() - start;
    const active = [0, 1].map((n) => ({ source: "codex" as const, id: id(n) })); observer.setLive(active);
    for (const identity of active) await observer.refresh(identity);
    await observer.list({ limit: 200, primary_window: true });
    const baseline = { ...observer.stats }; const cpu = process.cpuUsage(); const began = performance.now();
    for (let i = 0; i < 1_000; i++) await observer.list({ limit: 200, primary_window: true });
    const listMs = performance.now() - began; const consumed = process.cpuUsage(cpu);
    const listIo = { directories: observer.stats.directoryReads - baseline.directoryReads, files: observer.stats.fileReads - baseline.fileReads };
    const pollStart = performance.now();
    for (let i = 0; i < 20; i++) for (const identity of active) await observer.refresh(identity);
    console.log(JSON.stringify({ history: count, roots: homes.length, coldMs, list1000Ms: listMs,
      listCpuMs: (consumed.user + consumed.system) / 1_000, listIo,
      livePoll20Ms: performance.now() - pollStart, unchangedBodyReads: observer.stats.fileReads - baseline.fileReads,
      rssMiB: process.memoryUsage().rss / 1024 / 1024 }));
  } finally { await observer.close(); await fs.rm(home, { recursive: true, force: true }); }
}
