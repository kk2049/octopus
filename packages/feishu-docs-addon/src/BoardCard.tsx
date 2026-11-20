import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { renderBoard } from './board-html';
import { AgentApiError, bindingIsFor, type AgentApi, type BoardBinding, type BoardFrame, type DocsHost, type HostSnapshot } from './protocol';
import { Icon, Logo, Notice, relativeTime } from './ui';

const message = (e: unknown) => e instanceof Error ? e.message.slice(0, 300) : '操作没有完成，请重试';
/** A board changes when its agent republishes; a version check this often is enough and costs one small reply. */
const POLL_MS = 15_000;

/** The board's frame inside its shadow root: readable defaults and the theme variables agents are told to use. */
const BOARD_CSS = `
:host { display: block; color: var(--board-text); font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", "Segoe UI", sans-serif; overflow-wrap: anywhere; }
* { box-sizing: border-box; }
img, svg { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--board-border); padding: 6px 8px; text-align: left; vertical-align: top; }
th { color: var(--board-muted); font-weight: 600; }
h1, h2, h3, h4 { margin: 14px 0 8px; line-height: 1.35; }
h1 { font-size: 20px; } h2 { font-size: 17px; } h3 { font-size: 15px; }
p, ul, ol { margin: 6px 0; }
a { color: var(--board-accent); }
code { background: var(--board-surface); border-radius: 4px; padding: 0 4px; }
`;

/**
 * A board card: one page of static HTML an owner's agent keeps up to date.
 * Readers see its latest version; the owner can stop sharing it. The page is
 * rendered by `renderBoard` into a shadow root, so nothing in it runs or
 * reaches outside the card.
 */
export function BoardCard({ host, api, doc, board, preview = false }: { host: DocsHost; api: AgentApi; doc: HostSnapshot; board: BoardBinding; preview?: boolean }) {
  const [frame, setFrame] = useState<BoardFrame | null>(null);
  const [error, setError] = useState('');
  const [gone, setGone] = useState('');
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const view = useRef<HTMLDivElement>(null);
  const visible = useRef(doc.visible);
  const kick = useRef<() => void>(() => {});
  const copied = !bindingIsFor(board, doc.doc);

  useEffect(() => {
    setFrame(null); setGone(''); setError('');
    if (copied) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let version = '';
    const tick = async () => {
      clearTimeout(timer);
      if (stopped) return;
      if (visible.current && !document.hidden) {
        try {
          const reply = await api.board(board.board, version);
          if (stopped) return;
          setError('');
          if (!('unchanged' in reply)) { version = String(reply.version); setFrame(reply); }
        } catch (e) {
          if (stopped) return;
          if (e instanceof AgentApiError && (e.status === 403 || e.status === 404 || e.status === 410)) { setGone(e.message); return; }
          setError(message(e));
        }
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    kick.current = () => void tick();
    void tick();
    return () => { stopped = true; clearTimeout(timer); kick.current = () => {}; };
  }, [api, board.board, copied]);

  useEffect(() => {
    visible.current = doc.visible;
    if (doc.visible) kick.current();
  }, [doc.visible]);

  useEffect(() => {
    const node = view.current;
    if (!node || !frame) return;
    renderBoard(node.shadowRoot ?? node.attachShadow({ mode: 'open' }), frame.html, BOARD_CSS);
  }, [frame]);

  /** A board's links open through the host, never inside this frame. */
  const onClick = (event: MouseEvent) => {
    const link = event.nativeEvent.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement && node.hasAttribute('href'));
    if (!link) return;
    event.preventDefault();
    void host.open(link.href).catch(() => {});
  };

  async function stopSharing() {
    if (busy) return;
    setBusy(true); setMenu(false); setError('');
    try {
      await api.unboard(board.board);
      await host.clearBoard().catch(() => {});
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }

  const title = frame?.title ?? board.title;
  const owner = frame?.owner ?? board.owner;
  const updated = frame ? relativeTime(frame.updatedAt) : '';
  const canExpand = host.surface === 'inline';
  return <main className={`card board-card surface-${host.surface}`} data-theme={doc.dark ? 'dark' : 'light'}>
    {preview && <div className="preview-flag">本地预览 · 模拟数据，不连接真实 Agent</div>}
    <header className="bar">
      <Logo/>
      <div className="title"><h1 title={title}>{title}</h1><p>{[`${owner} 的看板`, updated && `更新于 ${updated}`].filter(Boolean).join(' · ')}</p></div>
      <div className="bar-side">
        {canExpand && !gone && !copied && <button className="icon-btn" title="放大查看" aria-label="放大查看" onClick={() => void host.expand(title).catch(() => {})}><Icon name="expand"/></button>}
        {frame?.role === 'owner' && <div className="menu-wrap">
          <button className="icon-btn" aria-label="更多操作" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><Icon name="more"/></button>
          {menu && <div className="menu" role="menu">
            <button role="menuitem" className="danger" disabled={busy} onClick={() => void stopSharing()}><Icon name="close" size={14}/>停止共享并清空卡片</button>
          </div>}
        </div>}
      </div>
    </header>
    {error && <Notice tone="warn">{error}</Notice>}
    {copied
      ? <div className="center"><p className="lead">这块看板是从另一篇文档复制来的。</p><p>为避免内容在所有者不知情时被更多人看到，需要 {board.owner} 在这里重新发布。</p></div>
      : gone
      ? <div className="center"><p className="lead">{gone}</p></div>
      : <div className="board-scroll">
          {!frame && <div className="center"><span className="spinner"/></div>}
          <div className="board-view" ref={view} onClick={onClick}/>
        </div>}
  </main>;
}
