import { parseKnowledgeChanges, type KnowledgeChange } from "../knowledge/changes.js";
import { parseSpecifications, type KnowledgeSpecification } from "../knowledge/specifications.js";
/**
 * Durable handoff from the human/CLI development lane to the ticket system.
 *
 * A CLI landing does not have the conversational ticket that devpipe-managed
 * work starts with, so its final commit carries one small JSON report. The
 * landing door validates it, then projects it into the existing dev-ticket
 * deploy/acceptance state machine. The checked-in JSON remains the recovery
 * source if the database write is interrupted after Git has moved.
 */

export const CLI_REPORT_DIR = "doc/cli-reports";

interface CliDeliveryReportBase {
  title: string;
  summary: string;
  requester: string;
  verification: string[];
  acceptance: string[];
}

export interface CliDeliveryReportV1 extends CliDeliveryReportBase {
  version: 1;
}

export interface CliDeliveryReportV2 extends CliDeliveryReportBase {
  version: 2;
  base_sha: string;
  requirements: string[];
  decisions: string[];
  non_goals: string[];
  risks: string[];
  supersedes: string[];
}
export type CliRetrievalFeedbackCode =
  | "not_run"
  | "helpful"
  | "not_helpful"
  | "missing_slot"
  | "code_index_stale"
  | "vector_unavailable"
  | "no_grounded_answer"
  | "wrong_lifecycle"
  | "wrong_scope"
  | "telemetry_receipt_missing"
  | "telemetry_receipt_invalid";

export interface CliRetrievalAttestation {
  traces: Array<{ id: `kr_${string}`; receipt_sha256: string }>;
  context_keys: string[];
  feedback: Array<{
    trace_id?: `kr_${string}`;
    code: CliRetrievalFeedbackCode;
    slot?:
      | "contract_principle"
      | "scenarios"
      | "sources_requirements"
      | "decisions_exceptions"
      | "actions_symbols"
      | "tests_evidence"
      | "landings_patterns"
      | "unknown_conflicts";
  }>;
}

export interface CliDeliveryReportV3 extends CliDeliveryReportBase {
  native_ticket_id?: number;
  specifications?: KnowledgeSpecification[];
  changes?: KnowledgeChange[];
  version: 3;
  base_sha: string;
  requirements: string[];
  decisions: string[];
  non_goals: string[];
  risks: string[];
  supersedes: string[];
  retrieval: CliRetrievalAttestation;
}


export type CliDeliveryReport = CliDeliveryReportV1 | CliDeliveryReportV2 | CliDeliveryReportV3;

export interface LoadedCliDeliveryReport {
  path: string;
  report: CliDeliveryReport;
}

const REPORT_PATH = /^doc\/cli-reports\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.json$/;
const REQUESTER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isCliReportPath(path: string): boolean {
  return REPORT_PATH.test(path);
}

function textField(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} 必须是字符串`);
  const text = value.trim();
  if (!text) throw new Error(`${name} 不能为空`);
  if (text.length > max) throw new Error(`${name} 不能超过 ${max} 字符`);
  return text;
}

function textList(value: unknown, name: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} 必须是至少一项的字符串数组`);
  }
  if (value.length > maxItems) throw new Error(`${name} 不能超过 ${maxItems} 项`);
  return value.map((item, at) => textField(item, `${name}[${at}]`, 500));
}
function optionalTextList(value: unknown, name: string, maxItems: number): string[] {
  if (Array.isArray(value) && value.length === 0) return [];
  return textList(value, name, maxItems);
}

