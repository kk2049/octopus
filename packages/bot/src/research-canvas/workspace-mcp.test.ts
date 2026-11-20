import { mkdtempSync, readFileSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createWorkspacePlatform, ResearchWorkspaceMcp, type WorkspacePlatform } from "./workspace-mcp.js";
it("edits a YAML file, forwards one causal commit, and validates workspace plugin calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-mcp-")), calls: Array<{ action: string; params: unknown }> = [];
  writeFileSync(join(root, "metrics.json"), '{"score":0.75}');
  writeFileSync(join(root, "plugin.mjs"), [
    'export function activate({history}) {',
    ' return {refs:[{ref:"adapter:metrics",tools:[{name:"read_metrics",description:"Read scores",readOnly:true,',
    ' inputSchema:{type:"object",properties:{},additionalProperties:false},',
    ' invoke:()=>JSON.parse(history.read("metrics.json"))}]}]};',
    '}',
  ].join("\n"));
  const platform: WorkspacePlatform = async (action, params) => {
    calls.push({ action, params });
    if (action === "graph_read") return { yaml: "schema: research-graph/v1\nsnapshot: original\nnodes: {}\nedges: {}\n", snapshot: "original", revision: "graph" };
    if (action === "graph_apply") return { status: "merged", conflicts: [] };
    if (action === "ref_describe") return { status: "available", ref: "adapter:metrics", tools: [] };
    throw new Error("Unexpected action");
  };
  const server = new ResearchWorkspaceMcp({ endpoint: "unused", instance: "unused", tokenFile: "unused", workspace: root, plugins: ["plugin.mjs"] }, platform);
  try {
    await server.initialize();
    expect(server.tools().map(tool => tool.name)).not.toContain("canvas_screenshot");
    await server.invoke("graph_checkout", { path: "graph.yaml" });
    writeFileSync(join(root, "graph.yaml"), readFileSync(join(root, "graph.yaml"), "utf8").replace("nodes: {}", "nodes:\n  metrics:\n    ref: adapter:metrics\n    label: Metrics"));
    expect(await server.invoke("graph_commit", { path: "graph.yaml", request: "once" })).toMatchObject({ status: "merged" });
    expect(calls.find(call => call.action === "graph_apply")?.params).toMatchObject({ request: "once", yaml: expect.stringContaining("snapshot: original") });
    await expect(server.invoke("graph_checkout", { path: "graph.yaml" })).rejects.toThrow("already exists");
    expect(await server.invoke("ref_describe", { ref: "adapter:metrics" })).toMatchObject({ pluginAvailable: true, workspaceTools: [{ name: "read_metrics" }] });
    expect(await server.invoke("ref_invoke", { ref: "adapter:metrics", tool: "read_metrics" })).toMatchObject({ result: { score: 0.75 } });
    await expect(server.invoke("ref_invoke", { ref: "adapter:metrics", tool: "read_metrics", params: { unrecognized: true } })).rejects.toThrow();
    await expect(server.invoke("graph_commit", { path: "../secret", request: "bad" })).rejects.toThrow("inside");
    await expect(server.invoke("graph_checkout", { path: "a.yaml", extra: "unrecognized" })).rejects.toThrow();
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

it("backs up a file past the old 64 MiB ceiling and keeps the graph interface usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-budget-"));
  writeFileSync(join(root, "large-data.bin"), "");
  truncateSync(join(root, "large-data.bin"), 64 * 1024 * 1024 + 1);
  const server = new ResearchWorkspaceMcp({ endpoint: "unused", instance: "unused", tokenFile: "unused", workspace: root },
    async () => ({ yaml: "schema: research-graph/v1\nnodes: {}\nedges: {}\n", snapshot: "base", revision: "r" }));
  try {
    await server.initialize();
    expect(await server.invoke("workspace_history")).toMatchObject({ backupError: null });
    expect(await server.invoke("workspace_checkpoint")).toMatchObject({ files: 1, unsaved: [] });
    expect(await server.invoke("graph_checkout", { path: "graph.yaml" })).toMatchObject({ snapshot: "base" });
    expect(readFileSync(join(root, "graph.yaml"), "utf8")).toContain("research-graph/v1");
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});


it("encodes plugin booleans and resource versions for the actual flat app_dispatch transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-transport-"));
  const tokenFile = join(root, "test-token");
  writeFileSync(tokenFile, "test-only-credential", { mode: 0o600 });
  const fetch = vi.fn(async (_url: unknown, _options: RequestInit) => new Response(JSON.stringify({ result: { structuredContent: { result: { ref: "adapter:r" } } } }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  try {
    const platform = createWorkspacePlatform({ endpoint: "http://127.0.0.1/api/mcp", instance: "asi_test", tokenFile, workspace: root });
    expect(await platform("adapter_register", { attach: false, version: 2, data: { title: "Metrics" }, omitted: undefined })).toEqual({ ref: "adapter:r" });
    const sent = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(sent.params.arguments.params).toEqual({ attach: "false", version: "2", data: '{"title":"Metrics"}' });
  } finally { vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); }
});
