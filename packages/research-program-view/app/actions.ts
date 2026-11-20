/**
 * Project-domain rules for the shared research workspace.
 *
 * Door 1 has already authenticated the principal, resolved this shared
 * instance's membership, applied the manifest role list and filtered
 * `human_only` actions. These handlers still check the business invariants:
 * stable local identifiers, archive terminality, and that a requested lead is
 * already present in this project's authoritative fold.
 */

import { assertProjectCapacity } from './research-model.js';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PATH_CONTROL = /[\u0000-\u001f\u007f]/;
const PROVIDERS = ["claude", "codex", "codex-runner"];
const STATUSES = ["active", "waiting", "idle", "done", "blocked"];
const MESSAGE_ROLES = ["user", "assistant", "system"];

export function configure_project(ctx: any, params: any) {
  if (ctx?.actor?.role !== "owner") throw new Error("role is not allowed");
  assertProjectCapacity(ctx.state);
  const title = singleLine(params?.title, 120, "title");
  const fundingLabel = optionalLine(params?.funding_label ?? ctx.state?.project?.funding_label, 120, "funding_label");
  const summary = optional(params?.summary ?? ctx.state?.project?.summary, 1200, "summary");
  return answer(ctx, "project_configured", {
    title: title.trim(),
    funding_label: fundingLabel.trim(),
    summary: summary.trim(),
  });
}

export function publish_agent_update(ctx: any, params: any) {
  mutableMember(ctx);
  if (!session(ctx, params?.session_key) && (ctx.state?.sessions?.length ?? 0) >= 2048) throw new Error("session index is full; existing history remains readable");
  const provider = choice(params?.provider, PROVIDERS, "provider");
  const status = choice(params?.status, STATUSES, "status");
  const data = {
    agent_key: key(params?.agent_key, "agent_key"),
    agent_label: singleLine(params?.agent_label, 120, "agent_label"),
    provider,
    workspace_key: key(params?.workspace_key, "workspace_key"),
    workspace_label: singleLine(params?.workspace_label, 160, "workspace_label"),
    session_key: key(params?.session_key, "session_key"),
    session_title: singleLine(params?.session_title, 200, "session_title"),
    status,
  };
  return answer(ctx, "agent_session_published", data, {
    agent_key: data.agent_key,
    session_key: data.session_key,
  });
}

export function publish_chat_message(ctx: any, params: any) {
  mutableMember(ctx);
  const sessionKey = key(params?.session_key, "session_key");
  if (!session(ctx, sessionKey)) throw new Error("session is not registered in this project");
  const data = {
    session_key: sessionKey,
    role: choice(params?.role, MESSAGE_ROLES, "role"),
    text: required(params?.text, 12000, "text").trim(),
  };
  return answer(ctx, "chat_message_published", data, { session_key: sessionKey });
}

export function publish_document(ctx: any, params: any) {
  mutableMember(ctx);
  if (!document(ctx, params?.document_key) && (ctx.state?.documents?.length ?? 0) >= 1200) throw new Error("document index is full; existing history remains readable");
  const data = {
    document_key: key(params?.document_key, "document_key"),
    path: displayPath(params?.path),
    title: singleLine(params?.title, 200, "title"),
    summary: optional(params?.summary, 1200, "summary").trim(),
    body: required(params?.body, 32000, "body").trim(),
    workspace_key: key(params?.workspace_key, "workspace_key"),
    workspace_label: singleLine(params?.workspace_label, 160, "workspace_label"),
  };
  return answer(ctx, "document_published", data, { document_key: data.document_key });
}

export function set_lead_agent(ctx: any, params: any) {
  mutableMember(ctx);
  const agentKey = key(params?.agent_key, "agent_key");
  const sessionKey = key(params?.session_key, "session_key");
  const candidate = session(ctx, sessionKey);
  if (!candidate || candidate.archive_only === true || candidate.agent_key !== agentKey) {
    throw new Error("lead session does not belong to that registered agent");
  }
  const reason = required(params?.reason, 500, "reason").trim();
  return answer(ctx, "lead_agent_set", { agent_key: agentKey, session_key: sessionKey, reason }, {
    agent_key: agentKey,
    session_key: sessionKey,
  });
}

export function set_lead_document(ctx: any, params: any) {
  mutableMember(ctx);
  const documentKey = key(params?.document_key, "document_key");
  if (!document(ctx, documentKey)) throw new Error("lead document is not published in this project");
  const reason = required(params?.reason, 500, "reason").trim();
  return answer(ctx, "lead_document_set", { document_key: documentKey, reason }, {
    document_key: documentKey,
  });
}

export function archive_project(ctx: any, params: any) {
  humanOwner(ctx);
  if (ctx?.state?.project?.archived === true) throw new Error("project is already archived");
  choice(params?.confirm, ["确认"], "confirm");
  const reason = required(params?.reason, 500, "reason").trim();
  return answer(ctx, "project_archived", { reason });
}

export function reopen_project(ctx: any, params: any) {
  humanOwner(ctx);
  if (ctx?.state?.project?.archived !== true) throw new Error("project is not archived");
  choice(params?.confirm, ["确认"], "confirm");
  const reason = required(params?.reason, 500, "reason").trim();
  return answer(ctx, "project_reopened", { reason });
}

