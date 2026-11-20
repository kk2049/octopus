# Session Resource — Session Plus 的可信资源边界

> 2026-08-04 新增。设计：`doc/development/session-plus-m2-m6-fable-design.md` §10、§12、§16。

## 一句话

View 只能提议一个闭集 action；可信 coordinator 用已认证的 `(owner, instance, release)` 重新绑定，
在 Runner 或 bot-host 的**独立单根** App Context 下打开 ControllerRun，最终让 capability Gate 决定。
这里不计算第二套权限，也不把 capability 交给 App Runtime。

```text
session_plus.grants (部署意图)
  → grant_intents source=config
  → IntentGrantResolver(owner, contract)
  → HostCapabilities App Context（Runner / local 各自一棵）
  → ControllerRun(app=session-plus, action=...)
  → Gate(resources, kernel operation, bounded args)
  → resource projection 白名单
  → SessionPlusAppService / MessagePort / View
```

## 文件和职责

| 文件 | 唯一职责 |
|---|---|
| `contract.ts` | 十份不可变闭集契约（基础、workspace、write、notify、CRDT、owner self-service、media、terminal、chat upload、file download）、按 digest 的精确查找（未知 digest = 无契约，绝不回落）、publisher 与 engine 唯一 contract digest |
| `workspace-grant.ts` | `workspace-files/v1` 那个平面的**全部**授权决定：exact 契约 → grant 交集 → 本平面 operation → capability Context。Dashboard 与纵向 e2e 用**同一个函数**——两份实现意味着被测的那份才是对的 |
| `catalog.ts` | 人类风险/披露说明；与 contract union 精确相等；禁止 `alwaysApprove` 与 `mayAutoAllow` 自相矛盾 |
| `intent-resolver.ts` | 读取 owner 对应的 active、未过期、publisher 匹配行，并只返回声明∩授权；不看 UI 状态 |
| `bundle.ts` | 关联一个 instance 的 Runner/local 两个普通 `HostCapabilities` plane 生命周期；绝不合并 root/rights |
| `service.ts` | 闭集 action 调度、参数收窄、ControllerRun 调用与统一审计 |
| `projection.ts` | 跨 View 边界的显式字段白名单；父子导航只投影 opaque parent resource；parent-owned 必须另带完整 mode + parent，绝不反射 Runner 对象图或原始 parent thread id |
| `../workspace-files/directory-index.ts` | 两个 capability plane 共用的唯一设备回复归一器；sessions plane 在自己的 Gate 成功后按 instance/device 整体替换关联快照，files plane 只消费 roots、绝不把 sibling disclosure 写进 sessions 投影。记的是**关联本身**（不是铸好的 key） |
| `kept-sessions.ts` | 收藏/文件夹成员（App 状态里的 opaque resource）解码为本 owner 的设备身份；名册刷新按设备用 `ids` 精确补取最近窗口外的这些会话，每实例 60 秒缓存，失败不缓存；离线设备与 bot-host 不补取 |
| `transcript-watch.ts` | 一个 live subscription 持有一个 ControllerRun；瞬时 Runner `failed`/`unknown` 继续同一个幂等读并在无内容变化时也恢复 `live`，Gate 拒绝/批准需求、撤销与 close 才终止并释放 |
| `types.ts` | coordinator port 与结构化 refusal；Runtime 不 import service 实现 |
| `app-operation-binding.ts` / `app-interaction-binding.ts` | Sessions+ 与 Research 共用的可信动作/交互绑定；原 session-plus 入口仅兼容 re-export，registry 不再 import 另一个 composition root（#537） |

## 权限词元：十九词元 union，历史契约不可变

只有这十九个字符串可以出现在契约、grant、Context rights、Gate 调用与审计中，
而**任何一份契约只包含自己声明的闭集**——每一次扩张都是一份新契约、新 digest、重新同意：

