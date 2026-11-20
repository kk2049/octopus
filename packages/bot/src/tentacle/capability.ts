import { createHash } from "node:crypto";
import {
  type ArgSpec,
  type CapabilityService,
  type ContextId,
  type ObjectDefinition,
  type Operation,
  type OperationSpec,
  type PolicyInput,
} from "@claude-bot/capability-kernel";
import type { Store, TentacleObjectRow } from "../store/store.js";
import type { TentaclePeer } from "../runner/gateway.js";
import { type BrokerToolResult, TentacleBroker } from "./broker.js";
import {
  TENTACLE_INVOKE_OPERATION,
  TENTACLE_READ_EVENT_OPERATION,
} from "./contract.js";
import {
  canonicalJson,
  cropProjection,
  isPlainRecord,
  jsonValue,
  schemaDigest,
  type JsonObject,
} from "./protocol.js";

export const TENTACLE_SLOT = "tentacle";
const RESERVED_PREFIX = "_octo_";

interface PinnedToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface TentacleBinding {
  row: TentacleObjectRow;
  broker: TentacleBroker;
}

export class TentacleGrant {
  private destroyed = false;

  constructor(
    private readonly service: CapabilityService,
    readonly contextId: ContextId,
    readonly operation: Operation,
    private readonly onDestroy: () => void,
  ) {}

  request(args: Record<string, unknown>) {
    return this.service.bind(this.contextId).request(TENTACLE_SLOT, this.operation, args);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onDestroy();
    this.service.destroyContext(this.contextId);
  }
}

function toolArgSpec(parameters: unknown): Record<string, ArgSpec> {
  if (!isPlainRecord(parameters) || parameters.type !== "object" || !isPlainRecord(parameters.properties)) {
    throw new Error("tool parameters must be a JSON Schema object with properties");
  }
  if (parameters.additionalProperties !== undefined && parameters.additionalProperties !== false) {
    throw new Error("tool parameters cannot allow unmodelled properties when shared");
  }
  const required = new Set(
    Array.isArray(parameters.required) && parameters.required.every((item) => typeof item === "string")
      ? parameters.required
      : [],
  );
  const out: Record<string, ArgSpec> = {};
  for (const [name, raw] of Object.entries(parameters.properties)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || name.startsWith(RESERVED_PREFIX)) {
      throw new Error(`tool parameter ${name} cannot be represented by the Gate`);
    }
    if (!isPlainRecord(raw) || typeof raw.type !== "string") {
      throw new Error(`tool parameter ${name} has an unsupported schema`);
    }
    if (raw.oneOf !== undefined || raw.anyOf !== undefined || raw.allOf !== undefined || raw.const !== undefined) {
      throw new Error(`tool parameter ${name} uses an unsupported schema combinator`);
    }
    const isRequired = required.has(name);
    switch (raw.type) {
      case "string": {
        const values = Array.isArray(raw.enum) && raw.enum.every((item) => typeof item === "string")
          ? (raw.enum as string[])
          : undefined;
        out[name] = {
          type: "string",
          ...(isRequired ? { required: true } : {}),
          ...(typeof raw.maxLength === "number" && Number.isSafeInteger(raw.maxLength) && raw.maxLength >= 0
            ? { maxLength: raw.maxLength }
            : {}),
          ...(values ? { enum: values } : {}),
        };
        break;
      }
      case "number":
      case "integer":
        out[name] = {
          type: "number",
          ...(isRequired ? { required: true } : {}),
          ...(raw.type === "integer" ? { integer: true } : {}),
          ...(typeof raw.minimum === "number" && Number.isFinite(raw.minimum) ? { min: raw.minimum } : {}),
          ...(typeof raw.maximum === "number" && Number.isFinite(raw.maximum) ? { max: raw.maximum } : {}),
        };
        break;
      case "boolean":
        out[name] = { type: "boolean", ...(isRequired ? { required: true } : {}) };
        break;
      default:
        throw new Error(`tool parameter ${name} type ${raw.type} is not supported by the capability kernel`);
    }
  }
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(out, name)) throw new Error(`required tool parameter ${name} is absent`);
  }
  return out;
}

export function normalizeToolSchema(value: unknown): PinnedToolSchema {
  if (!isPlainRecord(value) || typeof value.name !== "string" || !value.name || value.name.length > 128) {
    throw new Error("tool schema has no bounded name");
  }
  if (typeof value.description !== "string" || value.description.length > 16_384) {
    throw new Error("tool schema has no bounded description");
  }
  toolArgSpec(value.parameters);
  const parameters = value.parameters as Record<string, unknown>;
  return JSON.parse(canonicalJson({
    name: value.name,
    description: value.description,
    // The kernel's ArgSpec is a closed set. JSON Schema defaults an omitted
    // additionalProperties to true, so the shared Object explicitly narrows
    // the advertised schema to the properties the Gate can validate. The dsh
    // adapter receives only those validated fields.
    parameters: { ...parameters, additionalProperties: false },
  })) as PinnedToolSchema;
}

