import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { build, type Options } from "tsup";
import config from "./tsup.config.js";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("bundles current session source even when package exports resolve to deliberately stale dist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runner-standalone-source-")); dirs.push(root);
  const stale = path.join(root, "node_modules", "@claude-bot", "plugin-sessions");
  await mkdir(path.join(stale, "dist"), { recursive: true });
  await writeFile(path.join(stale, "package.json"), JSON.stringify({ name: "@claude-bot/plugin-sessions", type: "module",
    exports: { "./scan": "./dist/scan.js", "./parse": "./dist/parse.js" } }));
  await writeFile(path.join(stale, "dist", "scan.js"), 'export async function listRecentSessions(){return {sessions:[{title:"STALE_PLUGIN_DIST"}]}}');
  await writeFile(path.join(stale, "dist", "parse.js"), 'export function deriveIdFromPath(){return "STALE_PLUGIN_DIST"}');
  const entry = path.join(root, "entry.ts");
  await writeFile(entry, `import { listRecentSessions } from "@claude-bot/plugin-sessions/scan";
import { deriveIdFromPath } from "@claude-bot/plugin-sessions/parse";
const result = await listRecentSessions(process.argv[2], {source:"codex", limit:1});
console.log(JSON.stringify({title: result.sessions[0].title, id: deriveIdFromPath("codex", process.argv[3])}));`);
  const sid = "01a0a417-0984-7461-a8c4-5fb1760d9df5";
  const home = path.join(root, "home"), sessions = path.join(home, ".codex", "sessions", "2026", "09", "15");
  await mkdir(sessions, { recursive: true });
  const transcript = path.join(sessions, `rollout-2026-09-15T08-02-48-${sid}.jsonl`);
  await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id: sid, cwd: "/workspace", timestamp: "2026-09-15T08:02:48Z" } }) + "\n"
    + JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"Original prompt fallback"}]}}) + "\n");
  await writeFile(path.join(home, ".codex", "session_index.jsonl"), JSON.stringify({id:sid,thread_name:"Native current name"}) + "\n");
  const standalone = (config as Options[]).find((part) => part.entry && !Array.isArray(part.entry) && typeof part.entry === "object" && "standalone" in part.entry)!;
  expect(standalone).toBeDefined();
  const options: Options = { ...standalone, config: false, entry: { standalone: entry }, outDir: path.join(root, "dist"),
    outExtension: () => ({ js: ".mjs" }), splitting: false, silent: true };
  // Prove the fixture's ordinary package resolution really is stale.
  await build({ ...options, esbuildOptions: undefined });
  const output = path.join(root, "dist", "standalone.mjs");
  expect(JSON.parse((await run(process.execPath, [output, home, transcript])).stdout)).toEqual({ title: "STALE_PLUGIN_DIST", id: "STALE_PLUGIN_DIST" });
  await build(options);
  const built = await readFile(output, "utf8");
  expect(built).toContain("session_index.jsonl");
  expect(built).not.toContain("STALE_PLUGIN_DIST");
  expect(JSON.parse((await run(process.execPath, [output, home, transcript])).stdout)).toEqual({ title: "Native current name", id: sid });
}, 30_000);
