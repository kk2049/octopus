import {
  IssueBag,
  boundedStringAt,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
} from "@claude-bot/typed-port-kit";
import { SESSION_CHANNEL_LIMITS } from "./contract.js";

export const SESSION_ACTIVITY_TYPES = Object.freeze([
  "queued",
  "running",
  "text_delta",
  "tool_summary",
  "needs_local_action",
  "result",
  "error",
  "stopped",
] as const);
export type SessionActivityType = (typeof SESSION_ACTIVITY_TYPES)[number];

export interface SessionOpenReceipt {
  readonly sessionRef: string;
  readonly activityCursor: number;
}

export interface SessionSendReceipt {
  readonly sessionRef: string;
  readonly clientMessageId: string;
  readonly disposition: "accepted" | "duplicate";
}

export interface SessionStopReceipt {
  readonly sessionRef: string;
  readonly disposition: "stopped" | "already_stopped";
}

export interface SessionActivity {
  readonly sessionRef: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly type: SessionActivityType;
  readonly text?: string;
  readonly code?: string;
  readonly retryable?: boolean;
}

export interface SessionActivityBatch {
  readonly sessionRef: string;
  readonly afterCursor: number;
  readonly nextCursor: number;
  readonly events: readonly SessionActivity[];
}

const REF = /^[ -~]{1,200}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ACTIVITY = new Set<string>(SESSION_ACTIVITY_TYPES);

function safeIntegerAt(bag: IssueBag, value: unknown, at: string): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    bag.add("field_type", `${at} must be a non-negative safe integer`, at);
    return null;
  }
  return value;
}

function refAt(bag: IssueBag, row: Record<string, unknown>, field: string, at: string): string | null {
  const value = boundedStringAt(bag, row, field, at, SESSION_CHANNEL_LIMITS.maxRefLength);
  if (value !== null && !REF.test(value)) bag.add("identifier", `${field} must be an opaque printable ref`, `${at}.${field}`);
  return value;
}

export function readSessionOpenReceipt(value: unknown, at = "receipt"): ContractResult<SessionOpenReceipt> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, ["sessionRef", "activityCursor"], at);
  const sessionRef = refAt(bag, row, "sessionRef", at);
  const activityCursor = safeIntegerAt(bag, row.activityCursor, `${at}.activityCursor`);
  return bag.empty ? { ok: true, value: { sessionRef: sessionRef!, activityCursor: activityCursor! } } : bag.fail();
}

export function readSessionSendReceipt(value: unknown, at = "receipt"): ContractResult<SessionSendReceipt> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, ["sessionRef", "clientMessageId", "disposition"], at);
  const sessionRef = refAt(bag, row, "sessionRef", at);
  const clientMessageId = boundedStringAt(bag, row, "clientMessageId", at, SESSION_CHANNEL_LIMITS.maxIdempotencyKeyLength);
  if (row.disposition !== "accepted" && row.disposition !== "duplicate") {
    bag.add("schema", "disposition must be accepted or duplicate", `${at}.disposition`);
  }
  return bag.empty
    ? { ok: true, value: { sessionRef: sessionRef!, clientMessageId: clientMessageId!, disposition: row.disposition as "accepted" | "duplicate" } }
    : bag.fail();
}

export function readSessionStopReceipt(value: unknown, at = "receipt"): ContractResult<SessionStopReceipt> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, ["sessionRef", "disposition"], at);
  const sessionRef = refAt(bag, row, "sessionRef", at);
  if (row.disposition !== "stopped" && row.disposition !== "already_stopped") {
    bag.add("schema", "disposition must be stopped or already_stopped", `${at}.disposition`);
  }
  return bag.empty
    ? { ok: true, value: { sessionRef: sessionRef!, disposition: row.disposition as "stopped" | "already_stopped" } }
    : bag.fail();
}

export function readSessionActivity(value: unknown, at = "event"): ContractResult<SessionActivity> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, ["sessionRef", "seq", "timestamp", "type", "text", "code", "retryable"], at);
  const sessionRef = refAt(bag, row, "sessionRef", at);
  const seq = safeIntegerAt(bag, row.seq, `${at}.seq`);
  if (typeof row.timestamp !== "string" || !ISO_INSTANT.test(row.timestamp)) {
    bag.add("field_type", "timestamp must be an ISO-8601 UTC instant", `${at}.timestamp`);
  }
  if (typeof row.type !== "string" || !ACTIVITY.has(row.type)) bag.add("schema", "type is not in the closed activity vocabulary", `${at}.type`);
  const text = row.text === undefined ? undefined : boundedStringAt(bag, row, "text", at, 16_384) ?? undefined;
  const code = row.code === undefined ? undefined : boundedStringAt(bag, row, "code", at, 64) ?? undefined;
  if (row.retryable !== undefined && typeof row.retryable !== "boolean") bag.add("field_type", "retryable must be boolean", `${at}.retryable`);
  if (!bag.empty) return bag.fail();
  return {
    ok: true,
    value: {
      sessionRef: sessionRef!,
      seq: seq!,
      timestamp: row.timestamp as string,
      type: row.type as SessionActivityType,
      ...(text === undefined ? {} : { text }),
      ...(code === undefined ? {} : { code }),
      ...(row.retryable === undefined ? {} : { retryable: row.retryable as boolean }),
    },
  };
}

export function readSessionActivityBatch(value: unknown, at = "batch"): ContractResult<SessionActivityBatch> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, ["sessionRef", "afterCursor", "nextCursor", "events"], at);
  const sessionRef = refAt(bag, row, "sessionRef", at);
  const afterCursor = safeIntegerAt(bag, row.afterCursor, `${at}.afterCursor`);
  const nextCursor = safeIntegerAt(bag, row.nextCursor, `${at}.nextCursor`);
  const events: SessionActivity[] = [];
  if (!Array.isArray(row.events) || row.events.length > SESSION_CHANNEL_LIMITS.maxActivityBatch) {
    bag.add("limit", `events must be an array of at most ${SESSION_CHANNEL_LIMITS.maxActivityBatch}`, `${at}.events`);
  } else {
    row.events.forEach((event, index) => {
      const read = readSessionActivity(event, `${at}.events[${index}]`);
      if (!read.ok) read.issues.forEach((issue) => bag.add(issue.code, issue.message, issue.at));
      else events.push(read.value);
    });
  }
  if (nextCursor !== null && afterCursor !== null && nextCursor < afterCursor) bag.add("schema", "nextCursor cannot move backwards", `${at}.nextCursor`);
  if (sessionRef !== null && events.some((event) => event.sessionRef !== sessionRef)) bag.add("schema", "every event must echo the requested sessionRef", `${at}.events`);
  if (afterCursor !== null && events.some((event) => event.seq <= afterCursor)) bag.add("schema", "every event must be after afterCursor", `${at}.events`);
  if (nextCursor !== null && events.some((event) => event.seq > nextCursor)) bag.add("schema", "nextCursor must cover every returned event", `${at}.nextCursor`);
  if (events.some((event, index) => index > 0 && event.seq <= events[index - 1]!.seq)) bag.add("schema", "event seq must be strictly increasing", `${at}.events`);
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { sessionRef: sessionRef!, afterCursor: afterCursor!, nextCursor: nextCursor!, events } };
}
