import { assertProjectCapacity, approvals, emptyResearch, latestAttestation, RECORD_KINDS, TRANSITIONS, type ResearchRecord, type ResearchState, type WorkStatus } from './research-model.js';
interface Context {
    now?: string;
    actor?: {
        kind?: string;
        user?: string;
        agent?: string;
        role?: string;
    };
    state?: {
        project?: {
            archived?: boolean;
        };
        research?: ResearchState;
        sessions?: Array<{session_key: string; last_message_seq?: number}>;
        documents?: Array<{
            key: string;
            title: string;
            updated_seq?: number;
            first_published_seq?: number;
        }>;
    };
    history?: {
        events: any[];
        cursor: number;
        hasMore: boolean;
        head: number;
    };
}
type Params = Record<string, unknown>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const RELATIONS = ['derived_from', 'supports', 'contradicts', 'supersedes', 'uses', 'produces', 'requested_by'];
export function researchState(ctx: Context): ResearchState { return ctx.state?.research ?? emptyResearch(); }
function seat(ctx: Context, write = true, human = false) {
    if (!['owner', 'member', ...(write ? [] : ['viewer'])].includes(ctx.actor?.role ?? ''))
        throw new Error('没有此项目的操作角色');
    if (write)
        assertProjectCapacity(ctx.state);
    if (write && ctx.state?.project?.archived)
        throw new Error('项目已归档');
    if (human && (ctx.actor?.kind !== 'user' || !ctx.actor.user))
        throw new Error('必须由本人明确回复');
}
function str(p: Params, name: string, max: number, optional = false): string {
    const value = p[name] ?? '';
    if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
        throw new Error(`${name} 无效`);
    return value.trim();
}
function id(p: Params, name: string, optional = false) { const value = str(p, name, 96, optional); if ((value || !optional) && !ID.test(value))
    throw new Error(`${name} 无效`); return value; }
function list(p: Params, name: string, max = 24): string[] {
    const raw = str(p, name, 2600, true);
    const value = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || !ID.test(x)) || new Set(value).size !== value.length)
        throw new Error(`${name} 必须是唯一 ID 数组`);
    return value;
}
function known(state: ResearchState, key: string) { const row = state.records.find(r => r.id === key); if (!row)
    throw new Error(`记录不存在: ${key}`); return row; }
function branch(state: ResearchState, p: Params) { const row = state.branches.find(r => r.id === id(p, 'branch')); if (!row)
    throw new Error('分支不存在'); return row; }
function fresh(state: ResearchState, key: string) { if (state.records.some(r => r.id === key))
    throw new Error('记录 ID 已存在；请查询已有提交，勿重复发布'); }
function head(row: {
    head: string;
}, p: Params) { if (row.head !== id(p, 'expected_head', true))
    throw new Error('分支 head 已变化，请阅读新提交后重新操作'); }
