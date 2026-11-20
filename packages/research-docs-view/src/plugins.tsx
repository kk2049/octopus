import { createContext, useContext } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
export interface ResourceProps {
  plugin: string;
  project: string;
  node: string;
  card?: string;
  title: string;
  summary: string;
  file: string;
  media: string;
  size: number;
}
export interface DocumentPlugin {
  id: string;
  label: string;
  icon: string;
  description: string;
  accepts(node: ResearchNode): boolean;
}
export const plugins: readonly DocumentPlugin[] = [
  {
    id: "agent",
    label: "Agent 会话",
    icon: "✳",
    description: "在文档旁继续工作",
    accepts: (n) => n.type === "agent",
  },
  {
    id: "audio",
    label: "会议录音",
    icon: "♫",
    description: "录音、文字与纪要",
    accepts: (n) => n.type === "audio",
  },
  {
    id: "file",
    label: "文件资料",
    icon: "▤",
    description: "论文、代码和本地文件",
    accepts: (n) => n.type === "file",
  },
  {
    id: "evidence",
    label: "研究结果",
    icon: "▥",
    description: "保留结果与来源",
    accepts: (n) =>
      Boolean(
        n.data.meta &&
          typeof n.data.meta === "object" &&
          !Array.isArray(n.data.meta) &&
          n.data.meta.reportId,
      ) || n.type === "result",
  },
  {
    id: "note",
    label: "研究笔记",
    icon: "≡",
    description: "任务、笔记与讨论",
    accepts: () => true,
  },
];
export const pluginFor = (id: string) =>
  plugins.find((p) => p.id === id) ?? {
    id,
    label: "扩展元件",
    icon: "◇",
    description: "保留原始引用",
    accepts: () => false,
  };
export const ResourceContext = createContext<{
  open: (props: ResourceProps) => void;
}>({ open: () => {} });
export const researchResource = createReactBlockSpec(
  {
    type: "researchResource",
    propSchema: {
      plugin: { default: "file" },
      project: { default: "" },
      node: { default: "" },
      card: { default: "" },
      title: { default: "未命名资料" },
      summary: { default: "" },
      file: { default: "" },
      media: { default: "" },
      size: { default: 0 },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const ctx = useContext(ResourceContext),
        p = block.props,
        plugin = pluginFor(p.plugin);
      return (
        <div
          className={"rd-resource rd-resource-" + p.plugin}
          contentEditable={false}
          data-resource-kind={p.plugin}
        >
          <span className="rd-resource-icon" aria-hidden>
            {plugin.icon}
          </span>
          <div className="rd-resource-text">
            <span className="rd-eyebrow">
              {p.file ? "文档附件" : plugin.label}
            </span>
            <strong>{p.title}</strong>
            {p.summary && <p>{p.summary}</p>}
            <span className="rd-resource-origin">
              {p.file ? formatBytes(p.size) : "关联原始资料 · 按需加载"}
            </span>
          </div>
          <button
            className={p.plugin === "agent" ? "rd-primary" : "rd-resource-open"}
            type="button"
            onClick={() => ctx.open(p)}
          >
            {p.plugin === "agent"
              ? "继续聊天 ↗"
              : p.plugin === "audio"
                ? "打开录音 ↗"
                : "打开 ↗"}
          </button>
        </div>
      );
    },
    toExternalHTML: ({ block }) => (
      <div>
        <strong>{block.props.title}</strong>
        <p>{block.props.summary}</p>
        <span>
          {block.props.project} / {block.props.node || block.props.file}
        </span>
      </div>
    ),
  },
);
export const resourceFromNode = (project: string, n: ResearchNode) => ({
  type: "researchResource" as const,
  props: {
    plugin: plugins.find((p) => p.accepts(n))!.id,
    project,
    node: n.ref || n.id,
    card: n.id,
    title: n.title,
    summary: n.summary.slice(0, 500),
  },
});
export function formatBytes(size: number) {
  return size < 1024
    ? size + " B"
    : size < 1024 * 1024
      ? (size / 1024).toFixed(1) + " KB"
      : (size / 1024 / 1024).toFixed(1) + " MB";
}
