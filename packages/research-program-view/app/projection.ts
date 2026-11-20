import { foldSources } from './source-bindings.js';
import { foldSourceLocations } from './source-locations.js';
import { emptyResearch } from './research-model.js';
import { foldResearch, presentResearch } from './research-projection.js';
const LIMITS = Object.freeze({
  workspaces: 64,
  agents: 128,
  sessions: 2048,
  documents: 1200,
  messagesPerSession: 240,
  activity: 160,
  leadHistory: 120,
});

/**
 * Fold the project event log into one bounded, viewer-scoped research mirror.
 * The no-viewer form is the Runtime's private fold for the next action handler;
 * every real View open supplies `context.viewer` and is failed closed when that
 * evidence is malformed.
 */
export function project(events: any[], context?: any) {
  return projectIncremental(emptyState(), events, context);
}

export function projectIncremental(snapshot: any, events: any[], context?: any) {
  const state = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? JSON.parse(JSON.stringify(snapshot))
    : emptyState();
  state.research ??= emptyResearch();
  state.import_cursors ??= {};
  state.secretary_messages ??= [];
  for (const row of Array.isArray(events) ? events : []) {
    if (!foldSourceLocations(state, row) && !foldSources(state, row)) fold(state, row);
    present(state);
    boundContentCache(state);
  }
  present(state);
  boundContentCache(state);

  if (!context || !Object.prototype.hasOwnProperty.call(context, "viewer")) return state;

  const viewer = context.viewer && typeof context.viewer === "object" ? context.viewer : {};
  const user = typeof viewer.user === "string" ? viewer.user : "";
  const role = viewer.role === "owner" || viewer.role === "member" || viewer.role === "viewer"
    ? viewer.role
    : "";
  if ((!user && !(viewer.kind === "agent" && typeof viewer.agent === "string" && viewer.agent)) || !role) return deniedProjection();

  const { source_last: _lastSource, ...viewState } = state;
  return {
    ...viewState,
    available: true,
    sources: state.sources ?? {},
    session_archives: state.sessions.filter((s: any) => state.import_cursors[s.session_key]),
    research: presentResearch(state.research, viewer, (role === "owner" || role === "member") && !state.project.archived),
    viewer_role: role,
    controls: {
      can_configure: role === "owner",
      can_publish: (role === "owner" || role === "member") && !state.project.archived,
      can_bind: (role === "owner" || role === "member") && !state.project.archived,
      can_archive: role === "owner" && !state.project.archived,
      can_reopen: role === "owner" && state.project.archived,
      membership_surface: "trusted_outer",
    },
  };
}

function emptyState(): any {
  return {
    available: false,
    research: emptyResearch(),
    project: {
      title: "未命名科研项目",
      funding_label: "",
      summary: "",
      archived: false,
      archived_at: "",
    },
    workspaces: [],
    agents: [],
    sessions: [],
    transcripts: {},
    import_cursors: {},
    secretary_messages: [],
    documents: [],
    lead_agent: null,
    lead_document: null,
    lead_agent_history: [],
    lead_document_history: [],
    activity: [],
    viewer_role: "",
    controls: {
      can_configure: false,
      can_publish: false,
      can_bind: false,
      can_archive: false,
      can_reopen: false,
      membership_surface: "trusted_outer",
    },
  };
}

function deniedProjection(): any {
  return {
    ...emptyState(),
    project: { ...emptyState().project, title: "项目访问不可用" },
  };
}

