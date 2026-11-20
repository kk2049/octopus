import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CAPABILITY_LIMITS, RUNNER_CAPABILITY_PROTOCOL, capabilityId, jsonObject, publicCapabilityTool, publicCapabilityAdvertisement,
  type RunnerCapabilityAdvertisement, type RunnerCapabilityCallResult, type RunnerCapabilityProvider } from "./capability-protocol.js";
import { capabilityRegistryDirectory, readPrivateRegistration, registrationFiles, type CapabilityRegistration } from "./capability-registry.js";

export interface CapabilityConnection {
  tools(): Promise<unknown[]>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  changed(listener: () => void): void;
  lost(listener: () => void): void;
}
export async function connectCapabilityProvider(config: CapabilityRegistration): Promise<CapabilityConnection> {
  const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd,
    env: { ...getDefaultEnvironment(), ...config.env }, stderr: "pipe" });
  // Provider stderr may contain secrets. Never send it to Head or shared logs.
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "octopus-runner-capability", version: "1" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([client.connect(transport), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("provider_unavailable")), CAPABILITY_LIMITS.timeoutMs);
    })]);
  } catch { await transport.close(); throw new Error("provider_unavailable"); }
  finally { if (timer) clearTimeout(timer); }
  return {
    async tools() {
      const tools: unknown[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 5000, maxTotalTimeout: 5000 });
        tools.push(...page.tools);
        if (tools.length > CAPABILITY_LIMITS.tools) throw new Error("invalid_catalog");
        cursor = page.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size >= 8)) throw new Error("invalid_catalog");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return tools;
    },
    call: (name, args) => client.callTool({ name, arguments: args }, undefined,
      { timeout: CAPABILITY_LIMITS.timeoutMs, maxTotalTimeout: CAPABILITY_LIMITS.timeoutMs }),
    close: () => client.close(),
    changed: listener => client.setNotificationHandler(ToolListChangedNotificationSchema, async () => listener()),
    lost: listener => { client.onclose = listener; },
  };
}
interface Generation {
  digest: string;
  public: RunnerCapabilityProvider;
  connection?: CapabilityConnection;
  active: number;
  retired: boolean;
  refreshing: boolean;
  dirty?: boolean;
}
interface Receipt { fingerprint: string; result: Promise<RunnerCapabilityCallResult> }

