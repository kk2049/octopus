# Agent Sessions Contract — `agent-sessions/v1`

> 2026-08-06 新增（v4 模块平台第一纵切）。
> 设计：`doc/development/agentic-app-module-system-design.md` §15.2、§18.4

## 一句话

会话模块（roster / search / chat / new / operations）写给谁看：投影形状、action 与 operation 词表、
typed port，以及状态归属。**没有 React，没有传输，没有 Bot**——三个消费者要同意它，只有一个会渲染。

## port 上没有的东西，是这个包的全部意义

owner、用户名、app/scope id、instance handle、grant、capability、context id、规范路径、cookie、URL。
不是被过滤——是**不存在**。返回它们的 hook 只能编造，而编造身份正是整套架构在防的那一件事。

拒绝是**答案不是异常**：每个方法都 resolve，refusal 带一句给人看的有界文案，模块的职责是显示它而不是重试它。

## `directoryKey`：一个可选字段，而不是 `agent-sessions/v2`

2026-08-10（工单 #49）起 `SessionSummary` 与 `WorkspaceRow` 各多一个可选 `directoryKey`：一个有界、
opaque、不可逆的**相等令牌**，让会话行与 `workspace-files/v2` 的文件行说出「这是同一个真实目录」。

**为什么留在 v1，而 `workspace-files` 必须开新版本**——两个契约的演进规则本来就不同，而且是写在
本包文件头的：这里的类型 `?`-heavy 是刻意的，**没有任何 reader，也没有 `refuseUnknownFields`**，
一个缺失字段被当作缺席而不是被当作违约；它也不是 release 资产、不进任何 digest。
`workspace-files` 恰恰相反：严格 reader、未知字段即拒绝、是 binding plan 里被点名的 contract id。
所以「加一个可选字段」对本包是**它声明过的演进方式**，对那边是破坏性变更。

**缺席不是「更弱的 key」**：它是「这一侧不作承诺」。消费者绝不能因此回落到比 label / basename ——
那正是这个字段要消灭的缺陷。

2026-09-01（工单 #478）起，`directoryDeviceId?` 是跨机 placement 的可选展示坐标：`deviceId` 与
`resourceId` 仍指向 provider/运行机并用于读写，roster 的目录分组与 workspace 刷新使用
`directoryDeviceId ?? deviceId`。真实 `workspaceId` 仍不属于本契约；可信 Host 只投影由它铸出的
`directoryKey`。旧 Host 或普通本机会话缺字段时行为逐字不变。

## `title`：provider 有名字就直接用

2026-08-18 起 `SessionSummary.title?` 承载 CLI 自己维护的会话名。当前生产者是 Oh My Pi：
scanner 读取 `title` / `title_change` 状态，可信 Host 只把有界纯文本投影给 View。展示优先级是
`title → firstUserText → preview → projectLabel → sessionId`；没有该字段的 Claude Code / Codex
会话保持原来的回退行为。它与 `directoryKey` 一样是 v1 的可选展示字段，不参与身份、资源引用、
权限或 binding。

2026-08-22 起，`SessionsProjection.customTitles?` 是 Sessions+ App 自有的 durable 覆盖，按 opaque
session resource id 分键。展示优先级变为
`customTitles[resourceId] → title → firstUserText → preview → projectLabel → sessionId`。空标题表示清除
覆盖并恢复 provider 标题；它不改写 CLI transcript，也不进入 Gate operation。

`accountLabel?` 是 Codex 多账号路由的可选单字符展示元数据。它只接受可信 Runner 按本机账号池顺序
铸出的 `a`–`z`，展示在既有 provider/model 文案中（如 `Codex-a`），不进入用户拥有的会话标题；
邮箱、原始额度响应与 `CODEX_HOME` 都不进入会话摘要投影。它不参与 resourceId、目录联结、续跑参数、
权限或 binding；缺席时标题字节保持不变。

`parentResourceId?` 是 provider 明确声明的子 Agent 父资源，用于默认折叠的导航关系；Host 用同
owner、device、provider 铸造，不能从昵称、agent path、cwd 或相似正文猜父会话。Codex 的已声明
subagent source + parent thread，以及 Claude 的 `isSidechain` + parent `sessionId` 提供关系证据；
Claude 子 Agent 的独立身份来自 `agentId`（旧日志回落到实际 agent 文件名）。

`inputMode: "parent_owned"` 是额外的直接输入禁止，出现时必须同时带父资源。Codex 仍仅在
Multi-Agent V2 元数据完整时声明；Claude sidechain 没有独立 CLI resume 身份，同样只读并可打开父
Agent。只有导航关系的旧 Codex 子 Agent 不因此被推断成只读。View 不暗中转发输入或猜测直接写入能力，
旧 Host / Runner 仍保留自己的最终能力校验。

