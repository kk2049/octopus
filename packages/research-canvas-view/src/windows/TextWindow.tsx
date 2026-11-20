import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { researchLocationUrl, readResearchLocation, type ResearchNode } from "@claude-bot/research-canvas-contract";
import { Markdown } from "@claude-bot/agent-view-react/ui";
import type { CanvasDocument } from "../collaboration.js";
import type { Call } from "../client.js";
import { nodeMeta, nodeStatus, workKinds } from "../hierarchy.js";

export function TextWindow({
  node,
  doc,
  editable,
  project,
  editField,
}: {
  node: ResearchNode;
  project: string;
  doc: CanvasDocument;
  editable: boolean;
  editField?: "title" | "summary" | "body";
  runnable: boolean;
  call: Call;
  agents: ResearchNode[];
}) {
  const state = useSyncExternalStore(doc.subscribe, doc.snapshot),
    [preview, setPreview] = useState(true),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => { if (editField === "body" && editable) setPreview(false); }, [editField, editable]);
  useEffect(() => { void doc.sync(); return () => { generation.current++; }; }, [doc]);
  const content = doc.text();
  const meta = nodeMeta(node);
  return (
    <div className="rv-note-editor">
      {node.type === "task" && <section className="rv-task-context">
        <header><strong>{workKinds[String(meta.workKind)] ?? "研究任务"}</strong><span>{nodeStatus(node).label}</span></header>
        {typeof meta.claimedProgress === "string" && <p>{meta.claimedProgress}</p>}
        {typeof meta.progressSource === "string" && <small>{meta.progressSource}{typeof meta.sourceAt === "string" ? ` · ${meta.sourceAt.slice(0, 10)}` : ""}</small>}
        {meta.acceptanceStatus === "pending" && <small>独立验收：待完成</small>}
      </section>}
      <div className="rv-inline">
        <span>
          {state.pending
            ? "正在同步…"
            : state.error
              ? "本地草稿已保留"
              : "正文文件"}
        </span>
        <button disabled={!editable && preview} onClick={() => setPreview((value) => !value)}>
          {preview ? "编辑正文" : "阅读模式"}
        </button>
      </div>
      {state.error && (
        <p role="alert">
          {state.error}{" "}
          <button onClick={() => void doc.sync(true)}>重新同步</button>
        </p>
      )}
      {state.partial && (
        <p role="status">
          正文共 {(state.partial.total / 1024 / 1024).toFixed(1)} MiB，这里只载入了前 {(state.partial.loaded / 1024 / 1024).toFixed(1)} MiB 供阅读，未载入部分不会被改动。{" "}
          <button onClick={() => void doc.loadAll()}>载入全部</button>
        </p>
      )}
      {preview ? (
        <Markdown>{content}</Markdown>
      ) : (
        <textarea
          aria-label="便签正文"
          value={content}
          disabled={!editable || !state.ready || Boolean(state.partial)}
          onChange={(event) => doc.replaceText(event.target.value)}
          placeholder="记录线索、问题、结论，或给 Agent 的批注…"
        />
      )}
      <div className="rv-callout">
        <span>把节点引用放入 Agent 草稿，检查上下文后再启动。</span>
        <button className="rv-primary" onClick={async () => {
          const ticket = ++generation.current; setError("");
          try {
            await navigator.clipboard.writeText(researchLocationUrl(window.location.href, project, { ...readResearchLocation(window.location.href), node: node.id }));
            if (ticket === generation.current) setCopied(true);
          } catch { if (ticket === generation.current) setError("无法访问剪贴板，请从卡片的更多菜单打开节点地址。"); }
        }}>{copied ? "已复制节点引用" : "复制节点引用"}</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
