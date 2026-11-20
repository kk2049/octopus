import { readFileSync, existsSync, lstatSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CANVAS_CONTRACT } from "@claude-bot/research-canvas-contract";
import { mcpToolsOf, type McpToolDefinition } from "@claude-bot/typed-port-kit";
import type { AdapterTool } from "./projections.js";
import { WorkspaceHistory } from "./workspace-history.js";

export type WorkspacePlatform = (action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface WorkspacePluginTool extends AdapterTool {
  readOnly?: boolean;
  invoke(params: Record<string, unknown>): Promise<unknown> | unknown;
}
export interface WorkspacePlugin {
  refs: Array<{ ref: string; tools: WorkspacePluginTool[] }>;
  close?(): Promise<void> | void;
}
export interface WorkspaceMcpConfig {
  endpoint: string;
  instance: string;
  tokenFile: string;
  workspace: string;
  plugins?: string[];
  backupIntervalMs?: number;
  historyRetain?: number;
  screenshot?: { base: string; state: string; browser: string };
}
const objectSchema = (properties: McpToolDefinition["inputSchema"]["properties"], required: string[] = []): McpToolDefinition["inputSchema"] => ({ type: "object" as const, properties, required, additionalProperties: false });
const string = { type: "string" } as const;
const localTools = [
  { name: "graph_checkout", description: "Write a graph YAML snapshot into this workspace for file editing. Existing files require overwrite:true.", inputSchema: objectSchema({ path: string, scope: string, overwrite: { type: "boolean" } }, ["path"]) },
  { name: "graph_commit", description: "Commit the edited YAML file relative to its original snapshot. Keep request unchanged when retrying.", inputSchema: objectSchema({ path: string, request: string }, ["path", "request"]) },
  { name: "ref_invoke", description: "Invoke a built-in resource tool or a plugin installed in this workspace. Resolve the ref first.", inputSchema: objectSchema({ ref: string, tool: string, params: { type: "object" } }, ["ref", "tool"]) },
  { name: "workspace_checkpoint", description: "Back up ordinary workspace files of any size including plugin code. Reports skipped paths, files not saved this time (disk reserve or changed while read) and per-file consistency.", inputSchema: objectSchema({}) },
  { name: "workspace_history", description: "List retained workspace checkpoints.", inputSchema: objectSchema({}) },
  { name: "workspace_restore", description: "Restore selected files or the whole workspace; first preserve a checkpoint of current files.", inputSchema: objectSchema({ checkpoint: string, paths: { type: "array", items: string } }, ["checkpoint"]) },
  { name: "canvas_screenshot", description: "Capture the actual authorized research page as an MCP image, with graph/layout revisions and visible node bounds. Requires configured browser on this device.", inputSchema: objectSchema({ scope: string, node: string, layout: { type: "string", enum: ["tree", "hierarchy", "canvas"] }, format: { type: "string", enum: ["jpeg", "png"] }, width: { type: "integer", minimum: 320, maximum: 2560 }, height: { type: "integer", minimum: 480, maximum: 2160 } }) },
];
const forwarded = mcpToolsOf(CANVAS_CONTRACT, { namePrefix: "", describeRefusals: false })
  .map(tool => ({ ...tool, name: tool.name.slice(1) }))
  .filter(tool => ["graph_read", "graph_apply", "ref_create", "ref_describe", "layout_read", "layout_patch", "layout_arrange", "layout_move", "layout_auto", "layout_lease", "layout_release", "tools_search", "tools_describe", "tools_invoke"].includes(tool.name));

export function createWorkspacePlatform(config: WorkspaceMcpConfig): WorkspacePlatform {
  const endpoint = new URL(config.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw new Error("MCP endpoint must use HTTPS or loopback, without credentials in its URL");
  if (!/^asi_[A-Za-z0-9_-]{1,90}$/.test(config.instance)) throw new Error("A fixed shared project instance is required");
  const tokenFile = resolve(config.tokenFile);
  if (!lstatSync(tokenFile).isFile() || lstatSync(tokenFile).mode & 0o077) throw new Error("MCP token file must be a private ordinary file (0600)");
  let sequence = 0;
  return async (action, params = {}) => {
    const token = readFileSync(tokenFile, "utf8").trim();
    const encoded = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)]));
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60000),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name: "app_dispatch", arguments: { app: "research-v2", instance: config.instance, action, params: encoded } } }),
    });
    if (!response.ok) throw new Error("Project MCP transport refused the request: HTTP " + response.status);
    const body = await response.json() as { error?: { message?: string }; result?: { isError?: boolean; structuredContent?: { result?: Record<string, unknown> }; content?: Array<{ type: string; text?: string }> } };
    if (body.error || body.result?.isError) throw new Error(body.error?.message ?? body.result?.content?.find(item => item.type === "text")?.text ?? "Project action refused");
    const envelope = body.result?.structuredContent ?? JSON.parse(body.result?.content?.find(item => item.type === "text")?.text ?? "{}");
    if (!envelope || typeof envelope.result !== "object" || envelope.result === null) throw new Error("Project returned an invalid action receipt");
    return envelope.result;
  };
}

