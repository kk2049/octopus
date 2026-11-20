import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { classifyContent, isNoiseText, parseSessionText, type Source } from '@claude-bot/plugin-sessions/parse';
export interface ImportDocument {
    path: string;
    display: string;
    kind?: string;
    summary?: string;
}
export interface ImportSession {
    path: string;
    id: string;
    provider: Source;
    title: string;
    association: string;
}
export interface ImportProject {
    key: string;
    title: string;
    instance?: string;
    documents: ImportDocument[];
    sessions: ImportSession[];
    summary?: string;
    archived?: boolean;
    heads?: Array<{
        title: string;
        purpose: string;
        sources: string[];
    }>;
}
export interface ImportPlan {
    version: 1;
    projects: ImportProject[];
}
export interface ImportAction {
    action: string;
    params: Record<string, string>;
}
export interface SourceReceipt {
    source: string;
    digest: string;
    bytes: number;
    messages?: number;
    parts?: number;
    redactions: number;
    status: 'ready' | 'missing' | 'excluded';
    reason?: string;
}
export interface PreparedProject {
    key: string;
    title: string;
    instance?: string;
    archived?: boolean;
    actions: ImportAction[];
    sources: SourceReceipt[];
    summary: {
        documents: number;
        sessions: number;
        messages: number;
        redactions: number;
        missing: number;
    };
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stable = (prefix: string, value: string) => `${prefix}-${sha(value).slice(0, 32)}`;
export function redact(text: string): {
    text: string;
    count: number;
} {
    let count = 0;
    const patterns = [
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
        /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi,
        /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"'`,;]{12,}/gi,
    ];
    for (const pattern of patterns)
        text = text.replace(pattern, () => { count++; return '[REDACTED credential]'; });
    return { text: text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''), count };
}
/** Chunk visible text without truncation, keeping Unicode surrogate pairs intact. */
export function chunks(text: string, limit = 9000): string[] {
    const result: string[] = [];
    for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + limit);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!))
            end--;
        result.push(text.slice(offset, end));
        offset = end;
    }
    return result;
}
export interface ConversationMessage {
    role: string;
    text: string;
    timestamp?: string;
}
/** The existing parser owns metadata/Claude/OMP. Codex's mirrored channels need occurrence-level dedupe for mixed historical logs. */
export function conversation(provider: Source, raw: string): {
    messages: ConversationMessage[];
    excluded?: string;
} {
    if (provider === 'claude' && raw.split(/\r?\n/).slice(0, 40).some(line => { try {
        return JSON.parse(line)?.isSidechain === true;
    }
    catch {
        return false;
    } }))
        return { messages: [], excluded: 'Claude sidechain session' };
    const parsed = parseSessionText(provider, provider === 'codex' ? raw.split('\n', 1)[0]! : raw);
    if (parsed.meta.input_mode === 'parent_owned')
        return { messages: [], excluded: 'provider declares a parent-owned subagent' };
    if (provider !== 'codex')
        return { messages: parsed.messages.filter(m => ['user', 'assistant'].includes(m.role) && m.text.trim()).map(m => ({ role: m.role, text: m.text })) };
    const entries: Array<ConversationMessage & {
        channel: string;
    }> = [];
    for (const line of raw.split(/\r?\n/)) {
        let event: any;
        try {
            event = JSON.parse(line);
        }
        catch {
            continue;
        }
        const p = event?.payload;
        if (!p || typeof p !== 'object')
            continue;
        if (event.type === 'session_meta' && (p.thread_source === 'subagent' || p.source?.subagent))
            return { messages: [], excluded: 'provider declares a subagent' };
        if (event.type === 'event_msg' && ['user_message', 'agent_message'].includes(p.type)) {
            if (typeof p.message === 'string' && p.message.trim() && !isNoiseText(p.message))
                entries.push({ role: p.type === 'user_message' ? 'user' : 'assistant', text: p.message, timestamp: event.timestamp, channel: 'event' });
        }
        if (event.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role) && p.channel !== 'analysis') {
            const text = classifyContent(p.content).text;
            if (text && !isNoiseText(text))
                entries.push({ role: p.role, text, timestamp: event.timestamp, channel: 'item' });
        }
    }
    const mirrors = new Map<string, number>();
    for (const e of entries)
        if (e.channel === 'event') {
            const key = `${e.role}\0${e.text.trim()}`;
            mirrors.set(key, (mirrors.get(key) ?? 0) + 1);
        }
    const messages = entries.filter(e => {
        if (e.channel !== 'item')
            return true;
        const key = `${e.role}\0${e.text.trim()}`;
        const count = mirrors.get(key) ?? 0;
        if (count) {
            mirrors.set(key, count - 1);
            return false;
        }
        return true;
    }).map(({ role, text, timestamp }) => ({ role, text, timestamp }));
    return { messages };
}
function source(path: string): {
    raw: string;
    digest: string;
    bytes: number;
} {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
        throw new Error('not a regular bounded source file');
    const bytes = readFileSync(path);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { raw, digest: sha(bytes), bytes: bytes.length };
}
export function prepareProject(project: ImportProject): PreparedProject {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(project.key) || !Array.isArray(project.documents) || !Array.isArray(project.sessions))
        throw new Error('Invalid project manifest');
    const actions: ImportAction[] = [];
    const sources: SourceReceipt[] = [];
    const add = (action: string, params: Record<string, string>) => actions.push({ action, params });
    const documentRecords: string[] = [];
    const recordBySource = new Map<string, string>();
    for (const document of project.documents) {
        let value: ReturnType<typeof source>;
        try {
            value = source(document.path);
        }
        catch {
            sources.push({ source: document.display, digest: '', bytes: 0, redactions: 0, status: 'missing', reason: 'unavailable, invalid UTF-8 or exceeds 128 MiB' });
            continue;
        }
        const cleaned = redact(value.raw);
        const parts = chunks(cleaned.text, 8000);
        sources.push({ source: document.display, digest: value.digest, bytes: value.bytes, parts: parts.length, redactions: cleaned.count, status: 'ready' });
        const title = (cleaned.text.match(/^#\s+(.+)$/m)?.[1] ?? basename(document.path)).slice(0, 170);
        const publishedKeys = parts.map((_, part) => stable('doc', `${document.display}:${value.digest}:${part}`));
        for (let part = 0; part < parts.length; part++)
            add('publish_document', { document_key: publishedKeys[part]!, path: `${document.display}${parts.length > 1 ? ` · ${part + 1}/${parts.length}` : ''}`, title: `${title}${parts.length > 1 ? ` (${part + 1}/${parts.length})` : ''}`, body: parts[part]!, summary: '已发布来源正文；历史转述不代表系统已取得本人批准。', workspace_key: `source-${project.key}`, workspace_label: project.title });
        const key = stable('source', `${document.display}:${value.digest}`);
        documentRecords.push(key);
        recordBySource.set(document.display, key);
        const kind = document.kind ?? (/USER|INTENT|DECISION|REQUIREMENT/i.test(document.display) ? 'request' : /STATUS|PROGRESS|CURRENT/i.test(document.display) ? 'note' : /REPORT|REVIEW|RESULT|LESSON/i.test(document.display) ? 'claim' : /DESIGN|ROADMAP|PROTOCOL/i.test(document.display) ? 'plan' : 'artifact');
        const body = document.summary ?? `来源摘要（不是全文，也不代表已验收）：\n\n${cleaned.text.slice(0, 700)}\n\n${cleaned.text.length > 1000 ? `…\n\n末尾记录：\n${cleaned.text.slice(-450)}` : ''}\n\n完整正文已发布为 ${parts.length} 段项目文档。`;
        add('research_record', { record: key, kind, title, documents: JSON.stringify(publishedKeys.slice(0, 24)), body: body.slice(0, 5900), source: `${document.display}@sha256:${value.digest}`, origin: 'imported', critical: 'false', tags: JSON.stringify(['imported', project.key]) });
    }
    for (const session of project.sessions) {
        let value: ReturnType<typeof source>;
        try {
            value = source(session.path);
        }
        catch {
            sources.push({ source: `session:${session.id}`, digest: '', bytes: 0, redactions: 0, status: 'missing', reason: 'session source unavailable or too large' });
            continue;
        }
        if (session.path.includes('/subagents/')) {
            sources.push({ source: `session:${session.id}`, digest: value.digest, bytes: value.bytes, redactions: 0, status: 'excluded', reason: 'subagent directory' });
            continue;
        }
        const parsed = conversation(session.provider, value.raw);
        if (parsed.excluded || !parsed.messages.length) {
            sources.push({ source: `session:${session.id}`, digest: value.digest, bytes: value.bytes, redactions: 0, status: 'excluded', reason: parsed.excluded ?? 'no visible conversation messages' });
            continue;
        }
        const key = stable('archive', `${project.key}:${session.id}`);
        let redactions = 0;
        const messages = parsed.messages.flatMap(m => { const clean = redact(m.text); redactions += clean.count; return chunks(clean.text).map(text => ({ role: m.role, text, timestamp: m.timestamp ?? '' })); });
        // Archive-only registration never promotes a session or a historical provider to project leader.
        add('research_register_archive', { provider: session.provider, workspace_key: `source-${project.key}`, workspace_label: project.title, session_key: key, source_session: session.id, title: `${session.title || session.id}`.replace(/\s+/g, ' ').slice(0, 200) });
        for (let offset = 0; offset < messages.length;) {
            const batch: typeof messages = [];
            const start = offset;
            while (offset < messages.length && batch.length < 16 && JSON.stringify([...batch, messages[offset]]).length <= 30000)
                batch.push(messages[offset++]!);
            if (!batch.length)
                throw new Error('message exceeds import envelope');
            add('research_import_chat', { session_key: key, offset: String(start), batch_id: stable('batch', JSON.stringify(batch)), messages_json: JSON.stringify(batch) });
        }
        sources.push({ source: `session:${session.id}`, digest: value.digest, bytes: value.bytes, messages: parsed.messages.length, parts: messages.length, redactions, status: 'ready', reason: session.association });
    }
    const summary = { documents: sources.filter(s => s.status === 'ready' && !s.source.startsWith('session:')).length, sessions: sources.filter(s => s.status === 'ready' && s.source.startsWith('session:')).length, messages: sources.reduce((n, s) => n + (s.messages ?? 0), 0), redactions: sources.reduce((n, s) => n + s.redactions, 0), missing: sources.filter(s => s.status === 'missing').length };
    const importId = stable('onboarding', JSON.stringify(sources.map(s => [s.source, s.digest])));
    add('research_record', { record: importId, kind: 'briefing', title: '回到项目：初始资料接入与待对齐事项', body: `${project.summary ?? '此项目的研究记录已按来源整理。旧结论的有效性与批准尚待本人核对。'}\n\n导入 ${summary.documents} 份文档、${summary.sessions} 个会话、${summary.messages} 条可见对话。${summary.missing} 份来源不可用；凭据脱敏 ${summary.redactions} 处。\n\n本次未启动实验，未推断历史分支的因果关系，未替任何人补记已学习或批准。完整聊天的工具原始输出、内部思考及后台子 agent 已排除。长正文分段保留；来源摘要不等于全文。\n\n建议先学习当前状态与复盘材料，再决定哪些交付进入团队主线。`, source: `manifest:${importId}`, origin: 'imported', links: JSON.stringify(documentRecords.slice(-20).map(target => ({ relation: 'uses', target }))), tags: '["onboarding"]' });
    add('research_fork', { branch: stable('onboarding-branch', project.key), from: importId, title: '历史成果对齐与后续立项', purpose: '核对当前结论、证据和人的要求；确认后再开实验分支。本分支只跟踪资料接入，不启动科研实验。' });
    for (const [index, head] of (project.heads ?? []).entries()) {
        const evidence = head.sources.map(source => { const id = recordBySource.get(source); if (!id)
            throw new Error('Head refers to an unavailable document'); return id; });
        if (!evidence.length || evidence.length > 20)
            throw new Error('An initial research head needs 1–20 explicit sources');
        const record = stable('current-plan', `${importId}:${index}:${head.title}`);
        add('research_record', { record, kind: 'plan', title: head.title, body: `${head.purpose}\n\n这是本次接入整理出的后续对齐方案（infer），来源见证据。不表示历史用户已经批准，也不代表该分支已启动实验。`, origin: 'authored', links: JSON.stringify(evidence.map(target => ({ relation: 'uses', target }))), tags: '["onboarding","next-review"]' });
        add('research_fork', { branch: stable('current-head', `${project.key}:${index}:${head.title}`), from: record, title: head.title, purpose: head.purpose });
    }
    return { key: project.key, title: project.title, ...(project.instance ? { instance: project.instance } : {}), ...(project.archived ? { archived: true } : {}), actions, sources, summary };
}
