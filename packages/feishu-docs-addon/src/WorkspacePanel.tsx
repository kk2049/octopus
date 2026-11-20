import { useEffect, useState } from 'react';
import type { AgentApi, WorkspaceInfo } from './protocol';
import { Icon, Notice } from './ui';

const message = (e: unknown) => e instanceof Error ? e.message : '操作没有完成，请重试';

/**
 * The owner decides who may open files from this card: read access to the
 * whole registered workspace that holds the session's directory, granted to
 * named Octopus accounts. Readers then click paths the agent mentions.
 */
export function WorkspacePanel({ api, share, onClose, onAskAgent }: {
  api: AgentApi;
  share: string;
  onClose(): void;
  /** Hands the agent a one-line task (registering the directory as its own workspace). */
  onAskAgent(task: string): Promise<void>;
}) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    // A status line describes the view it was shown for; a refresh starts a new one.
    setError(''); setSaved('');
    api.workspace(share).then((value) => { if (live) { setInfo(value); setChosen(new Set(value.members.map((m) => m.username))); } }, (e) => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [api, share, reload]);

  const toggle = (name: string) => setChosen((set) => { const next = new Set(set); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const dirty = info ? info.members.map((m) => m.username).sort().join() !== [...chosen].sort().join() : false;
  const save = async () => {
    if (!info?.workspace) return;
    setBusy(true); setError(''); setSaved('');
    try {
      const next = await api.grantWorkspace(share, info.workspace.id, [...chosen]);
      setInfo(next); setChosen(new Set(next.members.map((m) => m.username)));
      setSaved(next.members.length ? `已共享给 ${next.members.map((m) => m.name).join('、')}` : '已取消共享，现在只有你能打开');
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const register = async () => {
    setBusy(true); setError('');
    try {
      await onAskAgent('请在当前工作目录运行 `octopus-runner workspace add "$(pwd)"`，把它登记为一个单独的 Octopus 工作区（可以加 `--label 项目名`），然后告诉我结果。');
      setSaved('已把登记任务交给 Agent，完成后点“刷新”。');
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };

  const ws = info?.workspace;
  return <section className="panel" aria-label="共享工作区文件">
    <header className="viewer-bar">
      <button className="icon-btn" aria-label="返回对话" title="返回对话" onClick={onClose}><Icon name="back"/></button>
      <Icon name="share" size={15}/>
      <div className="viewer-title"><b>共享工作区文件</b><span>被授权的成员可以在卡片里直接打开 Agent 提到的文件</span></div>
      <button className="btn btn-ghost" onClick={() => setReload((n) => n + 1)}>刷新</button>
    </header>
    <div className="panel-body">
      {!info && !error && <div className="viewer-empty"><span className="spinner"/>正在读取工作区…</div>}
      {error && <Notice tone="error">{error}</Notice>}
      {info && !ws && <div className="viewer-empty"><p className="lead">没有找到这个会话所在的工作区</p><p>它的目录可能不在 Runner 登记的工作区里。</p></div>}
      {ws && <>
        <div className="ws-card">
          <Icon name="folder" size={18}/>
          <div><b>{ws.label}</b><span>{info!.device} · {ws.display ?? ''}{info!.path ? ` · 会话目录 ${info!.path}` : ''}</span></div>
        </div>
        {!ws.shareable && <>
          <Notice tone="warn">{ws.reason}</Notice>
          <p className="panel-text">在会话目录里运行 <code>octopus-runner workspace add "$(pwd)"</code> 即可登记。也可以让 Agent 代劳：</p>
          <div className="row-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void register()}>让 Agent 登记当前目录</button></div>
        </>}
        {ws.shareable && <>
          <p className="panel-text">选中的成员可以读取整个工作区「{ws.label}」里的文件（只读，所有者设备在线时可用）。每次有人打开文件，你都会收到飞书通知。</p>
          <div className="members" role="group" aria-label="可以读取的成员">
            {info!.candidates.length === 0 && <p className="muted">还没有其他关联了飞书的 Octopus 成员。</p>}
            {info!.candidates.map((m) => <label key={m.username} className={`member${chosen.has(m.username) ? ' is-on' : ''}`}>
              <input type="checkbox" checked={chosen.has(m.username)} onChange={() => toggle(m.username)}/>
              <span className="avatar" aria-hidden="true">{m.name.slice(0, 1)}</span>
              <span className="member-name">{m.name}</span>
              {m.name !== m.username && <span className="member-id">{m.username}</span>}
            </label>)}
          </div>
          {saved && <Notice>{saved}</Notice>}
          <div className="row-actions">
            <button className="btn" disabled={busy} onClick={onClose}>完成</button>
            <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '正在保存…' : '保存'}</button>
          </div>
        </>}
        {!ws.shareable && saved && <Notice>{saved}</Notice>}
      </>}
    </div>
  </section>;
}
