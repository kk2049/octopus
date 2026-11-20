# 科研工作区工具

新的 YAML 接口、MCP 安装、备份和权限说明以
[Agent 工作流](../../doc/development/research-canvas-agents.md)为准。

- ctl/research-workspace-mcp.ts：本地 stdio MCP，graph_checkout/commit、
  ref_invoke、工作区历史和可选实际页面截图。
- metrics-plugin.example.mjs：项目内插件示例。复制到配置的 workspace，
  显式加载；登记独立 adapter ref，观察 metrics.json，内置表格呈现。
- capture-page.mjs：在指定计算设备中，用自己的已授权浏览器状态捕获实际页面 JPG/PNG（由 --out 后缀选择）。
  返回图/布局版本和节点像素范围，不以结构 SVG 代替页面。
- adapter-watch.ts：兼容既有受控投影 SDK；当前版本必须使用资源版本，
  不使用图卡片版本控制 adapter_publish。

下面保留既有种子和实例迁移脚本的用法。这些脚本不是部署步骤，
不会因为加载工作区 MCP 而自动运行。

## ACC canvas seed

`acc-seed.ts` turns the reviewed ACC source list into a deterministic, local
review plan. It reads only the paths named in
`/home/ubuntu/lht/octopus-worktrees/dev-codex-acc-v2-final/doc/research/acc-recycle-canvas.json`, checks realpaths against the allow-list, records SHA-256 receipts, and emits stable seed keys for nodes and semantic edges.

```sh
pnpm exec tsx scripts/research-v2/acc-seed.ts \
  --manifest doc/research/acc-recycle-canvas.json \
  --out /private/acc-recycle-seed.json
```

The output is a review artifact, not a database import and not a permission
grant. A trusted operator must inspect the receipts, create the exact
`research-v2` shared instance, and apply `node_add`/`edge_add` through the
declared App action channel. File nodes are uploaded through the existing
`file_begin` → `file_chunk` → `file_commit` actions; the View never receives a
filesystem path. Session sources are metadata-only and deliberately have no
raw rollout payload. The seed does not bind an Agent, Feishu group, or running
campaign, and it does not mark any result as human-approved.

## 受控热插拔投影适配器

适配器在已授权 Runner workspace 内运行，不在 Octopus Head 或浏览器中执行任意
JavaScript。Agent 通过现有 `tools_invoke` 桥接把 `adapter_register`、
`adapter_publish` 和 `adapter_control` 请求发送给当前研究项目；桥接只接受当前
Agent 登记的 adapter namespace。每次发布都带来源 SHA-256、请求 ID 和版本 CAS，
投影行只允许 schema 中声明的标量列，最多 200 行。适配器不能改写原始文件、普通
节点或审查结论；人可以暂停、恢复或移除它。

`adapter-watch.ts` 提供一个真正的 `fs.watch` runner-side SDK。模块路径和来源路径
必须位于调用方提供的 workspace 根目录，模块需要导出 `register` 与
`project({text, sourcePath, sourceRevision})`。调用方传入已经授权的 transport 回调，
SDK 不接收 token，也不自行登录：

```ts
// toolsInvoke uses the current authorized project and unwraps its action result.
const receipt = ({ node }) => ({ node: node.id, version: node.resourceVersion ?? node.version });
const watcher = await startAdapterWatcher({
  workspaceRoot: "/runner/workspace/acc",
  sourcePath: "/runner/workspace/acc/metrics.json",
  modulePath: "/runner/workspace/acc/acc-adapter.mjs",
  onError: error => reportAdapterFailure(error),
  transport: {
    register: async ({ request, ...data }) => receipt(await toolsInvoke(
      "adapter_register", { request, data: JSON.stringify(data) })),
    read: async ({ node }) => {
      const result = await toolsInvoke("ref_describe", { ref: "adapter:" + node });
      return { node: result.resource.id, version: result.resource.version,
        status: result.resource.data.adapter.status };
    },
    publish: async ({ data, ...params }) => receipt(await toolsInvoke(
      "adapter_publish", { ...params, data: JSON.stringify(data) })),
    control: async input => receipt(await toolsInvoke("adapter_control", input)),
  },
});
```

transport 的 read 使用 ref_describe 读取独立资源，即使卡片已经摘除也可用；需要调用者原有的项目读取
授权，没有新增后端动作。所有发布和控制串行执行，每次先读当前版本和状态，
不把本地缓存版本当作权威。只对服务器明确的版本冲突最多重读重试一次；网络结果
未知不自动重放。传输层应保留服务端冲突错误消息，不把网络错误伪装成版本冲突。

来源文件变化重新读取并发布新 revision，也支持编辑器通过原子替换保存文件。
在网页或 SDK 暂停后不再发布；若来源已有待发布变化，默认每 2 秒只读检查一次
暂停状态，恢复后自动发布最新内容，移除后停止监听。pause()/resume() 与网页
按钮共享同一份状态；close() 关闭本地监听、清理定时器并等候在途操作结束。
异步失败保留在 watcher.error，并调用 onError；未提供回调时产生进程 warning，
不会静默吞错。成功发布后清除 error。

