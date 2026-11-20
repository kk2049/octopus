import { useEffect, useRef, useState } from "react";
import { Markdown } from "@claude-bot/agent-view-react/ui";
import type { CloudDocumentRead, PaperSyncPreview, PaperSyncStrategy } from "@claude-bot/research-canvas-contract";
import type { NodeWindowProps } from "./NodeWindow.js";
import "../evidence.css";

const labels = { manual: "每次由我选择同步方向", local_to_cloud: "本任务以本地修改为主", cloud_to_local: "本任务以飞书修改为主", bidirectional: "允许双向同步；两边都改过时先处理冲突" };
export function CloudDocumentWindow({ node, nodes, call, editable, boot }: NodeWindowProps) {
  const [document, setDocument] = useState<CloudDocumentRead | null>(null), [preview, setPreview] = useState<PaperSyncPreview | null>(null);
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [block, setBlock] = useState("");
  const [localNode, setLocalNode] = useState(""), [strategy, setStrategy] = useState<PaperSyncStrategy | "">(""), [instructions, setInstructions] = useState("");
  const [watch, setWatch] = useState(false);
  const generation = useRef(0), edited = useRef(false), outgoing = useRef<{ action: string; fingerprint: string; request: string } | null>(null);
  const execute = async <T,>(action: string, params: Record<string, unknown>, writing = false): Promise<T | null> => {
    const ticket = generation.current; setPending(true); setError("");
    const fingerprint = JSON.stringify(params);
    if (writing && (!outgoing.current || outgoing.current.action !== action || outgoing.current.fingerprint !== fingerprint)) outgoing.current = { action, fingerprint, request: `document_${crypto.randomUUID()}` };
    try {
      const result = await call<T>(action, { ...params, ...(writing ? { request: outgoing.current!.request } : {}) });
      if (ticket !== generation.current) return null;
      if (writing) outgoing.current = null;
      return result;
    } catch (reason) { if (ticket === generation.current) setError(String(reason)); return null; }
    finally { if (ticket === generation.current) setPending(false); }
  };
  const read = async () => {
    const result = await execute<CloudDocumentRead>("cloud_document_read", { node: node.id });
    if (!result) return;
    setDocument(result);
    if (!edited.current) { setBlock(result.binding.block); setLocalNode(result.binding.localNode); setStrategy(result.binding.strategy ?? ""); setInstructions(result.binding.instructions); setWatch(result.binding.watch === true); }
  };
  useEffect(() => { generation.current++; void read(); return () => { generation.current++; }; }, [node.id, call, boot.epoch]);
  const change = (work: () => void) => { edited.current = true; work(); };
  const owner = editable && document?.binding.owner === boot.viewer;
  const check = async () => { const result = await execute<PaperSyncPreview>("paper_sync_check", { node: node.id }); if (result) setPreview(result); };
  const synchronize = async (direction: string) => {
    if (!preview) return;
    const result = await execute<PaperSyncPreview>("paper_sync_run", { node: node.id, direction, local_digest: preview.local.digest, cloud_digest: preview.cloud.digest }, true);
    if (result) setPreview(result);
  };
  return <section className="rv-evidence-window" aria-label="论文云文档">
    <header><b>论文材料与中文大纲</b><button disabled={pending} onClick={() => void read()}>刷新文档</button></header>
    {error && <p role="alert">{error}</p>}{pending && <p role="status">正在处理…</p>}
    {document && <>
      <a href={document.binding.url} target="_blank" rel="noopener noreferrer">打开飞书原文档，阅读或协作编辑 ↗</a>
      <p className="rv-muted">{document.embed.reason}</p>
      <details open><summary>文档内容 · {document.revision || "当前授权版本"}</summary><Markdown>{document.text || "文档暂无正文"}</Markdown></details>
      <details className="rv-settings" open={!document.binding.strategy}><summary>这个任务的同步设置</summary>
        <p>只同步选中的中文大纲文本块。完整论文、图片和其他内容保留在飞书中。</p>
        <form onSubmit={async event => {
          event.preventDefault();
          const result = await execute<{ binding: CloudDocumentRead["binding"] }>("paper_sync_configure", { node: node.id, data: { version: document.binding.version, block, localNode, strategy, instructions, watch } }, true);
          if (result) { edited.current = false; setDocument({ ...document, binding: result.binding }); setPreview(null); }
        }}>
          <label>本地中文大纲<select required disabled={!owner || pending} value={localNode} onChange={event => change(() => setLocalNode(event.target.value))}><option value="">选择本任务的 Markdown 或文本材料</option>{nodes.filter(item => !item.archived && item.id !== node.id && (["note", "task", "goal", "finding", "workgroup"].includes(item.type) || item.type === "file" && item.data.workspace)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <label>飞书中文大纲块<select required disabled={!owner || pending} value={block} onChange={event => change(() => setBlock(event.target.value))}><option value="">明确选择要同步的纯文本块</option>{document.blocks.filter(item => item.supported).map(item => <option key={item.id} value={item.id}>{item.text.slice(0, 90) || "空文本块"}</option>)}</select></label>
          <label>未列出的大纲块 ID<input disabled={!owner || pending} value={block} onChange={event => change(() => setBlock(event.target.value))} placeholder="可填写同一文档中其他纯文本块的 ID" /></label>
          <label>本任务策略<select required disabled={!owner || pending} value={strategy} onChange={event => change(() => setStrategy(event.target.value as PaperSyncStrategy))}><option value="">请按这个任务选择</option>{Object.entries(labels).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
          <label><input type="checkbox" disabled={!owner || pending} checked={watch} onChange={event => change(() => setWatch(event.target.checked))} />为这个任务持续核对；有明确同步策略时自动同步，冲突时提出待审事项</label>
          <label>补充策略<textarea disabled={!owner || pending} value={instructions} onChange={event => change(() => setInstructions(event.target.value))} placeholder="例如：每次交付前核对；存在冲突时留给作者处理" /></label>
          {owner && <button disabled={pending || !localNode || !block || !strategy}>保存本任务的设置</button>}
        </form>
      </details>
      <p role="status">{document.binding.watch ? "已开启本任务的持续核对 · " : ""}{document.binding.message}</p>
      <button disabled={pending || !document.binding.strategy} onClick={() => void check()}>核对本地与飞书的大纲</button>
      {preview && <section><p role="status">{preview.binding.message}</p><div className="rv-report-selections"><div><h4>本地 Markdown</h4><Markdown>{preview.local.text || "空内容"}</Markdown></div><div><h4>飞书大纲</h4><Markdown>{preview.cloud.text || "空内容"}</Markdown></div></div>
        {editable && preview.binding.status !== "synced" && <div className="rv-inline"><button disabled={pending} onClick={() => void synchronize("auto")}>按本任务策略同步</button><button disabled={pending} onClick={() => void synchronize("local_to_cloud")}>使用这份本地大纲更新飞书</button><button disabled={pending} onClick={() => void synchronize("cloud_to_local")}>使用这份飞书大纲更新本地</button></div>}
      </section>}
    </>}
  </section>;
}
