import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentApiError, type AgentApi, type FileEntry, type FileListing, type FileMeta, type FileReply } from './protocol';
import { Icon, Markdown } from './ui';

const PdfView = lazy(() => import('./pdf'));
/** Bytes of a text file rendered per step; "继续显示" adds the next step. */
export const TEXT_STEP = 400_000;
/** Table rows rendered per step; "再显示" adds the next step. */
export const ROW_STEP = 500;

type Loaded = { loading: true } | { error: AgentApiError | Error } | { reply: FileReply };

/** FileReader works in every host this card runs in (and in jsdom); Blob#text does not. */
function readBlob(blob: Blob, as: 'text'): Promise<string>;
function readBlob(blob: Blob, as: 'buffer'): Promise<ArrayBuffer>;
function readBlob(blob: Blob, as: 'text' | 'buffer'): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string | ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    if (as === 'text') reader.readAsText(blob); else reader.readAsArrayBuffer(blob);
  });
}

const size = (bytes?: number) => bytes === undefined ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

/**
 * A file or folder the agent mentioned, opened in place of the conversation.
 * The bridge alone decides whether this reader may see it; the viewer only
 * renders what came back, as inert data (Blob URLs, text, canvases).
 */
export function FileViewer({ api, share, path, owner, isOwner, canExpand, onClose, onExpand, onShareWorkspace }: {
  api: AgentApi;
  share: string;
  path: string;
  owner: string;
  isOwner: boolean;
  canExpand: boolean;
  onClose(): void;
  onExpand(path: string): void;
  onShareWorkspace(): void;
}) {
  const [trail, setTrail] = useState<string[]>([path]);
  const current = trail.at(-1)!;
  const [state, setState] = useState<Loaded>({ loading: true });
  const [reload, setReload] = useState(0);
  const [more, setMore] = useState<{ listing: FileListing; loading: boolean; error?: string } | null>(null);
  const moreFor = useRef<FileListing | null>(null);

  useEffect(() => { setTrail([path]); }, [path]);
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    setMore(null);
    moreFor.current = null;
    api.file(share, current).then((reply) => { if (live) setState({ reply }); }, (error) => { if (live) setState({ error }); });
    return () => { live = false; };
  }, [api, share, current, reload]);

  /**
   * The next page of the listing on screen, merged into it. The result is
   * applied only if that listing is still the one on screen: navigating away
   * or reloading while a page is in flight drops it.
   */
  const loadMore = (listing: FileListing) => {
    if (!listing.next || moreFor.current === listing) return;
    moreFor.current = listing;
    setMore({ listing, loading: true });
    api.file(share, current, listing.next).then((page) => {
      if (page.kind !== 'dir') throw new Error('目录已变成文件，请返回上一级重新打开');
      const merged: FileListing = { ...listing, entries: mergeEntries(listing.entries, page.entries), truncated: page.truncated, next: page.next };
      setState((prev) => 'reply' in prev && prev.reply === listing ? { reply: merged } : prev);
      if (moreFor.current === listing) { moreFor.current = null; setMore(null); }
    }).catch((error: unknown) => {
      if (moreFor.current !== listing) return;
      moreFor.current = null;
      setMore({ listing, loading: false, error: error instanceof Error ? error.message : '读取失败，请重试' });
    });
  };

  const open = (next: string) => setTrail((t) => [...t, next]);
  const back = () => trail.length > 1 ? setTrail((t) => t.slice(0, -1)) : onClose();
  const reply = 'reply' in state ? state.reply : null;
  const title = reply ? (reply.kind === 'file' ? reply.name : `${base(reply.path) || reply.workspace}/`) : base(current);
  const where = reply ? [reply.workspace, reply.path ? reply.path : '根目录', reply.kind === 'file' ? size(reply.size) : `${reply.entries.length} 项`].filter(Boolean).join(' · ') : current;

  return <section className="viewer" aria-label={`文件 ${title}`}>
    <header className="viewer-bar">
      <button className="icon-btn" aria-label={trail.length > 1 ? '上一级' : '返回对话'} title={trail.length > 1 ? '上一级' : '返回对话'} onClick={back}><Icon name="back"/></button>
      <Icon name={reply?.kind === 'dir' || current.endsWith('/') ? 'folder' : 'file'} size={15}/>
      <div className="viewer-title"><b title={title}>{title}</b><span title={where}>{where}</span></div>
      {reply?.kind === 'file' && <Download file={reply}/>}
      {canExpand && <button className="icon-btn" title="放大查看" aria-label="放大查看" onClick={() => onExpand(current)}><Icon name="expand"/></button>}
      <button className="icon-btn" title="关闭" aria-label="关闭文件" onClick={onClose}><Icon name="close"/></button>
    </header>
    <div className="viewer-body">
      {'loading' in state && <div className="viewer-empty"><span className="spinner"/>正在从 {owner} 的设备读取…</div>}
      {'error' in state && <FileError error={state.error} owner={owner} isOwner={isOwner} onRetry={() => setReload((n) => n + 1)} onShareWorkspace={onShareWorkspace}/>}
      {reply?.kind === 'dir' && <Folder listing={reply} onOpen={open} onMore={() => loadMore(reply)}
        loadingMore={more?.listing === reply && more.loading} moreError={more?.listing === reply ? more.error : undefined}/>}
      {reply?.kind === 'file' && <FileBody file={reply}/>}
    </div>
  </section>;
}

