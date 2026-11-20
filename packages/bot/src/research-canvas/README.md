# 自动科研 v2 trusted host

在现有 research-v2 中替换图核心，复用共享实例、身份、成员、权限、工作区、
原生会话和前端内置组件。平台只持有一个权威 Head 图副本；客户端可从不同的
因果快照编辑，提交时转换为 Yjs 操作。当前不是多个 Head 对等写入部署。

## 讨论、执行和人审工作台

来源、候选、Agent 草稿、规则、人审、报告和任务级论文同步共用此 host/plane。
审查为显式 flag；策略按 Agent/任务指定；报告分别显示最新与采纳。
部署与外部材料联调边界、数据桶和新增权限见
[本次交付](../../../../doc/deliveries/2026-09-26-research-workbench.md)。

## 数据边界

- `graph-documents`、`graph-crdt`：节点的稳定 ID/ref/label、边的端点/关系、
  坐标和图提交回执。YAML 是可编辑快照，不是实时共享的权威文件。
- `graph-yaml`：闭合 YAML schema。忽略排版/注释，按 ID 和字段计算差异。
  不允许坐标、资源正文、任意自定义字段、重复键或可执行 YAML 标签。
- `node-resources`：资源注册表。图通过固定 ref 引用它。移除图成员不删除文件、
  不停止会话、不停止订阅；同一资源可以有多个卡片。
- `text-files`：便签等正文迁移到普通 UTF-8 文件，浏览器保存覆盖文件，
  fs.watch 推动前端刷新。旧版本在独立文件历史中；正文不再进入图 CRDT。
  正文不限大小：`document_read` 带 offset 按 256 KiB 窗口（字符边界）读取，
  各窗口带同一整文件 revision；不带 offset 的旧调用仍整份返回且超过 1 MiB 拒绝。
  需要整份字符串的内部消费者（规则、提示、同步）预算 16 MiB；保存也不限大小：
  一次 `document_write` 是一个参数窗口，更长的正文按 `stage=begin/append/commit`
  分段暂存到工作区旁的 `staging/`（每项目最多 16 个、闲置 10 分钟清扫），commit
  才备份旧版本并一次 rename 替换；旧版本备份与恢复按文件复制，不整份载入。
- `native-files`：绑定工作区文件的读写复用既有 Runner Gate。file_link 返回 ref，
  同时固定 Agent 资源、相对路径和绑定版本。重新绑定 Agent 不会悄悄改指向。
  `file_write` 不限大小：超过一次设备调用的整份文本由 bot 自动分段；超过一次
  动作调用的文本按同一套 `stage` 分段，每一步直接映射到 Runner 的分段暂存写
  （workspace-files begin/append/commit），commit 仍是设备端 CAS + 原子替换。
  设备暂存 id 由项目、执行者、文件和令牌派生，别人的令牌指不到这次上传。
- `resources`：显式共享绑定及上传的不可变文件版本。
- `automation/native`：资源内部状态、持久会话及现有 managed-execution。
  图变化不自动形成执行依赖或触发 agent；窗口关闭不取消运行。

`plane` 是 App action 门。每次调用都复核成员/权限；资源操作还复核资源归属人的
授权。actor、project、provenance 来自可信实例，客户端参数不能伪造。
新 `research-canvas/v2` profile 使用 `edit_graph`，并显式声明
`replace_workspace_text`；旧授权不自动继承新增权力。外部消息仍需单独授权。

## 原生 Agent 权限档位

人工通过 `resource_bind` 授权原生会话时，可在 `config.permissionProfile`
选择共享契约中的 `manual` 或 `full_access`。该选择属于带版本的资源绑定，
新建监听会话和继续已有会话都沿用它；任务提示词不能修改权限档位。
OMP 不支持人工审批，拒绝 `manual`。省略此字段保留既有执行器/Runner 默认行为，
不将已有绑定自动升级。Codex 的 `full_access` 会关闭命令审批和文件系统沙箱，
只应由持有设备与项目资源授权的人在明确同意后选择。

