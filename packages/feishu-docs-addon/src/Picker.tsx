import { useEffect, useState } from 'react';
import type { AgentApi, SessionChoice } from './protocol';
import { Icon, Notice, providerName, relativeTime } from './ui';

const message = (e: unknown) => e instanceof Error ? e.message : '操作没有完成，请重试';

/** The owner's own sessions. Choosing one is the explicit act that shows it to this document's readers. */
export function Picker({ api, current, onPick, onNew, onCancel }: {
  api: AgentApi;
  current?: string;
  /** `title` is what the document's readers see on the card. */
  onPick(choice: SessionChoice, title: string): Promise<void>;
  /** Start a new agent for this document instead. */
  onNew(): void;
  onCancel?: () => void;
}) {
  const [sessions, setSessions] = useState<SessionChoice[] | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<SessionChoice | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setError('');
    api.sessions().then((result) => { if (live) { setSessions(result.sessions); setNotice(result.notice ?? ''); } })
      .catch((e) => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [api, reload]);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (sessions ?? []).filter((s) => words.every((w) => `${s.title} ${s.device} ${s.project ?? ''} ${s.provider}`.toLowerCase().includes(w)));

  const confirm = async () => {
    if (!chosen) return;
    setBusy(true); setError('');
    try { await onPick(chosen, title.trim() || chosen.title); } catch (e) { setError(message(e)); setBusy(false); }
  };
  const unshareAll = async (session: SessionChoice) => {
    setError('');
    try {
      await api.unshare({ resourceId: session.resourceId });
      setSessions((rows) => rows?.map((row) => row.resourceId === session.resourceId ? { ...row, shared: 0 } : row) ?? rows);
    } catch (e) { setError(message(e)); }
  };

  if (chosen) {
    return <section className="picker" aria-label="确认共享">
      <div className="confirm">
        <h2>把这个 Agent 会话放进文档</h2>
        <label className="field" htmlFor="card-title">卡片标题<span>文档读者看到的名字</span></label>
        <input id="card-title" className="input" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder={chosen.title}/>
        <p className="session-meta confirm-meta">{[chosen.device, providerName(chosen.provider), chosen.project].filter(Boolean).join(' · ')}</p>
        <ul>
          <li><b>你</b>可以在卡片里查看它，并给它发送任务、停止运行。</li>
          <li><b>能看到这篇文档的组织成员</b>可以实时只读观看它的对话；工具的输入输出与思考过程不会显示。</li>
          <li>随时可以从卡片菜单把它移出文档，移出后这张卡片立即失效。</li>
        </ul>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="row-actions">
          <button className="btn" disabled={busy} onClick={() => setChosen(null)}>返回</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>{busy ? '正在放入…' : '放进文档'}</button>
        </div>
      </div>
    </section>;
  }

  return <section className="picker" aria-label="选择 Agent 会话">
    <div className="picker-head">
      <button className="new-agent" onClick={onNew}>
        <span className="new-agent-icon"><Icon name="plus" size={16}/></span>
        <span className="new-agent-text"><b>新建 Agent</b><span>选设备、目录、模型和思考强度，以这篇文档为起点开始</span></span>
      </button>
      <div className="picker-row">
        <label className="search"><Icon name="search" size={14}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="或者放入已有会话：搜索会话、设备或项目" aria-label="搜索会话"/></label>
        {onCancel && <button className="btn btn-ghost" onClick={onCancel}>取消</button>}
      </div>
    </div>
    {notice && <Notice tone="warn">{notice}</Notice>}
    {error && <Notice tone="error" action={<button className="link" onClick={() => setReload((n) => n + 1)}>重试</button>}>{error}</Notice>}
    <div className="sessions" role="listbox" aria-label="你的会话">
      {sessions === null && !error && <div className="sessions-empty"><span className="spinner"/>正在读取你的会话…</div>}
      {sessions !== null && shown.length === 0 && <div className="sessions-empty">{sessions.length ? '没有匹配的会话' : '没有找到会话。请先在你的设备上用 Claude Code 或 Codex 开始一个会话。'}</div>}
      {shown.map((s) => <div key={s.resourceId} role="option" aria-selected={s.resourceId === current} className={`session ${s.resourceId === current ? 'is-current' : ''}`}>
        <button className="session-main" onClick={() => { setChosen(s); setTitle(s.title.slice(0, 60)); }}>
          <span className={`dot ${s.working ? 'dot-busy' : ''}`} aria-label={s.working ? '运行中' : '空闲'}/>
          <span className="session-text">
            <span className="session-title">{s.title}</span>
            {s.preview && s.preview !== s.title && <span className="session-preview">{s.preview}</span>}
            <span className="session-meta">{[s.device, providerName(s.provider), s.project, relativeTime(s.lastActivity)].filter(Boolean).join(' · ')}{!s.canSend && ' · 只能观看'}</span>
          </span>
          {s.resourceId === current && <span className="tag">当前</span>}
        </button>
        {s.shared > 0 && <button className="tag tag-shared" title="停止这个会话在所有文档中的共享" onClick={() => void unshareAll(s)}>已共享 {s.shared} 处 · 全部停止</button>}
      </div>)}
    </div>
  </section>;
}
