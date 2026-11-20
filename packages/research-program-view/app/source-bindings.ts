/** Explicitly published source snapshots. The runtime never reads a path. */
import { assertProjectCapacity } from './research-model.js';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const DIGEST = /^[a-f0-9]{64}$/;
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('来源参数无效');
  return value;
}
function key(value: unknown): string { const out = text(value, 96); if (!KEY.test(out)) throw new Error('来源标识无效'); return out; }
function seat(ctx: any, write: boolean) {
  if (!['owner', 'member', ...(write ? [] : ['viewer'])].includes(ctx.actor?.role)) throw new Error('没有此项目的来源维护权限');
  // Binding existing evidence is archival maintenance, not a restart of research.
  // Frozen projects remain frozen; only their owner can repair their sources.
  if (write && ctx.state?.project?.archived && ctx.actor?.role !== 'owner') throw new Error('归档项目只能由 Owner 维护来源');
  if (write) assertProjectCapacity(ctx.state);
}
function event(ctx: any, type: string, data: any, result: any = {}) { return { events: [{ type, data, at: ctx.now ?? '', by: 'research-program' }], result }; }
function source(ctx: any, p: any) {
  const id = key(p.source_key);
  const row = ctx.state?.sources?.[id];
  if (!row || row.generation !== p.generation) throw new Error('来源版本已变化，请重新读取项目状态');
  return row;
}

export function research_bind_source(ctx: any, p: any) {
  seat(ctx, true);
  const sourceKey = key(p.source_key);
  const generation = text(p.generation, 64);
  if (!DIGEST.test(generation)) throw new Error('generation 必须是来源内容的 SHA-256');
  const previous = ctx.state?.sources?.[sourceKey];
  const encoding = p.encoding || 'text';
  if (!['text', 'png-base64'].includes(encoding) || encoding !== 'text' && p.kind !== 'document') throw new Error('来源编码无效');
  if (previous?.generation === generation) {
    if (previous.kind !== p.kind || previous.total !== Number(p.total) || previous.source_ref !== p.source_ref || (previous.encoding || 'text') !== encoding) throw new Error('相同版本不能改变来源身份或长度');
    const title = text(p.title, 200), reason = text(p.reason, 500);
    if (previous.title !== title || previous.reason !== reason || previous.hidden) return event(ctx, 'research_source_labeled', { source_key: sourceKey, title, reason, hidden: false }, { next: previous.next, complete: previous.next === previous.total });
    return { events: [], result: { duplicate: true, next: previous.next, complete: previous.next === previous.total } };
  }
  if ((previous?.generation ?? '') !== (p.expected_generation ?? '')) throw new Error('来源版本已变化，请读取后再同步');
  if (!['session', 'document'].includes(p.kind)) throw new Error('来源类型无效');
  if (previous && previous.kind !== p.kind) throw new Error('来源类型不能变化');
  const total = Number(p.total);
  if (!Number.isSafeInteger(total) || total < 0 || total > 2_000_000) throw new Error('来源长度超出范围');
  if (!previous && Object.keys(ctx.state?.sources ?? {}).length >= 1200) throw new Error('来源目录已满');
  const provider = p.kind === 'session' ? text(p.provider, 16) : '';
  if (provider && !['codex', 'codex-runner', 'claude', 'omp', 'other'].includes(provider)) throw new Error('历史 provider 无效');
  const data = { source_key: sourceKey, kind: p.kind, generation, total, provider, encoding,
    title: text(p.title, 200), source_ref: text(p.source_ref, 320),
    reason: text(p.reason, 500), next: 0, ranges: [] };
  return event(ctx, 'research_source_bound', data, { source_key: sourceKey, next: 0, complete: total === 0 });
}

