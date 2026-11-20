/** Research transport adapter for the same Sessions+ module/controller contract. */
import { READ_ONLY_REFUSAL, createSessionCommands, SESSION_ACTIONS, type SessionOperation, type RichMessage, type SessionsPort, type SessionsSnapshot, type SessionsReply, type SessionSummary, type TranscriptWindow } from '@claude-bot/agent-sessions-contract';
import { registeredLeadAgents, rows, type ResearchProjection, type SessionRow } from './model.js';
import { readSourceChunks, type Propose } from './source-reader.js';
const OK: SessionsReply = { ok: true, message: '' };
export function createResearchSessionsAdapter(propose: Propose) {
  let projection: ResearchProjection = {};
  let scope = '';
  let generation = 0;
  let snapshot: SessionsSnapshot = { phase: 'waiting', projection: null, operations: [], refusal: '' };
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const updateSnapshot = (next: Partial<SessionsSnapshot>) => { snapshot = { ...snapshot, ...next }; notify(); };
  const refuse = async () => { updateSnapshot({ refusal: READ_ONLY_REFUSAL.message }); return READ_ONLY_REFUSAL; };
  const mapped = (resource: string) => snapshot.phase === 'open' && projection.viewer_role === 'owner' && !projection.project?.archived && Boolean(projection.source_locations?.sessions[resource]?.device);
  const commands = createSessionCommands(async (action, params) => {
    if (!mapped(params.resource ?? '') || action !== SESSION_ACTIONS.readWindow && !projection.sessionResources?.sessions?.some(row => row.resourceId === params.resource && row.deviceId)) return refuse();
    const answer = await propose(action, params);
    if (!answer.ok) updateSnapshot({ refusal: answer.message || '真实会话操作被拒绝。' });
    return { ok: answer.ok, code: answer.code, message: answer.message, result: answer.result };
  });
  const port: SessionsPort = {
    snapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    clearRefusal: () => updateSnapshot({ refusal: '' }),
    refreshSessions: async () => OK,
    listWorkspaces: async () => OK,
    async search(query, limit) {
      const needle = query.toLowerCase();
      updateSnapshot({ projection: { ...snapshot.projection, search: { query, results: (snapshot.projection?.sessions ?? []).filter(row => `${row.title} ${row.preview}`.toLowerCase().includes(needle)).slice(0, limit).map(session => ({ session, snippet: session.preview ?? '' })) } } });
      return OK;
    },
    async readWindow({ resource, limit, offset }) {
      if (snapshot.phase !== 'open') return { ok: false, code: 'unavailable', message: '项目连接已关闭。' };
      const requestGeneration = generation;
      const current = () => snapshot.phase === 'open' && requestGeneration === generation;
      const stale = () => ({ ok: false as const, code: 'unavailable', message: '项目连接或来源映射已变化，请重新读取。' });
      const source = projection.sources?.[resource];
      let connectionWarning = '';
      if (mapped(resource)) {
        const answer = await commands.readWindow({ resource, limit, ...(offset === undefined ? {} : { offset }) });
        if (!current()) return stale();
        if (answer.ok) {
          updateSnapshot({ projection: { ...snapshot.projection, transcript: { ...snapshot.projection?.transcript, [resource]: answer.result as TranscriptWindow } }, refusal: '' });
          return answer;
        }
        connectionWarning = `真实会话未连接：${answer.message || '读取被拒绝'} 当前显示已发布历史。`;
      }
      try {
        let window: TranscriptWindow;
        if (source?.kind === 'session') {
          if (source.next !== source.total) throw new Error(`会话正在同步（${source.next}/${source.total} 条）；完成后点击刷新。`);
          const start = offset === undefined ? Math.max(0, source.total - limit) : Math.max(0, Math.min(offset, source.total));
          const end = Math.min(source.total, start + Math.max(1, Math.min(limit, 2000)));
          const chunks = await readSourceChunks(source, start, end, propose);
          const messages = chunks.flatMap(chunk => (JSON.parse(chunk.payload) as RichMessage[]).slice(Math.max(0, start - chunk.offset), Math.min(chunk.count, end - chunk.offset)));
          if (messages.length !== end - start) throw new Error('会话窗口不完整；请重新读取。');
          window = { messages, offset: start, totalMessages: source.total, hasMore: start > 0, rich: true, activity: { state: 'idle' } };
          if (projection.sources?.[resource]?.generation !== source.generation) throw new Error('来源已更新，请刷新会话。');
        } else {
          const current = projection.transcripts?.[resource];
          if (!current) throw new Error('此会话尚未同步正文，请维护 Agent 绑定原始来源。');
          window = current;
        }
        if (!current()) return stale();
        const transcript = { ...snapshot.projection?.transcript, [resource]: window };
        // The controller owns the displayed windows; this adapter retains a bounded transport cache.
        const keys = Object.keys(transcript); for (const key of keys.slice(0, Math.max(0, keys.length - 8))) if (key !== resource) delete transcript[key];
        updateSnapshot({ projection: { ...snapshot.projection, transcript }, refusal: connectionWarning });
        return OK;
      } catch (error) {
        if (!current()) return stale();
        const message = error instanceof Error ? error.message : '来源读取未完成。';
        updateSnapshot({ refusal: message }); return { ok: false, code: 'unavailable', message };
      }
    },
    start: refuse, append: commands.append, resume: commands.resume, takeover: commands.takeover, fallback: refuse,
    interrupt: commands.interrupt, releaseControl: commands.releaseControl, respondInteraction: commands.respondInteraction,
    openTerminal: refuse, readTerminal: refuse, sendTerminal: refuse, closeTerminal: refuse,
    attachFile: commands.attachFile, setFileAnnotations: refuse,
    // These display preferences stay in the shared controller's current page.
    async pin(resource) { const pinned = snapshot.projection?.pinned ?? []; updateSnapshot({ projection: { ...snapshot.projection, pinned: pinned.includes(resource) ? pinned.filter(key => key !== resource) : [...pinned, resource] } }); return OK; },
    async setTitle(resource, title) { updateSnapshot({ projection: { ...snapshot.projection, customTitles: { ...snapshot.projection?.customTitles, [resource]: title } } }); return OK; },
    markReviewed: async () => OK,
  };
  return { port, update(next: ResearchProjection, open: boolean, operations: SessionOperation[] = []) {
    const nextScope = researchSessionScope(next, open);
    if (scope !== nextScope) { scope = nextScope; generation++; snapshot = { phase: 'waiting', projection: null, operations: [], refusal: '' }; }
    projection = next;
    if (!open) { updateSnapshot({ phase: 'closed', projection: null }); return; }
    const live = next.viewer_role === 'owner' && !next.project?.archived ? next.sessionResources : undefined;
    const visible = new Set(registeredLeadAgents(next).map(row => row.session_key));
    const sessions: SessionSummary[] = rows<SessionRow>(next.sessions).filter(row => visible.has(row.session_key)).map(row => ({
      resourceId: row.session_key!, sessionId: row.session_key!, title: row.title,
      cliKind: row.cliKind, deviceLabel: '项目历史', projectLabel: next.project?.title,
      ...(next.source_locations?.sessions[row.session_key!] ? { cwdDisplay: next.source_locations.sessions[row.session_key!]!.cwd } : {}),
      status: 'idle', resumable: false, messageCount: row.messageCount,
      lastActivity: row.lastActivity, sortActivity: row.lastActivity, preview: row.preview,
      ...live?.sessions?.find(liveRow => liveRow.resourceId === row.session_key),
    }));
    updateSnapshot({ phase: open ? 'open' : 'closed', operations, projection: { ...snapshot.projection, sessions, transcript: { ...snapshot.projection?.transcript, ...live?.transcript }, sources: [], resourceState: 'ready' } });
  } };
}

/** A change of binding vocabulary invalidates the shared controller's display caches. */
export function researchSessionScope(projection: ResearchProjection, open: boolean): string {
  return JSON.stringify([open, projection.viewer_role, projection.project?.archived,
    projection.workspace_navigation?.current_ref, projection.source_locations,
    registeredLeadAgents(projection).map(row => row.session_key).sort()]);
}
