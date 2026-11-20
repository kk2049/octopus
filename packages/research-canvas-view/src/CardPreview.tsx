import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Markdown } from "@claude-bot/agent-view-react/ui";
import { excerptSource, nodeMetadata, type ResearchNode } from "@claude-bot/research-canvas-contract";
import type { Call } from "./client.js";
import { fromBase64, type CanvasDocument } from "./collaboration.js";
import { BlobCollector } from "./file-upload.js";
import { THUMBNAIL_BUDGET_BYTES } from "./budgets.js";
import { AudioCardPreview } from "./AudioCardPreview.js";
import type { AudioUploadController } from "./audio-upload.js";
import { EvidencePreview } from "./windows/EvidenceWindow.js";


export function SourceContext({ node, nodes, open }: { node: ResearchNode; nodes: ResearchNode[]; open(id: string): void }) {
  const source = excerptSource(node), meta = nodeMetadata(node);
  const target = nodes.find(n => n.id === source.source && !n.archived);
  const current = target ? nodeMetadata(target).sha256 ?? nodeMetadata(target).sourceRevision : undefined;
  const stale = current && source.revision && current !== source.revision;
  if (!source.source && !source.revision && !source.limitation) return null;
  return <div className="rv-source-context">
    {source.source && <button disabled={!target} onClick={e => { e.stopPropagation(); open(source.source); }}>{target ? `来源：${target.title} ↗` : "来源暂不可用，引用已保留"}</button>}
    {source.revision && <small title={source.revision}>{stale ? "来源已更新，摘要待复核" : "来源快照"} · {source.revision.slice(0, 12)}{source.at ? ` · ${source.at.slice(0, 10)}` : ""}</small>}
    {typeof meta.acceptanceStatus === "string" && <small>验收：{meta.acceptanceStatus === "pending" ? "待独立验收" : meta.acceptanceStatus}</small>}
    {source.limitation && <small className="rv-limitation" title={source.limitation}>{source.limitation}</small>}
  </div>;
}

function TextExcerpt({ doc }: { doc: CanvasDocument }) {
  const state = useSyncExternalStore(doc.subscribe, doc.snapshot);
  useEffect(() => { void doc.sync(); }, [doc]);
  return <div data-edit-field="body"><small>原文摘录 · {state.pending ? "保存中" : "正文文件"}</small>{state.error ? <p role="alert">{state.error}</p> : <Markdown renderImage={image => <span>{image.alt || "[图片引用，打开来源查看]"}</span>}>{doc.text().slice(0, 2400)}</Markdown>}</div>;
}

/** Fetch only a declared, currently visible preview, through the ordinary authorized action.
 * Version-pin every chunk; never poll resources or read Markdown image destinations.
 */
function FileExcerpt({ node, call }: { node: ResearchNode; call: Call }) {
  const [content, setContent] = useState<{ text?: string; url?: string; version: string; truncated?: boolean } | null>(null);
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [deferred, setDeferred] = useState(0);
  const generation = useRef(0), objectUrl = useRef("");
  const meta = nodeMetadata(node);
  /** Past the thumbnail budget an image loads only when asked; it has no size limit. */
  const read = async (whole = false) => {
    const ticket = ++generation.current; setPending(true); setError(""); setContent(null); setDeferred(0);
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = ""; }
    try {
      let cursor: number | undefined, version = typeof meta.previewVersion === "string" ? meta.previewVersion : undefined;
      const collected = new BlobCollector();
      do {
        const part = await call<{ file: { id: string; mime: string; bytes: number; sha256: string }; data: string; next: number | null }>("resource_read", { node: node.id, cursor, version });
        if (ticket !== generation.current) return;
        if (version && part.file.id !== version) throw new Error("预览版本已变化，请重新读取");
        version = part.file.id;
        const chunk = fromBase64(part.data);
        if (meta.previewKind === "image") {
          if (!/^image\/(png|jpeg|webp|gif)$/.test(part.file.mime)) throw new Error("此来源不是受支持的图片；请打开详情");
          if (cursor === undefined && !whole && part.file.bytes > THUMBNAIL_BUDGET_BYTES) { setDeferred(part.file.bytes); return; }
          if (collected.size + chunk.length > part.file.bytes) throw new Error("图片内容超出声明大小，请重新读取");
          collected.add(chunk); cursor = part.next ?? undefined;
          if (cursor !== undefined) continue;
          const url = URL.createObjectURL(collected.blob(part.file.mime)); objectUrl.current = url;
          setContent({ url, version: part.file.sha256 });
        } else {
          if (!/^(text\/|application\/(json|xml))/.test(part.file.mime)) throw new Error("此来源不是文本；请打开详情");
          setContent({ text: new TextDecoder().decode(chunk).slice(0, 2400), version: part.file.sha256, truncated: part.next !== null || chunk.length > 2400 });
          cursor = undefined;
        }
      } while (cursor !== undefined);
    } catch (reason) { if (ticket === generation.current) setError(String(reason)); }
    finally { if (ticket === generation.current) setPending(false); }
  };
  useEffect(() => { void read(); return () => { generation.current++; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }; }, [node.id, node.resourceVersion, meta.previewVersion, meta.previewKind]);
  return <div className="rv-file-excerpt">
    {pending && <small>正在读取来源…</small>}
    {error && <p role="alert">{error}</p>}
    {deferred > 0 && <button onClick={e => { e.stopPropagation(); void read(true); }}>载入原图（{(deferred / 1024 / 1024).toFixed(1)} MiB）</button>}
    {content?.url && <img src={content.url} alt={node.summary || node.title} />}
    {content?.text !== undefined && <Markdown renderImage={image => <span>{image.alt || "[图片引用，打开来源查看]"}</span>}>{content.text}</Markdown>}
    {content && <small title={content.version}>{content.url ? "原图" : "原文摘录"} · {content.version.slice(0, 12)}{content.truncated ? " · 部分内容" : ""}</small>}
    <button disabled={pending} onClick={e => { e.stopPropagation(); void read(); }}>刷新预览</button>
  </div>;
}

