import type { ResearchView } from "./research-types.js";
import type { TranscriptWindow } from "@claude-bot/agent-sessions-contract";

export interface ProjectRow {
  title?: string;
  funding_label?: string;
  summary?: string;
  archived?: boolean;
  archived_at?: string;
}

/**
 * Display-only project directory supplied by the trusted Host.
 *
 * `ref` is a bounded lookup key already suitable for a shared URL, never the
 * per-tab instance handle. Roles, members, creators and management authority
 * deliberately have no representation in this projection.
 */
export interface WorkspaceProjectRow {
  ref?: string;
  title?: string;
  archived?: boolean;
}
export interface WorkspaceNavigationRow {
  current_ref?: string;
  projects?: WorkspaceProjectRow[];
  /** More projects exist than `projects` lists; `research.load_more_projects` appends them. */
  truncated?: boolean;
}

export interface WorkspaceRow { key?: string; label?: string; updated_at?: string }
export interface AgentRow {
  key?: string;
  label?: string;
  provider?: string;
  workspace_key?: string;
  session_key?: string;
  status?: string;
  updated_at?: string;
}
export interface SourceRow {
  encoding?: 'text' | 'png-base64';
  source_key: string; kind: "session" | "document"; generation: string;
  title: string; source_ref: string; reason: string; provider: string;
  total: number; next: number; ranges: Array<[number, number, number]>; updated_at: string;
}
export interface SessionRow {
  hidden?: boolean;
  source_key?: string; curated?: boolean;
  first_message_seq?: number;
  session_key?: string;
  resourceId?: string;
  agent_key?: string;
  workspace_key?: string;
  cliKind?: string;
  title?: string;
  preview?: string;
  status?: string;
  lastActivity?: string;
  messageCount?: number;
}
export interface DocumentRow {
  hidden?: boolean;
  source_key?: string; updated_seq?: number;
  first_published_seq?: number;
  body_in_history?: boolean;
  key?: string;
  path?: string;
  title?: string;
  summary?: string;
  body?: string;
  workspace_key?: string;
  workspace_label?: string;
  updated_at?: string;
  updated_by?: string;
}
export interface LeadAgentRow {
  agent_key?: string;
  agent_label?: string;
  session_key?: string;
  session_title?: string;
  reason?: string;
  at?: string;
  by?: string;
}
export interface LeadDocumentRow {
  document_key?: string;
  document_title?: string;
  document_path?: string;
  reason?: string;
  at?: string;
  by?: string;
}
export interface ActivityRow { seq?: number; type?: string; title?: string; detail?: string; at?: string; by?: string; target?: string }
export interface ControlRow {
  can_configure?: boolean;
  can_publish?: boolean;
  can_bind?: boolean;
  can_archive?: boolean;
  can_reopen?: boolean;
  membership_surface?: string;
}
export interface ResearchProjection {
  sessionResources?: import('@claude-bot/agent-sessions-contract').SessionsProjection;
  source_locations?: import('../app/source-locations.js').SourceLocations;
  sources?: Record<string, SourceRow>;
  research?: ResearchView;
  session_archives?: SessionRow[];
  secretary_messages?: Array<{ role: string; text: string; by: string; at: string; record?: string; seq?: number }>;
  available?: boolean;
  project?: ProjectRow;
  workspaces?: WorkspaceRow[];
  agents?: AgentRow[];
  sessions?: SessionRow[];
  transcripts?: Record<string, TranscriptWindow>;
  documents?: DocumentRow[];
  lead_agent?: LeadAgentRow | null;
  lead_document?: LeadDocumentRow | null;
  lead_agent_history?: LeadAgentRow[];
  lead_document_history?: LeadDocumentRow[];
  activity?: ActivityRow[];
  viewer_role?: string;
  controls?: ControlRow;
  workspace_navigation?: WorkspaceNavigationRow;
}

export function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((item): item is T => Boolean(item) && typeof item === "object") : [];
}

export function label(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function roleLabel(role: string | undefined): string {
  return role === "owner" ? "Owner" : role === "member" ? "Member" : role === "viewer" ? "Viewer" : "无角色";
}

export function providerLabel(provider: string | undefined): string {
  return provider === "claude" ? "Claude Opus"
    : provider === "codex-runner" ? "Codex 本地 Runner"
      : provider === "codex" ? "Codex 第一方"
        : "历史 Agent";
}

export function statusLabel(status: string | undefined): string {
  return status === "active" ? "运行中"
    : status === "waiting" ? "等待输入"
      : status === "done" ? "已完成"
        : status === "blocked" ? "受阻"
          : "空闲";
}

export function formatTime(value: string | undefined): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value.slice(0, 24);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function normalizedPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

export function defaultSessionKey(projection: ResearchProjection): string | null {
  const available = new Set(rows<SessionRow>(projection.sessions).flatMap((row) => {
    const key = row.session_key ?? row.resourceId;
    return key ? [key] : [];
  }));
  return registeredLeadAgents(projection).find((row) => row.session_key && available.has(row.session_key))?.session_key ?? null;
}

export function defaultDocumentKey(projection: ResearchProjection): string | null {
  const available = new Set(rows<DocumentRow>(projection.documents).flatMap((row) => row.key ? [row.key] : []));
  return navigationDocuments(projection)
    .find((row) => row.document_key && available.has(row.document_key))?.document_key ?? null;
}

/** Newest explicit registrations first, with one stable row per session. */
export function registeredLeadAgents(projection: ResearchProjection): LeadAgentRow[] {
  const source = [projection.lead_agent, ...rows<LeadAgentRow>(projection.lead_agent_history).reverse(),
    ...rows<SessionRow>(projection.sessions).filter(row => row.curated).map(row => ({
      session_key: row.session_key, agent_label: row.title, session_title: row.cliKind,
      reason: projection.sources?.[row.source_key ?? ""]?.reason, at: row.lastActivity,
    }))];
  const hidden = new Set(rows<SessionRow>(projection.sessions).filter(row => row.hidden).map(row => row.session_key));
  const seen = new Set<string>();
  return source.flatMap((row) => {
    const key = row?.session_key;
    if (!row || !key || seen.has(key) || hidden.has(key)) return [];
    seen.add(key);
    const session = rows<SessionRow>(projection.sessions).find(s => s.session_key === key && s.source_key);
    return [session ? { ...row, agent_label: session.title } : row];
  });
}

/**
 * Explicit lead registrations first, then every explicitly published project
 * document, with one stable row per document. Publishing is already the
 * curation boundary; unlike the Agent directory, this never infers from a
 * workspace or filesystem listing.
 */
export function navigationDocuments(projection: ResearchProjection): LeadDocumentRow[] {
  const source: Array<LeadDocumentRow | null | undefined> = [
    projection.lead_document,
    ...rows<LeadDocumentRow>(projection.lead_document_history).reverse(),
    ...rows<DocumentRow>(projection.documents).filter(row => !row.hidden).map((row) => ({
      document_key: row.key,
      document_title: row.title,
      document_path: row.path,
      reason: "已发布项目文档",
      at: row.updated_at,
      by: row.updated_by,
    })),
  ];
  const hidden = new Set(rows<DocumentRow>(projection.documents).filter(row => row.hidden).map(row => row.key));
  const seen = new Set<string>();
  return source.flatMap((row) => {
    const key = row?.document_key;
    if (!row || !key || seen.has(key) || hidden.has(key)) return [];
    seen.add(key);
    return [row];
  });
}
