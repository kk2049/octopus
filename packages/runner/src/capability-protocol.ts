/** Public, bounded facts only. Executables, environment and local paths stay on the device. */
export const RUNNER_CAPABILITY_PROTOCOL = "runner-capabilities/v1" as const;
export const CAPABILITY_LIMITS = { providers: 8, tools: 32, schemaBytes: 8192, inventoryBytes: 256 * 1024,
  inputBytes: 64 * 1024, resultBytes: 256 * 1024, timeoutMs: 20_000, receipts: 256 } as const;
export interface RunnerCapabilityTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
export interface RunnerCapabilityProvider {
  id: string;
  title: string;
  version: string;
  revision: string;
  status: "ready" | "disabled" | "error" | "loading";
  reason?: "invalid_config" | "provider_unavailable" | "invalid_catalog" | "machine_ops_disabled";
  tools: RunnerCapabilityTool[];
}
export interface RunnerCapabilityAdvertisement {
  protocol: typeof RUNNER_CAPABILITY_PROTOCOL;
  providers: RunnerCapabilityProvider[];
}
export type RunnerCapabilityCallResult =
  | { status: "succeeded"; request_id: string; revision: string; result: unknown }
  | { status: "refused"; request_id: string; revision: string; reason: "stale_revision" | "invalid_input" | "capacity" | "unavailable" | "request_conflict" }
  | { status: "indeterminate"; request_id: string; revision: string; reason: "provider_lost" | "result_unavailable" };

export const CAPABILITY_ACTIONS = {
  list: { operation: "list_runner_capabilities", summary: "Discover this owner's live Runner extensions. Query before calling; discovery grants no execution authority.",
    params: { query: { type: "string", optional: true, maxLength: 120, description: "Filter device, provider or tool name." },
      after: { type: "string", optional: true, maxLength: 80, description: "Opaque cursor from the previous page." } } },
  describe: { operation: "describe_runner_capability", summary: "Read the current input/output JSON Schema for an opaque capability reference.",
    params: { capability_ref: { type: "string", maxLength: 80, description: "Exact capability_ref returned by discovery." } } },
  call: { operation: "invoke_runner_capability", summary: "Invoke a revision-pinned device extension. All tools are effectful. Preserve request_id and arguments when retrieving an approval/result. Never retry an indeterminate result with a new ID.",
    params: { capability_ref: { type: "string", maxLength: 80, description: "Exact capability_ref returned by discovery." },
      request_id: { type: "string", maxLength: 80, description: "Unique call ID; reuse only for the identical call." },
      input_json: { type: "string", maxLength: CAPABILITY_LIMITS.inputBytes, description: "JSON object matching the tool inputSchema." } } },
} as const;

export function capabilityId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,47}$/.test(value);
}
export function jsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function publicCapabilityTool(value: unknown): RunnerCapabilityTool {
  if (!jsonObject(value) || typeof value.name !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(value.name)
    || (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 2000))) throw new Error("invalid_catalog");
  const schema = (raw: unknown) => {
    if (!jsonObject(raw) || raw.type !== "object" || new TextEncoder().encode(JSON.stringify(raw)).byteLength > CAPABILITY_LIMITS.schemaBytes) throw new Error("invalid_catalog");
    // MCP tools may use local JSON pointers, never remote schema resolution.
    const visit = (item: unknown, depth: number): void => {
      if (depth > 32) throw new Error("invalid_catalog");
      if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
      else if (jsonObject(item)) for (const [key, child] of Object.entries(item)) {
        if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#"))) throw new Error("invalid_catalog");
        visit(child, depth + 1);
      }
    };
    visit(raw, 0);
    return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  };
  return { name: value.name, description: value.description as string ?? "", inputSchema: schema(value.inputSchema),
    ...(value.outputSchema === undefined ? {} : { outputSchema: schema(value.outputSchema) }) };
}
/** Rebuild the public shape at the authenticated inventory boundary; reject the extension field independently. */
export function publicCapabilityAdvertisement(value: unknown): RunnerCapabilityAdvertisement | undefined {
  try {
    if (!jsonObject(value) || value.protocol !== RUNNER_CAPABILITY_PROTOCOL || !Array.isArray(value.providers)
      || value.providers.length > CAPABILITY_LIMITS.providers || new TextEncoder().encode(JSON.stringify(value)).byteLength > CAPABILITY_LIMITS.inventoryBytes) return undefined;
    const ids = new Set<string>();
    const providers = value.providers.map((row): RunnerCapabilityProvider => {
      if (!jsonObject(row) || !capabilityId(row.id) || ids.has(row.id)
        || typeof row.title !== "string" || row.title.length > 120
        || typeof row.version !== "string" || row.version.length > 80
        || typeof row.revision !== "string" || !/^[a-f0-9]{32}$/.test(row.revision)
        || !["ready", "disabled", "error", "loading"].includes(String(row.status))
        || !Array.isArray(row.tools) || row.tools.length > CAPABILITY_LIMITS.tools
        || (row.reason !== undefined && !["invalid_config", "provider_unavailable", "invalid_catalog", "machine_ops_disabled"].includes(String(row.reason)))) throw new Error("invalid_catalog");
      ids.add(row.id);
      const tools = row.tools.map(publicCapabilityTool);
      if (new Set(tools.map(tool => tool.name)).size !== tools.length || (row.status !== "ready" && tools.length)) throw new Error("invalid_catalog");
      return { id: row.id, title: row.title, version: row.version, revision: row.revision,
        status: row.status as RunnerCapabilityProvider["status"], tools,
        ...(row.reason ? { reason: row.reason as RunnerCapabilityProvider["reason"] } : {}) };
    });
    return { protocol: RUNNER_CAPABILITY_PROTOCOL, providers };
  } catch { return undefined; }
}