可运行投影模块见 scripts/research-v2/adapter-watch.example.ts。聚焦测试覆盖
真实 fs.watch、网页暂停/恢复、原子文件替换、CAS 竞争、错误可见性和移除停止：
node node_modules/vitest/vitest.mjs run --project node --maxWorkers=1 scripts/research-v2/adapter-watch.test.ts



## 既有实例层级投影

发布后可运行 interaction-migration.py 对 ACC、ArchTown、CXL-ZCOT 和 Octo
知识库实例做幂等的非破坏性投影。它只新增待审查文件夹、GOAL、独立审查节点和两条
语义关系；原有节点、正文、文件版本和历史 Agent 数据保持不变。脚本逐实例分页读取，
以标题前缀避免重复创建，完成后应回读节点与关系数量。

## ACC A–E 层级迁移（2026-09-22）

`acc-hierarchy-migration.py` 将人工整理的 `doc/research/acc-ae-plan-20260922.json`
投影为 A–E → 12 个具体事项 → 必要工作、现有材料、独立审查。32 项工作按真实下一步
选择分析/设计/写作/开发/测试，不为每个事项机械填满五类。18 个审查分别覆盖题面、
设计、实现或结果；所有审查初始为 pending。

脚本只通过 App 的 `node_add` 新建 82 个节点，不修改原始节点、正文、文件版本、
Agent 绑定、关系、审查目标或决定。原始资料以 ID 引用，原有目录和两位历史 Agent
收纳到资料馆。同一份材料可以从多个事项进入。没有新边，也不启动实验或 Agent。
任务字段位于现有标量元数据 `data.meta`：`workKind`、`status`、`claimedProgress`、
`progressSource`、`sourceAt`、`acceptanceStatus`、`evidenceNote`。文件夹复用
`data.members`；无后台 schema 扩展。任务保持 `todo`，用户声称已有实现/数据的进度
单独记录，不能当成验收。

默认 dry-run，必须指定唯一允许的 ACC instance。下面是离线预览示例（将输入/输出
路径替换为本次私有验收目录，文件必须尚不存在）：

```sh
python3 /home/ubuntu/lht/octopus-worktrees/dev-codex-acc-hierarchy-20260922/scripts/research-v2/acc-hierarchy-migration.py \
  --instance asi_51e0080bd7704fe9ac48d723b8c6fe45 \
  --graph /home/ubuntu/lht/acc-v2-recovery-20260922/current-acc-graph.json \
  --out /home/ubuntu/lht/acc-v2-recovery-20260922/evidence/acc-hierarchy-dry-run.json \
  --preview-out /home/ubuntu/lht/acc-v2-recovery-20260922/evidence/acc-hierarchy-preview-fixture.json
```

`--preview-out` 的图包含 `preview:` 临时 ID，仅用于私有前端 fixture，不能作为在线
导入数据。在线 dry-run 省略 `--graph`，使用 `--base` 和专用的 `--token-file`。
默认只允许 HTTPS 且校验证书；私有 CA 用 `--ca-file`。已核实的自签名测试站可显式
使用 `--insecure-tls`，脚本不会默默关闭验证。

实际执行再加 `--apply --backup-dir <绝对私有目录>`，并选择新的 `--out`。
此模式拒绝离线图，只接受现有 `codex_acceptance` editor/owner 的网页登录和 App
动作授权；不使用真实用户凭据、不更改成员、不调用 admin 接口、不伪装为 lht。
服务器将操作者如实记为 `codex_acceptance`；这是该专用验收账号的 App 操作通道，
MCP Agent 也通过新图 CRDT 直接编辑，旧提案描述不再适用于新 profile。新增审查从不调用 `review_decide`。

执行前再次完整读取图，和计划前像逐字段比对；任何并发变动都要求重新生成计划。
首个写入之前以 0600 保存原图、两位 Agent 绑定、计划；0700 目录中逐条 fsync 记录
发送前日志、请求 ID 和返回节点 ID。按 `migration + seedKey` 做身份匹配，稳定请求
ID 防重复；中途中断后回读再运行，不自动重试不明结果。已存在的 seed（含用户后来
修改的标题、状态和审查）不会重写；seed 冲突、被归档或 manifest 改版会拒绝继续。

执行后确认原节点/边/订阅/提案/绑定逐项不变，再生成 after receipt，验证再次执行
为零新增。审查目标绑定首次创建时的真实版本，后续 rerun 不刷新目标、不抹除 stale。
需要回退时依据 journal 只审查并归档本 migration 新增 ID；不要把全图备份覆盖回
生产，从而覆盖他人的后续研究工作。其他三个项目实例永远不在本脚本写入范围内。

离线校验：

```sh
python3 /home/ubuntu/lht/octopus-worktrees/dev-codex-acc-hierarchy-20260922/scripts/research-v2/acc-hierarchy-migration.test.py
```

测试覆盖指定实例/缺少来源拒绝、目录与原资产可达性、合法原生 node 数据、私有
备份、原内容/绑定/审查保护、中断续跑、零写入重跑、并发修改和重复 seed 拒绝。