function FileError({ error, owner, isOwner, onRetry, onShareWorkspace }: { error: Error; owner: string; isOwner: boolean; onRetry(): void; onShareWorkspace(): void }) {
  const status = error instanceof AgentApiError ? error.status : 0;
  const hint = status === 403 && !isOwner ? `可以请 ${owner} 在卡片菜单「共享工作区文件」里把这个工作区共享给你。`
    : status === 404 ? 'Agent 提到的路径可能已改名、删除，或不在登记的工作区里。'
      : status === 413 ? '升级所有者设备上的 Runner 后即可打开任意大小的文件。'
        : status === 503 || status === 0 ? '设备离线或网络中断时无法读取，稍后再试。' : '';
  return <div className="viewer-empty viewer-error">
    <p className="lead">{error.message}</p>
    {hint && <p>{hint}</p>}
    <div className="row-actions">
      {isOwner && status === 404 && <button className="btn" onClick={onShareWorkspace}>查看工作区</button>}
      {(status === 503 || status === 0 || status === 502) && <button className="btn" onClick={onRetry}>重试</button>}
    </div>
  </div>;
}

/** Pages merged in display order: folders first, then by name; a path seen twice is shown once. */
function mergeEntries(shown: FileEntry[], page: FileEntry[]): FileEntry[] {
  const byPath = new Map(shown.map((entry) => [entry.path, entry]));
  for (const entry of page) byPath.set(entry.path, entry);
  return [...byPath.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

function Folder({ listing, onOpen, onMore, loadingMore, moreError }: {
  listing: FileListing; onOpen(path: string): void; onMore(): void; loadingMore: boolean; moreError?: string;
}) {
  if (!listing.entries.length && !listing.next) return <div className="viewer-empty">这个文件夹是空的</div>;
  return <div className="folder">
    <div role="list">
      {listing.entries.map((entry) => <button key={entry.path} role="listitem" className="folder-row" onClick={() => onOpen(entry.dir ? `${entry.path}/` : entry.path)}>
        <Icon name={entry.dir ? 'folder' : 'file'} size={15}/>
        <span className="folder-name">{entry.name}{entry.dir ? '/' : ''}</span>
        <span className="folder-meta">{entry.dir ? '' : size(entry.size)}</span>
      </button>)}
    </div>
    {listing.next ? <div className="folder-more">
      <span className="muted">已列出 {listing.entries.length} 项，后面还有</span>
      <button className="btn" disabled={loadingMore} onClick={onMore}>{loadingMore ? '正在加载…' : '继续加载'}</button>
      {moreError && <span className="viewer-error-line" role="alert">{moreError}</span>}
    </div>
      // A bridge too old to page cannot continue; say so rather than imply the list is whole.
      : listing.truncated && <p className="muted folder-more">只列出了前 {listing.entries.length} 项；更新 Octopus 后可继续加载</p>}
  </div>;
}

function Download({ file }: { file: FileMeta & { data: Blob } }) {
  const url = useObjectUrl(file.data);
  return <a className="icon-btn" href={url} download={file.name} title="下载" aria-label="下载"><Icon name="download"/></a>;
}

function useObjectUrl(blob: Blob): string {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return url;
}

/** The first `bytes` of a text file; the text shown so far stays until a longer read replaces it. */
function useText(blob: Blob, bytes: number): { text: string; bytes: number } | null {
  const [loaded, setLoaded] = useState<{ text: string; bytes: number } | null>(null);
  useEffect(() => {
    let live = true;
    const prefix = blob.slice(0, bytes);
    const finish = (text: string) => { if (live) setLoaded({ text, bytes: prefix.size }); };
    readBlob(prefix, 'text').then(finish, () => finish(''));
    return () => { live = false; };
  }, [blob, bytes]);
  return loaded;
}

function FileBody({ file }: { file: FileMeta & { data: Blob } }) {
  const mime = file.mime;
  if (mime.startsWith('image/')) return <ImageView file={file}/>;
  if (mime === 'application/pdf') return <PdfFile file={file}/>;
  if (mime.startsWith('video/')) return <MediaView file={file} kind="video"/>;
  if (mime.startsWith('audio/')) return <MediaView file={file} kind="audio"/>;
  if (mime === 'text/markdown') return <TextView file={file} render={(text) => <div className="viewer-doc"><Markdown text={text} onLink={() => {}}/></div>}/>;
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') {
    return <TextView file={file} steps="inside" render={(text, more) => <Table text={text} tab={mime !== 'text/csv'} more={more}/>}/>;
  }
  if (mime === 'application/json' || mime === 'application/x-ndjson') return <TextView file={file} render={(text) => <pre className="viewer-code">{pretty(text)}</pre>}/>;
  if (mime.startsWith('text/')) return <TextView file={file} render={(text) => <pre className="viewer-code">{text}</pre>}/>;
  return <Unsupported file={file}/>;
}

function ImageView({ file }: { file: FileMeta & { data: Blob } }) {
  const url = useObjectUrl(file.data);
  const [actual, setActual] = useState(false);
  return <div className={`viewer-image${actual ? ' is-actual' : ''}`}>
    <img src={url} alt={file.name} onClick={() => setActual((a) => !a)} title={actual ? '适应宽度' : '原始尺寸'}/>
  </div>;
}

function MediaView({ file, kind }: { file: FileMeta & { data: Blob }; kind: 'video' | 'audio' }) {
  const url = useObjectUrl(file.data);
  return <div className="viewer-media">{kind === 'video' ? <video src={url} controls/> : <audio src={url} controls/>}</div>;
}

function PdfFile({ file }: { file: FileMeta & { data: Blob } }) {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; readBlob(file.data, 'buffer').then((value) => { if (live) setData(value); }, () => { if (live) setFailed(true); }); return () => { live = false; }; }, [file.data]);
  const fail = useCallback(() => setFailed(true), []);
  if (failed) return <Unsupported file={file} reason="这里无法渲染这个 PDF。"/>;
  if (!data) return <div className="viewer-empty"><span className="spinner"/>正在打开 PDF…</div>;
  return <Suspense fallback={<div className="viewer-empty"><span className="spinner"/>正在加载 PDF 阅读器…</div>}><PdfView data={data} onFailure={fail}/></Suspense>;
}