/** One resident owner; no remote registration RPC and no background retry of calls. */
export class RunnerCapabilityManager {
  private readonly providers = new Map<string, Generation>();
  private readonly draining = new Set<Generation>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly validator = new AjvJsonSchemaValidator();
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private closed = false;
  constructor(private readonly home: string, private readonly options: {
    enabled?: boolean;
    connect?: (registration: CapabilityRegistration) => Promise<CapabilityConnection>;
    onChanged?: () => void;
  } = {}) {}
  advertisement(): RunnerCapabilityAdvertisement {
    return { protocol: RUNNER_CAPABILITY_PROTOCOL, providers: [...this.providers.values()].map(row => structuredClone(row.public)) };
  }
  async start(): Promise<void> {
    await this.refresh();
    if (this.closed) return;
    this.timer = setInterval(() => { void this.refresh(); }, 2000);
    this.timer.unref?.();
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = this.reconcile().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private publish(): void { if (!this.closed) this.options.onChanged?.(); }
  private async retire(row: Generation): Promise<void> {
    row.retired = true;
    if (row.active) { this.draining.add(row); return; }
    this.draining.delete(row);
    await row.connection?.close().catch(() => undefined);
  }
  private async reconcile(): Promise<void> {
    let files: string[];
    try { files = await registrationFiles(this.home); } catch {
      for (const row of this.providers.values()) {
        row.public = { ...row.public, status: "error", reason: "invalid_config", tools: [] };
        await this.retire(row);
      }
      this.publish(); return;
    }
    const ids = new Set(files.map(file => file.slice(0, -5)));
    for (const [id, row] of this.providers) if (!ids.has(id)) {
      this.providers.delete(id); await this.retire(row); this.publish();
    }
    for (const file of files) {
      if (this.closed) return;
      const id = file.slice(0, -5);
      let config: CapabilityRegistration;
      let digest: string;
      try {
        const read = await readPrivateRegistration(path.join(capabilityRegistryDirectory(this.home), file));
        config = read.value; digest = read.digest;
        if (config.id !== id) throw new Error("invalid_config");
      } catch {
        const old = this.providers.get(id);
        if (!old && capabilityId(id)) {
          this.providers.set(id, { digest: "invalid", active: 0, retired: true, refreshing: false,
            public: { id, title: id, version: "", revision: randomBytes(16).toString("hex"), status: "error", reason: "invalid_config", tools: [] } });
          this.publish();
        }
        if (old && old.public.reason !== "invalid_config") { old.public = { ...old.public, status: "error", reason: "invalid_config", tools: [] }; await this.retire(old); this.publish(); }
        continue;
      }
      const old = this.providers.get(id);
      if (old?.digest === digest && !old.retired) { if (old.dirty) await this.refreshTools(old); continue; }
      const row: Generation = { digest, active: 0, retired: false, refreshing: false, public: {
        id, title: config.title, version: config.version, revision: randomBytes(16).toString("hex"),
        status: config.enabled && this.options.enabled !== false ? "loading" : "disabled", tools: [],
        ...(this.options.enabled === false ? { reason: "machine_ops_disabled" as const } : {}),
      } };
      this.providers.set(id, row);
      if (old) await this.retire(old);
      this.publish();
      if (!config.enabled || this.options.enabled === false) continue;
      try {
        row.connection = await (this.options.connect ?? connectCapabilityProvider)(config);
        if (this.closed || row.retired) { await this.retire(row); return; }
        row.connection.lost(() => {
          if (this.closed || row.retired) return;
          row.public = { ...row.public, status: "error", reason: "provider_unavailable", tools: [] }; this.publish();
        });
        row.connection.changed(() => { void this.refreshTools(row); });
        await this.refreshTools(row);
      } catch {
        row.public = { ...row.public, status: "error", reason: "provider_unavailable", tools: [] };
        await row.connection?.close().catch(() => undefined);
        this.publish();
      }
    }
  }
  private async refreshTools(row: Generation): Promise<void> {
    if (this.closed || row.retired || !row.connection) return;
    if (row.refreshing) { row.dirty = true; return; }
    row.dirty = false;
    row.refreshing = true;
    row.public = { ...row.public, revision: randomBytes(16).toString("hex"), status: "loading", tools: [] };
    this.publish();
    try {
      const tools = (await row.connection.tools()).map(publicCapabilityTool);
      if (this.closed || row.retired) return;
      for (const tool of tools) {
        this.validator.getValidator(tool.inputSchema);
        if (tool.outputSchema) this.validator.getValidator(tool.outputSchema);
      }
      const candidate = { ...row.public, status: "ready" as const, tools };
      const inventory = this.advertisement();
      inventory.providers = inventory.providers.map(item => item.id === candidate.id ? candidate : item);
      if (!publicCapabilityAdvertisement(inventory)) throw new Error("invalid_catalog");
      row.public = candidate;
    } catch {
      if (!this.closed && !row.retired) row.public = { ...row.public, status: "error", reason: "invalid_catalog", tools: [] };
    } finally {
      row.refreshing = false;
      if (row.dirty) row.public = { ...row.public, status: "loading", tools: [] };
      this.publish();
    }
  }
  async call(args: Record<string, unknown>, scope = "primary"): Promise<RunnerCapabilityCallResult> {
    const { provider, revision, tool, request_id, input_json } = args;
    const echo = { request_id: typeof request_id === "string" ? request_id : "", revision: typeof revision === "string" ? revision : "" };
    const refuse = (reason: Extract<RunnerCapabilityCallResult, { status: "refused" }>["reason"]): RunnerCapabilityCallResult => ({ status: "refused", ...echo, reason });
    if (this.closed) return refuse("unavailable");
    if (typeof provider !== "string" || typeof revision !== "string" || typeof tool !== "string"
      || typeof request_id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(request_id)
      || typeof input_json !== "string" || Buffer.byteLength(input_json) > CAPABILITY_LIMITS.inputBytes
      || Object.keys(args).some(key => !["provider", "revision", "tool", "request_id", "input_json"].includes(key))) return refuse("invalid_input");
    const fingerprint = createHash("sha256").update(JSON.stringify([provider, revision, tool, input_json])).digest("hex");
    const receiptKey = JSON.stringify([scope, request_id]);
    const held = this.receipts.get(receiptKey);
    if (held) return held.fingerprint === fingerprint ? held.result : refuse("request_conflict");
    const row = this.providers.get(provider);
    if (!row || row.public.revision !== revision) return refuse("stale_revision");
    if (row.public.status !== "ready" || row.retired || !row.connection) return refuse("unavailable");
    const descriptor = row.public.tools.find(item => item.name === tool);
    if (!descriptor) return refuse("invalid_input");
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(input_json);
      if (!jsonObject(parsed) || !this.validator.getValidator(descriptor.inputSchema)(parsed).valid) return refuse("invalid_input");
      input = parsed;
    } catch { return refuse("invalid_input"); }
    if (row.active) return refuse("capacity");
    if (this.receipts.size >= CAPABILITY_LIMITS.receipts) {
      if ([...this.providers.values(), ...this.draining].some(item => item.active)) return refuse("capacity");
      // Bounded receipts without ever replaying an evicted request: retire all
      // callable identities before dropping their result cache.
      for (const item of this.providers.values()) item.public = { ...item.public, revision: randomBytes(16).toString("hex") };
      this.receipts.clear(); this.publish();
      return refuse("stale_revision");
    }
    row.active++;
    const result = (async (): Promise<RunnerCapabilityCallResult> => {
      try {
        const output = await row.connection!.call(tool, input);
        if (this.closed || Buffer.byteLength(JSON.stringify(output) ?? "") > CAPABILITY_LIMITS.resultBytes
          || !jsonObject(output) || (descriptor.outputSchema && output.isError !== true
            && (!jsonObject(output.structuredContent) || !this.validator.getValidator(descriptor.outputSchema)(output.structuredContent).valid))) {
          return { status: "indeterminate", ...echo, reason: "result_unavailable" };
        }
        return { status: "succeeded", ...echo, result: output };
      } catch { return { status: "indeterminate", ...echo, reason: "provider_lost" }; }
      finally { row.active--; if (row.retired) await this.retire(row); }
    })();
    // Set before awaiting: identical concurrent deliveries join, never dispatch twice.
    this.receipts.set(receiptKey, { fingerprint, result });
    return result;
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const row of [...this.providers.values(), ...this.draining]) {
      row.retired = true; await row.connection?.close().catch(() => undefined);
    }
    await this.flight;
  }
}