function fold(state: any, row: any): void {
  if (!row || typeof row !== "object" || Array.isArray(row)) return;
  const data = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {};
  const at = text(row.at, 80);
  const by = actor(row.by);
  foldResearch(state.research, row);
  const researchTitles: Record<string, string> = {
    research_recorded: '留下科研记录', research_forked: '开了研究分支',
    research_advanced: '推进了分支', research_transitioned: '变更了工作状态',
    research_delivered: '提交了交付', research_merged: '合入了团队主线',
    research_attested: '留下了本人判断', research_confirmation_requested: '请求明确回复',
  };
  if (researchTitles[row.type]) {
    const branch = state.research.branches.find((b: any) => b.id === (data.branch ?? data.id));
    const target = data.record?.id ?? data.target ?? branch?.head ?? data.id;
    const record = state.research.records.find((r: any) => r.id === target);
    const judgments: Record<string, string> = { understood: '确认已理解', approve: '明确批准', reject: '拒绝', disagree: '不同意', withdraw: '撤回批准' };
    pushActivity(state, { type: 'research', title: row.type === 'research_attested' ? judgments[data.kind] : researchTitles[row.type],
      detail: record?.title ?? branch?.title ?? data.question ?? '', target, seq: Number(row.seq ?? 0), at, by });
  }

  if (row.type === "project_configured") {
    state.project.title = text(data.title, 120) || state.project.title;
    state.project.funding_label = text(data.funding_label, 120);
    state.project.summary = text(data.summary, 1200);
    pushActivity(state, { type: "project", title: "项目资料已更新", detail: state.project.title, at, by });
    return;
  }

  if (row.type === "agent_session_published") {
    const agentKey = localKey(data.agent_key);
    const workspaceKey = localKey(data.workspace_key);
    const sessionKey = localKey(data.session_key);
    if (!agentKey || !workspaceKey || !sessionKey) return;
    const workspaceLabel = text(data.workspace_label, 160) || workspaceKey;
    upsert(state.workspaces, workspaceKey, {
      key: workspaceKey,
      label: workspaceLabel,
      updated_at: at,
    }, LIMITS.workspaces);
    upsert(state.agents, agentKey, {
      key: agentKey,
      label: text(data.agent_label, 120) || agentKey,
      provider: provider(data.provider),
      workspace_key: workspaceKey,
      session_key: sessionKey,
      status: status(data.status),
      updated_at: at,
      updated_by: by,
    }, LIMITS.agents);
    const existing = state.sessions.find((item: any) => item.session_key === sessionKey);
    const messageCount = Number(existing?.messageCount ?? 0);
    upsert(state.sessions, sessionKey, {
      session_key: sessionKey,
      archive_only: data.archive_only === true,
      source_session: text(data.source_session, 96),
      resourceId: sessionKey,
      agent_key: agentKey,
      workspace_key: workspaceKey,
      directoryKey: workspaceKey,
      deviceLabel: "项目镜像",
      cliKind: provider(data.provider),
      projectLabel: workspaceLabel,
      cwdDisplay: workspaceLabel,
      lastActivity: at,
      sortActivity: at,
      completedAt: status(data.status) === "done" ? at : undefined,
      status: status(data.status),
      resumable: false,
      messageCount,
      title: text(data.session_title, 200) || sessionKey,
      preview: existing?.preview ?? "",
      first_message_seq: existing?.first_message_seq ?? null,
    }, LIMITS.sessions);
    retainTranscriptKeys(state);
    pushActivity(state, {
      type: "agent",
      title: `${text(data.agent_label, 120) || agentKey} · ${statusLabel(status(data.status))}`,
      detail: text(data.session_title, 200) || sessionKey,
      at,
      by,
      target: sessionKey,
    });
    return;
  }

  if (row.type === "sys_agent_inbox" && data.to === "secretary") {
    state.secretary_messages = [...state.secretary_messages, { role: "user", text: text(data.text, 4000), by, at, seq: row.seq }].slice(-80);
    return;
  }
  if (row.type === "research_recorded" && data.kind === "briefing") {
    state.secretary_messages = [...state.secretary_messages, { role: "assistant", text: text(data.body, 6000), record: data.id, by, at, seq: row.seq }].slice(-80);
  }
  if (row.type === "chat_message_published" || row.type === "chat_message_imported") {
    const sessionKey = localKey(data.session_key);
    const session = state.sessions.find((item: any) => item.session_key === sessionKey);
    if (!sessionKey || !session) return;
    const messageText = text(data.text, 12000);
    if (!messageText) return;
    session.first_message_seq ??= row.seq ?? 1;
    const role = messageRole(data.role);
    if (row.type === "chat_message_imported") state.import_cursors[sessionKey] = { next: Number(data.source_offset) + 1, batch: text(data.batch, 96), start: Number(data.batch_start) };
    const transcript = state.transcripts[sessionKey] ?? {
      sessionId: sessionKey,
      cliKind: session.cliKind,
      deviceLabel: session.projectLabel,
      rich: true,
      messages: [],
      activity: null,
      runtime: null,
      offset: 0,
      nextOffset: null,
      totalMessages: 0,
      hasMore: false,
      truncated: false,
    };
    const combined = [...transcript.messages, {
      role,
      timestamp: row.type === "chat_message_imported" ? text(data.source_at, 80) : at,
      blocks: [{ type: "text", text: messageText }],
    }];
    const trimmed = combined.length > LIMITS.messagesPerSession;
    transcript.messages = combined.slice(-LIMITS.messagesPerSession);
    transcript.totalMessages = Number(transcript.totalMessages ?? 0) + 1;
    transcript.offset = Math.max(0, transcript.totalMessages - transcript.messages.length);
    transcript.hasMore = transcript.offset > 0;
    transcript.truncated = transcript.truncated === true || trimmed;
    state.transcripts[sessionKey] = transcript;
    session.last_message_seq = row.seq ?? 0;
    session.lastActivity = at;
    session.sortActivity = at;
    session.messageCount = transcript.totalMessages;
    session.preview = messageText.slice(0, 240);
    pushActivity(state, {
      type: "message",
      title: role === "user" ? "研究者消息" : role === "system" ? "系统记录" : "Agent 汇报",
      detail: messageText.slice(0, 240),
      at,
      by,
      target: sessionKey,
    });
    return;
  }

  if (row.type === "document_published") {
    const documentKey = localKey(data.document_key);
    const workspaceKey = localKey(data.workspace_key);
    if (!documentKey || !workspaceKey) return;
    const workspaceLabel = text(data.workspace_label, 160) || workspaceKey;
    upsert(state.workspaces, workspaceKey, { key: workspaceKey, label: workspaceLabel, updated_at: at }, LIMITS.workspaces);
    const firstPublished = state.documents.find((d: any) => d.key === documentKey)?.first_published_seq ?? row.seq ?? 1;
    upsert(state.documents, documentKey, {
      first_published_seq: firstPublished,
      updated_seq: row.seq ?? 0,
      key: documentKey,
      document_key: documentKey,
      path: displayPath(data.path),
      title: text(data.title, 200) || documentKey,
      summary: text(data.summary, 1200),
      body: text(data.body, 32000),
      workspace_key: workspaceKey,
      workspace_label: workspaceLabel,
      updated_at: at,
      updated_by: by,
    }, LIMITS.documents);
    pushActivity(state, {
      type: "document",
      title: "现状文档已发布",
      detail: text(data.title, 200) || documentKey,
      at,
      by,
      target: documentKey,
    });
    return;
  }

  if (row.type === "lead_agent_set") {
    const agentKey = localKey(data.agent_key);
    const sessionKey = localKey(data.session_key);
    const session = state.sessions.find((item: any) => item.session_key === sessionKey && item.agent_key === agentKey);
    if (!agentKey || !sessionKey || !session) return;
    const agentRow = state.agents.find((item: any) => item.key === agentKey);
    const entry = {
      agent_key: agentKey,
      agent_label: agentRow?.label ?? agentKey,
      session_key: sessionKey,
      session_title: session.title,
      reason: text(data.reason, 500),
      at,
      by,
    };
    state.lead_agent = entry;
    state.lead_agent_history = [...state.lead_agent_history, entry].slice(-LIMITS.leadHistory);
    pushActivity(state, { type: "lead-agent", title: "主导 Agent 已切换", detail: entry.agent_label, at, by, target: sessionKey });
    return;
  }

  if (row.type === "lead_document_set") {
    const documentKey = localKey(data.document_key);
    const documentRow = state.documents.find((item: any) => item.key === documentKey);
    if (!documentKey || !documentRow) return;
    const entry = {
      document_key: documentKey,
      document_title: documentRow.title,
      document_path: documentRow.path,
      reason: text(data.reason, 500),
      at,
      by,
    };
    state.lead_document = entry;
    state.lead_document_history = [...state.lead_document_history, entry].slice(-LIMITS.leadHistory);
    pushActivity(state, { type: "lead-document", title: "主导文档已切换", detail: entry.document_title, at, by, target: documentKey });
    return;
  }

  if (row.type === "project_archived") {
    state.project.archived = true;
    state.project.archived_at = at;
    pushActivity(state, { type: "lifecycle", title: "项目已归档", detail: text(data.reason, 500), at, by });
    return;
  }

  if (row.type === "project_reopened") {
    state.project.archived = false;
    state.project.archived_at = "";
    pushActivity(state, { type: "lifecycle", title: "项目已重新开放", detail: text(data.reason, 500), at, by });
  }
}

