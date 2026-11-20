import { useEffect, useRef, useState } from 'react';
import { AgentChat } from '@claude-bot/agent-sessions-view';
import { Markdown } from '@claude-bot/agent-view-react/ui';
import type { TranscriptWindow } from '@claude-bot/agent-sessions-contract';
import { useResearchProgram } from './runtime.js';
type HistoryEvent = {
    seq: number;
    type: string;
    at: string;
    by: string;
    data: {
        role?: string;
        text?: string;
        source_at?: string;
        body?: string;
        title?: string;
    };
};
interface HistoryPage {
    events: HistoryEvent[];
    cursor: number;
    has_more: boolean;
    head: number;
}
/** Explicit, single-flight reads; one page stays mounted without retaining an unbounded transcript. */
export function ResearchHistory({ session, document, start = 0, onClose }: {
    session?: string;
    document?: string;
    start?: number;
    onClose(): void;
}) {
    const { propose, channelOpen, projection } = useResearchProgram();
    const [page, setPage] = useState<HistoryPage | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [cursors, setCursors] = useState<number[]>([]);
    const current = useRef(start);
    const flight = useRef(false);
    const generation = useRef(0);
    useEffect(() => { generation.current++; flight.current = false; setBusy(false); return () => { generation.current++; }; }, [session, document, channelOpen]);
    async function read(cursor: number, backwards = false) {
        if (!channelOpen || flight.current)
            return;
        flight.current = true;
        setBusy(true);
        setError('');
        const mine = generation.current;
        try {
            const reply = await propose('research_read_history', { after_seq: String(cursor), ...(session ? { session } : {}), ...(document ? { document } : {}) });
            if (mine !== generation.current)
                return;
            if (!reply.ok) {
                setError(reply.message || '历史读取被拒绝');
                return;
            }
            const value = reply.result as HistoryPage;
            if (!value || !Array.isArray(value.events) || !Number.isSafeInteger(value.cursor)) {
                setError('历史页格式不可用');
                return;
            }
            if (backwards)
                setCursors(items => items.slice(0, -1));
            else if (page)
                setCursors(items => [...items, current.current]);
            current.current = cursor;
            setPage(value);
        }
        catch {
            if (mine === generation.current)
                setError('历史读取失败；可手动重试。');
        }
        finally {
            if (mine === generation.current) {
                flight.current = false;
                setBusy(false);
            }
        }
    }
    const provider = projection.sessions?.find(row => row.session_key === session)?.cliKind ?? 'other';
    const transcript: TranscriptWindow | null = page && session ? { sessionId: session, rich: true, cliKind: provider, offset: 0, nextOffset: null, totalMessages: page.events.length, hasMore: false, truncated: false,
        messages: page.events.map(row => ({ role: row.data.role === 'user' || row.data.role === 'system' ? row.data.role : 'assistant', timestamp: row.type === 'chat_message_imported' ? row.data.source_at ?? '' : row.at, blocks: [{ type: 'text', text: row.data.text ?? '' }] })), activity: null, runtime: null } : null;
    return <section className="research-program__archive" role="dialog" aria-label="完整发布历史"><header><strong>完整发布历史</strong><button onClick={onClose} aria-label="关闭完整历史">×</button></header><p>从事件原文分页读取；导入记录保留已知来源时间；缺失时间留空，消息角色不代表人类批准。</p><div className="research-program__archive-actions">{!page ? <button disabled={busy || !channelOpen} onClick={() => void read(start)}>读取第一段</button> : <><button disabled={busy || !channelOpen || !cursors.length} onClick={() => void read(cursors.at(-1)!, true)}>上一段</button><span>事件 {current.current + 1}–{page.cursor} / {page.head}</span><button disabled={busy || !channelOpen || !page.has_more} onClick={() => void read(page.cursor)}>下一段</button></>}{busy && <span role="status">读取中…</span>}</div>{error && <p role="alert">{error}</p>}{page?.events.length === 0 && <p>这一段没有匹配记录，可继续读取下一段。</p>}{session && transcript && <AgentChat domIdScope={`archive-${session}`} session={{ resourceId: session, sessionId: session, cliKind: provider, title: '原始会话历史', status: 'idle', resumable: false }} transcript={transcript} transcriptStatus={undefined} transcriptBusy={busy} draft="" onDraftChange={() => { }} onSend={() => { }} onRefresh={() => void read(current.current)} onLoadOlder={() => { }} onPin={() => { }}/>}{document && page?.events.map(row => <article key={row.seq}><header><strong>{row.data.title}</strong><small>{row.at} · {row.by}</small></header><Markdown>{row.data.body ?? ''}</Markdown></article>)}</section>;
}