/** Workspace code executes only in this local process, never in the trusted Head. */
export class ResearchWorkspaceMcp {
  readonly history: WorkspaceHistory;
  private readonly validator = new AjvJsonSchemaValidator();
  private readonly validators = new Map<string, JsonSchemaValidator<unknown>>();
  private readonly plugins = new Map<string, WorkspacePluginTool[]>();
  private readonly modules: WorkspacePlugin[] = [];
  private backupTimer?: ReturnType<typeof setInterval>;
  private backupError = "";
  constructor(readonly config: WorkspaceMcpConfig, readonly platform: WorkspacePlatform = createWorkspacePlatform(config)) {
    this.history = new WorkspaceHistory(config.workspace, config.historyRetain);
  }
  private automaticCheckpoint(): void {
    try { this.history.checkpoint(); this.backupError = ""; }
    catch (error) {
      this.backupError = error instanceof Error ? error.message : String(error);
      process.stderr.write("Research workspace checkpoint failed: " + this.backupError + "\n");
    }
  }
  async initialize(): Promise<void> {
    this.automaticCheckpoint();
    for (const path of this.config.plugins ?? []) {
      const file = this.history.path(path);
      if (!/\.(mjs|js|ts)$/.test(file) || !lstatSync(file).isFile()) throw new Error("Plugin must be an explicit workspace code module");
      const module = await import(pathToFileURL(file).href) as { activate?: (context: { workspace: string; platform: WorkspacePlatform; history: WorkspaceHistory }) => Promise<WorkspacePlugin> | WorkspacePlugin };
      if (typeof module.activate !== "function") throw new Error("Workspace plugin must export activate");
      const plugin = await module.activate({ workspace: this.history.root, platform: this.platform, history: this.history });
      for (const resource of plugin.refs) {
        if (!/^[a-z][a-z0-9_-]*:[A-Za-z0-9_.:-]+$/.test(resource.ref) || this.plugins.has(resource.ref)) throw new Error("Duplicate or invalid plugin ref");
        if (!Array.isArray(resource.tools) || resource.tools.length > 32 || new Set(resource.tools.map(tool => tool.name)).size !== resource.tools.length || resource.tools.some(tool => typeof tool.invoke !== "function" || !tool.inputSchema || !tool.name)) throw new Error("Plugin tool declarations are invalid");
        this.plugins.set(resource.ref, resource.tools);
      }
      this.modules.push(plugin);
    }
    const interval = this.config.backupIntervalMs ?? 60000;
    if (!Number.isInteger(interval) || interval < 10000 || interval > 3600000) throw new Error("Backup interval must be between 10 seconds and one hour");
    this.backupTimer = setInterval(() => this.automaticCheckpoint(), interval);
    this.backupTimer.unref();
  }
  tools(): McpToolDefinition[] { return [...forwarded, ...localTools.filter(tool => tool.name !== "canvas_screenshot" || this.config.screenshot)]; }
  async invoke(name: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (Buffer.byteLength(JSON.stringify(params)) > 512 * 1024) throw new Error("Tool arguments exceed 512 KiB");
    const declared = this.tools().find(tool => tool.name === name);
    if (!declared) throw new Error("Tool is not declared");
    let validate = this.validators.get(name);
    if (!validate) { validate = this.validator.getValidator(declared.inputSchema); this.validators.set(name, validate); }
    const checked = validate(params);
    if (!checked.valid) throw new Error(checked.errorMessage);
    const text = (key: string) => { if (typeof params[key] !== "string" || !params[key]) throw new Error(key + " is required"); return params[key] as string; };
    if (name === "graph_checkout") {
      const path = text("path");
      if (existsSync(this.history.path(path, true)) && params.overwrite !== true) throw new Error("The YAML file already exists; commit it or explicitly overwrite it");
      const result = await this.platform("graph_read", params.scope ? { scope: params.scope } : {});
      if (typeof result.yaml !== "string") throw new Error("Project returned no YAML snapshot");
      this.automaticCheckpoint(); this.history.write(path, result.yaml);
      return { path: this.history.path(path), snapshot: result.snapshot, revision: result.revision, expires: result.expires };
    }
    if (name === "graph_commit") return this.platform("graph_apply", { request: text("request"), yaml: this.history.read(text("path")) });
    if (name === "workspace_checkpoint") {
      const checkpoint = this.history.checkpoint();
      return { checkpoint: checkpoint.id, at: checkpoint.at, files: Object.keys(checkpoint.files).length, skipped: checkpoint.skipped, unsaved: checkpoint.unsaved ?? [], consistency: checkpoint.consistency };
    }
    if (name === "workspace_history") return { checkpoints: this.history.list(), backupError: this.backupError || null, intervalMs: this.config.backupIntervalMs ?? 60000 };
    if (name === "workspace_restore") {
      if (params.paths !== undefined && (!Array.isArray(params.paths) || params.paths.some(path => typeof path !== "string"))) throw new Error("paths must be a string array");
      return this.history.restore(text("checkpoint"), params.paths as string[] | undefined);
    }
    if (name === "ref_describe" || name === "ref_invoke") {
      const ref = text("ref"), description = await this.platform("ref_describe", { ref });
      const installed = this.plugins.get(ref);
      if (name === "ref_describe") return { ...description, workspaceTools: installed?.map(({ invoke: _invoke, ...tool }) => tool) ?? [], pluginAvailable: Boolean(installed) };
      if (description.status !== "available") throw new Error("Resource is not registered in this project");
      const toolName = text("tool"), plugin = installed?.find(tool => tool.name === toolName), args = params.params ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool params must be an object");
      if (plugin) {
        const key = ref + ":" + toolName;
        let validatePlugin = this.validators.get(key);
        if (!validatePlugin) { validatePlugin = this.validator.getValidator(plugin.inputSchema); this.validators.set(key, validatePlugin); }
        const checked = validatePlugin(args);
        if (!checked.valid) throw new Error(checked.errorMessage);
        if (!plugin.readOnly) this.automaticCheckpoint();
        const value = await plugin.invoke(args as Record<string, unknown>);
        if (!plugin.readOnly) this.automaticCheckpoint();
        return { ref, tool: toolName, result: value };
      }
      const tool = (description.tools as Array<{ name: string; defaults: Record<string, unknown> }> | undefined)?.find(tool => tool.name === toolName);
      if (!tool) throw new Error("This ref has no installed tool named " + toolName);
      return this.platform(toolName, { ...args as Record<string, unknown>, ...tool.defaults });
    }
    if (name === "canvas_screenshot") {
      if (!this.config.screenshot) throw new Error("No browser configured for this workspace");
      const modulePath = new URL("../../../../scripts/research-v2/capture-page.mjs", import.meta.url).href;
      const { captureResearchPage } = await import(modulePath) as { captureResearchPage(options: Record<string, unknown>): Promise<Record<string, unknown>> };
      return captureResearchPage({ ...this.config.screenshot, ...params, instance: this.config.instance, out: this.history.path(params.format === "png" ? "screenshots/research.png" : "screenshots/research.jpg", true), layout: params.layout ?? "tree" });
    }
    if (!forwarded.some(tool => tool.name === name)) throw new Error("Tool is not declared");
    return this.platform(name, params);
  }
  async close(): Promise<void> { clearInterval(this.backupTimer); for (const module of this.modules.splice(0).reverse()) await module.close?.(); }
}
export async function runWorkspaceMcp(configFile: string): Promise<void> {
  const config = JSON.parse(readFileSync(resolve(configFile), "utf8")) as WorkspaceMcpConfig;
  const workspace = new ResearchWorkspaceMcp(config);
  const server = new Server({ name: "research-workspace", version: "2.0.0" }, { capabilities: { tools: {} } });
  try {
    await workspace.initialize();
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: workspace.tools() }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const result = await workspace.invoke(request.params.name, request.params.arguments ?? {});
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: typeof result.yaml === "string" ? result.yaml : JSON.stringify(result) }];
        if (request.params.name === "canvas_screenshot" && typeof result.screenshot === "string")
          content.push({ type: "image", data: readFileSync(result.screenshot).toString("base64"), mimeType: /\.jpe?g$/i.test(result.screenshot) ? "image/jpeg" : "image/png" });
        return { content, structuredContent: result, isError: result.status === "rejected" };
      } catch (error) {
        const result = { status: "rejected", error: { code: "workspace_tool_failed", message: error instanceof Error ? error.message : String(error) } };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
    });
    const shutdown = () => { void workspace.close().finally(() => server.close()); };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    server.onclose = () => { void workspace.close(); };
    await server.connect(new StdioServerTransport());
  } catch (error) { await workspace.close(); await server.close(); throw error; }
}