function present(state: any): void {
  state.workspaces.sort(recent);
  state.agents.sort(recent);
  state.sessions.sort((left: any, right: any) => Number(right.last_message_seq ?? 0) - Number(left.last_message_seq ?? 0) || String(right.sortActivity ?? "").localeCompare(String(left.sortActivity ?? "")));
  state.documents.sort(recent);
  if (state.lead_agent && !state.sessions.some((row: any) => row.session_key === state.lead_agent.session_key)) {
    state.lead_agent = null;
  }
  if (state.lead_document && !state.documents.some((row: any) => row.key === state.lead_document.document_key)) {
    state.lead_document = null;
  }
}

function recent(left: any, right: any): number {
  return Number(right.updated_seq ?? 0) - Number(left.updated_seq ?? 0) || String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""));
}

function upsert(rows: any[], key: string, next: any, limit: number): void {
  const index = rows.findIndex((row) => row.key === key || row.session_key === key);
  if (index >= 0) rows.splice(index, 1);
  rows.push(next);
  if (rows.length > limit) rows.splice(0, rows.length - limit);
}

function retainTranscriptKeys(state: any): void {
  const allowed = new Set(state.sessions.map((row: any) => row.session_key));
  for (const key of Object.keys(state.transcripts)) {
    if (!allowed.has(key)) delete state.transcripts[key];
  }
}