/** One bounded source chunk. Duplicate receipts are checked against exact content. */
export function research_publish_source(ctx: any, p: any) {
  seat(ctx, true);
  const row = source(ctx, p);
  const offset = Number(p.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('来源偏移无效');
  const payload = text(p.payload, 32000, true);
  if (!payload.length) throw new Error('来源分段不能为空');
  const fragment = p.fragment_total !== undefined && p.fragment_total !== '';
  const fragmentOffset = fragment ? Number(p.fragment_offset) : undefined;
  if (ctx.state.source_last?.key === p.source_key && ctx.state.source_last?.generation === row.generation && ctx.state.source_last?.offset === offset && ctx.state.source_last?.fragment_offset === fragmentOffset && ctx.state.source_last?.fragment_total === (fragment ? Number(p.fragment_total) : undefined) && ctx.state.source_last?.payload === payload) return { events: [], result: { duplicate: true, next: row.next, fragment_next: fragment ? fragmentOffset! + payload.length : undefined, complete: row.next === row.total } };
  if (row.next !== offset) throw new Error(`来源偏移已变化，请从 ${row.next} 继续`);
  if (fragment) {
    // A single native message can exceed the transport envelope. The payload
    // is a slice of its serialized JSON array; the reader validates the joined
    // message before exposing it to the shared typed session port.
    const total = Number(p.fragment_total);
    if (row.kind !== 'session' || !Number.isSafeInteger(total) || total < 1 || total > 4_194_304 || !Number.isSafeInteger(fragmentOffset) || fragmentOffset! < 0 || fragmentOffset! + payload.length > total) throw new Error('长消息分段范围无效');
    if (offset >= row.total || fragmentOffset !== (row.partial?.next ?? 0) || row.partial && row.partial.total !== total) throw new Error('长消息分段偏移已变化，请读取来源状态');
    const next = fragmentOffset! + payload.length;
    const count = next === total ? 1 : 0;
    return event(ctx, 'research_source_published', { source_key: p.source_key, generation: row.generation, offset, count, payload, fragment_offset: fragmentOffset, fragment_total: total }, { next: offset + count, fragment_next: next, complete: offset + count === row.total });
  }
  if (row.partial) throw new Error('请先完成当前长消息分段');
  let count: number;
  if (row.kind === 'session') {
    const messages = JSON.parse(payload);
    if (!Array.isArray(messages) || !messages.length || messages.length > 64) throw new Error('会话分段必须包含 1–64 条消息');
    for (const message of messages) {
      if (!message || Object.keys(message).some(k => !['role', 'timestamp', 'blocks'].includes(k)) || !['user', 'assistant', 'system'].includes(message.role) || !Array.isArray(message.blocks)) throw new Error('会话消息格式无效');
      if (message.timestamp !== undefined) text(message.timestamp, 80, true);
      for (const block of message.blocks) {
        if (!block || !['text', 'thinking', 'tool'].includes(block.type) || Object.keys(block).some(k => !['type', 'text', 'tool', 'input', 'output', 'is_error', 'truncated', 'bilingual', 'translation_error'].includes(k))) throw new Error('会话内容块格式无效');
        for (const field of ['text', 'tool', 'input', 'output', 'translation_error']) if (block[field] !== undefined && block[field] !== null) text(block[field], 32000, true);
        for (const field of ['is_error', 'truncated']) if (block[field] !== undefined && typeof block[field] !== 'boolean') throw new Error('会话内容块标记无效');
        if (block.bilingual !== undefined) {
          if (!block.bilingual || Object.keys(block.bilingual).some(k => !['zh', 'en'].includes(k))) throw new Error('双语内容格式无效');
          text(block.bilingual.zh, 30000, true); text(block.bilingual.en, 30000, true);
        }
      }
    }
    count = messages.length;
  } else {
    if (row.encoding === 'png-base64' && (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.includes('=') && offset + payload.length !== row.total)) throw new Error('PNG 来源分段编码无效');
    count = payload.length;
  }
  if (offset + count > row.total) throw new Error('来源分段超过声明长度');
  return event(ctx, 'research_source_published', { source_key: p.source_key, generation: row.generation, offset, count, payload }, { next: offset + count, complete: offset + count === row.total });
}

export function research_read_source(ctx: any, p: any) {
  seat(ctx, false);
  const row = source(ctx, p);
  if (!ctx.history) throw new Error('当前部署不支持来源分页');
  const chunks = ctx.history.events.filter((e: any) => e.type === 'research_source_published' && e.data?.source_key === p.source_key && e.data?.generation === row.generation)
    .map((e: any) => ({ seq: e.seq, ...e.data }));
  return { events: [], result: { chunks, cursor: ctx.history.cursor, head: ctx.history.head, complete: row.next === row.total } };
}

/** Compact MCP status remains usable when the full projection exceeds its transport cap. */
export function research_source_status(ctx: any, p: any) {
  seat(ctx, false);
  if (p.source_key) {
    const row = ctx.state?.sources?.[key(p.source_key)] ?? null;
    return { events: [], result: { source: row } };
  }
  const cursor = text(p.cursor ?? '', 96, true);
  const rows = Object.values(ctx.state?.sources ?? {}).sort((a: any, b: any) => a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0) as any[];
  const page = rows.filter(row => row.source_key > cursor).slice(0, 20);
  return { events: [], result: { project: ctx.state?.project, lead_agent: ctx.state?.lead_agent, lead_document: ctx.state?.lead_document, source_locations: ctx.state?.source_locations ?? null,
    total: rows.length, sources: page.map(({ ranges: _ranges, ...row }) => row), next_cursor: page.length === 20 ? page.at(-1).source_key : null } };
}
export function research_unbind_source(ctx: any, p: any) {
  seat(ctx, true);
  const row = source(ctx, p);
  if (ctx.state?.lead_agent?.session_key === p.source_key || ctx.state?.lead_document?.document_key === p.source_key) throw new Error('请先选择新的默认 Agent 或文档再解除绑定');
  return event(ctx, 'research_source_labeled', { source_key: p.source_key, title: row.title, reason: text(p.reason, 500), hidden: true });
}

export function foldSources(state: any, event: any): boolean {
  state.sources ??= {};
  const data = event.data ?? {};
  if (event.type === 'research_source_labeled') {
    const source = state.sources[data.source_key]; if (!source) return true;
    Object.assign(source, { title: data.title, reason: data.reason, hidden: data.hidden, updated_at: event.at });
    const row = source.kind === 'session' ? state.sessions.find((s: any) => s.session_key === data.source_key) : state.documents.find((d: any) => d.key === data.source_key);
    if (row) Object.assign(row, { title: data.title, hidden: data.hidden });
    return true;
  }
  if (event.type === 'research_source_bound') {
    state.sources[data.source_key] = { ...data, updated_at: event.at };
    if (data.kind === 'session') {
      let session = state.sessions.find((s: any) => s.session_key === data.source_key);
      if (!session) { session = { session_key: data.source_key, resourceId: data.source_key, archive_only: true }; state.sessions.push(session); }
      Object.assign(session, { source_key: data.source_key, title: data.title, cliKind: data.provider, curated: true, hidden: false, messageCount: 0, lastActivity: event.at });
      delete state.transcripts[data.source_key];
    } else {
      let doc = state.documents.find((d: any) => d.key === data.source_key);
      if (!doc) { doc = { key: data.source_key }; state.documents.push(doc); }
      Object.assign(doc, { source_key: data.source_key, title: data.title, path: data.source_ref, body: '', hidden: false, updated_at: event.at, updated_seq: event.seq });
    }
    return true;
  }
  if (event.type === 'research_source_published') {
    const row = state.sources[data.source_key];
    if (!row || row.generation !== data.generation || row.next !== data.offset) return true;
    row.ranges.push([event.seq, data.offset, data.fragment_total ? 1 : data.count]);
    row.next += data.count;
    if (data.fragment_total && !data.count) row.partial = { offset: data.offset, next: data.fragment_offset + data.payload.length, total: data.fragment_total };
    else delete row.partial;
    row.updated_at = event.at;
    // Only the last chunk is held for exact idempotency, outside the public view.
    state.source_last = { key: data.source_key, generation: data.generation, offset: data.offset, payload: data.payload, ...(data.fragment_total ? { fragment_offset: data.fragment_offset, fragment_total: data.fragment_total } : {}) };
    if (row.kind === 'session') {
      const session = state.sessions.find((s: any) => s.session_key === data.source_key);
      if (session) { session.messageCount = row.next; session.lastActivity = data.fragment_total ? event.at : JSON.parse(data.payload).at(-1)?.timestamp || event.at; }
    }
    return true;
  }
  return false;
}