/**
 * A text file shown a step at a time: the whole file is a click (or several)
 * away, never cut off. `more` is defined while bytes remain; a renderer that
 * pages on its own (`steps="inside"`, the table) offers it in its own control.
 */
type TextContinuation = { read(): void; loading: boolean };

function TextView({ file, render, steps = 'below' }: {
  file: FileMeta & { data: Blob };
  render(text: string, more: TextContinuation | undefined): React.ReactNode;
  steps?: 'below' | 'inside';
}) {
  const [bytes, setBytes] = useState(TEXT_STEP);
  const loaded = useText(file.data, bytes);
  if (loaded === null) return <div className="viewer-empty"><span className="spinner"/></div>;
  const total = file.data.size;
  // Completeness belongs to the displayed text, not an in-flight read request.
  const more = total > loaded.bytes ? { read: () => setBytes(loaded.bytes + TEXT_STEP), loading: bytes > loaded.bytes } : undefined;
  return <>
    {render(loaded.text, more)}
    {more && steps === 'below' && <div className="viewer-more">
      <span className="muted">已显示前 {size(loaded.bytes)}，共 {size(total)}</span>
      <button className="btn" disabled={more.loading} onClick={more.read}>{more.loading ? '正在读取…' : '继续显示'}</button>
    </div>}
  </>;
}