function pushActivity(state: any, entry: any): void {
  state.activity = [...state.activity, entry].slice(-LIMITS.activity);
}

function localKey(value: any): string {
  const out = text(value, 96);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(out) ? out : "";
}

function displayPath(value: any): string {
  const out = text(value, 320).trim();
  if (!out || /[\u0000-\u001f\u007f]/.test(out) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(out)) return "";
  return out;
}

function text(value: any, max: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function actor(value: any): string {
  const out = text(value, 160);
  return out.startsWith("user:") ? out.slice(5) : out || "可信协调器";
}

function provider(value: any): string {
  return ["claude", "codex", "codex-runner", "omp", "other"].includes(value) ? value : "other";
}

function status(value: any): string {
  return ["active", "waiting", "idle", "done", "blocked"].includes(value) ? value : "idle";
}

function messageRole(value: any): string {
  return value === "user" || value === "system" ? value : "assistant";
}

function statusLabel(value: string): string {
  return value === "active" ? "运行中"
    : value === "waiting" ? "等待输入"
      : value === "done" ? "已完成"
        : value === "blocked" ? "受阻"
          : "空闲";
}

/** Bodies are an evictable cache; immutable log pages retain complete content. */
function boundContentCache(state: any): void {
  let secretaryBudget = 48000;
  state.secretary_messages = [...state.secretary_messages].reverse().filter((message: any) => {
    const size = JSON.stringify(message).length;
    if (size > secretaryBudget) return false;
    secretaryBudget -= size; return true;
  }).reverse();
  let documentBudget = 96000;
  for (const document of state.documents) {
    const body = typeof document.body === "string" ? document.body : "";
    if (body.length > documentBudget) { document.body = ""; document.body_in_history = true; }
    else { documentBudget -= body.length; }
  }
  let messageBudget = 96000;
  for (const session of state.sessions) {
    const transcript = state.transcripts[session.session_key];
    if (!transcript) continue;
    const retained = [];
    for (let i = transcript.messages.length - 1; i >= 0; i--) {
      const message = transcript.messages[i];
      const size = JSON.stringify(message).length;
      if (size > messageBudget) break;
      messageBudget -= size; retained.unshift(message);
    }
    if (retained.length < transcript.messages.length) {
      transcript.messages = retained;
      transcript.offset = transcript.totalMessages - retained.length;
      transcript.hasMore = true; transcript.truncated = true;
    }
  }
}