function mutableMember(ctx: any): string {
  assertProjectCapacity(ctx.state);
  const role = member(ctx, ["owner", "member"]);
  if (ctx?.state?.project?.archived === true) throw new Error("project is archived");
  return role;
}

function humanOwner(ctx: any): void {
  member(ctx, ["owner"]);
  if (ctx?.actor?.kind !== "user") throw new Error("this action requires a person");
}

function member(ctx: any, allowed: string[]): string {
  const role = ctx?.actor?.role;
  if (!allowed.includes(role)) throw new Error("actor role is not allowed");
  return role;
}

function session(ctx: any, sessionKey: string): any | undefined {
  return Array.isArray(ctx?.state?.sessions)
    ? ctx.state.sessions.find((row: any) => row?.session_key === sessionKey || row?.resourceId === sessionKey)
    : undefined;
}

function document(ctx: any, documentKey: string): any | undefined {
  return Array.isArray(ctx?.state?.documents)
    ? ctx.state.documents.find((row: any) => row?.key === documentKey || row?.document_key === documentKey)
    : undefined;
}

function key(value: any, name: string): string {
  const out = required(value, 96, name);
  if (!KEY.test(out)) throw new Error(`${name} is invalid`);
  return out;
}

function displayPath(value: any): string {
  const out = required(value, 320, "path").trim();
  if (PATH_CONTROL.test(out) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(out)) {
    throw new Error("path must be a plain display path");
  }
  return out;
}

function required(value: any, max: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || CONTROL.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optional(value: any, max: number, name: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function singleLine(value: any, max: number, name: string): string {
  const out = required(value, max, name).trim();
  if (/[\r\n\t]/.test(out)) throw new Error(`${name} is invalid`);
  return out;
}

function optionalLine(value: any, max: number, name: string): string {
  const out = optional(value, max, name).trim();
  if (/[\r\n\t]/.test(out)) throw new Error(`${name} is invalid`);
  return out;
}

function choice(value: any, choices: string[], name: string): string {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`${name} is invalid`);
  return value;
}

function answer(ctx: any, type: string, data: any, result: any = {}) {
  return { events: [event(ctx, type, data)], result };
}

/** `at` and `by` are placeholders; the trusted coordinator overwrites both. */
function event(ctx: any, type: string, data: any) {
  return { type, data, at: String(ctx?.now ?? ""), by: "research-program" };
}

export { research_record, research_fork, research_advance, research_transition, research_deliver, research_request_confirmation, research_attest, research_merge, research_query, research_mark_seen, research_read_history } from "./research-actions.js";

/** Import roles/timestamps are source claims; trusted publisher attribution stays separate. */
export function research_import_chat(ctx: any, params: any) {
  mutableMember(ctx);
  const sessionKey = key(params?.session_key, 'session_key');
  if (!session(ctx, sessionKey)) throw new Error('session is not registered in this project');
  const offsetText = required(params?.offset, 12, 'offset');
  if (!/^[0-9]{1,12}$/.test(offsetText)) throw new Error('offset is invalid');
  const offset = Number(offsetText);
  const batch = key(params?.batch_id, 'batch_id');
  const current = ctx.state.import_cursors?.[sessionKey] ?? { next: 0, batch: '', start: 0 };
  if (current.batch === batch && current.start === offset) return { events: [], result: { next_offset: current.next, duplicate: true } };
  if (offset !== current.next) throw new Error(`source offset changed; resume at ${current.next}`);
  const rows = JSON.parse(required(params?.messages_json, 32000, 'messages_json'));
  if (!Array.isArray(rows) || !rows.length || rows.length > 16) throw new Error('messages_json must contain 1–16 messages');
  const events = rows.map((row, index) => event(ctx, 'chat_message_imported', {
    session_key: sessionKey, role: choice(row?.role, MESSAGE_ROLES, 'role'),
    text: required(row?.text, 12000, 'text'), source_at: optionalLine(row?.timestamp, 80, 'timestamp'),
    source_offset: offset + index, batch, batch_start: offset,
  }));
  return { events, result: { next_offset: offset + rows.length, duplicate: false } };
}

/** Historical session registration has no implication about the project's current leader. */
export function research_register_archive(ctx: any, params: any) {
  mutableMember(ctx);
  const sessionKey = key(params?.session_key, 'session_key');
  if (!session(ctx, sessionKey) && (ctx.state?.sessions?.length ?? 0) >= 2048) throw new Error('session index is full');
  const provider = choice(params?.provider, ['codex', 'claude', 'omp', 'other'], 'provider');
  return answer(ctx, 'agent_session_published', {
    agent_key: sessionKey, agent_label: `历史会话 · ${provider}`, provider, archive_only: true,
    workspace_key: key(params?.workspace_key, 'workspace_key'), workspace_label: singleLine(params?.workspace_label, 160, 'workspace_label'),
    session_key: sessionKey, session_title: singleLine(params?.title, 200, 'title'), status: 'done',
    source_session: key(params?.source_session, 'source_session'),
  });
}
export { research_capture_requirement } from './research-actions.js';

export { research_bind_source, research_publish_source, research_read_source, research_source_status, research_unbind_source } from "./source-bindings.js";
export { research_set_source_locations } from './source-locations.js';
