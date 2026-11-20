import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { KNOWLEDGE_SCRATCH, knowledgeScratchInUse, runnerKnowledgeGraphBuilder, runnerKnowledgeDeployProjection } from "./knowledge-graph-runner.js";
import { git, gitOrThrow } from "./worktree.js";
import { GraphDb, type GraphSnapshot } from "../knowledge/graph-db.js";
import type { WorkspaceProvider, WorkspaceTask } from "./workspace-provider.js";
const sha = "a".repeat(40);
vi.mock("./worktree.js", () => ({
  gitOrThrow: vi.fn(async () => "a".repeat(40)),
  git: vi.fn(async () => ({ ok: true, stdout: "", stderr: "", code: 0 })),
}));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function fixture(wrongSha = false, realGraph = false) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "graph-runner-")); dirs.push(dir);
  const inputs = path.join(dir, "inputs.json"); await fs.writeFile(inputs, '{"tickets":[],"landings":[]}');
  const artifacts = new Map<string, Buffer>(), files = [];
  let graphBytes: Buffer | undefined;
  if (realGraph) {
    const file = path.join(dir, "source-graph.db");
    GraphDb.writeSnapshot(file, { meta: { commit: sha }, nodes: [], edges: [], cells: [], observations: [],
      observationArtifacts: [], coverage: [], conflicts: [], runtimeInputs: { landings: [], tickets: [] } } as unknown as GraphSnapshot);
    graphBytes = await fs.readFile(file);
  }
  for (const name of ["graph.db", "context.json"]) {
    const data = name === "graph.db" && graphBytes ? graphBytes : Buffer.from(`exact ${name}`), packed = gzipSync(data); artifacts.set(`${name}.gz`, packed);
    files.push({ name, bytes: data.length, sha256: hash(data), compressedBytes: packed.length, compressedSha256: hash(packed) });
  }
  artifacts.set("graph-result.json", Buffer.from(JSON.stringify({ version: 1, sha: wrongSha ? "b".repeat(40) : sha, result: { sha }, files })));
  const wait = vi.fn(async (_task: WorkspaceTask) => ({ state: "succeeded" }));
  const provider = { target: { device: "remote" }, wait, artifact: vi.fn(async (_key: string, name: string, offset: number, length: number) => {
    const b = artifacts.get(name)!; return { data: b.subarray(offset, offset + length), total: b.length, eof: offset + length >= b.length };
  }) } as unknown as WorkspaceProvider;
  return { dir, inputs, wait, provider, build: runnerKnowledgeGraphBuilder({ provider, worktreesDir: dir, signal: new AbortController().signal }) };
}
it("receives an exact remote graph with small explicit inputs and no local analysis", async () => {
  const f = await fixture();
  const options = { outFile: path.join(f.dir, "graph.db"), contextFile: path.join(f.dir, "context.json") };
  await f.build({ repoDir: f.dir, ref: sha, inputs: f.inputs, options });
  expect(await fs.readFile(options.outFile, "utf8")).toBe("exact graph.db");
  expect(f.wait.mock.calls[0][0]).toMatchObject({ sha, files: [{ name: "runtime.json" }, { name: "graph-build.mjs" }] });
});
it("deployment review accepts identical runtime inputs regardless of JSON object key order", async () => {
  const f = await fixture(false, true);
  const project = runnerKnowledgeDeployProjection({ provider: f.provider, worktreesDir: f.dir, signal: new AbortController().signal });
  await expect(project({ repoDir: f.dir, ref: sha, runtime: { tickets: [], landings: [] } })).resolves.toEqual({ nodes: [], conflicts: [] });
});
it("refuses a graph built for a different source before creating usable output", async () => {
  const f = await fixture(true), outFile = path.join(f.dir, "graph.db");
  await expect(f.build({ repoDir: f.dir, ref: sha, inputs: f.inputs, options: { outFile, contextFile: path.join(f.dir, "context.json") } })).rejects.toThrow("source manifest mismatch");
  expect(await fs.stat(outFile).catch(() => null)).toBeNull();
});
it("builds from a fresh no-checkout source per build and removes it afterwards, also on failure", async () => {
  const f = await fixture();
  const added = (): string[] => vi.mocked(gitOrThrow).mock.calls.map(([, args]) => args)
    .filter((args) => args[0] === "worktree" && args[1] === "add").map((args) => args.at(-2)!);
  const removed = (): string[] => vi.mocked(git).mock.calls.map(([, args]) => args)
    .filter((args) => args[0] === "worktree" && args[1] === "remove").map((args) => args.at(-1)!);
  const seenInUse: boolean[] = [];
  f.wait.mockImplementation(async (task: WorkspaceTask) => { seenInUse.push(knowledgeScratchInUse(task.sourceDir!)); return { state: "succeeded" }; });
  const options = { outFile: path.join(f.dir, "graph.db"), contextFile: path.join(f.dir, "context.json") };
  await f.build({ repoDir: f.dir, ref: sha, inputs: f.inputs, options });
  f.wait.mockImplementationOnce(async () => { throw new Error("runner went away"); });
  await expect(f.build({ repoDir: f.dir, ref: sha, inputs: f.inputs, options })).rejects.toThrow("runner went away");

  const [first, second] = added().slice(-2);
  expect(vi.mocked(gitOrThrow).mock.calls.some(([, args]) => args.includes("--no-checkout") && args.includes(first!))).toBe(true);
  expect(path.basename(first!)).toMatch(/^_graph-a{40}-[0-9a-f]{8}$/);
  expect(KNOWLEDGE_SCRATCH.test(path.basename(first!))).toBe(true);
  expect(first).not.toBe(second);
  expect(removed().slice(-2)).toEqual([first, second]);
  expect(seenInUse).toEqual([true]);
  expect(knowledgeScratchInUse(first!) || knowledgeScratchInUse(second!)).toBe(false);
});