```text
── sessions/v1（六词元，每个回滚目标都声明它）────────────────────────────
list_recent_sessions      read/observe，可配置 auto-allow，已实现
search_sessions           read，可配置 auto-allow，已实现
read_session              read + live，可配置 auto-allow，已实现
list_session_workspaces   observe，可配置 auto-allow，已实现
start_session             execute；self-service release 本人可信页面静默，已实现
append_session            execute；self-service release 本人可信页面静默，已实现
── + sessions-workspace/v1（八词元，modular-v2 声明它）──────────────────
list_workspace_entries    read，可配置 auto-allow，已实现
read_workspace_text       read，可配置 auto-allow，已实现
── + sessions-workspace-write/v1（九词元，历史 ask）────────────────────
replace_workspace_text    modify；self-service release 本人可信页面静默，已实现
── + sessions-workspace-write-notify/v1（十词元，没有形状声明它）─────────
send_notification         modify，永远逐次批准，**批准本身尚未实现**（见下）
── + sessions-workspace-write-crdt/v1（十一词元）────────────────────────
read_document             read，单独授权后可 auto-allow，已实现
edit_document             modify，每实例/文档首次编辑批准，已实现
── sessions-workspace-write-crdt-self-service/v1 ────────────────────────
operation 与 CRDT 契约相同；只扩 autoAllow，不修改任何历史契约。
── + self-service/v2 ────────────────────────────────────────────────────
read_workspace_binary     read，有界媒体/PDF 内容读取，已实现
── + self-service/v3 ────────────────────────────────────────────────────
open_workspace_terminal   execute，本人打开静默；共享访客打开仍需 owner 批准（2026-10-15 O1），已实现
workspace_terminal        execute，只在已批准的 opaque lease 内 auto-allow，已实现
── + self-service/v4 ────────────────────────────────────────────────────
upload_session_file       modify；本人选择文件后，在所选 session 所在机器的临时目录写入，已实现
── + self-service/v5 ──────────────────────────────────────────────────
download_workspace_file   read；本人显式点击后，下载任意受支持大小的普通文件，已实现
── + self-service/v6 ───────────────────────────────────────────────────
access_owner_files        read；本人 Runner 的 OS 可访问绝对路径，不经过 workspace 匹配，已实现
── + self-service/v7（当前 release）────────────────────────────────────
replace_owner_text        modify；本人 Runner 已存在文本的 CAS 原子替换，单独授权，不继承到共享
```

v6 的 `access_owner_files` 不扩写任何旧 workspace token：它只在可信侧已经绑定当前 owner 与其 Runner 后
出现，以 mode 区分目录列举、文本、媒体和下载窗口。Provider 仍只向 View 投影 opaque ref；绝对路径只在
Runner 与可信 adapter 之间回显核对。历史 workspace ref/containment 分支继续服务旧 release，并保留给未来
跨用户 workspace 共享；本人直读分支不查询 workspace registry，也不比较 `directoryKey`。

v5 的 `download_workspace_file` 与 `read_workspace_binary` 故意分开：后者的旧披露只覆盖
PNG/JPEG/GIF/WebP/PDF 内嵌预览，不能被静默扩成任意格式导出。下载仍只接受 provider 铸出的 opaque ref，
沿 workspace-files 的 regular-file / containment / 8 MiB 边界分块读取，不允许 View 提交路径。

v4 的 `upload_session_file` 只允许按序、有界分块（每块 256 KiB），不设文件总大小上限。
设备逐块写盘并保留磁盘余量；同一 upload_id 不允许并发写，未完成上传闲置 30 分钟自动清理，
持续成功写入会续期。计数使用安全整数，服务回执不再按 8 MiB 截断。可信服务按原 session 的 durable split placement
选执行 Runner/workspace，或使用本平面已授权的目录关联；Gate看到的是最终执行设备。接收 Runner
自己解析登记的 workspace，并创建随机 `.octopus-attachment-*` 目录，每块回显 workspace_id。
View 不能选目标路径、覆盖文件或在最后一片前拿到 path；multipart 绑定 session/scope/workspace，
换选目标后不能续写旧 upload_id。未登记工作区的旧本机会话仍使用设备临时根。这仍是
设备写入，所以进入新契约；旧 v3 grant 只含 terminal，不会被静默加宽，用户必须重新同意 v4。

bot-host 会话沿独立 local plane 调同一个 operation：resource id 只决定可信侧选 local，View 不能提交
设备；本地 capability Object 用 v2 身份声明这项 modify，避免旧只读 root 或待批准调用被重新解释。
multipart 状态另按可信 owner 分域，防止同进程服务多个账户时 upload id 跨账户续写。

**`start_session` 的目标有两种形态，但仍然是同一个词元**（v4）：`workspace_id`（设备私有登记表里的
不透明 id）或 `directory`（用户**打字写出来的**路径）。这不是扩权——两者都是「在这台设备上起一个
新 Agent」，权限判定、审计身份与批准次数一模一样；变的只是**起始目录怎么被指名**。

三条随之而来的规则：

- **可信侧不把目录和任何列表比对**。那是他们自己机器上的路径，只有那台机器说了算。可信侧只做
  语法界定，而且用的是**设备端同一个函数**（`@claude-bot/runner/directories` 的
  `launchDirectoryProblem`）——两份「哪些路径可接受」的写法意味着一张卡可以被批准，然后被设备拒绝。
