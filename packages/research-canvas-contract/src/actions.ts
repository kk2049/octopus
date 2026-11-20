import { WORKFLOW_ACTIONS } from "./workflows.js";
import { EVIDENCE_ACTIONS } from "./evidence.js";
import { CLOUD_DOCUMENT_ACTIONS } from "./documents.js";
import { MEETING_ACTIONS } from "./meeting.js";
import {
  declareContract,
  refusalVocabulary,
  type PortActionSpec,
  type PortField,
} from "@claude-bot/typed-port-kit";

const str = (
  description: string,
  maxLength = 160,
  optional = false,
): PortField => ({ type: "string", description, maxLength, optional });
const json = (
  description: string,
  maxLength = 24_000,
  optional = false,
): PortField => ({
  type: "json",
  description,
  maxLength,
  optional,
  schema: { type: "object" },
});
const id = str("项目内的稳定对象 ID");
const request = str("本次操作的唯一请求 ID；重试必须沿用", 100);
/**
 * A text save larger than one call's `text` window is staged (2026-10-20):
 * begin → append × N → commit. The window stays per call; the body has no
 * total. Commit is the same compare-and-swap and atomic replacement as a
 * one-call save; nothing before commit touches the file.
 */
const textStage = {
  stage: { ...str("内容超过一次调用的 text 窗口时分段保存：begin 取得 upload，append 依次带 offset 与一段 text，commit 带 size 原子替换；整份一次给出时省略", 10, true), enum: ["begin", "append", "commit"] },
  upload: str("stage=begin 回答里的 upload；append 与 commit 必填", 32, true),
  offset: str("stage=append：这一段在新全文中的起始 UTF-8 字节，等于上一次回答的 size", 20, true),
  size: str("stage=commit：新全文的 UTF-8 总字节数，等于最后一次 append 回答的 size", 20, true),
} satisfies Record<string, PortField>;
const revision: PortField = {
  type: "integer",
  description: "读到的对象版本；过期时拒绝覆盖",
  minimum: 1,
  maximum: 2_147_483_647,
};
const action = (
  summary: string,
  operation: string,
  params: Record<string, PortField>,
): PortActionSpec => ({ summary, operation, params });
export const CANVAS_CONTRACT = declareContract({
  contract: "research-canvas/v2",
  summary: "人和 Agent 共用的研究图、项目资源、协作及自动化",
  refusals: refusalVocabulary(
    ["forbidden", "invalid", "conflict", "unavailable", "unknown"],
    { fallback: "unavailable", maxMessageLength: 600 },
  ),
  actions: {
    ...WORKFLOW_ACTIONS,
    ...EVIDENCE_ACTIONS,
    ...CLOUD_DOCUMENT_ACTIONS,
    ...MEETING_ACTIONS,
    graph_read: action("读取可编辑的图 YAML 快照；保留 snapshot，修改后 graph_apply", "read_project", { scope: str("可选节点 ID；导出它及相邻节点", 160, true) }),
    graph_apply: action("把 YAML 相对原快照的修改合入图 CRDT；返回有效值和冲突", "edit_graph", { request, yaml: str("编辑后的完整 YAML，保留 snapshot；不包含坐标和资源正文", 196608) }),
    layout_read: action("读取公共坐标和布局版本", "read_project", {}),
    layout_patch: action("异步修改位置/尺寸/固定标记和连接端口；返回并发覆盖信息", "edit_graph", { request, data: json("{edits:节点 ID 到 {position?:{x,y},size?:{width,height},pinned?:boolean},base:这些节点开始操作时的布局,ports?:边ID到{sourceSide?,targetSide?},basePorts?:开始操作时的端口}", 96000) }),
    layout_arrange: action("异步自动排版；保留固定节点并跳过基线后已改变的节点", "edit_graph", { request, data: json("{nodes:节点 ID 数组,mode:tree 或 compact,base:这些节点开始排版时的布局}", 96000) }),
    layout_move: action("一次提交节点位置与预览尺寸；过期时重新读取", "edit_graph", { request, revision: str("layout_read 的 revision", 64), positions: json("节点 ID 到 {x,y,width?,height?,pinned?}；省略尺寸保留原值", 96000), lease: str("可选布局动作租约", 100, true) }),
    layout_auto: action("将指定节点按横向树或紧凑网格排到公共画布；保留固定位置和卡片尺寸", "edit_graph", { request, revision: str("layout_read 的 revision", 64), node: { ...id, optional: true }, nodes: { ...json("可选节点 ID 数组；仅调整这些节点", 96000, true), schema: { type: "array", items: { type: "string" }, maxItems: 1000, uniqueItems: true } }, mode: { ...str("默认 tree；compact 紧凑排列", 20, true), enum: ["tree", "compact"] }, lease: str("可选布局动作租约", 100, true) }),
    layout_lease: action("获取或续期十秒布局动作租约；只在拖动和提交期间持有", "edit_graph", { lease: str("续期时提供原租约", 100, true) }),
    layout_release: action("结束布局动作，释放自己的租约", "edit_graph", { lease: str("租约", 100) }),
    ref_create: action("登记独立资源并返回固定 ref；随后用 YAML 把它纳入图", "edit_graph", { request, data: json("内置资源的 type、title 和类型数据；坐标不在这里") }),
    ref_describe: action("解析固定 ref；返回资源状态、文件和可调用工具", "read_project", { ref: str("节点的 ref", 320) }),
    document_write: action("直接保存真实正文文件；备份旧版本，不修改图", "edit_graph", { request, node: id, text: str("新的完整正文；stage=append 时为从 offset 起的一段", 196608, true), expected: str("可选正文版本；同步必须提供以免覆盖", 100, true), ...textStage }),
    text_versions: action("列出正文文件的保存历史", "read_project", { node: id, after: str("分页游标", 100, true) }),
    text_restore: action("恢复真实文件的历史版本，保留恢复前内容", "edit_graph", { request, node: id, version: str("历史版本 ID", 160) }),
    canvas_read: action(
      "读取项目概览或指定节点；大项目按游标翻页",
      "read_project",
      { after: str("分页游标", 100, true), node: { ...id, optional: true }, active: { type: "boolean", optional: true, description: "仅当前图成员；省略时兼容包含归档记录的读取" } },
    ),
    canvas_layout_check: action("检查指定层级的卡片重叠和关系交叉，返回有界 warnings", "read_project", {
      scope: str("文件夹 ID；省略为项目根层", 160, true),
      relations: { ...str("检查本层关系；none 仅检查卡片", 20, true), enum: ["none", "scope"] },
      layout: { ...str("统一读取公共画布坐标与尺寸；兼容旧 layout 参数", 20, true), enum: ["tree", "hierarchy", "canvas"] },
      expanded: str("tree 展开的节点 ID JSON 数组；省略只展开根 GOAL", 20000, true),
    }),
    canvas_snapshot: action("生成当前层级的安全 SVG 结构预览；不是浏览器页面截图", "read_project", {
      scope: str("文件夹 ID；省略为项目根层", 160, true),
      relations: { ...str("省略或 scope 显示本层关系，none 隐藏关系", 20, true), enum: ["none", "scope"] },
      layout: { ...str("统一读取公共画布坐标与尺寸；兼容旧 layout 参数", 20, true), enum: ["tree", "hierarchy", "canvas"] },
      expanded: str("tree 展开的节点 ID JSON 数组；省略只展开根 GOAL", 20000, true),
    }),
    canvas_changes: action("读取项目语义变更", "read_project", {
      after: str("上次收到的变更序号", 32),
    }),
    node_add: action("新增节点，自动记录实际决策者", "edit_graph", {
      request,
      data: json("节点类型、标题、摘要、阶段、初始坐标及类型数据"),
    }),
    adapter_register: action("登记一个可热插拔的细粒度投影适配器", "edit_graph", {
      request,
      attach: { type: "boolean", description: "是否立即添加到图；false 只登记资源并返回 ref", optional: true },
      data: json("适配器标题、监听资源、投影字段和受控入口", 20_000),
    }),
    adapter_publish: action("发布适配器读取到的一批结构化行", "edit_graph", {
      request,
      node: id,
      version: revision,
      data: json("来源版本、游标和 schema 约束下的标量行", 24_000),
    }),
    adapter_control: action("暂停、恢复或移除一个投影适配器", "edit_graph", {
      request,
      node: id,
      version: revision,
      state: { ...str("适配器生命周期"), enum: ["paused", "registered", "removed"] },
    }),
    node_update: action(
      "修改图标签或资源描述；图修改合入共同的 CRDT",
      "edit_graph",
      { request, node: id, version: revision, snapshot: str("读取时的图快照", 100, true), data: json("需要修改的字段") },
    ),
    node_archive: action("从图中摘除节点，保留底层资源和运行", "edit_graph", {
      request,
      node: id,
      version: revision,
      snapshot: str("读取时的图快照", 100, true),
    }),
    edge_add: action("新增不执行动作的语义关系", "edit_graph", {
      request,
      snapshot: str("读取时的图快照", 100, true),
      source: id,
      target: id,
      label: str("关系，例如 supports、contains、支持", 120),
    }),
    edge_archive: action("从图中摘除语义关系", "edit_graph", {
      request,
      edge: id,
      version: revision,
      snapshot: str("读取时的图快照", 100, true),
    }),
    review_decide: action("更新一个独立审查节点的结论", "edit_graph", {
      request,
      node: id,
      version: revision,
      decision: { ...str("审查结论"), enum: ["approved", "changes_requested", "pending"] },
      targets: json("审查时读取到的目标版本摘要", 20_000),
    }),
    proposal_resolve: action("确认或拒绝具体整理提案", "edit_graph", {
      request,
      proposal: id,
      version: revision,
      decision: { ...str("处理决定"), enum: ["approve", "reject"] },
    }),
    document_read: action(
      "读取真实正文文件或公共布局及版本；正文可带 offset 分段读取任意大小，每段 256 KiB，按返回的 next 继续直到 null，各段 revision 相同",
      "read_project",
      {
        node: id,
        field: { ...str("协作字段"), enum: ["text", "layout"] },
        offset: str("可选：正文字节偏移，首段为 0，之后用返回的 next；省略时整份返回（超过 1 MiB 拒绝）", 20, true),
      },
    ),
    resources_list: action(
      "列出当前成员可以绑定到项目的运行资源",
      "read_project",
      {},
    ),
    resource_bind: action(
      "将本人有权共享的资源显式绑定到节点",
      "manage_resources",
      { request, node: id, data: json("绑定种类、资源 ID、配置；不接受凭据") },
    ),
    resource_read: action(
      "读取已绑定对象的历史、文件或媒体块",
      "read_project",
      {
        node: id,
        cursor: str("分页或分块游标", 512, true),
        version: str("固定资源版本", 100, true),
      },
    ),
    file_link: action("登记绑定工作区中的真实文件并返回 ref；不会复制文件或自动加入图", "edit_graph", {
      request, agent: str("已经绑定工作区的 Agent 节点或 ref", 320),
      path: str("工作区内的文件路径", 2000), title: str("文件显示名", 160, true),
    }),
    file_write: action("直接保存 ref 指向的真实文本文件；不会提交图结构", "edit_graph", {
      request, node: id, text: str("新的完整 UTF-8 文件内容；stage=append 时为从 offset 起的一段", 196608, true),
      expected: str("可选真实文件摘要；同步必须提供以免覆盖；stage=commit 必填（begin 回答的 digest）", 100, true), ...textStage,
    }),
    file_versions: action("列出文件节点的历史版本", "read_project", {
      node: id,
      after: str("版本分页游标", 100, true),
    }),
    file_begin: action("准备文件或会议音频的新完整版本", "edit_graph", {
      request,
      node: id,
      data: json("name、mime、bytes、sha256"),
    }),
    file_chunk: action("追加可续传的文件块", "edit_graph", {
      upload: id,
      offset: str("字节偏移", 32),
      data: str("文件块 base64", 48_000),
    }),
    file_commit: action("提交已校验的完整文件版本并产生事件", "edit_graph", {
      request,
      upload: id,
    }),
    audio_transcribe: action("用明确配置的 MOSS 转写设备处理音频、检查完整性并整理带来源的纪要", "transcribe_audio", {
      request,
      node: id,
      version: revision,
      summary: json("可选纪要选择：{kind:none}仅转写；{kind:agent,agent}或{kind:codex,resource,account?,model?,effort?}完成转写后整理", 24_000, true),
    }),
    agent_send: action(
      "向 Agent 的手动会话追加任务；沿用绑定资源",
      "run_agent",
      { request, node: id, prompt: str("任务或批注", 24_000) },
    ),
    agent_stop: action("停止指定运行；关闭窗口不会停止运行", "run_agent", {
      request,
      run: id,
      node: { ...id, optional: true },
    }),
    session_read: action("读取所选 Agent 会话的完整历史窗口", "read_project", {
      node: id,
      conversation: str("手动或监听会话 ID", 240),
      offset: str("历史消息偏移", 32, true),
    }),
    session_file_read: action(
      "读取 Agent 明确绑定工作区内的引用文件，逐块校验版本",
      "read_project",
      {
        node: id,
        path: str("工作区内文件路径", 2000),
        cursor: str("字节偏移", 32, true),
        version: str("固定文件摘要", 100, true),
      },
    ),
    session_attach: action("向绑定会话上传本人选择的附件块", "run_agent", {
      node: id,
      name: str("文件名", 240),
      media_type: str("文件 MIME", 160),
      chunk_index: str("当前分块", 16),
      chunk_count: str("总分块", 16),
      upload_id: str("续传 ID", 100, true),
      data: str("文件块 base64", 48000),
    }),
    session_respond: action("回答绑定会话当前的人类交互请求", "run_agent", {
      request,
      node: id,
      conversation: str("手动或监听会话 ID", 240),
      interaction: id,
      response: json("针对当前请求的一次性回答"),
    }),
    source_list: action("读取讨论来源与处理进度", "read_project", {}),
    source_read: action("读取指定来源的阶段、完整性与派生材料", "read_project", { node: id, version: str("来源版本", 100, true) }),
    source_retry: action("明确重新处理失败的来源；录音还需转写权限", "run_agent", { request, node: id, version: str("来源版本", 100, true) }),
    discussion_create: action("明确创建飞书讨论群并绑定到项目；未知结果不自动重发", "create_discussion_group", { request, node: id, title: str("群标题", 160), agenda: str("讨论议题", 2000, true) }),
    discussion_follow: action("按本任务开启或关闭讨论群增量采集", "run_agent", { request, node: id, data: json("{enabled:boolean,cursor?:string}") }),
    discussion_sync: action("立即采集绑定讨论群的新消息并整理为候选", "run_agent", { request, node: id }),
    discussion_capture: action("将选定群消息区间固定为原始记录并创建可编辑纪要；不发送消息或启动 Agent", "edit_graph", {
      request, node: id, from: str("区间最早消息 ID", 200), to: str("区间最新消息 ID", 200), title: str("讨论标题", 160),
    }),
    group_send: action(
      "向绑定群发送一条消息；未知结果不自动重试",
      "send_message",
      { request, node: id, text: str("群消息正文", 8_000) },
    ),
    subscription_save: action(
      "配置事件插头；每条连接有独立持续会话",
      "run_agent",
      { request, data: json("订阅 ID/版本、源、目标、事件、筛选、任务与启停") },
    ),
    tools_search: action("按节点、类型或用途检索项目工具", "read_project", {
      query: str("检索词", 300, true),
      node: { ...id, optional: true },
    }),
    tools_describe: action("读取一个工具的完整参数定义", "read_project", {
      tool: str("工具名"),
    }),
    tools_invoke: action(
      "调用已登记对象的工具；执行相同项目和资源权限",
      "read_project",
      { tool: str("工具名"), params: json("工具参数；被调用动作仍独立校验自己的长度上限", 262_144) },
    ),
  },
});
export type CanvasAction = (typeof CANVAS_CONTRACT.actionIds)[number];
export const CANVAS_ACTIONS = CANVAS_CONTRACT.actionIds;
export const CANVAS_OPERATIONS = [...CANVAS_CONTRACT.operations];