function tentaclePolicy(input: PolicyInput) {
  const owner = input.object.metadata.owner ?? "";
  const viewer = input.context.metadata.viewer ?? "";
  if (!owner || !viewer) return { kind: "deny" as const, reason: "tentacle Object has no bound owner/viewer" };
  if (!input.terms.autoAllow.includes(input.operation)) {
    return { kind: "deny" as const, reason: "cross-user share is not active" };
  }
  return { kind: "allow" as const };
}

function operationsFor(row: TentacleObjectRow): Record<string, OperationSpec> {
  if (row.kind === "projection") {
    return {
      [TENTACLE_READ_EVENT_OPERATION]: {
        args: {
          payload: { type: "string", required: true, maxLength: 256 * 1024 },
        },
        effect: "read",
        title: "读取 dsh 会话投影事件",
      },
    };
  }
  const schema = normalizeToolSchema(JSON.parse(row.schema_json));
  return {
    [TENTACLE_INVOKE_OPERATION]: {
      args: {
        ...toolArgSpec(schema.parameters),
        _octo_from: { type: "string", required: true, maxLength: 128 },
        _octo_source_device: { type: "string", required: true, maxLength: 128 },
        _octo_seq: { type: "number", required: true, min: 1, max: Number.MAX_SAFE_INTEGER, integer: true },
      },
      effect: "execute",
      retrySafe: false,
      title: `调用 dsh 工具 ${schema.name}`,
    },
  };
}

async function adapter(binding: TentacleBinding, operation: Operation, args: Readonly<Record<string, unknown>>): Promise<unknown> {
  if (operation === TENTACLE_READ_EVENT_OPERATION) {
    return cropProjection(binding.row.resource_key, JSON.parse(String(args.payload)));
  }
  if (operation !== TENTACLE_INVOKE_OPERATION || binding.row.kind !== "tool") {
    throw new Error("unknown tentacle Object operation");
  }
  const schema = normalizeToolSchema(JSON.parse(binding.row.schema_json));
  const toolArgs: JsonObject = {};
  for (const [name, value] of Object.entries(args)) {
    if (!name.startsWith(RESERVED_PREFIX)) toolArgs[name] = jsonValue(value);
  }
  return await binding.broker.invokeTool({
    source: {
      username: String(args._octo_from),
      device: String(args._octo_source_device),
    },
    target: { username: binding.row.owner, device: binding.row.device },
    objectId: binding.row.object_id,
    sourceSeq: Number(args._octo_seq),
    tool: schema.name,
    args: toolArgs,
  });
}

function objectIdFor(row: Omit<TentacleObjectRow, "object_id" | "status" | "created_at">): string {
  const digest = createHash("sha256")
    .update(canonicalJson([row.kind, row.owner, row.device, row.resource_key, row.schema_digest]))
    .digest("hex");
  return `tentacle-${row.kind}-v1:${digest.slice(0, 40)}`;
}

export class TentacleCapabilities {
  private readonly active = new Map<string, Set<ContextId>>();

  constructor(
    private readonly store: Store,
    private readonly service: CapabilityService,
    private readonly broker: TentacleBroker,
  ) {
    for (const row of store.listTentacleObjects()) this.register(row);
  }

  castTool(owner: string, device: string, value: unknown): TentacleObjectRow {
    const schema = normalizeToolSchema(value);
    const digest = schemaDigest(schema);
    return this.persist({ kind: "tool", owner, device, resource_key: schema.name, schema_digest: digest, schema_json: canonicalJson(schema) });
  }

  castProjection(owner: string, device: string, sourceSessionId: string): TentacleObjectRow {
    if (!sourceSessionId || Buffer.byteLength(sourceSessionId, "utf8") > 256) {
      throw new Error("source session id is absent or too large");
    }
    const schema = { version: 1, operation: TENTACLE_READ_EVENT_OPERATION };
    return this.persist({
      kind: "projection",
      owner,
      device,
      resource_key: sourceSessionId,
      schema_digest: schemaDigest(schema),
      schema_json: canonicalJson(schema),
    });
  }

  get(objectId: string): TentacleObjectRow | null {
    return this.store.getTentacleObject(objectId) ?? null;
  }

  list(owner?: string): TentacleObjectRow[] {
    return this.store.listTentacleObjects(owner);
  }