- **同时给两种形态 = 拒绝**，在绑定层、执行器与设备三处都拒绝，而不是按优先级挑一个：批准卡上
  写的是其中一个，挑赢家就是允许卡与 cwd 不一致。
- **fingerprint 与 resourceId 覆盖目标原文**（`ws:<id>` 或 `dir:<原样路径>`）。同一个按钮按两下
  是一个意图；换一个目录是另一个意图。

**两个只读文件词元是第二份契约,不是第七、第八个词元**（2026-08-06）：`list_workspace_entries` 与
`read_workspace_text` 由**另一个 capability Object**（`workspace-files-runner-v2`）服务，所以把它们
加进 ask 并没有加宽 sessions 那个平面；它做的是让第二个平面在**有人同意之后**可达。
`list_session_workspaces` 被**复用**而不是复制成第三个名字——文件树的根枚举与新建表单问的是同一件事。

**写是第三份契约，不是把第二份加宽**（2026-08-07，P6a）：`sessions-workspace-write/v1` = 八个读
加 `replace_workspace_text`。加宽第二份会改掉它的 digest，而下游每一处都把 digest 当作「这个人
同意过的那件事」——一个同意了八个读的人会发现自己的同意现在覆盖了覆盖写。所以前两份的 digest
**一个字节没动**。该历史契约的 `autoAllow` 与第二份逐字相同；工单 #101 没有改它，而是新增
self-service 契约，并把 owner root 作为上限、由可信人类 plane 显式领取本地写的静默条款。

**对外通知是第四份契约**（2026-08-08）：`sessions-workspace-write-notify/v1` = 九个加
`send_notification`。同一条规则第三次：「可以改写我选的那个文件」与「可以在聊天软件上给我发消息」
是两个决定，不是一个决定的两档。三条细节值得单独记：

- **它进 `operations` 而不是 `deliveries`**。`deliveries` 是 engine SEC-01 的跨 scope 投递词表
  （可信用户目录 + 收件方默认拒绝的策略 + 固定 envelope），那一整套这里都不存在；而且
  `IntentGrantResolver` 根本不记录 delivery grant，填在那里既是声称一套不存在的装置，也执行不了。
- **`notify/v1` 没有 capability Object**，它由一条投递路径服务。于是权限投影必须被显式告知这个
  平面持有什么（`PermissionService.extraAccountOperations` + `notifyAccountOperations`），否则
  `computeEffective` 会永远报 `account_lacks_operation`——页面说「你不能被通知」而 provider 正在通知你。
  两边读的是**同一个事实**：本部署有没有 outbound channel（也正是 `notify-grant.ts` 的第一行）。
- **`alwaysApprove` 今天没有执行者**，所以**没有任何 release 形状可以声明这份契约**。指过来之前
  必须先关这个缺口（建 capability Object，或把同意行改成老实说「一旦授权就直接发」）。

不增加 `live_session`、`resume_session` 或 UI action 别名。live 折叠进 `read_session`，resume 折叠进
`append_session`；折叠的披露/审批代价已经在设计文档写明。新增词元是权限契约扩权，不能作为普通
重构混进来。

## 目录关联键（2026-08-10，工单 #49）

`SessionSummary.directoryKey?` 与 `WorkspaceRow.directoryKey?` 让会话投影与
`workspace-files/v2` 的文件投影**精确地**说出「这两行是同一个真实目录」，取代
`SessionRoster` 里按 display/label/basename 四选一的猜测。

- **关联由设备算**：会话的 cwd 与工作区的 root 都是那台机器上的绝对路径，可信侧两者都没有
  （拿到的是不透明 id 与只用于显示的 `~/…`）。所以 Runner 在 `list_session_workspaces` 里多报
  `session_directories`，用的是文件平面**已有的**词汇 `(workspace_id, relative_path)`。
- **根只来自显式登记且此刻真实存在的目录**：Runner 可以用 session cwd 计算与已登记 root 的关联，
  但绝不能把历史会话 cwd 推断或写成新 root。登记项暂时不可达或已删除时不出现在本次回复，持久记录
  保留，目录重新可达后自然恢复。
- **只认同一次回复里的工作区**：关联到一个本次没被列出的工作区，会产出一个只可能与**另一次调用**
  的列表匹配的 key，而「匹配了屏幕上没有的东西」与错误联结无从分辨。
- **记的是关联不是 key**：roster 是另一条、更频繁的调用，设备不会在那里重复关联。记住输入而不是
  结果，铸造才会在提问者变化时仍然正确。按 instance 分域、双向有界、按调用方自己的存活谓词 prune。
