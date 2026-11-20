import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useProposals } from '@claude-bot/agent-view-react';
import { Markdown } from '@claude-bot/agent-view-react/ui';
import { useResearchProgram } from './runtime.js';
import { formatTime } from './model.js';
import { judgmentNames, kindNames, newResearchId, originNames, stateNames, type BranchView, type RecordView } from './research-types.js';
import './styles/research-workbench.css';
import { ResearchHistory } from './ResearchHistory.js';
type Field = {
    key: string;
    label: string;
    value?: string;
    max?: number;
    options?: {
        value: string;
        label: string;
    }[];
    multiline?: boolean;
    multiple?: boolean;
    optional?: boolean;
};
type Command = {
    action: string;
    title: string;
    params: Record<string, string>;
    fields: Field[];
};
export function ResearchWorkbench() {
    const { projection, propose, channelOpen } = useResearchProgram();
    const research = projection.research;
    const [tab, setTab] = useState('overview');
    const [selected, setSelected] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [kind, setKind] = useState('');
    const [author, setAuthor] = useState('');
    const [command, setCommand] = useState<Command | null>(null);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [prompt, setPrompt] = useState('');
    const [sourceDocument, setSourceDocument] = useState<{
        key: string;
        seq: number;
    } | null>(null);
    const [archive, setArchive] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const [pending, setPending] = useState(false);
    const busy = useRef(false);
    const generation = useRef(0);
    const { proposals, dismiss } = useProposals();
    useEffect(() => { generation.current++; busy.current = false; setPending(false); return () => { generation.current++; }; }, [channelOpen]);
    const records = research?.records ?? [];
    const branches = research?.branches ?? [];
    const selectedRecord = records.find(r => r.id === selected);
    const selectedBranch = branches.find(b => b.head === selected || b.delivery === selected);
    const writable = channelOpen && research?.controls.can_write === true && !projection.project?.archived;
    const canAttest = writable && research?.controls.can_attest;
    const filtered = useMemo(() => records.filter(r => (!kind || r.kind === kind) && (!author || r.by === author || r.origin_by === author) && (!query || `${r.title} ${r.body} ${r.tags.join(' ')} ${r.id}`.toLowerCase().includes(query.toLowerCase()))).reverse(), [records, kind, author, query]);
    const pendingReviews = branches.filter(b => b.status === 'review');
    const unseen = records.filter(r => r.seq > (research?.seen_through ?? 0));
    async function submit(action: string, params: Record<string, string>) {
        if (busy.current || !channelOpen)
            return false;
        const mine = generation.current;
        busy.current = true;
        setPending(true);
        setNotice('正在提交…');
        for (const row of proposals)
            if (row.action === action && row.phase === 'refused')
                dismiss(row.rid);
        try {
            const reply = await propose(action, params);
            if (generation.current !== mine)
                return false;
            setNotice(reply.ok ? '已提交，等待项目状态确认。' : reply.message || '操作被拒绝，输入已保留。');
            return reply.ok;
        }
        catch {
            if (generation.current === mine)
                setNotice('通道请求失败，输入已保留。');
            return false;
        }
        finally {
            if (generation.current === mine) {
                busy.current = false;
                setPending(false);
            }
        }
    }
    function select(id: string) { setSelected(id); }
    function openFork(from = research?.main ?? '') {
        setCommand({ action: 'research_fork', title: '开一个研究分支', params: { branch: newResearchId('branch'), from }, fields: [
                { key: 'title', label: '分支名称', max: 200 }, { key: 'purpose', label: '为什么值得探索？谁提出了这个问题？', multiline: true, max: 1200 },
            ] });
    }
    function openRecord(branch?: BranchView) {
        setCommand({ action: 'research_record', title: '留下一个可追溯的研究提交', params: { record: newResearchId('record'), parents: JSON.stringify(branch?.head ? [branch.head] : selected ? [selected] : []), origin: 'authored' }, fields: [
                { key: 'kind', label: '记录类型', value: 'note', options: Object.entries(kindNames).filter(([id]) => id !== 'delivery').map(([value, label]) => ({ value, label })) },
                { key: 'title', label: '标题', max: 200 }, { key: 'body', label: '内容、证据、适用范围与未知事项', multiline: true, max: 6000 },
                { key: 'source', label: '原始来源 / Git SHA / 数据摘要', max: 500, optional: true },
                { key: 'critical', label: '是否需要真人明确判断', options: [{ value: 'false', label: '普通记录' }, { value: 'true', label: '关键事项' }] },
            ] });
    }
    function transition(branch: BranchView, status: string) {
        setCommand({ action: 'research_transition', title: `${branch.title} · ${stateNames[status]}`, params: { branch: branch.id, expected_status: branch.status, status }, fields: [{ key: 'reason', label: '原因与接下来需要什么', multiline: true, max: 1200 }] });
    }
    function deliver(branch: BranchView) {
        setCommand({ action: 'research_deliver', title: '准备一份可学习、可验收的交付', params: { branch: branch.id, expected_head: branch.head, record: newResearchId('delivery') }, fields: [
                { key: 'title', label: '交付标题', value: branch.title, max: 200 }, { key: 'summary', label: '我们得到什么结论？', multiline: true, max: 1400 },
                { key: 'evidence', label: '交付引用哪些证据？', value: JSON.stringify([branch.head]), multiple: true, options: records.map(r => ({ value: r.id, label: `${kindNames[r.kind]} · ${r.title}` })) },
                { key: 'reproduce', label: '如何复现和核对？', multiline: true, max: 1400 }, { key: 'limitations', label: '局限、负结果与尚未解决的问题', multiline: true, max: 1400 },
                { key: 'question', label: '具体请人作什么判断？', multiline: true, max: 1400 },
            ] });
    }
    function merge(branch: BranchView) {
        setCommand({ action: 'research_merge', title: '合入团队科研主线', params: { branch: branch.id, expected_head: branch.head, expected_main: research?.main ?? '', record: newResearchId('merge') }, fields: [{ key: 'reason', label: '采纳什么、适用于哪里、如何兼容主线？', multiline: true, max: 1200 }] });
    }
    if (!research)
        return <div className="rw-empty">此项目尚未启用科研协作契约。</div>;
    return <div className="rw">
    <header className="rw-heading"><div><small>SHARED RESEARCH</small><h1>回到项目</h1><p>跟上进展，理解证据，再作判断。</p></div><div className="rw-heading-actions">{writable && <><button onClick={() => openRecord()}>记下发现</button><button className="rw-primary" onClick={() => openFork()}>新研究分支</button></>}</div></header>
    <nav className="rw-tabs" aria-label="科研协作视图">{[['overview', '项目进展'], ['graph', '研究图'], ['knowledge', '知识与判断'], ['secretary', '科研秘书'], ['archives', '会话档案']].map(([id, title]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id!)}>{title}</button>)}</nav>
    {notice && selected === null && !command && <div className="rw-notice" role={pending ? 'status' : 'alert'}>{notice}</div>}
    <section hidden={tab !== 'overview'} className="rw-overview">
      <div className="rw-stats"><div><span>团队主线</span><strong>{research.main ? records.find(r => r.id === research.main)?.title ?? research.main : '等待第一份验收'}</strong></div><div><span>并行探索</span><strong>{branches.filter(b => !['merged', 'abandoned'].includes(b.status)).length} 个分支</strong></div><div><span>等待人类判断</span><strong>{pendingReviews.length} 份交付</strong></div><div><span>上次回来之后</span><strong>{unseen.length} 条新知识</strong></div></div>
      <div className="rw-overview-grid"><section><div className="rw-section-heading"><h2>研究分支</h2><span>每一条探索保留自己的来路</span></div><div className="rw-branches">{branches.map(b => <article key={b.id} className={`rw-branch is-${b.status}`}>
        <div className="rw-branch-heading"><button onClick={() => select(b.head)} disabled={!b.head}>{b.title}</button><span className="rw-badge">{stateNames[b.status]}</span></div><p>{b.purpose}</p><small>发起 {b.created_by ?? b.by} · 最近推进 {b.by} · {formatTime(b.at)}</small>
        {b.review_stale && <p className="rw-warning">主线已有新进展，需要重新交付和验收。</p>}
        {writable && <div className="rw-actions">{b.transitions.map(status => <button key={status} onClick={() => transition(b, status)}>{stateNames[status]}</button>)}{b.status === 'active' && <><button onClick={() => openRecord(b)}>新增研究记录</button><button onClick={() => setCommand({ action: 'research_advance', title: '将提交推进到此分支', params: { branch: b.id, expected_head: b.head }, fields: [{ key: 'record', label: '新的研究提交 ID', options: records.filter(r => r.id !== b.head && (!b.head || r.parents.includes(b.head))).map(r => ({ value: r.id, label: r.title })) }, { key: 'reason', label: '推进说明', max: 500 }] })}>推进提交</button>{b.head && <button onClick={() => deliver(b)}>准备交付</button>}</>}{b.status === 'review' && <>{b.review_stale ? <button onClick={() => deliver(b)}>重新交付</button> : <button onClick={() => merge(b)}>合入主线</button>}</>}</div>}
      </article>)}{!branches.length && <p className="rw-empty">从一个问题开分支。记录假设、实验与证据，交付之后邀请人来学习和验收。</p>}</div></section>
      <aside className="rw-inbox"><h2>待对齐</h2>{pendingReviews.map(b => <button className="rw-inbox-item" aria-label={`审阅交付：${b.title}`} key={b.id} onClick={() => select(b.delivery)}><small>交付待验收</small><strong>{b.title}</strong><span>{b.by}</span></button>)}{research.confirmations.filter(c => !['approve', 'reject', 'disagree'].includes(records.find(r => r.id === c.target)?.my_judgment ?? '')).map(c => <button className="rw-inbox-item" key={c.id} onClick={() => select(c.target)}><small>需要明确回复</small><strong>{c.question}</strong><span>由 {c.by} 提出</span></button>)}{records.filter(r => r.critical && r.kind !== 'delivery' && !r.superseded && !r.my_judgment && !research.confirmations.some(c => c.target === r.id)).map(r => <button className="rw-inbox-item" key={`critical-${r.id}`} onClick={() => select(r.id)}><small>关键判断等待你的回复</small><strong>{r.title}</strong><span>由 {r.by} 提出</span></button>)}<h2>新发生的事</h2>{(projection.activity ?? []).filter(a => a.type === 'research' && (a.seq ?? 0) > research.seen_through).slice(-12).reverse().map(a => <button className="rw-inbox-item" key={a.seq} disabled={!a.target} onClick={() => a.target && select(a.target)}><small>{a.by} · {a.title}</small><strong>{a.detail}</strong><span>{formatTime(a.at)}</span></button>)}{channelOpen && research.controls.can_mark_seen && <button disabled={pending} onClick={() => void submit('research_mark_seen', { through: String(research.revision) })}>已浏览到这里</button>}<p>浏览标记只控制追赶进度。学习与批准需要对具体版本另行确认。</p></aside></div>
    </section>
    <section hidden={tab !== 'graph'}><ResearchGraph records={records} branches={branches} main={research.main} selected={selected} onSelect={select}/></section>
    <section hidden={tab !== 'knowledge'} className="rw-knowledge"><div className="rw-search"><input aria-label="搜索科研知识" placeholder="搜索结论、证据、要求、版本…" value={query} onChange={e => setQuery(e.target.value)}/><select aria-label="知识类型" value={kind} onChange={e => setKind(e.target.value)}><option value="">全部类型</option>{Object.entries(kindNames).map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select><select aria-label="知识作者" value={author} onChange={e => setAuthor(e.target.value)}><option value="">所有贡献者</option>{research.indexes.authors.map(id => <option key={id} value={id}>{id}</option>)}</select></div><p>{filtered.length} 条知识 · 学过与同意分别记录</p><div className="rw-record-grid">{filtered.map(r => <button key={r.id} className="rw-record-card" onClick={() => select(r.id)}><small>{kindNames[r.kind]} · {originNames[r.source_level]}</small><strong>{r.title}</strong><span>{r.body.slice(0, 160)}</span><footer>{r.by} · {r.understood_by_me ? '我已理解' : '我未确认学习'}{r.superseded ? ' · 已被替代' : r.needs_recheck ? ' · 依据有变化' : ''}</footer></button>)}</div></section>
    <section hidden={tab !== 'secretary'} className="rw-secretary"><div className="rw-secretary-intro"><h2>项目科研秘书</h2><p>让秘书解释进展、教你读懂证据，或准备下一步操作。答复对本项目成员可见。</p><div className="rw-actions">{['我离开了两天：谁推进了什么，哪些需要我判断？', '教我理解最近的交付，先解释证据和局限。', '哪些结论有反例或已失效？谁批准过，谁还没有学过？'].map(text => <button key={text} onClick={() => setPrompt(text)}>{text}</button>)}</div></div><div className="rw-secretary-messages">{(projection.secretary_messages ?? []).map(m => <article key={m.seq ?? `${m.at}-${m.record ?? m.text.slice(0, 30)}`} className={`is-${m.role}`}><small>{m.by} · {formatTime(m.at)}</small><Markdown>{m.text}</Markdown>{m.record && <button onClick={() => select(m.record!)}>查看引用与学习确认</button>}</article>)}</div>{writable ? <form onSubmit={async (e) => { e.preventDefault(); if (prompt.trim() && await submit('ask_secretary', { prompt: prompt.trim() }))
        setPrompt(''); }}><label htmlFor="rw-secretary-prompt">问秘书 / 交代下一步</label><textarea id="rw-secretary-prompt" value={prompt} maxLength={4000} onChange={e => setPrompt(e.target.value)} placeholder="从你想了解或决定的事情开始…"/><button className="rw-primary" disabled={pending || !prompt.trim()}>交给科研秘书</button></form> : <p>当前仅可阅读秘书与项目记录。</p>}</section>
    <section hidden={tab !== 'archives'} className="rw-knowledge"><h2>已明确接入的项目会话</h2><p>这里是历史对话档案，主导 Agent 的接力登记单独保留。</p><div className="rw-record-grid">{(projection.session_archives ?? []).map(s => <button key={s.session_key} className="rw-record-card" onClick={() => setArchive(s.session_key!)}><small>{s.cliKind} · {s.messageCount ?? 0} 条发布消息</small><strong>{s.title}</strong><span>{s.preview}</span></button>)}</div></section>
    {sourceDocument && <ResearchHistory key={`${sourceDocument.key}-${sourceDocument.seq}`} document={sourceDocument.key} start={Math.max(0, sourceDocument.seq - 1)} onClose={() => setSourceDocument(null)}/>}
    {archive && <ResearchHistory key={archive} session={archive} start={Math.max(0, ((projection.session_archives ?? []).find(s => s.session_key === archive)?.first_message_seq ?? 1) - 1)} onClose={() => setArchive(null)}/>}
    {selected !== null && <aside className="rw-detail" role="dialog" aria-modal="false" aria-label="科研记录详情"><header><small>不可变研究记录</small><button aria-label="关闭记录详情" onClick={() => setSelected(null)}>×</button></header>{selectedRecord ? <><div className="rw-detail-badges"><span>{kindNames[selectedRecord.kind]}</span><span>{originNames[selectedRecord.source_level]}</span>{selectedRecord.critical && <span className="rw-warning">关键事项 · 需要明确判断</span>}</div><h2>{selectedRecord.title}</h2>{selectedRecord.title_inferred && <p>标题是秘书整理（infer）；下面的要求正文逐字引用真人输入。</p>}<code>{selectedRecord.id}</code><p>发布 {selectedRecord.by} · {formatTime(selectedRecord.at)}{selectedRecord.origin_by ? ` · 原始要求来自 ${selectedRecord.origin_by}` : ""}</p>{(selectedRecord.superseded || selectedRecord.needs_recheck) && <p className="rw-warning">{selectedRecord.superseded ? '已有新记录替代此结论，历史仍保留。' : '依据已发生变化，请重新检查适用性。'}</p>}<Markdown>{selectedRecord.body}</Markdown>{selectedRecord.source && <p className="rw-source">来源：{selectedRecord.source}</p>}<h3>来路与证据</h3><div className="rw-links">{selectedRecord.documents?.map(d => <button key={`${d.key}-${d.seq}`} onClick={() => setSourceDocument(d)}>原始文档 · {d.title}</button>)}</div><div className="rw-links">{selectedRecord.parents.map(id => <button key={`parent-${id}`} onClick={() => select(id)}>父提交 · {records.find(r => r.id === id)?.title ?? id}</button>)}{selectedRecord.links.map((link, i) => <button key={`${link.relation}-${link.target}-${i}`} onClick={() => select(link.target)}>{link.relation} · {records.find(r => r.id === link.target)?.title ?? link.target}</button>)}{records.filter(r => r.links.some(l => l.target === selected)).map(r => <button key={`back-${r.id}`} onClick={() => select(r.id)}>后续引用 · {r.title}</button>)}</div><h3>谁学过，谁作了判断</h3><ul className="rw-receipts">{research.attestations.filter(a => a.target === selected).map(a => <li key={a.seq}><strong>{a.by} · {judgmentNames[a.kind]}</strong><p>{a.response}</p><small>{formatTime(a.at)}{a.main ? ` · 主线 ${a.main}` : ''}</small></li>)}</ul>{canAttest && <div className="rw-attest">{notice && <p role="status">{notice}</p>}<label htmlFor="rw-response">我的理解或明确意见（仅代表本人）</label><textarea id="rw-response" value={drafts[selected] ?? ''} onChange={e => setDrafts(d => ({ ...d, [selected]: e.target.value }))} maxLength={1200} placeholder="说清你理解了什么，或批准 / 不同意的具体内容。"/><div className="rw-actions">{Object.entries(judgmentNames).map(([value, title]) => <button key={value} disabled={pending || !(drafts[selected] ?? '').trim() || (value === 'approve' && selectedRecord.kind === 'delivery' && (!selectedRecord.understood_by_me || selectedBranch?.review_stale || selectedBranch?.status !== 'review'))} onClick={() => void submit('research_attest', { record: selected, kind: value, response: drafts[selected]!.trim(), main: selectedBranch?.review_main ?? '' })}>{title}</button>)}</div></div>}{writable && <button onClick={() => openFork(selectedRecord.id)}>从这里分叉探索</button>}</> : <p>所选记录暂未出现在当前投影。保留选择，不切换到其他记录。</p>}</aside>}
    {command && <CommandDialog key={command.params.record ?? command.params.branch + command.action} command={command} notice={notice} pending={pending} disabled={!writable} onClose={() => setCommand(null)} onSubmit={async (params) => { if (await submit(command.action, params))
        setCommand(null); }}/>}
  </div>;
}
function CommandDialog({ command, notice, pending, disabled, onClose, onSubmit }: {
    command: Command;
    notice: string;
    pending: boolean;
    disabled: boolean;
    onClose(): void;
    onSubmit(params: Record<string, string>): Promise<void>;
}) {
    const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(command.fields.map(f => [f.key, f.value ?? (f.multiple ? '[]' : f.options?.[0]?.value ?? '')])));
    async function send(e: FormEvent) { e.preventDefault(); await onSubmit({ ...command.params, ...values }); }
    return <div className="rw-modal-backdrop">
      <section role="dialog" aria-modal="true" aria-label={command.title} className="rw-modal">
        <header><h2>{command.title}</h2><button onClick={onClose} disabled={pending} aria-label="关闭操作表单">×</button></header>
        <form onSubmit={send}>
          {command.fields.map(f => f.multiple ? <fieldset key={f.key} className="rw-evidence-options">
            <legend>{f.label}</legend>
            {f.options?.map(o => <label key={o.value}><input type="checkbox"
              checked={JSON.parse(values[f.key] || '[]').includes(o.value)}
              onChange={e => setValues(v => ({ ...v, [f.key]: JSON.stringify(e.target.checked
                ? [...JSON.parse(v[f.key] || '[]'), o.value]
                : JSON.parse(v[f.key] || '[]').filter((id: string) => id !== o.value)) }))} />{o.label}</label>)}
          </fieldset> : <label key={f.key}>{f.label}{f.options ? <select required={!f.optional} value={values[f.key]} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}>
            {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select> : f.multiline ? <textarea required={!f.optional} maxLength={f.max} value={values[f.key]} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} />
            : <input required={!f.optional} maxLength={f.max} value={values[f.key]} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} />}</label>)}
          {notice && <p role="status">{notice}</p>}
          <footer><button type="button" onClick={onClose} disabled={pending}>取消</button><button className="rw-primary" disabled={pending || disabled}>{pending ? '提交中…' : '提交'}</button></footer>
        </form>
      </section>
    </div>;
}
function ResearchGraph({ records, branches, main, selected, onSelect }: {
    records: RecordView[];
    branches: BranchView[];
    main: string;
    selected: string | null;
    onSelect(id: string): void;
}) {
    const visible = records.slice(-120);
    const levels = new Map<string, number>();
    const slots = new Map<number, number>();
    const nodes = visible.map(record => { const level = Math.max(0, ...record.parents.map(p => (levels.get(p) ?? -1) + 1)); levels.set(record.id, level); const slot = slots.get(level) ?? 0; slots.set(level, slot + 1); return { record, x: level * 244 + 24, y: slot * 116 + 24 }; });
    const byId = new Map(nodes.map(n => [n.record.id, n]));
    return <div className="rw-graph"><p>沿父提交看研究来路；点击节点查看证据、判断与学习记录。{records.length > 120 ? '当前显示最近 120 个节点，更早记录可从来路和知识检索打开。' : ''}</p><div className="rw-graph-canvas"><svg role="group" aria-label="科研提交 DAG" width={Math.max(700, ...nodes.map(n => n.x + 244))} height={Math.max(280, ...nodes.map(n => n.y + 116))}>{nodes.flatMap(n => n.record.parents.map(parent => { const p = byId.get(parent); return p ? <path key={`${parent}-${n.record.id}`} d={`M ${p.x + 210} ${p.y + 40} C ${p.x + 232} ${p.y + 40}, ${n.x - 24} ${n.y + 40}, ${n.x} ${n.y + 40}`}/> : null; }))}{nodes.map(n => <g key={n.record.id} role="button" tabIndex={0} aria-label={n.record.title} aria-pressed={n.record.id === selected} onClick={() => onSelect(n.record.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(n.record.id);
    } }} transform={`translate(${n.x},${n.y})`}><rect width="210" height="84" rx="12" className={n.record.id === main ? 'is-main' : n.record.kind === 'delivery' ? 'is-delivery' : ''}/><text x="14" y="23" className="rw-graph-kind">{n.record.id === main ? '● 团队主线' : kindNames[n.record.kind]}</text><text x="14" y="47">{n.record.title.slice(0, 15)}{n.record.title.length > 15 ? '…' : ''}</text><text x="14" y="68" className="rw-graph-kind">{branches.find(b => b.head === n.record.id)?.title.slice(0, 20) ?? n.record.by.slice(0, 24)}</text></g>)}</svg></div></div>;
}
