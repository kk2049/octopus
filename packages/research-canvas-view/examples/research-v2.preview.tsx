/** Synthetic interaction fixture only. This file never enters the released App. */
import {
  defineCustomPreview,
  type FixtureAgentViewClient,
} from "@claude-bot/agent-view-preview";
import type {
  ResearchNode,
  ResearchEdge,
  ResearchSubscription,
} from "@claude-bot/research-canvas-contract";
import { App } from "../src/App.js";
import { toBase64 } from "../src/collaboration.js";
const nativePreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('native');
const stamp = {
  kind: "human" as const,
  owner: "林同学",
  trigger: "林同学",
  agent: null,
  run: null,
  model: null,
  at: "2026-09-17T09:00:00Z",
};
const nodes: ResearchNode[] = [
  {
    id: "question",
    type: "note",
    title: "从一个值得追问的问题开始",
    summary: "样本量变化会怎样影响实验结论？",
    phase: "past",
    x: 150,
    y: 170,
    data: {
      text: "我们需要区分模型能力与数据分布的影响。\n\n请保留支持和反对这一假设的证据。",
    },
  },
  {
    id: "paper",
    type: "file",
    title: "实验记录.md",
    summary: "原始数据与第一轮实验方法",
    phase: "past",
    x: 490,
    y: 140,
    data: {},
  },
  {
    id: "researcher",
    type: "agent",
    title: "实验研究员",
    summary: "梳理证据，提出下一步实验",
    phase: "present",
    x: 825,
    y: 240,
    data: { instructions: "保留原意，关键成果及时记录。" },
  },
  {
    id: "finding",
    type: "finding",
    title: "目前能够确认的结论",
    summary: "两个子集上观察到相同趋势；仍需对照实验。",
    phase: "present",
    x: 480,
    y: 405,
    data: { text: "重复实验支持这一趋势，但证据还不足以推断因果。" },
  },
  {
    id: "group",
    type: "group",
    title: "实验讨论群",
    summary: "共享问题、讨论结果与待办",
    phase: "present",
    x: 140,
    y: 455,
    data: {},
  },
  {
    id: "audio",
    type: "audio",
    title: "周四研究例会",
    summary: "会议录音与转写",
    phase: "past",
    x: 825,
    y: 515,
    data: {},
  },
  {
    id: "next",
    type: "task",
    title: "扩大样本的对照实验",
    summary: "下一步：检查边界条件",
    phase: "future",
    x: 1180,
    y: 205,
    data: { text: "增加一组随机采样对照。" },
  },
].map((node) => ({
  ...node,
  schema: 1,
  version: 1,
  archived: false,
  created: stamp,
  updated: stamp,
})) as ResearchNode[];
const edges: ResearchEdge[] = [
  ["question", "paper", "佐证"],
  ["paper", "researcher", "输入"],
  ["researcher", "finding", "产物"],
  ["finding", "next", "支持"],
].map(([source, target, label], index) => ({
  id: `edge-${index}`,
  source,
  target,
  label,
  version: 1,
  archived: false,
  created: stamp,
  updated: stamp,
}));
const subscriptions: ResearchSubscription[] = [];
const bodies = new Map(nodes.map(node => [node.id, String(node.data.text ?? "")]));
const positions = Object.fromEntries(nodes.map(node => [node.id, { x: node.x, y: node.y }]));
let layoutRevision = 1;
let cursor = 0;
const changes: { bucket: string; id: string; record: unknown }[] = [];
const projection = () => ({
  canvas: {
    project: "synthetic-research-preview",
    viewer: "林同学",
    role: "owner",
    epoch: cursor,
  },
});
function changed(bucket: string, id: string, record: unknown) {
  changes.push({ bucket, id, record });
  cursor++;
  queueMicrotask(() =>
    (
      globalThis as unknown as { __appPreview: FixtureAgentViewClient }
    ).__appPreview?.setProjection(projection()),
  );
}
export default defineCustomPreview({
  kind: "custom",
  app: "research-v2",
  title: "自动科研 v2 · 合成数据交互预览",
  projection: projection(),
  render: () => <App />,
  actions: {
    canvas_read: () => ({
      result: {
        ...projection().canvas,
        revision: String(cursor),
        nodes,
        edges,
        subscriptions,
        proposals: [],
        runs: [],
        cursor,
        next: null,
      },
    }),
    canvas_changes: (params) => ({
      result: {
        changes: changes.slice(Number(params.after)),
        revision: String(cursor),
        cursor,
        hasMore: false,
      },
    }),
    layout_read: () => ({ result: { revision: String(layoutRevision), sequence: layoutRevision, positions } }),
    layout_patch: params => {
      const data = JSON.parse(params.data);
      for (const [id, edit] of Object.entries(data.edits) as [string, { position?: { x: number; y: number }; size?: { width: number; height: number }; pinned?: boolean }][]) positions[id] = { ...positions[id], ...edit.position, ...edit.size, ...(edit.pinned === undefined ? {} : { pinned: edit.pinned }) };
      layoutRevision++; changed("layout", "board", null);
      return { result: { status: "merged", conflicts: [], issues: [], layout: { revision: String(layoutRevision), sequence: layoutRevision, positions } } };
    },
    layout_lease: { result: { lease: "fixture-gesture" } },
    layout_release: { result: { released: true } },
    layout_move: params => {
      if (params.revision !== String(layoutRevision)) return { result: { status: "rejected", error: { message: "布局已变化" } } };
      Object.assign(positions, JSON.parse(params.positions)); layoutRevision++;
      changed("layout", "board", null);
      return { result: { status: "merged", layout: { revision: String(layoutRevision), positions } } };
    },
    document_read: params => ({ result: { revision: String(cursor), data: { text: bodies.get(params.node) ?? "" } } }),
    document_write: params => {
      bodies.set(params.node, params.text); changed("document", params.node, null);
      return { result: { revision: String(cursor) } };
    },
    resources_list: { result: { resources: [] } },
    resource_read: (params) => ({
      result:
        params.node === "researcher"
          ? {
              runs: [],
              messages: [
                {
                  id: "m1",
                  run: "r1",
                  conversation: "manual:researcher",
                  role: "assistant",
                  text: "已阅读项目线索。关键方法记录在 [实验记录.md](paper)，接下来可以核对对照组。",
                  at: stamp.at,
                },
                {
                  id: "m2",
                  run: "r1",
                  conversation: "manual:researcher",
                  role: "tool",
                  tool: "canvas_read",
                  arguments: '{"node":"paper"}',
                  text: "读取了实验记录",
                  at: stamp.at,
                },
              ],
              older: null,
              binding: { owner: "林同学", resource: "预览资源", kind: nativePreview ? "session" : "agent" },
            }
          : params.node === "group"
            ? {
                items: [
                  {
                    message_id: "chat1",
                    sender: "周同学",
                    body: "下一轮实验可以增加一组随机采样对照。",
                    create_time: "1789635600000",
                  },
                ],
                has_more: false,
              }
            : params.node === "paper"
              ? {
                  file: {
                    id: "paper-v1",
                    name: "实验记录.md",
                    mime: "text/markdown",
                    bytes: 54,
                    sha256: "synthetic",
                    version: 1,
                  },
                  data: toBase64(
                    new TextEncoder().encode(
                      "# 实验记录\n\n第一轮观察到稳定趋势，仍需对照实验。",
                    ),
                  ),
                  next: null,
                }
              : null,
    }),
    file_versions: {result:{files:[{id:'paper-v1',name:'实验记录.md',version:1}],next:null}},
    session_read: {result:{transcript:{rich:true,sessionId:'fixture-native',messages:[{role:'user',blocks:[{type:'text',text:'请分析实验数据。'}]},{role:'assistant',blocks:[{type:'text',text:'分析结果见 [analysis.md](/work/research/analysis.md)。'},{type:'tool',tool:'research_canvas_read',input:'{}',output:'已读取项目。'}]}]}}},
    session_file_read: {result:{file:{id:'fixture-digest',name:'analysis.md',mime:'text/markdown',bytes:20,sha256:'fixture-digest',version:1},data:toBase64(new TextEncoder().encode('# 引用文件\n\n结果仍需要对照验证。')),next:null}},
    node_add: (params) => {
      const node = {
        ...JSON.parse(params.data),
        id: crypto.randomUUID(),
        schema: 1,
        version: 1,
        archived: false,
        created: stamp,
        updated: stamp,
        summary: "",
        phase: "present",
      } as ResearchNode;
      nodes.push(node);
      changed("nodes", node.id, node);
      return { result: { node } };
    },
    node_update: (params) => {
      const node = nodes.find((node) => node.id === params.node)!;
      const data = JSON.parse(params.data);
      if (data.cardKind) { node.data.meta = { ...(node.data.meta as object ?? {}), cardKind: data.cardKind }; delete data.cardKind; }
      Object.assign(node, data, {
        version: node.version + 1,
      });
      changed("nodes", node.id, node);
      return { result: { node } };
    },
    edge_add: (params) => {
      const edge = {
        id: crypto.randomUUID(),
        source: params.source,
        target: params.target,
        label: params.label,
        version: 1,
        archived: false,
        created: stamp,
        updated: stamp,
      };
      edges.push(edge);
      changed("edges", edge.id, edge);
      return { result: { edge } };
    },
    subscription_save: (params) => {
      const row = {
        ...JSON.parse(params.data),
        id: crypto.randomUUID(),
        version: 1,
        archived: false,
        created: stamp,
        updated: stamp,
        conversation: "fixture-listener",
        state: "ready",
        error: null,
      };
      subscriptions.push(row);
      changed("subscriptions", row.id, row);
      return { result: { subscription: row } };
    },
    agent_send: { result: { run: { id: "synthetic-run", status: "queued" } } },
    agent_stop: { result: { stopped: true } },
    group_send: { result: { status: "sent", message: "synthetic-receipt" } },
  },
});
