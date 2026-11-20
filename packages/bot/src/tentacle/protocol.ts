import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const TENTACLE_PROTOCOL_VERSION = 1;
export const TENTACLE_HEAD_USER = "head";
export const TENTACLE_MAX_EVENT_BYTES = 256 * 1024;

export interface TentacleWireMessage {
  version: typeof TENTACLE_PROTOCOL_VERSION;
  fromUser: string;
  toUser: string;
  objectId: string;
  op: string;
  args: JsonObject;
  seq: number;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function jsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > TENTACLE_MAX_EVENT_BYTES) {
    throw new Error("tentacle JSON value is absent or too large");
  }
  return JSON.parse(encoded) as JsonValue;
}

export function parseTentacleMessage(value: unknown): TentacleWireMessage {
  if (!isPlainRecord(value)) throw new Error("tentacle message must be a plain object");
  if (value.version !== TENTACLE_PROTOCOL_VERSION) {
    throw new Error(`unsupported tentacle protocol version ${String(value.version)}`);
  }
  for (const field of ["fromUser", "toUser", "objectId", "op"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0 || value[field].length > 512) {
      throw new Error(`tentacle ${field} must be a bounded non-empty string`);
    }
  }
  if (!isPlainRecord(value.args)) throw new Error("tentacle args must be a plain object");
  if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0) {
    throw new Error("tentacle seq must be a non-negative safe integer");
  }
  jsonValue(value);
  return value as unknown as TentacleWireMessage;
}

export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainRecord(node)) return node;
    return Object.fromEntries(Object.keys(node).sort().map((key) => [key, walk(node[key])]));
  };
  return JSON.stringify(walk(value));
}

export function schemaDigest(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

const PROJECTION_EVENT_TYPES = new Set([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "assistant/chunk",
  "assistant/message",
]);

const PRIVATE_KEYS = new Set([
  "credential",
  "credentials",
  "token",
  "secret",
  "env",
  "environment",
  "stack",
  "debug",
  "cwd",
  "path",
  "workdir",
  "homedir",
]);

function viewerValue(value: unknown, depth = 0): JsonValue {
  if (depth > 24) throw new Error("projection event nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("projection event has a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => viewerValue(item, depth + 1));
  if (!isPlainRecord(value)) throw new Error("projection event contains a non-JSON value");
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key.toLowerCase())) continue;
    out[key] = viewerValue(item, depth + 1);
  }
  return out;
}

export type CroppedProjection =
  | { op: "projection.open"; args: JsonObject }
  | { op: "projection.event"; args: JsonObject }
  | null;

/** Viewer-facing allowlist. Unknown/private dsh events are acknowledged but not disclosed. */
export function cropProjection(resourceKey: string, payload: unknown): CroppedProjection {
  if (!isPlainRecord(payload) || (payload.op !== "projection.open" && payload.op !== "projection.event")) {
    throw new Error("invalid projection payload");
  }
  if (!isPlainRecord(payload.args) || payload.args.sourceSessionId !== resourceKey) {
    throw new Error("projection payload does not match its bound session");
  }
  if (payload.op === "projection.open") {
    const createdAt = payload.args.createdAt;
    return {
      op: "projection.open",
      args: {
        sourceSessionId: resourceKey,
        ...(typeof createdAt === "number" && Number.isFinite(createdAt) ? { createdAt } : {}),
      },
    };
  }

  const raw = payload.args.event;
  if (!isPlainRecord(raw) || typeof raw.type !== "string" || !PROJECTION_EVENT_TYPES.has(raw.type)) return null;
  if (typeof raw.seq !== "number" || !Number.isSafeInteger(raw.seq) || raw.seq < 0) {
    throw new Error("projection event has an invalid source seq");
  }
  const event: JsonObject = {
    type: raw.type,
    seq: raw.seq,
    time: typeof raw.time === "number" && Number.isFinite(raw.time) ? raw.time : 0,
    data: viewerValue(raw.data),
  };
  if (raw.surfaceOp !== undefined) event.surfaceOp = viewerValue(raw.surfaceOp);
  if (raw.sourceEventSeqs !== undefined) {
    if (!Array.isArray(raw.sourceEventSeqs) || raw.sourceEventSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) {
      throw new Error("projection event has invalid dependencies");
    }
    event.sourceEventSeqs = raw.sourceEventSeqs as number[];
  }
  const out: CroppedProjection = {
    op: "projection.event",
    args: { sourceSessionId: resourceKey, event },
  };
  jsonValue(out);
  return out;
}