`executionMode?: "exec"` 仅表示 Codex 日志明确记录的非交互 exec 来源：`source: "exec"`，或
`originator: "codex_exec"`（`codex exec` 线束 fork 出的线程记录为 `source: "vscode"`）。它不声明父会话，
不参与资源身份、权限或续跑判断。2026-10-22 起它有两个展示/窗口含义：名册窗口给它独立名额（见下），导航器
把未收藏、未命名、未归档的这类会话放进默认收起的「自动化任务」分区；收藏、命名或归档后照常显示。

可选 `browseSessions({ device, source, cursor })` 复用最近会话的 read 权限，产出独立的有界
`sessionHistory`，不覆盖 live `sessions`。cursor 只能使用 provider 回传的不透明资源；可信侧重验
owner/device/provider。`rosterTruncated` 明说最近窗口不完整，不能据此断言旧会话被删除。

`selectSessionWindow` 统一三份独立名额：200 条交互主会话、`SESSION_AUTOMATED_WINDOW`（100）条自动化
主会话、最多 300 条子 Agent。一次 exec 爆发因此挤不掉人正在用的会话（2026-10-22 之前它们共用 200 名额，
实测一个基准线束三天产生 1237 个 exec 线程、占满窗口）。`options.kept` 标记的行（收藏、文件夹成员）不占
名额、永远入选：截断只决定什么算「最近」，不决定什么存在。调用方只传已经验证的父关系，它不推断 provider
身份或权限。

`encodeSessionIds` / `decodeSessionIds` 是 `list_recent_sessions` 的可选 `ids` 选择器（`source:id`，逗号
分隔，最多 `SESSION_IDS_MAX` 个）：可信 Host 用它向在线设备补取最近窗口外的收藏与文件夹会话。它只收窄
一次已经过 Gate 的读取；设备只从自己的目录作答，解码对畸形条目是全函数（丢弃而不放宽）。`rosterIndexPending?` 表示设备正在补齐目录/摘要；已有会话仍然可打开，
View 只展示进度，不合并第二份业务名册。

已确认 alive + attached terminal_tmux 的会话在各自名额内先入选，再按已有活动顺序补足；优先级必须在
Scanner、Runner 与 Host 合并截断之前生效，不能只对已截断的 View 排序。设备 Scanner 通过独立于 RPC
参数的可信回调获得当前优先身份集合；历史游标仍按稳定身份分页。收藏仍归 App，parent-owned 语义不变。

## 文件夹（2026-10-22）

`SessionsProjection.sessionFolders?: SessionFolder[]` 是 App 自有状态：`{ id, name, sessions }`，按用户
顺序，成员只是 opaque session resource。文件夹只组织导航，不是 provider 分组、目录、授权或生命周期；
删除文件夹只让会话回到未归档列表。port 上对应可选的 `setPinned` / `saveFolder` / `deleteFolder` /
`fileSessions`，旧 port 缺席时导航器隐藏整理功能。上限（64 个文件夹、名称 32 字、总计 2,000 个成员）由
App 动作拒绝、由投影折叠再执行一遍。

## 稳定排序与完成验收（2026-08-25，工单 #369）

`SessionSummary.sortActivity?` 是 provider 在版本化摘要缓存中一次产出的
`max(最后真实用户输入, 最后 Agent 任务终止)`；`completedAt?` 只记录后者。View 不为排序读取 transcript，
也不让工具输出、thinking 或普通 assistant 增量改写排序键。旧 provider 缺字段时继续回落到
`lastActivity`，因此协议仍是 additive v1。

`SessionsProjection.reviewedAt?` 是 App 自有 durable 状态，按 opaque resource id 记录用户最后明确打开过的
`completedAt`。`review_session` 只携带这两个投影字段，不进入 Gate operation；启动时自动选择不写，
显式打开才写。新的 `completedAt` 大于已记录值时，待验收提示重新出现。

## 输入证据与执行状态

`SessionOperation.input?` 是可选、显示用途的 `SessionInputReceipt`，记录 `phase`、`evidence`、`at`
和可选 provider session/turn、transport、controlAction。`dispatched` + `terminal_write` 只证明写入终端，
不得显示成 Agent 已消费；provider 接受与 native input 观察有独立证据。operation 原有生命周期继续表示
动作结局，旧 operation 缺此字段时保持兼容；启动只在确认原生 identity 后记录 `launch_identity`。

## 「运行中」的判定（活动过期规则）

