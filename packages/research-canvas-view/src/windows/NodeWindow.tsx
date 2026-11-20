import { useEffect, useMemo, type ComponentType, type ReactNode } from "react";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import type { CanvasDocument } from "../collaboration.js";
import type { Call, CanvasBoot } from "../client.js";
import { pluginFor } from "../plugins.js";
import type { WorkWindow } from "./state.js";
import { SourceContext } from "../CardPreview.js";
import { TextWindow } from "./TextWindow.js";
import { AgentWindow } from "./AgentWindow.js";
import { FileWindow } from "./FileWindow.js";
import { AudioWindow } from "./AudioWindow.js";
import { AudioUploadController, type AudioUploadFor } from "../audio-upload.js";
import { GroupWindow } from "./GroupWindow.js";
import { ResourceSettings } from "./ResourceSettings.js";
import { NodeSettings } from "./NodeSettings.js";
import { TimerSettings } from "./TimerSettings.js";
import { ReviewWindow } from "./ReviewWindow.js";
import { FolderWindow } from "./FolderWindow.js";
import { EvidenceWindow } from "./EvidenceWindow.js";
import { CloudDocumentWindow } from "./CloudDocumentWindow.js";
import { AdapterWindow } from "./AdapterWindow.js";
export interface NodeWindowProps {
  node: ResearchNode;
  original: ResearchNode;
  nodes: ResearchNode[];
  window: WorkWindow;
  boot: CanvasBoot;
  call: Call;
  documentFor(node: string, field: "text" | "layout"): CanvasDocument;
  editable: boolean;
  runnable: boolean;
  storageKey: string;
  open(node: string, version?: string): void;
  openFile(path: string): void;
  mutate(action: string, params: Record<string, unknown>): Promise<unknown>;
  conversationSettings?: ReactNode;
  audioFor?: AudioUploadFor;
}
function isReadOnly(node: ResearchNode): boolean {
  const meta = node.data.meta;
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) && meta.read_only === true;
}
export function NodeWindow({
  node,
  original,
  nodes,
  window,
  boot,
  call,
  documentFor,
  editable,
  runnable,
  storageKey,
  open,
  openFile,
  mutate,
  audioFor,
}: NodeWindowProps) {
  const meta = node.data.meta && typeof node.data.meta === "object" && !Array.isArray(node.data.meta) ? node.data.meta : {};
  const Render = meta.reportId ? EvidenceWindow : meta.cloudDocument ? CloudDocumentWindow :
    windowRenderers.get(pluginFor(node.type).window) ?? UnknownWindow;
  const nodeEditable = editable && !isReadOnly(node);
  if (window.filePath)
    return (
      <>
        <div className="rv-provenance">
          会话引用 · {original.title} · 文件作者未知
        </div>
        <FileContent
          {...{
            node,
            original,
            nodes,
            window,
            boot,
            call,
            documentFor,
            editable: nodeEditable,
            runnable,
            storageKey,
            open,
            openFile,
            mutate,
          }}
        />
        <p className="rv-muted">{window.filePath}</p>
      </>
    );
  const agent = !meta.reportId && !meta.cloudDocument && pluginFor(node.type).window === "agent";
  const header = (
    <>
      <div className="rv-provenance">
        {node.created.kind === "agent" ? "Agent 决策" : "人工记录"} ·{" "}
        {node.created.owner}
        {node.created.model ? ` / ${node.created.model}` : ""} · v{node.version}
        {node.archived ? " · 已归档" : ""}
      </div>
      <SourceContext node={node} nodes={nodes} open={open} />
      <NodeSettings
        editField={window.editField}
        node={node}
        nodes={nodes}
        call={call}
        editable={editable && !node.archived && !window.filePath}
      />
      {boot.role === "owner" && nodeEditable && ["agent", "group"].includes(node.type) && (
        <ResourceSettings node={node} call={call} />
      )}
    </>
  );
  const footer = (
    <details className="rv-settings">
      <summary>节点信息与来源</summary>
      <p>{node.id}</p>
      <p>
        触发：{node.created.trigger} · {node.created.at}
      </p>
      {node.created.run && <p>运行：{node.created.run}</p>}
      {node.data.meta && (
        <dl className="rv-metadata">
          {Object.entries(node.data.meta).map(([key, value]) => (
            <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>
          ))}
        </dl>
      )}
      <label>
        研究阶段
        <select
          disabled={!nodeEditable || Boolean(window.filePath)}
          value={node.phase}
          onChange={(event) =>
            void mutate("node_update", {
              node: node.id,
              version: node.version, snapshot: node.snapshot,
              data: { phase: event.target.value },
            })
          }
        >
          <option value="past">历史</option>
          <option value="present">进行中</option>
          <option value="future">下一步</option>
        </select>
      </label>
      {editable && !node.archived && !window.filePath && (
        <button
          onClick={() =>
            void mutate("node_archive", {
              node: node.id,
              version: node.version, snapshot: node.snapshot,
            })
          }
        >
          归档节点
        </button>
      )}
    </details>
  );
  return (
    <>
      {!agent && node.type !== "audio" && header}
      <Render
        {...{
          node,
          original,
          nodes,
          window,
          boot,
          call,
          documentFor,
          editable: meta.reportId ? editable && !node.archived : nodeEditable,
          runnable,
          storageKey,
          open,
          openFile,
          mutate,
          audioFor,
          conversationSettings: agent ? <>{header}{footer}</> : undefined,
        }}
      />
      {!agent && node.type === "audio" && <details className="rv-settings"><summary>录音标题与来源设置</summary>{header}</details>}
      {!agent && footer}
    </>
  );
}

