import type { EventType, NodeType } from "@claude-bot/research-canvas-contract";
export interface NodePlugin {
  type: string;
  title: string;
  icon: string;
  color: string;
  width: number;
  height: number;
  events: { type: EventType; title: string }[];
  window:
    | "text"
    | "agent"
    | "file"
    | "group"
    | "audio"
    | "collection"
    | "folder"
    | "review"
    | "adapter"
    | "timer"
    | "unknown";
}
const entries: NodePlugin[] = [
  {
    type: "note",
    title: "便签",
    icon: "✎",
    color: "yellow",
    width: 245,
    height: 177,
    events: [],
    window: "text",
  },
  {
    type: "task",
    title: "任务",
    icon: "□",
    color: "white",
    width: 250,
    height: 150,
    events: [],
    window: "text",
  },
  {
    type: "finding",
    title: "研究结论",
    icon: "◇",
    color: "green",
    width: 265,
    height: 170,
    events: [],
    window: "text",
  },
  {
    type: "file",
    title: "文件",
    icon: "▤",
    color: "white",
    width: 240,
    height: 150,
    events: [{ type: "file.updated", title: "版本更新" }],
    window: "file",
  },
  {
    type: "agent",
    title: "Agent",
    icon: "✳",
    color: "white",
    width: 270,
    height: 180,
    events: [{ type: "agent.completed", title: "运行结束" }],
    window: "agent",
  },
  {
    type: "group",
    title: "飞书群",
    icon: "◉",
    color: "white",
    width: 255,
    height: 165,
    events: [{ type: "group.message", title: "群消息" }],
    window: "group",
  },
  {
    type: "workgroup",
    title: "研究工作群",
    icon: "◌",
    color: "green",
    width: 280,
    height: 190,
    events: [],
    window: "text",
  },
  {
    type: "audio",
    title: "会议录音",
    icon: "♫",
    color: "white",
    width: 250,
    height: 150,
    events: [{ type: "audio.transcribed", title: "转写完成" }],
    window: "audio",
  },
  {
    type: "folder",
    title: "研究目录",
    icon: "▰",
    color: "folder",
    width: 285,
    height: 185,
    events: [{ type: "file.created", title: "新增材料" }],
    window: "folder",
  },
  {
    type: "goal",
    title: "GOAL",
    icon: "◎",
    color: "goal",
    width: 310,
    height: 205,
    events: [],
    window: "text",
  },
  {
    type: "review",
    title: "审查",
    icon: "✓",
    color: "review",
    width: 275,
    height: 180,
    events: [],
    window: "review",
  },
  {
    type: "adapter",
    title: "投影适配器",
    icon: "⌁",
    color: "adapter",
    width: 275,
    height: 175,
    events: [{ type: "file.updated", title: "投影更新" }],
    window: "adapter",
  },
  {
    type: "collection",
    title: "资料集合",
    icon: "▱",
    color: "green",
    width: 250,
    height: 150,
    events: [{ type: "file.created", title: "新增文件" }],
    window: "collection",
  },
  {
    type: "timer",
    title: "定时器",
    icon: "◷",
    color: "white",
    width: 230,
    height: 150,
    events: [{ type: "timer.tick", title: "定时触发" }],
    window: "timer",
  },
];
export const plugins = new Map(entries.map((plugin) => [plugin.type, plugin]));
export const nodeTypes = entries as (NodePlugin & { type: NodeType })[];
export const pluginFor = (type: string): NodePlugin =>
  plugins.get(type) ?? {
    type,
    title: `未知类型 · ${type}`,
    icon: "◇",
    color: "white",
    width: 240,
    height: 155,
    events: [],
    window: "unknown",
  };