更改档位仍经过人工 `manage_resources`、归属人的工作区登记和授权检查，
递增绑定版本并使旧版本的执行及文件链接失效。更改后须明确重新关联文件；
不会把旧链接悄悄改指向。Agent/研究成员不能借发送任务自行提升绑定权限。

## 因果提交与恢复

graph_read 持久化原始因果状态和导出范围，返回两小时有效的 snapshot。
graph_apply 在原状态上构造一次提交，再合并当前状态。不同节点/字段独立合并；
同字段竞争返回 base/current/submitted/effective。并发删除不复活，已使用 ID
不能复用；悬空边保留在图中并返回 issue，渲染时不画缺端点的关系。
局部导出的省略只删除该快照范围内原有对象，其他并发新增保留。

提交顺序是验证 → CRDT 更新及回执一起 append/fsync → 重建 SQL 索引 → SQL
请求回执 → 响应。CRDT 中的有限回执桥接提交成功但 SQL/响应未完成的崩溃窗口；
稳定 request 在新 MCP turn 中也能回读相同结果。二进制不存入 App State。

布局与图结构同处一个 CRDT，YAML 不包含坐标。layout_patch 接受一个 data 对象，
其中 edits 按节点包含 position 坐标对、size 宽高对及 pinned，base 用于并发诊断。
单权威 Head 按接收顺序把字段动作写入 Yjs；相同字段并发采用后接受的动作并在
conflicts 返回前后意图。不是浏览器对等 Yjs 副本，也不支持多 Head 并行写入。
不同节点、位置与尺寸互不覆盖；删除节点不会被布局动作复活。layout_arrange
只调整基线后未改变的节点，继续保留固定位置和尺寸。每次提交的 sequence 随 CRDT
一起持久化，客户端用它拒绝旧回执/读取。稳定 request 沿用原有持久回执恢复。
layout_move/auto 的严格 revision/租约保留给旧调用者；它们不锁定新异步编辑接口。
新节点自动补位；相机、窗口、选区、待确认动作和草稿属于浏览者本地状态。

node_update 的 cardKind 只修改普通正文节点的展示角色，不重写资源 type/ref。
文件、Agent、adapter 不能经该入口转换成内容卡片；特殊资源和真实正文继续由
各自 provider 管理，界面默认按钮只打开 Agent 交互入口，发送仍须显式提交。

## 热路径与投影失效

单 Head 进程在成功持久化后失效图投影缓存，保留最多 8 个项目；重建 SQL
索引与恢复回执每个驻留项目执行一次（恢复标记最多 32 个），进程重启仍从 CRDT
恢复。缓存只复用图投影，资源正文仍按资源版本读取，plane 每次调用仍检查权限。
因果快照按项目、归属人和范围复用至过期；结构写入立即失效，纯布局写入不重复
导出整个 CRDT。布局不在 YAML 中，旧快照仍能合并后续结构写入。

canvas_read 的可选 active=true 省略归档记录，每桶上限 200，仍使用统一词法
游标；旧调用保留包含归档记录的 60 行分页。canvas_changes 仍传递删除记录。
plane 同时提供 epoch 与 dataEpoch：前者唤醒布局，后者只在数据变化时推进，
避免每次拖动都重读图、工作流和聊天。旧客户端仍使用 epoch。

node_add 的可选 data.parent={id,label} 将新节点和 contains/decomposes 关系
放进同一次图提交，回执包含新节点、关系和父节点投影。相同 request 重放相同
结果；旧版三步创建的待恢复请求仍沿用原路径。资源创建与图提交仍保留原有
幂等边界，未引入新的跨存储事务。

## 工作区 MCP 与插件

`ctl/research-workspace-mcp.ts` 是可选本地 stdio MCP，桥接统一 HTTP
`/api/mcp` 的 app_dispatch，并提供 graph_checkout/commit、ref_invoke、
工作区备份和浏览器 JPG/PNG 工具。见
[Agent 工作流](../../../../doc/development/research-canvas-agents.md)。