const UnknownWindow = ({ node }: NodeWindowProps) => (
  <pre>{JSON.stringify(node.data, null, 2)}</pre>
);
function AudioContent({ node, call, editable, runnable, storageKey, open, window, boot, audioFor }: NodeWindowProps) {
  const controller = useMemo(() => audioFor?.(node.id) ?? new AudioUploadController(call, storageKey, node.id), [audioFor, call, storageKey, node.id]);
  useEffect(() => () => { if (!audioFor) controller.close(); }, [controller, audioFor]);
  return <AudioWindow node={node} call={call} controller={controller} editable={editable && !node.archived}
    runnable={runnable && !node.archived} storageKey={storageKey} open={open} version={window.version}
    openVersion={version => open(node.id, version)} epoch={boot.epoch} />;
}
const FileContent = ({
  node,
  original,
  window,
  call,
  editable,
  storageKey,
  open,
  runnable,
}: NodeWindowProps) => (
  <FileWindow
    node={node}
    call={call}
    version={window.filePath ? undefined : window.version}
    editable={editable && !isReadOnly(node) && !node.archived && !window.filePath}
    source={
      window.filePath ? { node: original.id, path: window.filePath } : undefined
    }
    storageKey={storageKey}
    openVersion={(version) => open(node.id, version)}
    open={open}
    runnable={runnable}
  />
);
/** Extension modules register a renderer next to their plugin metadata; the canvas stays generic. */
export const windowRenderers = new Map<string, ComponentType<NodeWindowProps>>([
  [
    "text",
    ({ node, documentFor, runnable, editable, call, nodes, boot, window }) => (
      <TextWindow
        editField={window.editField}
        project={boot.project}
        node={node}
        doc={documentFor(node.id, "text")}
        runnable={runnable}
        editable={editable && !node.archived}
        call={call}
        agents={nodes.filter((item) => item.type === "agent")}
      />
    ),
  ],
  [
    "agent",
    ({ node, call, boot, storageKey, runnable, openFile, conversationSettings }) => (
      <AgentWindow
        node={node}
        call={call}
        epoch={boot.epoch}
        storageKey={storageKey}
        runnable={runnable && !node.archived}
        openFile={openFile}
        settings={conversationSettings}
      />
    ),
  ],
  ["file", FileContent],
  ["audio", AudioContent],
  [
    "group",
    ({ node, call, runnable, editable, storageKey, open }) => (
      <GroupWindow
        node={node}
        call={call}
        runnable={runnable && !node.archived}
        editable={editable && !node.archived}
        storageKey={storageKey}
        open={open}
      />
    ),
  ],
  [
    "review",
    ({ node, nodes, editable, mutate, open }) => (
      <ReviewWindow node={node} nodes={nodes} editable={editable} mutate={mutate} open={open} />
    ),
  ],
  [
    "folder",
    ({ node, nodes, editable, mutate, open }) => (
      <FolderWindow node={node} nodes={nodes} editable={editable} mutate={mutate} open={open} />
    ),
  ],
  [
    "adapter",
    ({ node, editable, mutate }) => (
      <AdapterWindow node={node} editable={editable} mutate={mutate} />
    ),
  ],
  [
    "collection",
    ({ node, nodes, open }) => (
      <div>
        <p>新文件可归入这个集合，并通过事件插头触发分析。</p>
        {nodes
          .filter((item) => item.data.collection === node.id)
          .map((item) => (
            <button key={item.id} onClick={() => open(item.id)}>
              {item.title}
            </button>
          ))}
      </div>
    ),
  ],
  [
    "timer",
    ({ node, call, editable }) => (
      <TimerSettings node={node} call={call} editable={editable} />
    ),
  ],
]);