function parseRetrievalAttestation(value: unknown): CliRetrievalAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("retrieval 必须是 object");
  const retrieval = value as Record<string, unknown>;
  const unknown = Object.keys(retrieval).filter((key) => !["traces", "context_keys", "feedback"].includes(key));
  if (unknown.length) throw new Error(`retrieval 未知字段: ${unknown.join(", ")}`);
  if (!Array.isArray(retrieval.traces) || retrieval.traces.length > 8) throw new Error("retrieval.traces 不能超过 8 项");
  const traces = retrieval.traces.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`retrieval.traces[${index}] 必须是 object`);
    const item = raw as Record<string, unknown>;
    const extra = Object.keys(item).filter((key) => key !== "id" && key !== "receipt_sha256");
    if (extra.length) throw new Error(`retrieval.traces[${index}] 未知字段: ${extra.join(", ")}`);
    const id = textField(item.id, `retrieval.traces[${index}].id`, 35);
    if (!/^kr_[0-9a-f]{32}$/u.test(id)) throw new Error(`retrieval.traces[${index}].id 不是合法 trace id`);
    const receiptSha256 = textField(item.receipt_sha256, `retrieval.traces[${index}].receipt_sha256`, 64);
    if (!/^[0-9a-f]{64}$/u.test(receiptSha256)) throw new Error(`retrieval.traces[${index}].receipt_sha256 必须是小写 SHA-256`);
    return { id: id as `kr_${string}`, receipt_sha256: receiptSha256 };
  });
  if (new Set(traces.map((trace) => trace.id)).size !== traces.length) throw new Error("retrieval.traces 不能重复");
  if (!Array.isArray(retrieval.context_keys) || retrieval.context_keys.length > 50) throw new Error("retrieval.context_keys 不能超过 50 项");
  const contextKeys = retrieval.context_keys.map((raw, index) => {
    const key = textField(raw, `retrieval.context_keys[${index}]`, 512);
    if (!/^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,511}$/u.test(key)) throw new Error(`retrieval.context_keys[${index}] 不是稳定记录 id`);
    return key;
  });
  if (new Set(contextKeys).size !== contextKeys.length) throw new Error("retrieval.context_keys 不能重复");
  if (!Array.isArray(retrieval.feedback) || retrieval.feedback.length > 8) throw new Error("retrieval.feedback 不能超过 8 项");
  const traceIds = new Set(traces.map((trace) => trace.id));
  const feedbackCodes: readonly CliRetrievalFeedbackCode[] = [
    "not_run", "helpful", "not_helpful", "missing_slot", "code_index_stale",
    "vector_unavailable", "no_grounded_answer", "wrong_lifecycle", "wrong_scope",
    "telemetry_receipt_missing", "telemetry_receipt_invalid",
  ];
  const slots: ReadonlyArray<NonNullable<CliRetrievalAttestation["feedback"][number]["slot"]>> = [
    "contract_principle", "scenarios", "sources_requirements", "decisions_exceptions",
    "actions_symbols", "tests_evidence", "landings_patterns", "unknown_conflicts",
  ];
  const feedback = retrieval.feedback.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`retrieval.feedback[${index}] 必须是 object`);
    const item = raw as Record<string, unknown>;
    const extra = Object.keys(item).filter((key) => !["trace_id", "code", "slot"].includes(key));
    if (extra.length) throw new Error(`retrieval.feedback[${index}] 未知字段: ${extra.join(", ")}`);
    const code = textField(item.code, `retrieval.feedback[${index}].code`, 64);
    if (!feedbackCodes.includes(code as CliRetrievalFeedbackCode)) throw new Error(`retrieval.feedback[${index}].code 不受支持`);
    const traceId = item.trace_id === undefined ? undefined : textField(item.trace_id, `retrieval.feedback[${index}].trace_id`, 35);
    if (code === "not_run") {
      if (traceId !== undefined || item.slot !== undefined) throw new Error("not_run 反馈不能声称 trace 或 slot");
    } else if (!traceId || !traceIds.has(traceId as `kr_${string}`)) {
      throw new Error(`retrieval.feedback[${index}].trace_id 必须引用 retrieval.traces`);
    }
    const slot = item.slot === undefined ? undefined : textField(item.slot, `retrieval.feedback[${index}].slot`, 64);
    if (slot !== undefined && !slots.includes(slot as NonNullable<CliRetrievalAttestation["feedback"][number]["slot"]>)) {
      throw new Error(`retrieval.feedback[${index}].slot 不受支持`);
    }
    return {
      ...(traceId === undefined ? {} : { trace_id: traceId as `kr_${string}` }),
      code: code as CliRetrievalFeedbackCode,
      ...(slot === undefined ? {} : { slot: slot as NonNullable<CliRetrievalAttestation["feedback"][number]["slot"]> }),
    };
  });
  if (traces.length === 0 && contextKeys.length > 0) throw new Error("没有 retrieval.traces 时不能声明 context_keys");
  if (traces.length === 0 && (feedback.length !== 1 || feedback[0]?.code !== "not_run")) {
    throw new Error("没有 retrieval.traces 时必须且只能声明 not_run");
  }
  if (traces.length > 0 && feedback.some((item) => item.code === "not_run")) throw new Error("已有 retrieval.traces 时不能声明 not_run");
  return { traces, context_keys: contextKeys, feedback };
}