插件代码只在 agent 的明确工作区进程执行。使用既有 adapter 注册表和内置组件
发布投影，声明 JSON Schema 工具，由 ref_invoke 校验并调用。
这不允许 YAML 指定 Head 或浏览器要执行的代码。插件和真实文件内部更新不动图。

工作区 MCP 存活时默认每分钟 checkpoint，保留最近 120 个；恢复前再次备份。
它按文件保存，不能保证多个文件同一时刻，也不能追回采样间隔内每次外部写入。
远程工作区只有在该工作区运行/配置备份时才覆盖，不自动备份所有 Runner。

## 迁移与运维

首次打开旧实例，复制旧节点为独立资源、保留 node/edge ID 和 provenance，
把 folder.members 转成 contains 边，迁移布局。旧 SQL/Yjs 数据保留原处。
旧正文第一次读取迁移到文件。正文保存和图提交独立，不构成跨存储事务。

备份 SQLite、research-v2 整个数据目录和各工作区 `.research-history`。
回退旧实现前停写并导出新图/文件；旧实现只看旧快照，不会理解新写入。
恢复部署前的完整备份会丢失备份后的工作，不能把它当成无损降级。

聚焦验证覆盖原始因果合并、删除/碰撞、持久回执重放、范围/权限/迁移、文件、
真实 Runner 文件 Gate、HTTP MCP、布局租约和插件。open.test.ts 的可选
RESEARCH_TEST_BROWSER 验证实际打包的 ESM 页面、HTTP 动作、文件保存、拖动、
自动排版和 stdio MCP 图片。计算及浏览器验收在计算设备执行，不在 Head 上。

## 阅读与过程记录

contains 成员投影适用于所有父节点，新增或移除关系后刷新父节点的成员描述。
树模式使用共享的有界卡片尺寸和迭代展开布局；个人展开不持久化到图。

discussions 固定已绑定群的闭区间消息，跨页验证完整性后登记不可变原始记录
和带来源的可编辑纪要。记录先创建为独立 ref，最后一次图操作纳入成员与关系；
中断后按相同 request 复用已有原始记录，拒绝请求 ID 携带不同区间。
读取与登记仍分别执行原权限检查，无群发送或任务执行副作用。

## 会议录音与所选 Agent

录音卡片直接上传到不可变文件版本。`audio_transcribe` 可指定
`summary: {kind: "none"}` 只转写，或选择已绑定 Agent / 本人已登记的 Codex
来源，在完整性验证后继续生成纪要。省略 summary 的旧客户端仍沿用站点文本
模型；新前端必须明确给出选择，不能上传即自动执行。

MOSS 使用第一方 `meeting_transcription_*` 闭集 RPC。Head 只配置设备及等待
上限，脚本、模型、运行目录由设备私有配置固定，研究层没有通用 exec 回退。
六项独立权限与原项目操作分别检查；共享录音使用录音归属人的设备授权。
配置和恢复步骤见 [Runner 运行说明](../../../../doc/runbooks/meeting-transcription-runner.md)。

`meeting-flow` 在 `meeting-plans` 固定音频版本和处理选择，在
`meeting-summaries` 记录整理轮次、所选 Agent、真实 run 及完整来源读取游标。
运行复用既有 automation/native 队列；重启只跟踪已有运行，不重放模型任务。
`source_segments` 按时间顺序分页直到 next=null，`source_summary_submit`
仅接受该轮被选中的可信 Agent/run，核对完整读取及候选证据后创建可编辑纪要
和待审候选。后续重新整理另存一份纪要，保留用户已改文本。

候选生成与任务下发独立。用户编辑、确认、选择执行 Agent 后，原有
`candidates_publish` 的 human-only 路径才可发布并执行。模型声明完成、
会话退出或仅生成自然语言回复都不等于已提交结构化纪要。

卡片只投影 `node.data.meta.meeting` 的文件版本、名称、大小和阶段，正文及
音频不进入图快照；音频播放按需加载。来源状态固定 file.id，不能把上一个
录音版本的纪要当成本次结果。异步绑定前后复核授权；相同请求恢复返回真实
当前 run，不用初始 queued 回执回退卡片状态。