- **`session_directories` 本身永不过界**，过界的只有由它派生的 key。
- **一次 workspaces 刷新会顺带给已经在投影里的会话补上 key**，否则界面会停在「root 能联结、会话不能」。
- **key 不授予任何东西**，也不改变 Gate/Context/owner 绑定；文件读取仍然只接受 provider 铸的 ref。

### split-home 只按正向目录进入 Sessions+（2026-09-01，工单 #478）

普通 `sessionScanRoot` 继续排除 `.octopus/codex-split-home`；不得把这个物理根加入通用 roster，也不得按
cwd、workspace、标题或目录名反推会话用途。Sessions+ 跨机启动成功后，Host 单独持久化 owner-scoped
正向目录，并把 Host 铸造的 correlation 写进 Runner 的 placement 证据。Sessions+ 的 roster/search/read
才可在 Gate 后提交这份有界选择；Runner 先按 placement 校验、按 provider id 在 transcript 读取前筛选，
Host 再把回包与原选择取交集。工单 `codex_agent_*` relay 不写目录/placement，因此即使 transcript 与
Sessions+ 会话共处 split-home、cwd 与登记 workspace 完全相同，也不进入 Sessions+。

跨机条目同时保留两套不可互换的坐标：`deviceId/resourceId` 指向 Agent 运行机，负责 transcript 与控制；
`directoryDeviceId + directoryKey` 指向执行机的登记 workspace，负责目录导航和收纳。内部
`directoryWorkspaceId` 只参与可信侧铸 key，不能投影给 View。旧的、仍有 execution binding 的 Sessions+
会话迁移成无 correlation 的 legacy 目录项，Runner 只接受其完整运行机/session/执行机/workspace tuple；
已经没有可信 owner 绑定的旧 transcript 保持不可见。

## 完整会话分页（2026-09-05）

最近窗口显式请求 `primary_window`，保留 200 条主会话并另附最多 300 条子 Agent；此语义贯穿 Scanner、
Runner push、Bot 持久缓存与多设备合并。旧 raw-500 快照不能命中新模式请求；单 provider 查询如果不能
由缓存证明覆盖，也回到已有 Gate 后的设备读取。`rosterIndexPending` 只展示回填进度，不改权限。
`refresh_sessions` 带显式 device + cursor 时，沿同一
`list_recent_sessions` Gate 读取完整设备目录的一页（最多 100 条）。设备精确绑定本人 Runner；
游标重验 owner/device/provider 后才转成设备私有 provider/id 顺序。分页绕过不完整的 materialized
最近快照；独立 `sessionHistory` patch 不重建或清除 recent roster。旧 Runner 没有明确分页回复时
报告不支持，不能把第一页冒充完整目录。split-home 仍只合并 Host 正向目录中的记录。

## materialized roster 与按需 transcript（2026-08-23）

Runner 从设备本地会话索引重建 `roster_full`；hook/runtime/interaction 只是失效提示，正常十秒 reconcile
兜底、五分钟无变化心跳；有界冷回填按一秒间隔继续，关闭 projector 后停止。文件仍是真相。Bot 把每个 owner/device 的有界 roster 持久化到独立 SQLite，把 hot transcript
窗口只放在有字节上限的内存里。两种缓存都在 Runner Object adapter 的 **Gate 之后**：命中只省设备 RPC，
绝不省 Context、policy、audit 或 owner/resource check。

`refresh_sessions` 冷首屏只对 runner/local 各开一次 requested-limit Gate，不再先读 20 行再读全量。
空白首屏仍可收到先完成 plane 的 `loading` 帧；已经显示行的投影不收 partial，避免 roster-shrink
闪烁。每个 instance 最多同时保留 64 个 resource 的独立 live 订阅；hot transcript 投影保持八个窗口。
超出跟随预算仍然允许读取，仅暂停最早 follow 并投影 `paused`，显式刷新可以重新跟随。只有授权
`open_session` 成功后才连接该资源。`close_session` 仅撤销对应资源并废止它的在途旧 tail，不能结束 Agent
或删除草稿/历史；已打开标签之间的焦点切换不改变订阅。`transcriptStatuses` 按资源记录状态。push 到达再过
同一个 Gate 读取内存窗口。instance、权限或 credential 结束同步撤销全部订阅；投影失败继续使用原有
per-instance stale roster，绝不把失败解释成空列表。workspace 回包只在最终当前投影上重新关联目录键，
不得把 await 前的旧 session 字段写回。