`activityPhase` / `shouldFollow`（`src/activity.ts`）是唯一的活动过期规则：无配对工具调用静默超过
`TOOL_STALE_MS`、其他非 idle 状态静默超过 `QUIET_MS` 即不再算运行中。`chat-ui-commons` 原样再导出；
可信 Session Hub 用同一规则得出 `SessionSummary.status`，只有 Runner 已核验的存活进程不受静默时长影响。

## transcript 订阅生命周期

`closeSession?(resource)` 对应 `close_session`，只撤销当前实例对这个资源的实时读取；不关闭 Agent、不删除
历史或草稿，也不新增 Gate operation。旧 port 可以缺席这个清理方法；正式 proposal adapter 实现它。
无 offset 的 `readWindow` 在授权成功后持有该资源的订阅，显式关闭使在途旧读取不能重新开订阅。
`transcriptStatuses[resource]` 表达各资源自己的 live/reconnecting/closed 状态，旧 `transcriptStatus`
只作迁移兼容。焦点不是读取生命周期；仍打开的多个资源可以同时更新。

## transcript 来源版本（2026-08-27，工单 #410）

`TranscriptWindow.turnConfiguration?` 是最近一次 Codex 原生 `turn_context` 的只读 model/effort
快照，不是 composer 草稿或全局默认配置。可信侧只披露有界标识符；`null` 明确清除旧值，
每轮整体替换，缺失 effort 不沿用上一轮。它随已授权的 transcript 读取/订阅更新，不新增读取、
权限或持久状态。CLI 空闲时仅切换 `/model` 尚未写日志，开始下一轮才可观察。

`TranscriptWindow.version? = { epoch, sequence }` 是 Runner 产出该窗口时的可选来源版本。`sequence`
只在同一 `epoch` 内可比较；不同 epoch 是显式的来源重建边界，可以合法缩短或重写 transcript。它只是
display freshness 证据，不是 resource identity、App revision、授权或 action 前置条件。旧 Host 缺字段时，
消费者继续用 `offset + messages.length + totalMessages` 做保守协调，因此仍是 additive v1。

同一 epoch 的会话文件按 append-only 处理：更高 sequence 可以推进尾部，也可以在相同绝对前沿改写流式
tool/assistant 内容，但不能以更小 total/end 覆盖已经显示的尾部。显式历史页可按绝对 offset 向左补齐，
不能成为共享 hot tail。

## `newResourceId`：启动或已证明会话切换后的可信导航目标

成功的 `start_session` operation 可带 `newResourceId`：可信 Host 用已绑定的 owner 与 operation
最终确认的 device / CLI / session id 铸出 opaque session resource。`fallback_session` 成功时也带这个
字段，但目标是 Runner 在备用账号里通过 provider `thread/fork` 铸出的新 session id；原 resource 保持
不变。已精确绑定的长驻 TUI 若在提交边界真实 rebound，也可返回 provider 证明的新 session id；普通
managed resume 保持原 identity，绝不能把 parent-owned 子 Agent `thread/fork` 成另一个根 Agent 后冒充续接。
View 不从 session id 推导身份；字段缺席（旧 Host 或尚未成功）就保留原回执，不猜导航目标。
运行时字段闭集由同文件的 `SESSION_OPERATION_FIELDS` 给出；transport adapter 必须迭代这份契约词表，
不能在 App 内复制另一份 allowlist，也不能把 generic operation 的额外字段整包透传。

## `bilingual`：Claude 人类正文的设备侧翻译

2026-08-21 起 `RichBlock.bilingual?` 可同时携带 `{ zh, en }`：`zh` 是默认人类阅读版本，
`en` 是 Runner 实际发给 Claude 或从 Claude 收到的原文。只有 `text` block 可以带它；
thinking、tool input/output 和权限细节禁止进入翻译管线。`translation_error?` 表示 Claude 已成功返回、
但中文翻译失败，此时 `text` 仍是英文原文。两个字段都是 v1 的可选展示元数据，不参与 action、
operation、身份、资源引用或授权。

## 状态归属（这一条一直被搞错，所以写在契约里）

| 层 | 拥有什么 |
|---|---|
| Host / provider | session / transcript / workspace 事实、稳定排序与完成时间、operation 生命周期及成功启动后的 opaque resource、权限 |
| App durable state | pin、文件夹、自定义标题、完成验收时间与文件批注 |
| sessions controller | 请求排队、分页算法、用户拥有的稳定选择（缺席不等于删除，绝不自动搬移）、完成事件去重、**按 session 分键的 composer 草稿**、**pending send 生命周期（本地 echo → opId 对账 → 同 resource 绝对坐标消重 / 跨 resource 可信 operation 墓碑 → 拒绝回填草稿）**、**按稳定组 key 的折叠覆盖** |
| View module instance | 搜索输入、目录树展开、当前显示模式 |
| workspace coordinator | slot、panel identity、focus/open/close |
| App | 把自己的传输适配到这个 port，并选择挂哪些模块实例 |