function Unsupported({ file, reason }: { file: FileMeta & { data: Blob }; reason?: string }) {
  const url = useObjectUrl(file.data);
  return <div className="viewer-empty">
    <Icon name="file" size={28}/>
    <p className="lead">{reason ?? '卡片里暂时不能预览这种文件'}</p>
    <p>{file.name} · {size(file.size)}</p>
    <a className="btn" href={url} download={file.name}><Icon name="download" size={14}/>下载</a>
  </div>;
}

function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/** A small CSV reader: quotes, escaped quotes, CRLF. Enough to read a results table. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quoted) {
      if (c === '"' && text[k + 1] === '"') { cell += '"'; k++; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === '') { quoted = true; continue; }
    if (c === delimiter) { row.push(cell); cell = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[k + 1] === '\n') k++;
      row.push(cell); rows.push(row); row = []; cell = '';
      continue;
    }
    cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * A table of a text prefix. While `more` is defined the prefix may end inside a
 * row, so the text after its last line break is not parsed (it is not a row
 * yet) and the count is a lower bound. One control pages rows, and reads the
 * next part of the file when the loaded rows run out.
 */
function Table({ text, tab, more }: { text: string; tab: boolean; more?: TextContinuation }) {
  const whole = more === undefined ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  const rows = useMemo(() => parseDelimited(whole, tab ? '\t' : ','), [whole, tab]);
  const [shown, setShown] = useState(ROW_STEP);
  if (!rows.length && !more) return <div className="viewer-empty">空表格</div>;
  const [head = [], ...body] = rows;
  const count = more ? `至少 ${body.length} 行` : `共 ${body.length} 行`;
  return <div className="viewer-table">
    <table>
      <thead><tr>{head.map((cell, k) => <th key={k}>{cell}</th>)}</tr></thead>
      <tbody>{body.slice(0, shown).map((row, r) => <tr key={r}>{head.map((_, k) => <td key={k}>{row[k] ?? ''}</td>)}</tr>)}</tbody>
    </table>
    {(body.length > shown || more) && <div className="viewer-more">
      <span className="muted">已显示 {Math.min(shown, body.length)} 行，{count}</span>
      {body.length > shown
        ? <button className="btn" onClick={() => setShown((n) => n + ROW_STEP)}>再显示 {Math.min(ROW_STEP, body.length - shown)} 行</button>
        : <button className="btn" disabled={more?.loading} onClick={more?.read}>{more?.loading ? '正在读取…' : '继续显示'}</button>}
    </div>}
  </div>;
}