hot transcript 保留 Runner 的 `{epoch, sequence}`，并经 trusted allowlist 投影成可选 display `version`。
带显式 `offset` 的历史 RPC 回包绝不写 shared hot tail；无 offset fallback 也不能覆盖已有 materialized
版本。同 epoch 只允许 append-only 前沿前进或同前沿内容改写，较小 total/end 被拒；新 epoch 会清空旧
device tail，已经退休的 epoch 不能通过延迟帧复活。Session Resource 与 App dispatch 每次都按版本和绝对
位置协调窗口，而不是用请求完成顺序或 App revision 猜 freshness。

## 不可协商的边界

1. **PermissionService 不是判定器。** 它只存意图、算 UI 投影、发审计/撤销事件；最终判定只有 Gate。
2. **两个 root 不求并集。** `AppAuthorityBundles` 可以同时持两个 Context id，但每次调用先选一个
   plane；不存在多父 Context、跨 plane fallback 或“方便”的 rights 合并。
3. **owner check 在开 ControllerRun 前。** 别人的 resourceId 必须产生零 transport frame、零批准卡。
4. **View 输入不携带身份。** owner、app、instance、publisher、grant、Context id 都来自可信绑定。
5. **资源回包逐字段投影。** owner、canonical cwd/path、任意额外字段与原始错误只留服务端审计，
   不进入 iframe；交给 View 的 transcript 内容视为已经向 publisher 披露。
6. **本人资源静默（2026-10-15，O1）。** owner 的 grant 在首次打开时持有全部本人本地操作（会话、
   工作区、本人文件、终端）并全部免批；owner 自己的 App agent 走同一组静默条款。共享访客经
   `guest` plane 驱动 owner 的 plane，打开终端仍排 owner 批准卡。CRDT 共享文档与 outbound
   notification 仍需真实同意。`directSelfAutoAllow` 仍只属于 Session Hub。
7. **销毁是同步边界。** 实例、owner grant 或父 root 被销毁后不能重开 run；live 发送 terminal
   error 并停止轮询。Runner 的 `failed` / `unknown` 是可重试的读错误，只显示 reconnecting；下一次成功即使
   transcript 字节未变也必须恢复 live。durable App state 不随 capability 撤销删除。

## 当前 grant 所有权

同一个 `grant_intents` 执行面支持两种来源，且主键仍只有一行：

- `session_plus.grants.<owner>` 同步为 `source=config`，权限页与 grant/revoke API 都只读；
- 没有配置行的 owner 可在可信主站写 `source=user`，并在权限页或会话+可信条撤销。

两者都由同一个 `IntentGrantResolver` 消费，不存在 user 专用判定器。另表 `app_trust` 只控制是否
加载发布者代码，不参与 Context 派生。发布者变化时 trust 与 capability grant 都不继承；权限 UI
的通用投影与 resolver 都 fail closed。

## 验证

```bash
npx vitest run packages/bot/src/session-resource
npx vitest run packages/bot/src/session-plus/app-service.test.ts packages/bot/src/session-plus/browser.e2e.test.ts
npx vitest run packages/bot/src/permissions
npx tsc --noEmit -p packages/bot/tsconfig.json
```

关键负向断言：双 plane 四象限；Bob→Alice 零帧；共享访客打开终端排批准卡；resource 对象额外字段
不跨界；缺 auto-allow 产生 App ControllerRun 批准卡；bundle destroy 终止 live；Hub 回归保持绿色。

## Research composition

`research-contract.ts` declares the independent `research-sessions/v1` contract:
read_session, append_session and upload_session_file. No Sessions+ grant transfers
to this App. AppAuthorityBundles accepts a trusted composition profile; default
Sessions+ identity/rights remain unchanged. Research reuses SessionResourceService,
SessionPlusOperationBinding, the durable operation coordinator and the same Runner
leases. Its trusted adapter rebinds a currently published source alias to one
current owner/device/provider/session tuple before Gate; live state stays outside
the shared project stream. Old empty-contract research releases stay read-only.

Research v2 uses a separate reviewed `research-canvas/v1` profile. Its trusted
delegation callback checks the current project member, binding owner consent,
App grant and exact device/provider/session/workspace tuple on every call.
This is explicit delegation through the existing resource service, not a Hub
principal impersonating the owner. Imported sessions remain pinned to their
registered workspace; file references use that workspace's read/download
capabilities, never `access_owner_files`. Internally minted execution credentials
expose the five project discovery/invocation tools only for the exact live run.
Repeated native operation IDs resolve the original durable receipt; accepting
input does not count as completion. User responses to Agent interaction prompts
also preserve both the resource owner and actual project-member trigger.