/** Parse without coercion: a plausible-looking malformed report is a refusal. */
export function parseCliDeliveryReport(raw: string, path: string): CliDeliveryReport {
  if (!isCliReportPath(path)) {
    throw new Error(`简报路径必须匹配 ${CLI_REPORT_DIR}/YYYY-MM-DD-<slug>.json`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`JSON 无法解析: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("简报根必须是 JSON object");
  }
  const record = value as Record<string, unknown>;
  const baseAllowed = ["$schema", "version", "title", "summary", "requester", "verification", "acceptance"];
  const v2Allowed = ["base_sha", "requirements", "decisions", "non_goals", "risks", "supersedes"];
  const allowed = new Set(record.version === 2 ? [...baseAllowed, ...v2Allowed] : record.version === 3 ? [...baseAllowed, ...v2Allowed, "retrieval", "changes", "specifications", "native_ticket_id"] : baseAllowed);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`未知字段: ${unknown.join(", ")}`);
  if (record.version !== 1 && record.version !== 2 && record.version !== 3) throw new Error("version 必须是 1、2 或 3");
  const requester = textField(record.requester, "requester", 64);
  if (!REQUESTER.test(requester)) throw new Error("requester 不是合法的 Dashboard 用户名");
  const common = {
    title: textField(record.title, "title", 120),
    summary: textField(record.summary, "summary", 4_000),
    requester,
    verification: textList(record.verification, "verification", 20),
    acceptance: textList(record.acceptance, "acceptance", 12),
  };
  if (record.version === 1) return { version: 1, ...common };
  const baseSha = textField(record.base_sha, "base_sha", 64);
  if (record.version === 3 ? !/^[0-9a-f]{40}$/.test(baseSha) : !/^[0-9a-f]{40,64}$/.test(baseSha)) {
    throw new Error("base_sha 必须是完整小写 commit SHA");
  }
  const structured = {
    base_sha: baseSha,
    ...common,
    requirements: textList(record.requirements, "requirements", 20),
    decisions: textList(record.decisions, "decisions", 20),
    non_goals: optionalTextList(record.non_goals, "non_goals", 20),
    risks: optionalTextList(record.risks, "risks", 20),
    supersedes: optionalTextList(record.supersedes, "supersedes", 20),
  };
  if (record.version === 2) return { version: 2, ...structured };
  if (record.native_ticket_id !== undefined && (!Number.isSafeInteger(record.native_ticket_id) || Number(record.native_ticket_id) < 1)) throw new Error("native_ticket_id must be a positive ticket id");
  if (record.native_ticket_id !== undefined) Object.assign(structured, { native_ticket_id: record.native_ticket_id });
  return { version: 3, ...structured, ...(record.specifications === undefined ? {} : { specifications: parseSpecifications(record.specifications) }), ...(record.changes === undefined ? {} : { changes: parseKnowledgeChanges(record.changes) }), retrieval: parseRetrievalAttestation(record.retrieval) };
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/** Canonical Markdown is what the trusted Dashboard renders in the report card. */
export function renderCliDeliveryReport(loaded: LoadedCliDeliveryReport): string {
  return [
    loaded.report.summary,
    "## 开发侧验证",
    bullets(loaded.report.verification),
    "## 生产验收",
    bullets(loaded.report.acceptance),
    `简报来源：\`${loaded.path}\``,
  ].join("\n\n");
}

/** DeployService already extracts this heading into its aggregate checklist. */
export function cliAcceptanceSpec(report: CliDeliveryReport): string {
  return `## 验收标准\n${bullets(report.acceptance)}`;
}