> 2026-08-13 起 composer 草稿从 module instance 上移到 controller：草稿属于
> **某个 session** 而不是某个挂载实例——留在组件里的草稿会在焦点变化后跨会话
> 发送，并随任何 remount 消失。选择的纪律同时收紧：数据帧只能填充空选择，
> 不得覆盖用户的选择；选中项在某一帧缺席时保持选中并如实提示
> （`selectedAbsent`）。设计：`doc/development/frontend-interaction-stability-design.md`。

## 两个词表，为什么不是一一对应

`SESSION_ACTIONS`（跨 App 传输的 action id）与 `SESSION_OPERATIONS`（每个 action 花掉的 Gate 词元）
是两个问题的答案：

- `append` 与 `resume` 是**两个模块意图**，但权限层视为**同一条持久授权**（`append_session`）——
  action id 分开，是为了批准卡与审计记录说出人**实际**要求的那一个；
- `fallback_session` 是人明确要求的跨账号分叉：Runner 只收一个布尔意图，从设备本地账号池自动选择
  健康备用账号，原会话不改写；它与 resume 共用 `append_session` Gate 词元，但 action / audit 独立；
- `pin_session`、`save_session_folder`、`delete_session_folder`、`file_sessions`、`set_session_title` 与
  `review_session` 都只写 App 自有 durable state，所以不在 standing operation 表里；标题参数是 opaque
  session resource + 有界纯文本，空文本清除覆盖；验收参数是 opaque resource + 当前投影中的有界完成时间；
  `pin_session` 可选 `pinned`（布尔），拖到「收藏」用它做幂等设置，缺席时保持旧的切换语义；
  文件夹 id 由 View 铸造（`[A-Za-z0-9_-]{1,64}`），`file_sessions` 一次至多 64 个 opaque resource，
  folder 为空表示移出所有文件夹；每个会话至多在一个文件夹里；
- `respond_agent_interaction` 也不在 standing operation 表里。它只能回答投影中**当前那一个** provider
  提问/权限请求，且声明为 `human_only`；正在显示的 provider prompt 本身就是逐次授权面，不能被折成
  一个可长期授予、可由 App agent 继承的词元。
- `attach_file` 是设备资源写入：它通过所选 session 的不透明 resource 花掉
  `upload_session_file`，由 Runner 在自己的临时目录新建文件。它不是 host-local 旁路，必须进入 release
  的 standing operation / consent 契约；动作仍声明 `human_only`，App agent 不能借它写设备。
- `append` / `resume` / `takeover` / `fallback` 可选携带一个有界 `model` 与 provider 自己闭集中的
  `effort`（闭集只在 `src/providers.ts` 定义一次：View 渲染、可信 Host 绑定与 Runner 拒绝都用它，
  Runner 构建时内联，不在运行时拉取）。它们仍是同一条 `append_session` 执行授权，不新增 operation；可信 Host 按 resource 重新绑定
  provider、校验语法/档位并冻结参数，Runner 只在开启新的托管轮次时应用，最终模型支持范围由 provider
  裁决。缺席表示保持 Runner 当前/默认值，不能在 tmux 注入或已开始的原生轮次中静默忽略。

`SESSION_OPERATIONS` 只让消费者**说出**一个组合请求什么；**授予**它是可信 Host 的 catalog 的事。

## 测试

```bash
npx vitest run --project node packages/agent-sessions-contract
npx tsc --noEmit -p packages/agent-sessions-contract/tsconfig.json
```

`src/contract.test.ts` 钉住：二十五个 action id、operation 映射、pin/文件夹/标题/验收/交互回答不进入
standing operation 表，附件精确映射到 `upload_session_file`，且 port 表面没有任何能告诉模块「在给谁画」的方法。
`src/roster-window.test.ts` 钉住三份名额、kept 行不占名额与 `ids` 选择器的编解码。

## 新建 Codex 账号选择（工单 #590）

`PlacementDevice.codexAccounts?` 是另一份设备注册投影：公开注册 id、展示标签、
有界的剩余百分比/窗口长度/reset 时间及采样时间。不得透传 auth、邮箱、provider account id、
本机路径或原始额度响应。未知额度明确显示未知；离线或超过两分钟的值显示缓存状态。

`StartSessionRequest.codexAccount?` 仅用于新建会话，可信 Host 在所选运行机当前注册中重验，
作为 `codex_account` 冻结进原 start_session 操作及去重指纹；缺失的显式选择拒绝启动。
没有显式选择时保留原来的 Runner 自动选路，不隐式绑定到列表第一项。
续跑仍按原 opaque session 绑定，不允许通过此字段迁移旧会话。