function AdapterExcerpt({ node }: { node: ResearchNode }) {
  const adapter = node.data.adapter as { schema?: { columns?: { key: string; label: string }[] }; rows?: { id: string; cells: Record<string, unknown> }[]; sourceRevision?: string; status?: string } | undefined;
  const columns = adapter?.schema?.columns?.slice(0, 3) ?? [], rows = adapter?.rows?.slice(0, 50) ?? [];
  return <>{!rows.length ? <p>尚未发布结果</p> : <table className="rv-card-table"><thead><tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{columns.map(c => <td key={c.key}>{String(row.cells[c.key] ?? "—")}</td>)}</tr>)}</tbody></table>}
    <small>来源投影 · {adapter?.sourceRevision?.slice(0, 12) || "尚无版本"}{adapter?.status === "paused" ? " · 已暂停" : ""}</small>
  </>;
}

export function CardPreview({ node, children, nodes, call, documentFor, open, epoch = 0, editable = false, audioUpload }: {
  audioUpload?: AudioUploadController; editable?: boolean;
  node: ResearchNode; children: ResearchNode[]; nodes: ResearchNode[]; call: Call; epoch?: number;
  documentFor(node: string, field: "text" | "layout"): CanvasDocument; open(id: string): void;
}) {
  const meta = nodeMetadata(node), excerpt = excerptSource(node);
  const report = typeof meta.reportId === "string" && meta.reportId.length > 0;
  return <div className={`rv-card-content${report ? " rv-report-card" : ""}`} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
    {node.type !== "audio" && node.summary && <p className="rv-card-summary" data-edit-field="summary" title="点击编辑摘要">{node.summary}</p>}
    {node.type !== "audio" && typeof meta.successCriteria === "string" && <p className="rv-success-criteria">完成依据：{meta.successCriteria}</p>}
    {node.type !== "audio" && <SourceContext node={node} nodes={nodes} open={open} />}
    {node.type !== "audio" && (children.length > 0 || node.type === "folder") && <div className="rv-child-counts" title="当前分组的直接子项；同一资源的不同卡片分别计数">
      {children.length ? `本层 · ${childComposition(children)}` : "尚未收纳内容"}
    </div>}
    {node.type === "audio" && audioUpload ? <AudioCardPreview node={node} controller={audioUpload} editable={editable && !node.archived && meta.read_only !== true} open={open} /> : report ? <EvidencePreview node={node} nodes={nodes} call={call} open={open} epoch={epoch} /> : node.type === "adapter" ? <AdapterExcerpt node={node} /> : (meta.previewKind === "image" || meta.previewKind === "markdown") && node.type === "file" ? <FileExcerpt node={node} call={call} /> : (meta.previewKind === "markdown" || !node.summary && !excerpt.text) && ["note", "task", "finding", "goal", "workgroup"].includes(node.type) ? <TextExcerpt doc={documentFor(node.id, "text")} /> : excerpt.text ? <><small>{excerpt.kind}</small><Markdown renderImage={image => <span>{image.alt || "[图片引用，打开来源查看]"}</span>}>{excerpt.text}</Markdown></> : null}
    {!report && !node.summary && !excerpt.text && !meta.previewKind && !["audio", "folder", "adapter", "note", "task", "finding", "goal", "workgroup"].includes(node.type) && <p>暂无卡片说明</p>}
  </div>;
}

export function childComposition(children: ResearchNode[]): string {
  const counts = { cards: 0, agents: 0, files: 0, groups: 0, adapters: 0 };
  for (const child of children) {
    if (child.archived) continue;
    counts[child.type === "agent" ? "agents" : ["file", "audio"].includes(child.type) ? "files" : ["folder", "collection", "group"].includes(child.type) ? "groups" : child.type === "adapter" ? "adapters" : "cards"]++;
  }
  return [[counts.cards, "张卡片"], [counts.agents, "个 Agent"], [counts.files, "份资料"], [counts.groups, "个分组"], [counts.adapters, "个数据投影"]].filter(([count]) => count).map(([count, name]) => `${count} ${name}`).join(" · ");
}