  accountOperations(owner: string): string[] {
    const tokens = new Set(this.store.listRunnerTokens(owner).map((row) => row.device));
    const out = new Set<string>();
    for (const row of this.store.listTentacleObjects(owner)) {
      if (row.status !== "active" || !tokens.has(row.device)) continue;
      out.add(row.kind === "tool" ? TENTACLE_INVOKE_OPERATION : TENTACLE_READ_EVENT_OPERATION);
    }
    return [...out].sort();
  }

  open(row: TentacleObjectRow, viewer: string, operation: Operation, scopeKey: string): TentacleGrant | null {
    if (row.status !== "active" || !this.store.getUser(viewer)) return null;
    const root = this.rootFor(row);
    if (!root || !this.service.rightsOf(root, TENTACLE_SLOT).includes(operation)) return null;
    const contextId = this.service.createContext(
      "tentacle-share-call",
      { owner: row.owner, viewer, objectId: row.object_id, purpose: `dsh share to ${viewer}` },
      root,
    );
    try {
      this.service.derive(root, TENTACLE_SLOT, contextId, TENTACLE_SLOT, [operation], { autoAllow: [operation] });
    } catch {
      this.service.destroyContext(contextId);
      return null;
    }
    const contexts = this.active.get(scopeKey) ?? new Set<ContextId>();
    contexts.add(contextId);
    this.active.set(scopeKey, contexts);
    return new TentacleGrant(this.service, contextId, operation, () => {
      contexts.delete(contextId);
      if (contexts.size === 0) this.active.delete(scopeKey);
    });
  }

  /**
   * Put an ungranted/retired proposal through the real Gate as a rootless
   * Context.  This is the deny path used by the wire service: it keeps
   * authorization inside capability-kernel and proves the adapter is untouched.
   */
  async deny(viewer: string, operation: Operation, args: Record<string, unknown>) {
    const contextId = this.service.createContext("tentacle-ungranted", {
      viewer,
      purpose: "refused dsh cross-user proposal",
    });
    try {
      return await this.service.bind(contextId).request(TENTACLE_SLOT, operation, args);
    } finally {
      this.service.destroyContext(contextId);
    }
  }

  destroyScope(scopeKey: string): void {
    const contexts = this.active.get(scopeKey);
    if (!contexts) return;
    this.active.delete(scopeKey);
    for (const contextId of contexts) this.service.destroyContext(contextId);
  }

  revokeDevice(owner: string, device: string): void {
    for (const row of this.store.listTentacleObjects(owner)) {
      if (row.device !== device) continue;
      for (const root of this.service.rootsOf(row.object_id)) this.service.destroyContext(root.contextId);
    }
  }

  private persist(input: Omit<TentacleObjectRow, "object_id" | "status" | "created_at">): TentacleObjectRow {
    const row: TentacleObjectRow = {
      ...input,
      object_id: objectIdFor(input),
      status: "active",
      created_at: new Date().toISOString(),
    };
    this.store.saveTentacleObject(row);
    const stored = this.store.getTentacleObject(row.object_id)!;
    this.register(stored);
    return stored;
  }

  private register(row: TentacleObjectRow): void {
    if (this.service.hasObject(row.object_id)) return;
    this.service.registerObject({
      id: row.object_id,
      kind: row.kind === "tool" ? "tentacle-tool" : "tentacle-session-projection",
      binding: { row, broker: this.broker },
      metadata: {
        owner: row.owner,
        device: row.device,
        resourceKey: row.resource_key,
        schemaDigest: row.schema_digest,
      },
      operations: operationsFor(row),
      policy: tentaclePolicy,
      adapter: adapter as ObjectDefinition<TentacleBinding>["adapter"],
    });
  }

  private rootFor(row: TentacleObjectRow): ContextId | null {
    const hasDevice = this.store.listRunnerTokens(row.owner).some((token) => token.device === row.device);
    const roots = this.service.rootsOf(row.object_id).filter((root) => root.slot === TENTACLE_SLOT);
    if (!hasDevice || row.status !== "active") {
      for (const root of roots) this.service.destroyContext(root.contextId);
      return null;
    }
    const operation = row.kind === "tool" ? TENTACLE_INVOKE_OPERATION : TENTACLE_READ_EVENT_OPERATION;
    if (roots.length === 1) return roots[0].contextId;
    for (const root of roots) this.service.destroyContext(root.contextId);
    const contextId = this.service.createContext("tentacle-object-owner", {
      owner: row.owner,
      objectId: row.object_id,
      purpose: "dsh shared Object root",
    });
    this.service.mintRoot(contextId, TENTACLE_SLOT, row.object_id, [operation], { autoAllow: [operation] });
    return contextId;
  }
}

export function isBrokerToolResult(value: unknown): value is BrokerToolResult {
  return isPlainRecord(value)
    && typeof value.replyKey === "string"
    && isPlainRecord(value.message)
    && typeof value.message.objectId === "string";
}
