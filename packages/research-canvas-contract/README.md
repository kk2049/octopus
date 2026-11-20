# Research canvas contract

自动科研 v2 的共享模型和闭合动作声明；无传输、存储或授权实现。
Host 从同一声明生成 App manifest 与 MCP schema，并逐次检查项目和资源授权。

`graph-document.ts` 定义 `research-graph/v1` YAML 投影：
nodes 按稳定 ID 映射到 ref/label，edges 映射到 from/to/relation，
snapshot 标识原始因果基线。坐标、资源内部内容、插件代码不属于 YAML。
图 CRDT 管结构与公共坐标、卡片宽高和固定标记；文件、Agent 和适配器由独立资源注册表管理。
`model.ts` 的 ResearchNode 是面向浏览器的组合投影，不是 YAML 数据模型。
resourceVersion 与卡片图版本分别表达资源和图变化。

`actions.ts` 的 profile 为 `research-canvas/v2`。Agent 首选
graph_read/apply 或本地 MCP graph_checkout/commit；人类 UI 的 node/edge
动作进入同一个 CRDT。文件直接读写，布局首选 layout_patch / layout_arrange 的有界 data 参数，位置、尺寸和固定标记独立合并；旧 layout_move 仍校验 revision 与可选租约。
回执返回最终冲突值；不能把 merged_with_conflicts 当作全部意图获胜。

`layout.ts` 共享卡片边界、分层显示与有限几何诊断。canvas_snapshot 是结构 SVG；
实际页面 PNG 由明确配置浏览器的工作区 MCP 返回，带图/布局版本。