function event(ctx: Context, type: string, data: unknown, result: unknown = {}) { return { events: [{ type, data, at: ctx.now ?? '', by: 'research-program' }], result }; }
function room(state: ResearchState, data: unknown) {
    // Refuse before exhausting the IPC budget. Never silently evict authoritative DAG nodes.
    if (state.records.length >= 1200 || JSON.stringify(state).length + JSON.stringify(data).length > 420000)
        throw new Error('项目索引容量已满；历史完整保留，请扩容项目索引后继续');
}
function requireRefs(state: ResearchState, ids: string[]) { ids.forEach(key => known(state, key)); }
export function research_record(ctx: Context, p: Params) {
    seat(ctx);
    const state = researchState(ctx);
    const key = id(p, 'record');
    fresh(state, key);
    const kind = str(p, 'kind', 24);
    if (!(RECORD_KINDS as readonly string[]).includes(kind) || kind === 'delivery')
        throw new Error('记录类型无效；交付使用 research_deliver');
    const parents = list(p, 'parents', 8);
    requireRefs(state, parents);
    const links = JSON.parse(str(p, 'links', 4000, true) || '[]');
    if (!Array.isArray(links) || links.length > 24 || links.some(l => !l || Object.keys(l).some(k => !['relation', 'target'].includes(k)) || !RELATIONS.includes(l.relation) || !ID.test(l.target)))
        throw new Error('证据关系无效');
    requireRefs(state, links.map(l => l.target));
    const origin = str(p, 'origin', 16, true) || 'authored';
    if (!['authored', 'imported'].includes(origin))
        throw new Error('来源类型无效');
    const critical = str(p, 'critical', 5, true) || 'false';
    if (!['true', 'false'].includes(critical))
        throw new Error('critical 无效');
    const documents = list(p, 'documents').map(key => {
        const document = ctx.state?.documents?.find(d => d.key === key);
        if (!document)
            throw new Error('来源文档尚未发布');
        return { key, title: document.title, seq: document.updated_seq ?? document.first_published_seq ?? 0 };
    });
    const data = { id: key, kind, documents, title: str(p, 'title', 200), body: str(p, 'body', 6000), parents, links,
        source: str(p, 'source', 500, true), source_level: origin === 'imported' ? 'imported' : ctx.actor?.kind === 'user' ? kind === 'request' ? 'user_direct' : 'human_authored' : 'infer',
        critical: critical === 'true' || kind === 'decision' || links.some(l => l.relation === 'supersedes' && known(state, l.target).critical), tags: list(p, 'tags', 12) };
    room(state, data);
    return event(ctx, 'research_recorded', data, { record: key });
}
export function research_fork(ctx: Context, p: Params) {
    seat(ctx);
    const state = researchState(ctx);
    const key = id(p, 'branch');
    if (state.branches.some(r => r.id === key) || state.branches.length >= 128)
        throw new Error('分支已存在或数量达上限');
    const from = id(p, 'from', true);
    if (from)
        known(state, from);
    const data = { id: key, title: str(p, 'title', 200), purpose: str(p, 'purpose', 1200), base: state.main, head: from, status: 'proposed', delivery: '', review_main: '', reason: '' };
    room(state, data);
    return event(ctx, 'research_forked', data, { branch: key });
}
export function research_advance(ctx: Context, p: Params) {
    seat(ctx);
    const state = researchState(ctx);
    const row = branch(state, p);
    head(row, p);
    if (row.status !== 'active')
        throw new Error('只有推进中的分支可以提交新 head');
    const record = known(state, id(p, 'record'));
    if (record.id === row.head || (row.head && !record.parents.includes(row.head)))
        throw new Error('新提交必须直接延伸当前 head');
    return event(ctx, 'research_advanced', { branch: row.id, head: record.id, reason: str(p, 'reason', 500) });
}
export function research_transition(ctx: Context, p: Params) {
    seat(ctx);
    const state = researchState(ctx);
    const row = branch(state, p);
    if (str(p, 'expected_status', 24) !== row.status)
        throw new Error('分支状态已变化');
    const next = str(p, 'status', 24) as WorkStatus;
    if (!TRANSITIONS[row.status]?.includes(next))
        throw new Error('不允许此状态转移；交付与合入使用专门动作');
    return event(ctx, 'research_transitioned', { branch: row.id, status: next, reason: str(p, 'reason', 1200) });
}
export function research_deliver(ctx: Context, p: Params) {
    seat(ctx);
    const state = researchState(ctx);
    const row = branch(state, p);
    head(row, p);
    if (!['active', 'review'].includes(row.status) || !row.head)
        throw new Error('需要有提交的推进中分支，或对主线变化重新交付');
    const key = id(p, 'record');
    fresh(state, key);
    const evidence = list(p, 'evidence');
    if (!evidence.length)
        throw new Error('交付必须引用已登记的证据');
    requireRefs(state, evidence);
    const body = ['结论', '复现办法', '局限与负结果', '请人判断'].map((heading, i) => `## ${heading}\n${str(p, ['summary', 'reproduce', 'limitations', 'question'][i]!, 1400)}`).join('\n\n');
    const record = { id: key, kind: 'delivery', title: str(p, 'title', 200), body, parents: row.status === 'review' ? known(state, row.delivery).parents : [row.head], links: [...evidence.map(target => ({ relation: 'uses', target })), ...(row.status === 'review' ? [{ relation: 'supersedes', target: row.delivery }] : [])], source: '', source_level: 'infer', critical: true, tags: [] };
    room(state, record);
    return event(ctx, 'research_delivered', { branch: row.id, record, main: state.main }, { record: key });
}
export function research_request_confirmation(ctx: Context, p: Params) {
    seat(ctx);
    const state = researchState(ctx);
    const target = id(p, 'record');
    known(state, target);
    const key = id(p, 'request');
    if (state.confirmations.some(r => r.id === key) || state.confirmations.length >= 512)
        throw new Error('确认请求已存在或达上限');
    const data = { id: key, target, question: str(p, 'question', 1200) };
    room(state, data);
    return event(ctx, 'research_confirmation_requested', data);
}
export function research_attest(ctx: Context, p: Params) {
    seat(ctx, true, true);
    const state = researchState(ctx);
    const target = id(p, 'record');
    const record = known(state, target);
    const kind = str(p, 'kind', 20);
    if (!['understood', 'approve', 'reject', 'disagree', 'withdraw'].includes(kind))
        throw new Error('确认类型无效');
    const main = id(p, 'main', true);
    if (kind === 'approve' && record.kind === 'delivery') {
        const row = state.branches.find(r => r.delivery === target && r.status === 'review');
        if (!row || row.review_main !== main || state.main !== main)
            throw new Error('交付或主线已改变，请重新审阅');
        if (!latestAttestation(state, target, `user:${ctx.actor!.user}`, ['understood']))
            throw new Error('请先明确确认已理解此版本');
    }
    const data = { target, kind, main, response: str(p, 'response', 1200) };
    room(state, data);
    return event(ctx, 'research_attested', data);
}
function ancestors(state: ResearchState, start: string, stop: string): ResearchRecord[] {
    const seen = new Set<string>();
    const stack = [start];
    const out: ResearchRecord[] = [];
    while (stack.length) {
        const id = stack.pop()!;
        if (!id || id === stop || seen.has(id))
            continue;
        seen.add(id);
        const node = known(state, id);
        out.push(node);
        stack.push(...node.parents, ...node.links.filter(l => !['contradicts', 'supersedes'].includes(l.relation)).map(l => l.target));
    }
    return out;
}
export function research_merge(ctx: Context, p: Params) {
    seat(ctx);
    const state = researchState(ctx);
    const row = branch(state, p);
    head(row, p);
    if (state.main !== id(p, 'expected_main', true) || row.review_main !== state.main)
        throw new Error('主线已前移；请重新交付并取得明确验收');
    if (row.status !== 'review' || row.delivery !== row.head)
        throw new Error('分支尚未交付待审');
    if (!approvals(state, row.delivery, state.main).some(a => latestAttestation(state, row.delivery, a.by, ['understood'])))
        throw new Error('需要同一真人学习并明确批准当前交付');
    const closure = [...new Map([...ancestors(state, row.head, ''), ...ancestors(state, state.main, '')].map(record => [record.id, record])).values()];
    const replacedHere = new Set(closure.flatMap(n => n.links.filter(l => l.relation === 'supersedes').map(l => l.target)));
    const replacedAnywhere = new Set(state.records.flatMap(n => n.links.filter(l => l.relation === 'supersedes').map(l => l.target)));
    if (closure.some(n => replacedAnywhere.has(n.id) && !replacedHere.has(n.id)))
        throw new Error('依据已被新记录替代；请更新交付与证据后再验收');
    const critical = closure.filter(n => n.critical && !replacedHere.has(n.id));
    if (critical.some(n => !approvals(state, n.id).length))
        throw new Error('存在尚未明确批准或已撤回的关键判断');
    const key = id(p, 'record');
    fresh(state, key);
    const record = { id: key, kind: 'note', title: `合入 ${row.title}`, body: str(p, 'reason', 1200), parents: [...new Set([state.main, row.head].filter(Boolean))], links: [], source: '', source_level: 'infer', critical: false, tags: ['merge'] };
    room(state, record);
    return event(ctx, 'research_merged', { branch: row.id, record }, { main: key });
}
export function research_mark_seen(ctx: Context, p: Params) {
    seat(ctx, false, true);
    const state = researchState(ctx);
    const value = Number(str(p, 'through', 12));
    if (!Number.isSafeInteger(value) || value < 0 || value > state.revision)
        throw new Error('已读水位无效');
    return event(ctx, 'research_seen', { through: value });
}
export function research_query(ctx: Context, p: Params) {
    seat(ctx, false);
    const state = researchState(ctx);
    const kind = str(p, 'kind', 24, true);
    const query = str(p, 'query', 200, true).toLowerCase();
    const author = str(p, 'author', 160, true);
    const target = id(p, 'target', true);
    const offset = Number(str(p, 'cursor', 8, true) || 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('分页游标无效');
    const since = str(p, 'since', 40, true);
    if (since && !Number.isFinite(Date.parse(since)))
        throw new Error('since 必须是 ISO 时间');
    const relation = str(p, 'relation', 24, true);
    if (relation && !RELATIONS.includes(relation))
        throw new Error('relation 无效');
    const matches = state.records.filter(r => (!since || Date.parse(r.at) >= Date.parse(since)) && (!relation || r.links.some(l => l.relation === relation && (!target || l.target === target))) && (!kind || r.kind === kind) && (!author || r.by === author || r.origin_by === author) && (!target || r.id === target || r.parents.includes(target) || r.links.some(l => l.target === target)) && (!query || `${r.title}\n${r.body}\n${r.tags.join(' ')}`.toLowerCase().includes(query)));
    return { events: [], result: { records: matches.slice(offset, offset + 20), total: matches.length, next_cursor: offset + 20 < matches.length ? String(offset + 20) : null } };
}
/** Trusted history pages contain ONLY the already-authorized App's own stream. */
export function research_read_history(ctx: Context, p: Params) {
    seat(ctx, false);
    if (!ctx.history)
        throw new Error('此部署尚不支持历史分页');
    const session = id(p, 'session', true);
    const document = id(p, 'document', true);
    const events = ctx.history.events.filter(row => session ? ['chat_message_published', 'chat_message_imported'].includes(row.type) && row.data?.session_key === session : document ? row.type === 'document_published' && row.data?.document_key === document : (row.type.startsWith('research_') && !['research_queried', 'research_seen', 'research_history_read'].includes(row.type) || row.type === 'sys_agent_inbox' && row.data?.to === 'secretary')).map(row => row.type === 'sys_agent_inbox' ? { seq: row.seq, type: 'secretary_question', at: row.at, by: row.by, data: { text: row.data.text } } : row);
    const last = session ? ctx.state?.sessions?.find(row => row.session_key === session)?.last_message_seq
      : document ? ctx.state?.documents?.find(row => row.key === document)?.updated_seq : undefined;
    return { events: [], result: { events, cursor: ctx.history.cursor, has_more: ctx.history.hasMore && (last === undefined || ctx.history.cursor < last), head: ctx.history.head } };
}
/** Quote an authenticated person's exact input; the secretary cannot rewrite it as a human requirement. */
export function research_capture_requirement(ctx: Context, p: Params) {
    seat(ctx);
    const state = researchState(ctx);
    const key = id(p, 'record');
    fresh(state, key);
    const source = ctx.history?.events[0];
    const userInput = source?.type === 'sys_agent_inbox' && source.data?.to === 'secretary'
        || source?.type === 'chat_message_published' && source.data?.role === 'user';
    if (!source || !userInput || typeof source.by !== 'string' || !source.by.startsWith('user:') || typeof source.data?.text !== 'string')
        throw new Error('需要可信历史中的真人原始输入，不能使用导入角色或 Agent 转述');
    if (source.data.text.length > 6000)
        throw new Error('原始输入太长，请保留原文并以 infer 记录解释，不截取后伪称完整要求');
    const record = { id: key, kind: 'request', title: str(p, 'title', 200), body: source.data.text, parents: [], links: [], documents: [], source: `event:${source.seq}`, source_level: 'user_direct', origin_by: source.by, title_inferred: true, critical: p.critical === 'true', tags: [] };
    room(state, record);
    return event(ctx, 'research_recorded', record, { record: key });
}
