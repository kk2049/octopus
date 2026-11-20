# Agent Sessions View — 可复用的会话模块

> 2026-08-06 新增（v4 模块平台第一纵切）。
> 契约：`packages/agent-sessions-contract/CLAUDE.md`
> 布局内核：`packages/agent-view-react/CLAUDE.md`（`./workspace`）
> 交付：`doc/deliveries/2026-08-06-agentic-app-module-platform.md`、
> `doc/deliveries/2026-08-10-session-plus-unified-index.md`（统一目录索引 + chat 文件链接）

## 一句话

七个模块（`session.search/v1`、`session.roster-tree/v1`、`session.directory-index/v1`、
`agent.chat/v1`、`session.new/v1`、`session.operations/v1`、`session.remote-terminal/v1`）加一个共享 controller。
`session.directory-index/v1` 现在是**导航器**：一个活动栏（会话列表 / 文件树 / 全文搜索）下的三个视图，见下文。会话面只依赖
`agent-sessions/v1` 这个 typed port；**统一目录索引与 chat 文件链接**还会在组合提供了
workspace-files provider 时消费那个 port（当前声明 v1–v4；`useOptionalWorkspaceFiles`——缺席是组合的
陈述，渲染诚实降级而不是抛错）。同一份实现既跑在 Session Plus 上，也跑在 `src/harness` 那个只读 App 上。
可信 Dashboard 与本包都依赖中立的 `chat-ui-commons` transcript/chat 展示实现；两边各自注入
Markdown、安全策略和 Host 行为，彼此仍不 import。本包不得 import Dashboard、Bot、身份或传输。

助手正文的 `mermaid` 围栏经 SDK 的 `renderCodeBlock` 注入缝交给 `chat-ui-commons/mermaid`，
以 SVG 图片呈现流程图，源码始终可展开；普通围栏和行内代码不变。文件链接改写前后都使用同一适配器。
图表不产生文件读取、链接动作或 HTML 注入；大小上限与降级行为见中立包文档。

这些代码原来是 `packages/session-plus-view/src/{App,components,lib}` 的主体。

## 统一目录索引与文件链接的一条纪律（2026-08-10；2026-08-14 补充展示去重）

凡是声称“这个 session 与这个文件 resource 是同一目录”的**资源联结**，仍然只按 `directoryKey`
相等成立；同 label、basename 或显示路径都不能铸造 ref、跳过 Gate 或建立授权关系。

文件优先的 home 导航另有一条更窄的**纯展示映射**：同一设备上，两个已公开且可解析的
`~/…` 展示坐标相等时只画一行。例如 `~` 根的 listing 里有 `lht`，同时 `~/lht` 又是注册根，保留
上方位置并合入后者的 opaque ref，而不是再在下面画第二个 `lht`。`..` / `~/…` 的脱敏外部位置不参与
这种去重。这个映射也只用来（1）按 session 自己的 cwd 展示蓝色历史计数，（2）给新建表单预填目录；
真正的文件读取仍提交 opaque ref，新 Agent 的目录仍由 Runner 在执行时校验。

跨机 placement 的 session 行按 `directoryDeviceId ?? deviceId` 放进设备/目录树；设备刷新清单同时包含
两者。这个覆盖只决定收纳位置：打开 transcript、发送、停止等动作仍提交原 `resourceId`，绝不能用执行机
设备名重铸或改写资源身份。`directoryKey` 仍是会话与文件目录发生 JOIN 的唯一依据。

## JOIN 的规则不是 CLICK 的规则（2026-08-11，工单 #61）

上面那条约束的是**联结**：两行声称自己是同一个目录。它不适合**打开一个链接**——大多数链接所在的
工作区从来没把 key 送到 View 这一侧，在那里拒绝的观感是「面板不肯打开一个它明明看得见的文件」。

所以 `lib/file-link.ts` 现在产出**有序候选**：① key 相等的 base（最精确，仍然第一）→ ② 路径里
出现某个 root 的 label → ③ 相对链接原样放到每个 root 下。**放宽的只有起点**：下钻仍然逐级
`listDirectory`、只认 listing 自己的 label、只用可信侧铸的 ref，所以猜错的候选只花掉一次「没有这个
条目」。**真正的拒绝立刻终止整次点击**（`approval_required` 尤其），否则一次点击会变成一摞批准卡。
非 key 命中会明说是哪个工作区答的。

**2026-08-26（工单 #399）：本人 Runner 的绝对路径先走 `/` opaque root。** 可信 provider 只有在当前
release 的 owner-local 权限词元有效时才铸这个 root；View 仍只提交 root ref 与逐段 label。绝对路径从
该 root 精确下钻，不要求 workspace 根、`directoryKey` 或显示路径比较。没有这个 root 的旧 release 与
共享/workspace scope 继续使用原 key/label/root 候选，二者不互相伪装。

**2026-09-08（工单 #537）：浏览器补成完整 View URL 的路径仍走文件解析。** chat 点击接受当前
View origin，以及同协议、端口和部署域下旧内容摘要 host 的路径；普通外站 URL 保持链接行为。
这只还原路径主张，实际打开仍经原 opaque root、typed port 与 Gate。文件根刷新同时通知已挂载目录树
重读展开目录并清除收起目录的旧缓存，手机外框与桌面目录刷新共用该信号；完成帧不触发额外读取。

**2026-08-17（工单 #243）：下钻搬到可信侧，一个候选一次往返。** 手机网络上逐层往返让一条深路径成为
一串断链机会（观测到的失败正是设备链路中途抖断）。port 提供 `resolvePath` 时，`walkToFile` 对每个
候选只发一次调用，可信 provider 在服务器侧跑**同一个**逐层 listing 下钻——语义、拒绝词表、批准行为
逐字不变；`not_found` / `not_a_directory` 换下一个候选，其余拒绝照旧终止整次点击。没有该方法的 port
（harness、v1 wire）继续走原来的逐层 walk。

## 文件优先导航（2026-08-13，工单 #96 / #109）

`session.directory-index/v1` 在组合提供 workspace-files port 时直接呈现懒加载文件树，不再把 sessions 与
文件做成两个导航模式。根通过 exact `directoryKey` 找到 sessions plane 已公开的 `~/…` display，再只为导航
显示组织成以 `~` 开始的共享祖先树；home 外的省略路径落在一个 `..` 节点下，实际读仍只提交 opaque ref。
文件目录优先用自己或**已经可信列出的**后代 `directoryKey` 汇集 session；在 home 导航内，还会按上节
限定的同设备 `~/…` 展示坐标补齐历史计数，并按 resource id 去重。点击蓝色计数在按钮右侧打开紧凑列表，
按相对目录深度稳定排序；靠近视口底部时弹层会向上让出至少 220px 的常规高度。每个可解析的 home 目录
都有 `＋`，脱敏的外部路径没有。全局会话列表（收藏、文件夹、最近、自动化）在导航器的「会话列表」视图，
不再叠在文件树上方（2026-10-22）。它不会为了排序或找 session 预取 transcript/目录。没有 files provider 的
第二消费者仍诚实降级为旧的 session 目录索引，其中久未活动目录的纯投影折叠规则保持不变。

统一索引复用 `FileTreeRow` 时必须连同那一行实际 listing 携带的 root ref + label 链交给 open intent；
不能只转发文件 ref。这个上下文不是另一个地址，也不参与 panel 身份，只让 Markdown 查看器经可信侧
`resolvePath` 找到相对图片。会话/文件合并导航、独立文件树，以及从聊天链接逐层 listing 后得到的文件，
都必须把同一次解析的 root ref + label 链送进 open intent。

## 路径就是引用，哪怕没人给它加链接（2026-08-16，工单 #189）

Agent 写文件引用有三种写法，从前只有一种（作者手写的 Markdown 链接）可点。`lib/file-mentions.ts` 给出
**唯一一份路径文法**，两处消费：`components/Transcript.tsx` 渲染前把助手正文（以及整段就是路径的行内
代码）改写成 Markdown 链接——走的是**已经存在**的那条「无 scheme 链接 = 打开文件」通道，不新增开启路径、
不教渲染器认路径，围栏代码块与既有链接逐字保留；工具调用把 `extractFilePaths` 交给中立卡片，把这次调用
提到的文件放在详情折叠卡的**顶部**。文法刻意保守（要有扩展名；域名形状与版本号被拒；裸文件名走白名单加
一小张散文词表），因为点不动的蓝字比纯文字更差。它**从不是权威**：解析仍是从可信侧铸的 root 逐级
listing，猜错只花掉一次「没有这个条目」。

## 路径不是 ASCII 也是路径（2026-08-17，工单 #201）

`lib/file-mentions.ts` 的 run 字母表原来只有 ASCII，于是这台机器上最常见的那种引用——
`/home/ubuntu/lht/oh-my-pi-技术报告.md`——在第一个汉字处被切成两段，两段都没有扩展名，整条链接、
行内代码与工具卡顶部的文件列表一起失效（三处读的是同一份文法）。现在字母表接受任意 Unicode
**字母 / 数字 / 组合符**；**标点仍在外面**，这是 run 不会吞掉整句话的原因：`（`、`，`、`。` 与 ASCII
的 `(` 同属 `\p{P}`。扩展名仍要求 ASCII，所以版本号、域名形状与散文裸词照旧被拒。

同一次点击的另一半在 `lib/file-link.ts` 的 `decodeLinkPath`：Markdown 渲染器会把链接目标
percent-encode 进 DOM，而解析是逐级拿 segment 去比对 **listing 自己的 label**，编码过的 segment 谁
都匹配不上。`components/Transcript.tsx` 读 href 的那一处先解码，函数是全函数（坏转义 = 本来就没编码）。

## 导航行只有一套 chrome（2026-08-17，工单 #201）

展开箭头统一为 `FileTreeChevron`（含叶子占位，这样文件图标与目录图标在同一列），`💻` 与 `↰` 换成
glyph family 里的 `device` / `parent`。设备头改成普通 `.wsrow` 骨架，但**故意不带 `.wsdir`**——那个 class
是浏览器套件用来数真实目录按钮的。行的数量、depth 算术与所有 `data-tree` / `data-ref` 钩子未变。

**2026-08-28（工单 #438）：物理机行同时是终端入口。** 文件优先索引中每台物理机右侧有一个紧凑
`›_` 按钮；它只用投影中的设备名打开 `remote-terminal` resource，Dock coordinator 按
`kind + device` 复用/聚焦同一 tab。tab 挂载后从该设备已投影的登记工作区选择起点，并只发一次现有
`open_terminal` typed-port 提议；真实设备与工作区仍由可信 Gate 重新解析，View 不按路径猜测、不新增权限。
关闭 tab 对当前租约做一次 best-effort close，失败不自动重试，设备端 30 分钟 TTL 仍是兜底。


## Chat 直达真实工作目录（2026-08-25，工单 #376；2026-08-27，工单 #419）

chat 标题右侧显示当前 `cwdDisplay` 的文件索引按钮；手机用同一个入口的紧凑 44px 图标按钮。
点击后请求现有的 `session.directory-index/v1` 从同设备**最浅的 exact-key 登记根**逐级 listing 到 session cwd；
定位成功后才聚焦索引面板（手机因此跳回导航层）并展开、选中目标目录项，拒绝则留在 chat 原处显示回执。
目标目录按钮只在手机导航层切换为可见后取得 DOM focus；使用 `preventScroll` 禁止浏览器移动 App frame 或
embedder，再只调节工作区索引自己的 `scrollTop`，保证桌面和手机都能看到目标。桌面默认仍折叠全局最近会话，
手机仍保持最近会话优先的低工作区落脚区；用户显式开合与拖动过的上下分栏不被 reveal 改写。最浅根让中间目录
也真实可见；遇到嵌套登记根时按 workspace row 与 root 的 exact key 计划改用它自己的 opaque ref；即使上层
listing 的同坐标 entry 来自较窄协议、没有携带 `directoryKey`，展开状态也落在渲染层实际保留的那一行，而不是
隐藏 entry ref。显示路径只提供已精确根以下的 listing label，不能按设备名、root label 或 basename 铸造联结；
没有精确根就在 chat 原处给出失败回执。文件链接回退提示也只称命中的对象为“目录根”，不再把 `ubuntu`
之类的根标签误称为 Agent 的“工作区”。

## 子 Agent 的导航折叠

最近会话和目录索引只在可信 `parentResourceId` 指向当前名册中同设备、同 provider 的真实父会话时，
把子 Agent 收进默认关闭按钮。父会话缺席、循环或不确定关系直接显示真实会话，不生成占位父卡片。
用户置顶、自定义命名或已确认在 tmux 前台运行的会话始终直接显示；这只改变导航，不改变 provider 的 parent-owned 输入限制。
目录计数按实际显示卡片计算，多级子 Agent 逐级展开。展开覆盖沿现有模块实例状态按父 resource 分键，
投影刷新不会重置。开机默认 chat 跳过子 Agent。
`SessionFamilies` 同时用于文件优先目录、无文件 provider 降级和旧 roster 模块；导航器先按收藏、文件夹
分区，再用同一份 `sessionFamilies` 折叠（收藏、命名或归档的子 Agent 直接显示）。没有父 ID 的
`executionMode: "exec"` 不推断父子关系；未收藏、未命名、未归档时，它在导航器里进入默认收起的
「自动化任务」分区（2026-10-22，见下文），目录弹层与搜索仍直接列出。

未取得完整摘要的 `messageCount` 保持缺席，显示「条数未统计」，不能当作 0；完整 transcript 已通过用户
读取取得时，导航可消费该窗口的 `totalMessages` 补足未知计数，不额外预取所有子任务。原生 Codex 子任务
标题由 provider 的任务名/昵称提供，继承的父会话提问仍属于 transcript，不冒充子任务标题。

「全部会话」在原目录模块内显式打开分页对话框；可选择设备和 provider，并额外展开子 Agent。
每次只读取 100 条完整设备日志目录的一页，游标是 Host 铸造的 session resource；默认的最近名册
仍保持有界。页状态独立投影，绝不替换 live roster；设备/来源切换立即清空旧页，拒绝保留可恢复
位置，不自动重试。翻页按 provider/id 稳定顺序，不使用会随工具输出变化的 mtime。
`rosterTruncated` 为真时，离开最近窗口不再被判定为会话不存在。

搜索输入变更立即隐藏旧结果；只有显式再次搜索且投影 query 与当前输入一致才显示结果。
清空后输入回同一个词也不会自动恢复旧结果，编辑和清空不会发搜索提议。

聊天正文不再渲染窗口计数、顶部“加载更早”、正常“实时跟随”徽标或“搜索已读取记录”条，所有
provider 使用同一规则。向上滚动自动分页、设置卡内手动加载、重连/暂停/停止提示和同步忙态继续保留。

## Chat 文件附件（2026-08-21，工单 #301）

`lib/attachments.ts` 是纯的那一半：粘贴图片筛选、分块参数，以及 `promptWithAttachments()`。桌面按钮、
drop 与图片 paste 最终都走同一个 `controller.attachFile(resource, file)`；同一文件的每片都按顺序 await，
不同文件各持 opaque upload id 并行前进，上传期间仍可继续选择文件，且按可信侧分片回执显示逐文件进度；
任何失败都不自动重试。只有 session 所在的 Runner 或 bot host 确认最后一片后才出现 chip，所以草稿永远
不会引用一个半成品路径。

**ref 是 prompt 的一部分**，在发送那一刻由仍在草稿上的 chip 组成——不是投影字段，也不是可信侧
替你拼进去的。agent 读的是 prompt，删掉 chip 的文件不会被告知。有附件无文字是一条合法消息，
无附件无文字不是。

View 说不出目标路径，也读不了文件：它只选择本地 `File`、分片并拿到可信侧最终回的 label 与绝对路径。
桌面上传按钮和输入框并列；手机层只在 composer 默认关闭的 `<details>` 设置卡内显示按钮。
输入区 drop 是同一动作，不另造 upload 状态或第二条 transport。

## 手机层的 chrome（2026-08-16，工单 #181 与 #189）

`session.directory-index/v1` 通过布局内核自己的 `useNarrowViewport()`（同一条 720px media query，
不是第二套断点）拿到 narrow 事实，并且只用它决定**哪些 chrome 常驻**：

- rail 头部的手动 ↻ 在窄屏不渲染；`onRefresh` 回调、宽屏按钮与刷新语义都没动。**#189 把这个入口放回了
  App 外框**：`chrome.tsx` 的 `SessionsRefreshAction` 不是模块（没有 manifest / slot / 资源），是组合放进
  布局内核 `mobileActions` 插槽的按钮，一次手势刷名册、工作区、文件根与**已选中会话**的尾窗。放在外框而
  不是导航栏，是因为从 chat 层也要够得着——那里导航栏不在屏幕上。
- 默认 chat 只从 settled roster 选择。`resourceState: "loading"` 是最快 provider 的不完整首帧；从它选中
  本机 observer 会让手机/桌面都粘在随后消失或只读的会话上，与用户从完整历史列表打开 chat 的路径不同。
- `wsaccess` 权限档位在窄屏折进一个默认关闭的 `<details>`（summary 就一个「权限」）。**是折叠不是丢弃**：
  「写入:不可用」正是保存会失败的答案，某个视口悄悄省掉它就是用布局撒谎。文案、tone 与顺序仍逐字来自
  可信侧。
- **窄屏不做开机绑定（2026-08-24，工单 #349）**：`agent.chat/v1` 那条把常驻 panel 绑到开机选择的
  open intent，在 `workspace.state.narrow` 时不发。窄屏下被接受的 open intent 是一次**跳层**（#189），
  那条规则是给点击用的；用在没人要求的绑定上，进 Sessions+ 就直接落在排序第一的会话（实际就是最上面
  那个收藏）里。未绑定的 chat 仍然跟随选择，所以会话层不是空的；用户真点一下仍然照 #292 直接进那个 chat。
- `source-note`（＋ / `..` / 🗄 的常驻图例）在窄屏不渲染：一屏的栏里三行说明会把树顶到折叠线以下。
- 搜索行的 `搜索` 按钮是 `flex: none` + `nowrap`：输入框 `width: 100%`，被压缩的一直是按钮，两个字折成
  两行会让这一行成为树上方最高的东西。这条不是手机专属规则——标签被折断在任何视口都不对。

## 依赖边界（`src/architecture.test.ts` 读本包源码强制）

| 允许 | 禁止 |
|---|---|
| React、`@claude-bot/chat-ui-commons`、`@claude-bot/agent-sessions-contract`、`@claude-bot/agent-module-contract` | 任何 App（`session-plus-view`）、`@claude-bot/bot`、`dashboard-web`、`web-trust` |
| `@claude-bot/agent-view-react/ui`（展示原语）与 `/workspace`（布局内核） | `@claude-bot/agent-view-react` **根入口**——它 re-export 传输与 wire 常量 |
| — | 任何 channel 原语、`fetch`/`XHR`/`WebSocket`/`EventSource`、protocol 常量 |
| — | `useIdentity`/`useOwner`/`useCapability`/`instanceHandle`/`csrf` 之类的名字 |

窄入口不是风格：一个模块**够不到** wire 常量，才让「模块不知道传输是什么」成为类型错误而不是习惯。

## 文件

| 文件 | 职责 |
|---|---|
| `src/controller.ts` | 六条编排规则（读请求串行且不丢、缺失 transcript 每资源只请求一次——上游淘汰后重新放行、按可见单位扩尾窗、工作区串行队列、succeeded 只处理一次、roster 刷新 single-flight + 有界 trailing，自动 wake 最多每两秒启动一次、拒绝后等显式刷新，手动刷新即时）+ authenticated projection wake + 用户拥有的选择（缺席不等于删除，数据帧只能填充空选择）+ 显式打开后的验收乐观覆盖（拒绝恢复）+ 按 session 分键、按 resource 单独订阅的 composer 草稿（按键不刷新共享 controller）+ pending send 生命周期（本地 echo、opId 对账、点击时绝对 transcript/投影基线、同 resource 消息一对一消重；tmux 成功只确认送达并保留正文；跨 resource 由同一成功 operation 封口且不搬坐标；receipt 晚于 operation 时立即重放当前快照；无绝对 offset 时保守保留；仅未入 transcript 的失败/拒绝回填）+ parent-owned 子 Agent 写入拒绝 + 折叠覆盖 + 新建草稿 + **新建 Agent 的启动生命周期（工单 #191）** + 自定义标题动作 + 跨模块 cwd reveal 请求/回执（展开状态仍属于目录实例） |
| `src/composer-drafts.ts` | 每个 Provider/port generation 一份、最多 32 个非空 session 草稿的外部 store；通知严格按 resource 隔离；组合可选注入 browser-only persistence，发送/删除立即写空墓碑，只有明确拒绝或 operation 失败才恢复持久副本 |
| `src/context.tsx` | `SessionsProvider` / `useSessions()`；接收可选的单调 wake token 与纯展示草稿 persistence seam，但实际 session 数据仍只从 port 读取 |
| `src/manifests.ts` | 七份 manifest，**纯数据**：Node 侧 release builder 要读它来产出 module lock，不能被迫 import React 或 CSS；directory index 声明 workspace-files v1–v4，只有组合实际连接的版本可用 |
| `src/modules.tsx` | manifest + 挂载组件；session 行先发 `workspace.open`，成功后才跟随 selection；standing chat 首次绑定 boot resource，之后不同 session 成为 sibling tab；物理机终端用 device-keyed resource 进入同一 Dock 生命周期；`useFileLinkOpener`（chat 链接 → 解析 → `workspace.open`）；桌面 cwd reveal 逐级消费 exact-root 计划并聚焦目录 |
| `src/components/*.tsx` | `SessionSearch` / `SessionRoster` / `DirectoryIndex` / `DirectorySessionsDialog` / `AgentChat` / `AgentInteractionCard` / `NewSession` / `SessionOperations` / `RemoteTerminal` / `Transcript`——**全部 props 驱动**，所以 harness 能拿 fixture 直接渲染；交互卡只消费 provider-neutral 投影并提交 opaque resource + interaction id + answer |
| `src/components/{Navigator,SessionNavigator,NavMenu}.tsx` | 导航器活动栏、会话列表视图（分区、拖放、多选、行内重命名）、共用上下文菜单；同样 props 驱动 |
| `src/lib/navigator.ts` | 会话列表的纯分区：收藏 / 文件夹 / 最近 / 自动化、筛选、缺席占位、Shift 连选顺序、View 铸造的文件夹 id |
| `src/components/RunConfig.tsx` | 启动 composer 与 chat composer 共用的运行配置条：`RunConfigBar` / `RunConfigField` / `ModelPicker` / `EffortPicker` / `AgentPermissionField`；只渲染与回报选择，clamp 仍在 `lib/cli.ts` |
| `src/lib/transcript.ts` | `chat-ui-commons/transcript` 的兼容入口；ViewEntry 归一、折叠单位与活动过期只有中立包一份实现 |
| `src/transcript-ui.ts` + `src/components/{ChatTranscript,TranscriptGroup}.tsx` | side-effect-free 的 `chat-ui-commons/transcript-ui` 兼容入口；根 bundle entry 显式导入共享 CSS，Agent View 仍注入 Markdown、spinner、chip 与 App 专属 class/callback |
| `src/lib/roster.ts` | 目录树压缩、按稳定 activity key 的最近排序；输入已排序时只线性确认并截取 |
| `src/lib/directory-index.ts` | 统一索引的**纯联结**：cwd 树 ∪ workspace 行 ∪ 懒加载文件层，只按 key 相等合并 |
| `src/lib/home-directory-tree.ts` | exact-key 根定位 + 以 `~` / `..` 组织共享显示祖先；cwd reveal 只从 exact-key 根派生 listing 计划；读操作仍只用 opaque ref |
| `src/lib/directory-sessions.ts` | 文件目录紧凑列表的纯联结：只按 `directoryKey` 汇集已列出子树里的 session，并按相对深度稳定排序 |
| `src/lib/file-link.ts` | chat 文件链接：显示路径归一 → key 跳到文件 root → 逐级 listing 下钻；全部拒绝有界 |
| `src/lib/file-mentions.ts` | **纯展示启发式**：一段文本里哪些子串是文件（`filePathOf`/`findFilePaths`），以及把一份 Markdown 里的路径改写成链接（`linkifyFilePaths`）。字母表含 Unicode 字母/数字/组合符，不含标点。不解析、不授权、不铸 ref |
| `src/lib/attachments.ts` | 粘贴图片的纯逻辑:剪贴板筛选、base64、`promptWithAttachments()`(发送时组成 ref) |
| `src/chrome.tsx` | 组合放进 App 外框的会话 chrome（手机刷新键）。不是模块 |
| `src/lib/projection.ts` | 投影派生：稳定排序、完成验收比较、尾窗判据、设备清单、provider 会话名优先且用户首条消息回退的标题、按 `observed_at` 选择最新 runtime |
| `src/lib/cli.ts` | 各 CLI 的模型建议与 effort 阶梯；effort 阶梯直接取自契约 `providers.ts`（可信 Host 与 Runner 用同一定义校验），本包不再另写一份；**渲染与提交用同一个 clamp**；`modelChoices()` 给模型下拉排选项（含空的「Runner 默认」与未列出的草稿值） |
| `src/sessions.css` | 模块自己的样式，随发出这些 class 名的组件走 |
| `src/harness/` | 第二个 App：内存只读 port + 三模块组合（见下） |

## 六条本包的规则

1. **一次只跑一个 transcript 读，但一个请求都不丢。** 两个并发会把尾窗刷新和一页历史交错成一个既不是
   尾窗也不是历史的窗口，所以在飞的时候来的请求**排队**而不是被丢掉——丢掉正是「第二个 chat panel
   永远转圈」的成因（没有别人会替它要）。已经在排队或在飞的**同一个窗口**则去重：正在回来的那个答案
   就是它的答案。
2. **一个 panel 缺的 transcript 只要一次。** `ensureTranscript(resource)` 是「为某个资源打开的 panel」
   说出自己需要它的唯一方式（controller 自己那条路只跟着**选择**走）。每个资源一次——拒绝是答案，
   每来一帧再问一次就是把一次被拒的读变成一串批准卡。
3. **尾窗按「可见单位」扩展，不按消息数。** 一串工具调用折叠成一行，200 条消息在屏幕上可能是两样东西。
4. **工作区查询一台一台排队。** 每次都是对一台真实机器的独立 capability 调用；一起发出去就是一次打开
   页面弹出 N 张批准卡，顺序还没人选过。
5. **succeeded 的 operation 只处理一次。** Host 会随状态推进重发同一条记录。
6. **roster 刷新单飞且不丢最后一次变化。** 同一 `SessionsProvider` + port 内，boot、可信 Host 发出的
   authenticated projection wake 和用户刷新共用一个在途请求；期间所有触发合并为最多一次 trailing refresh。
   running operation 不发盲轮询：设备 materializer 的 runtime/interaction 变化就是 wake。Provider 卸载后不再
   pump。这个协调器不跨 tab，也不共享或绕过任何 capability Gate。
   扫描标记覆盖本 port 的 in-flight/trailing 请求、Host loading 投影及索引 backfill；缓存 ready 帧不能
   提前结束在途扫描标记。缓存行继续可用，旧 port 的回包不能清除新 port 的忙态。

注意 `select()` 与「提交完成后重读」走的是 `read()` 而**不是** `ensureTranscript()`：它们是显式的刷新
意图，不该被「这个资源问过了」挡住。

## 多标签缓存与持续可见（2026-08-14）

controller 在一个 port / View generation 内保留有界 display LRU：最多 256 条 session summary 和 8 个
transcript window。Host 仍只投影更小的工作集；被轮换掉的 transcript 仍按原规则重新经过 capability Gate，
缓存只让已打开 tab 在这段时间继续画最后已知正文，不持久化、不跨 port，也不作为授权或写入依据。

transcript LRU 还保留每个 resource 的最强来源证据。相同 Runner epoch 内，较低 sequence 或更小
`total/end` 不能因为外层 App frame revision 更高就覆盖新尾部；较早 offset 若与现有窗口连续/重叠，只补
历史前缀。更高 sequence 的同前沿改写仍可替换流式内容，不同 epoch 则作为真实来源重建接受。缓存于
layout effect 在浏览器绘制前记住已接受窗口，避免已画出的完成消息在下一帧闪回。

缓存正文或渐进名册仍在等待权威读回时，模块保留现有内容，并用共享、支持 reduced-motion 的小旋转分别标明
「正在同步最新消息」或「正在同步最新会话」。transcript 忙碌状态按 resource 记账，不能让另一个 chat 的读
在当前 tab 上制造假加载；没有明确 loading 生命周期的表面也不根据内容猜陈旧。

Hook 证明 `process_state=alive + turn_state=working` 时，如果当前没有 pending interaction，也没有
`activity.state=tool` 的工具尾部，chat 最底部显示共享 spinner +「Agent 正在思考」。工具卡或请求卡一出现，
这个兜底立即让位，避免一轮仍在运行却整屏完全静止。有 `observed_at` 的 working 证据静默超过共享
`QUIET_MS` 后降为「状态待确认」并撤掉动画；旧 Runner 没有时间戳时不猜测，仍保留兼容行为。

## 运行动画、完成验收与稳定排序（2026-08-25，工单 #369）

session 行只有两种互斥状态标记：`working` / 仍可信的 activity 显示共享 `av-spin` 小旋转；最后一次
`completedAt` 晚于 App durable `reviewedAt[resource]` 时显示静态待验收点。运行态优先，所以新一轮开始后不会
同时出现旧完成点；该轮完成后点会重新出现。开机填充默认 selection 不算看过，只有 session 的
`workspace.open` 被接受后调用 controller `select()` 才乐观写验收，拒绝或异常会恢复点，不自动重试。

导航器里收藏是独立分区，永远在最上面，按收藏顺序排列，不再排在前台 tmux 之后（2026-10-22）。「最近会话」
与每个文件夹内部的排序依次为 Runner 已确认在 tmux 前台运行的会话、其余会话。前台需 alive + attached
terminal_tmux 证据，离线旧行不提升；空闲等待输入的前台 CLI 也优先。组内按 `sortActivity`（旧 provider
回落 `lastActivity`）从新到旧。
scanner 的版本化摘要
缓存负责一次计算 `sortActivity` / `completedAt`；View 不扫描 transcript。controller 已先排序，最近列表会先做
线性有序检查，常规投影更新不再重复 `sort()`。

## 缺席判定只认 settled 帧（2026-08-15，工单 #138）

Host 的渐进 roster 帧（`resourceState: "loading"`）是首屏披露，不是名册权威：它只带先完成的一个
plane；Runner plane 自身已经是 Bot materialized snapshot。controller 的 `selectedAbsent` 与
`sessionAbsent(resource)` 因此只在 settled 帧上判缺席；loading 帧从不改写这个判断。AgentChat 的 ⚠ 提示条再叠加
`ABSENT_NOTICE_DELAY_MS`（1.5s）防抖：
短于该时长的缺席不闪现，行回来时立即清除（在场不防抖）。被防抖的只是提示条；聊天本身始终按
「absence is not deletion」渲染保留事实。

## 导航器：收藏、文件夹、最近与自动化（2026-10-22）

`components/Navigator.tsx` 是活动栏：桌面是左侧竖条，窄屏是导航层顶部一行标签（会话列表 / 文件树 /
全文搜索，刻意不与外框的「会话 / 文件」层标签同名）。三个视图常驻挂载，只切换 `hidden`，所以切换不丢
文件树展开和各列表滚动位置；chat header 的 cwd reveal 会自动切到文件树。

`components/SessionNavigator.tsx` + `lib/navigator.ts` 是会话列表视图。纯函数把名册与 App 自有状态分成
四区：**收藏**（收藏顺序）、**文件夹**（用户建立，默认收起，显示数量与运行中指示）、**最近会话**、
**自动化任务**（provider 声明的 exec 且未收藏/命名/归档，默认收起）。一个会话至多在一个文件夹里，归档
后离开「最近」；收藏的会话在收藏区与所在文件夹都可见。顶部筛选框只匹配行上看得见的标题、目录、设备与
provider，回车把同一词交给全文搜索视图。

整理动作全部是 App 自有状态（见契约 CLAUDE.md）：行的 ⋯、右键或上下文菜单键打开同一菜单（打开 / 收藏 /
重命名 / 移到文件夹 ▸ / 移出文件夹）；Ctrl/⌘-click 多选、Shift-click 按显示顺序连选；拖动一行或整个选择
到「收藏」、某个文件夹、「文件夹」标题（新建并归入）或「最近会话」（移出所有文件夹）。拖拽数据只有
opaque resource 数组（`application/x-octopus-sessions`）。拒绝显示一行回执，不自动重试。菜单经 portal
挂到 `[data-app-surface]`，避免被 Dock 流式容器裁切，关闭后焦点回到打开它的行。

收藏或归档的会话不在当前帧里（设备离线、Runner 待升级、会话已删除）时显示为「不在当前名册」的占位行，
仍可打开、取消收藏或移出文件夹；absence is not deletion。可信 Host 会为这些会话按身份补取摘要，所以
在线设备上的旧收藏不再因为最近窗口截断而消失。

## 自定义会话标题（2026-08-22，工单 #316）

`customTitles` 是 App 投影里的 durable 覆盖，不是 provider roster 的改写。controller 保留原始 provider
summary，再在展示边界按 opaque resource id 覆盖标题；这样选中行暂时离开 roster 时仍能命名，清除覆盖后也能
恢复缓存中的 provider 标题。搜索、目录会话列表、chat header 与 Dock tab 都消费同一展示标题。输入折叠空白，
最多 48 个 Unicode code point；空值调用同一个动作清除覆盖。拒绝时保留草稿并允许重试。

## `data-*` 测试锚点是契约，CSS class 不是

`[data-av-session-row]` / `[data-av-session-composer]` / `[data-av-chat-transcript]` /
`[data-av-session-action]` / `[data-av-new-session-*]` 等显式属性被
`packages/bot/src/session-plus/browser.e2e.test.ts` **从 frame 外面**读取。新增跨 frame 验收只能扩展
`data-av-*`（可信 Dashboard 用 `data-testid`）或使用 ARIA role/name；不得把 class、计算样式或某个像素值当测试
API。class 只服务样式，可以重命名、分层或模块化而不要求重写行为测试。Dockview / CodeMirror 的私有 class
只允许留在确实验证其拖拽、文本 surface 等第三方行为的局部测试里。

`AgentChat` 的键盘提交语义来自中立 `chat-ui-commons/composer`：内容宽度不超过 720px 时 Enter
直接发送，宽屏继续只认 Ctrl/Command+Enter；输入法合成确认、WebKit 229 与按键重复都不提交。
任何组合复用 `agent.chat/v1` 会继承同一行为，模块仍然只把 prompt 交给调用方的 `onSend`。

两个断点都只常驻自增长输入框和发送键（桌面第二行另有下面的运行配置条，不占输入框上方空间）。
权限档位、收藏、备用账号切换、刷新、加载更早消息，以及 Host
声明当前可中断时的停止动作，都进入输入框右下角默认关闭的 `composer-options` 弹卡；有普通写入路径时，
显式接管也留在该卡中；只有接管可用时，常驻主键明确改为「交给 Octopus 托管并发送」，避免输入框可写但
唯一可执行动作被藏起。不同 CLI/provider 不再在草稿上方常驻一坨运行时控制。折叠只改展示，不改 port 动作、
权限档位或 Host 审批语义。停止文案仍按 `capabilities.terminal_interrupt` 分叉：本机终端只发送一次停止键并
明确「不结束 CLI」，托管轮次则调用 provider interrupt；按下后的 pending 仍由 Host 撤销能力清除，并保留
有界兜底，避免拒绝后永久不可重试。

composer 可按 opaque session resource 保存页面内的模型与 effort 选择。空值表示保持 Runner
当前/默认值；模型来自新建 Agent 共用的 provider 下拉目录，effort 使用 provider 自己的闭集，并随后续一次会
开启新托管轮次的发送一起提交。正在进行的 provider-native steer 已经固定了本轮配置，外部 TUI/tmux 注入也没有
provider 配置回执，因此普通发送在这两种状态不携带选择；可信 Runner 仍会在竞态下明确拒绝，绝不把“改模型/effort”
降级成只把文字送进终端。选择以 opaque session resource 分键、只留在当前 View 生成中，不写入会话持久状态。

**运行配置条（2026-10-20，工单 #767）。** 模型与 effort 不再藏在设置卡里，而是与新建 Agent 的启动输入框
共用 `components/RunConfig.tsx` 的同一组紧凑项、同一顺序（后端 → 模型 → Effort）：桌面在输入框正下方独占
composer 网格的一整行（有配置条时 ⚙、上传、发送顺移到下一行，`composer-entry-configured`；Dock 分组常比视口窄，
与按钮挤在一行会把下拉框压到只剩几个字），手机仍保持「输入框 + 发送」两列栅格并把配置条折进 ⚙ 卡顶部。
不按 `html[data-av-theme]` 限定这些重置：classic 主题就是没有该属性。
`lib/cli.ts` 的 `turnConfigurationRoute()` 决定是否出现：`managed`（下一条消息开启托管轮次）或 `takeover`
——Agent 从别的路径启动（终端 TUI、hook 观察的 CLI），普通发送只能把文字送进那个进程，但显式「交给 Octopus
托管并发送」会先结束精确绑定的 CLI 再开托管轮次，Runner 在那里以所选模型/effort 为准；此时配置条标注
「托管时生效」，controller 经 `carriesTurnConfiguration()` 只把选择附在 takeover 提议上，绝不附在终端追加上。
父 Agent 所有的子 Agent、无接管能力的外部 CLI 与进行中的 steer 不显示配置条。Fast（服务档位）与指定目标
账号的切换需要可信 Host/Runner 协议新增参数，本包没有假装提供。

Codex 备用账号切换只在可信 roster 给出 `accountLabel`、会话空闲且没有待回答 interaction 时出现。它是
一次显式发送意图，不自动重试失败回合，也不让 View 选择账号。成功后 controller 只跟随 Host 返回的
`newResourceId` 并保留原会话；同一成功 operation 把原 resource 的 optimistic echo 封成墓碑，绝不把旧
transcript 的绝对坐标搬到新 resource。新 transcript 只显示 provider 的 authoritative copy；失败则沿用
发送生命周期恢复草稿。界面明确披露上下文会复制、provider 缓存不跨账号复用。

## 消息送达与 Agent 执行分开显示（2026-09-07，工单 #519）

同 resource 的 tmux / managed 发送沿用一个本地气泡：提交当帧显示文字，operation 只推进发送状态，
成功显示静态「已送达」，等绝对位置在点击之后、正文按 `promptMatchKey` 相同的权威 user 消息到达才一对一替换
（contract 的唯一定义：去掉 Claude 的 `<pasted_content>` 包装、空白不敏感；双语 Claude 按 `bilingual.zh`
比较。终端粘贴回来的文本会被 Claude 改写，2026-11-12 前的逐字比较让多行消息显示两遍）。Host 把同一 resource
上仍在进行的相同发送合并到原 operation，所以一个 opId 只保留一个回显。成功后旧 operation
不得退回 running/unknown 或恢复草稿。消息未同步时可显式隐藏本地回显，不让不保留原文的 CLI 永远转圈。
只有原生 `/compact` 和有 `newResourceId` 的跨资源交接仍由精确成功 operation 封口。

`waiting_approval` 明说等待批准，unknown、缺失 opId 或发送抛错均停止动画并说明结果未确认，不伪报失败。
明确失败/拒绝保留有界原因并恢复空草稿；不确定输入只保留在气泡，核对后可以显式放回空输入框，恢复动作
不会发送、覆盖新草稿或触发接管。晚到的异步回执不得写入已卸载/换 port 的状态。Agent 是否执行、思考或
等待交互仍只认 runtime/interaction，不能从发送 operation 推断。

## 父 Agent 所有的 Codex 子 Agent（2026-08-30，工单 #457）

Codex Multi-Agent V2 的 `thread_spawn` 子 Agent 由父 Agent 管理：只有父 Agent 能用 `followup_task` 唤醒或
继续它，app-server 的 `canAcceptDirectInput: false` 明确拒绝外部 `turn/start`。可信 Host 只在 provider
元数据完整声明这一关系时投影 `inputMode: "parent_owned"` 与精确 `parentResourceId`；缺席时不按昵称、agent
path、cwd 或相似正文猜。`AgentChat` 因而保留 transcript 和本地草稿，但隐藏发送、接管、账号分叉、中断、
模型/effort 与控制释放，只提供“打开父 Agent”。controller 与 Host binding 分别拒绝同样的写动作，Runner 最后
再以 app-server 能力兜底；任何一层都不得用 `thread/fork` 的历史副本冒充原子 Agent 自动恢复。

## 启动一个 Agent 必须有结局（2026-08-16，工单 #191）

`startNewSession()` 以前只有一行 `port.start(...)`，收据被调用点 `void` 掉；而**被接受之后** operation
才失败的那一种更糟——本 App 根本没挂 `session.operations/v1`，失败帧到达、被收下、无人渲染。现在启动
与 chat 发送同构：点击当帧产生 `PendingLaunch`，按回执里的 `opId` 跟随 operation 流，终态带那句话，
表单在按钮上方逐字显示。三条纪律：**被拒绝不清草稿**（只有 succeeded 清指令，旧规则未动）、
**在飞时不二次启动**、**不重试**。App 层另有 `AgentViewAlerts` 兜底「我当时没看着这个表单」。

2026-08-21 起，可信 Host 在成功 operation 上给出可选 `newResourceId`；启动表单收到后通过既有
`workspace.open(session)` 打开并聚焦新会话。桌面进入对应 chat tab，手机由同一个语义焦点切到会话层；
旧 Host 缺字段时保留成功回执，不拿启动目标的临时 resource 猜会话身份。

2026-08-28（工单 #429）：session composer 与新建 Agent 的首条 prompt 可由组合注入浏览器本地 persistence；
模块仍不知道 localStorage、viewer、release 或 MessagePort。点击发送/启动先写空墓碑但保留必要的在屏回执，
明确动作拒绝或终态 operation 失败才恢复缓存。Chat 的 `backend_unavailable` / `dispatch_failed` / unknown
只在本地气泡保留文字，标明结果未确认；核对后可显式「放回输入框」，不会自动回填或重发。
启动表单的不确定失败仍只在当前页面保留可重试文字。附件与权限/模型选择不落盘。

模型字段同批从 `<input list=…>` 改成 `<select>`（datalist 在手机上没有可见性，人只能凭记忆打字）。
列表在 `lib/cli.ts`，草稿里未列出的值仍保留为一个 option。交付：
`doc/deliveries/2026-08-16-session-plus-launch-feedback.md`。

**启动面是一个空聊天（2026-10-20，工单 #767）。** `NewSession` 不再是整页表单：顶部一行标题与目标位置，
中间是空 transcript（未发送时说明「发送即启动」并汇总所有选择，含折叠在 ⚙ 里的账号与权限，避免隐藏值
无声生效），底部与 chat 相同的 composer 网格。设备、目录、后端、模型、Effort 是输入框下方的运行配置条
（手机两列排布，目录独占一行）；Codex 账号、权限档位、进阶放置与安全说明折进 ⚙ 卡，卡片锚定在 composer
上方而不是 ⚙ 图标，窄 Dock 分组里也不会被裁掉。发送第一条消息即启动：在飞时这条消息显示为右侧气泡、
输入框清空并锁定，回执（含拒绝/失败原文与「知道了」）紧随气泡；被拒绝时草稿仍回到输入框。启动是一份
brief 而不是一句聊天，所以沿用 #180 的 `handleModifierSubmitKeyDown`：任何视口 Enter 都换行，只有
Ctrl/⌘+Enter 或发送键提交。成功并被组合接受打开新会话后，模块清掉回执并关闭自己的 runtime panel，空聊天
直接变成那个会话的 chat；组合拒绝 session intent 时保留「已启动」回执。DOM id 与 `data-av-new-session-*`
锚点全部保留，主键可访问名为「发送并启动 Agent」。

## 复用证明（`src/harness/`）

`createMemorySessionsPort(fixture)` 是 `agent-sessions/v1` 的**第二个真实实现**：从 fixture 作答，
四个写方法返回 `READ_ONLY_REFUSAL`。`ReadOnlySessionsApp` 用**同样的 module 对象**（按 id 从
`SESSIONS_MODULES` 里筛出三个）加一个不同的 composition。它不复制后端 service，也不绕过 typed port
去构造 wire message——那样只能证明 App 能跑，而那不是这里要证明的事。

## 测试

异步问题的“忽略”是展示偏好：按会话 resource 与问题稳定 id 记录，不发送消息，也不改变回答证据。
已忽略项退出未确认计数，在独立的默认折叠区展示；显式回答记录优先显示为已回答。
组合可通过 `SessionsProvider.asyncQuestionPersistence` 注入与草稿相同形状的浏览器缓存接口，
模块不接触存储或身份；每会话保留最近 128 项并限制序列化长度。缺席该接口时只保留当前组件状态。
Sessions+ 使用独立 `session-async-ignored:` 键，沿用 Host 的账号分区、容量和有效期，
不跨设备同步，清除/过期浏览器缓存后可能再次显示未确认。

```bash
npx vitest run --project agent-sessions-view --maxWorkers=1
npx tsc --noEmit -p packages/agent-sessions-view/tsconfig.json
```

| 文件 | 测什么 |
|---|---|
| `src/controller.test.tsx` | 六条规则（含**排队后仍会被读到**、同窗口去重、18 路 roster 触发合并、running operation 不盲轮询与 unmount 停泵）+ 多 tab display LRU + 选择修复 + 分页 + 新建草稿的保留与清空 + 回答交互后刷新 + optimistic send 按绝对位置精确消重（含重复同文、prepend/tail slide、legacy fail-safe、失败/拒绝、resume/takeover/steer、跨 resource operation 墓碑）+ parent-owned 子 Agent 零写提议 + 启动生命周期（拒绝保草稿、接受后设备失败、在飞时不二次启动）+ 新建 prompt hydration/提交前墓碑 |
| `src/composer-drafts.test.ts` | resource-local 通知、LRU、延迟写、空墓碑、匹配回执恢复，以及不确定失败只留当前页面 |
| `src/modules.instance.test.tsx` | 同一模块多次挂载时的 DOM id；首个 chat 绑定 + 点击 session 派生/复用 tab；外部 Codex best-effort send；Hook working 的 thinking 兜底 |
| `src/architecture.test.ts` | 依赖边界与禁用名字（读本包源码，包括注释）：不许出现 `SESSION_ACTIONS` / `SESSION_PARAMS` / `SESSION_OPERATIONS` / `ALL_SOURCES`，`AGENT_SESSIONS_CONTRACT` 仍然允许（manifest 要声明用哪个 port） |
| `src/harness/harness.test.tsx` | 第二个 App 复用**同一批 module 对象**、从 fixture 渲染、写路径被拒绝 |
| `src/lib/transcript.test.ts` | 通过兼容入口钉住两种 CLI 归一、折叠单位、活动状态是 NOW 的函数 |
| `src/components/ChatTranscript.test.tsx` | 共享 chat 外壳按注入渲染：窗口条算术、加载更早、注入 renderer、仅新到达末尾纯文本的有界打字机、`ChatTurn` class |
| `src/components/Transcript.memo.test.tsx` | 新投影只换 status/空 pending/callback 包装时不重画既有 Markdown；稳定 handler 仍调用最新已提交回调，真实 transcript 变化照常渲染 |
| `src/components/AgentInteractionCard.test.tsx` | Claude AskUserQuestion 与 Codex request_user_input 共用一张卡：必答校验、选项回传、权限拒绝与无自动回答 |
| `src/components/NewSession.test.tsx` | 空聊天结构（输入框、composer 内配置条、⚙ 折叠项、选择汇总）、仅 Ctrl/⌘+Enter 提交、在飞时消息成为气泡且输入锁定、模型下拉按 CLI 列出、未知值不被改写、启动收据各 phase 的文案与失败着色 |
| `src/components/DirectoryIndex.test.tsx` | home 根文件树、文件打开保留 listing lineage、默认折叠的全局最近会话、目录旁紧凑列表、无 key 不猜，没有 files provider 时的 session-tree 降级，以及 narrow 时收起手动 ↻ / 折叠权限档位（含折叠后文案与 tone 逐字保留） |
| `src/lib/home-directory-tree.test.ts` | 多 root 共享祖先、外部 root 的 `..`、exact-key 定位、synthetic/ref 两套展开身份，以及未登记 cwd 从精确父根定位且拒绝 root-label 猜测 |
| `src/lib/directory-sessions.test.ts` | 已列出目录子树的 exact-key 联结、浅层优先、未列出的深层不预取 |
| `src/lib/file-link.test.ts` | 候选顺序（key 永远第一）、无 key 时按 label / 相对路径回落、缺条目才换起点、**拒绝即停**、目录端点与非文本的诚实文案 |
| `src/lib/file-mentions.test.ts` | 四种锚定写法、`:行号` 被剥掉、目录/版本号/域名/掉了 scheme 的 URL 一律拒绝、裸文件名的白名单与散文词表；linkify 不碰围栏代码块、既有链接与真 URL，行内代码整段是路径才改写，流式半行仍可渲染 |
| `src/lib/roster.test.ts` | 单链目录压缩、子树计数、Windows 分隔符、忙碌会话浮到日志更新的前面 |
| `src/lib/navigator.test.ts` | 收藏顺序高于 tmux、一会话一文件夹、未命名 exec 进自动化区、子 Agent 折叠与保留、缺席占位、筛选、连选顺序 |
| `src/components/SessionNavigator.test.tsx` | 分区与默认展开、行状态、菜单收藏/归档/重命名、拖放到文件夹/收藏/最近、Ctrl/Shift 多选、新建与重命名/删除文件夹、拒绝回执、无整理能力与访客降级、共享列表 |

`WorkspaceFilesProvider.links` is an optional published-index resolver supplied
by an App composition. Chat and FileViewer use it for explicit evidence indexes
without pretending those indexes are filesystem roots. It returns only a file
ref already in that App’s published projection and grants no capability. Without
it, Sessions+ retains the ordinary workspace planner and typed-port Gate path.
`chat-controls.css` owns the shared chat/composer chrome for every consumer.


## Per-resource frontend lifecycle (2026-09-14)

Session read/workspace scheduling belongs to one port generation. At most two
different resources/devices run concurrently; reads for one resource remain
ordered and duplicate windows are single-flight. Provider exceptions settle the
attempt and release the queue. Old-generation replies never pump new work.
Mounted chat panels retain their resource lease; the last panel releases only
that subscription through closeSession, never the Agent. Reopening cached text
still restores the live lease. Projection hot-window eviction is not subscription
loss, and still-open transcript display windows are retained outside the inactive
LRU. The controller samples the same newest roster/transcript runtime used by the
chat controls before encoding model, effort and append/resume.

An unknown launch is uncertain, retains its submitted text in the visible
receipt, accepts a later success and never automatically restores an executable
draft or repeats the launch.

### Resource display subscriptions (2026-09-14)

`SessionsProvider` keeps one stable store per port. Chat modules use
`useSessionResource(resource)` for immutable resource slices; equal decoded
projection branches retain identity. Commands forward to the latest committed
controller, so stable callback identity never freezes model/runtime settings.
Directory/roster navigation uses `useSessionNavigation()` and search uses
`useSessionSearch()`; transcript-only full frames preserve these snapshots and
do not rerender navigation. Roster metadata (including count/review status),
workspace access, history and reveal still invalidate the appropriate slice.
Forms retain `useSessions()` compatibility. Mounted
transcript windows remain cached when absent from a bounded hot projection;
absence alone does not trigger another capability read. The Session+ Dock root
is memoized independently of transport frames; recovery remains a mount-only
checkpoint and resource modules update through their own subscriptions.

Directory rows share one `createDirectorySessionsIndex` per immutable roster and
listing-cache generation. Exact directory-key buckets and same-device resolvable
home-ancestor buckets preserve the previous union, deduplication and depth/order
rules. The cache makes no requests, includes only already-listed file descendants,
and is discarded with its mounted index/generation; it never grants file access.


## Codex 模型目录（工单 #785）

模型建议优先使用 placement 中运行机的账号 `models`；新建的显式账号按注册 id 选，
后续轮次按会话的稳定账号 label 选。尚未自动路由账号时显示该设备已发现模型的去重并集。
失败、空目录、旧 Runner 或缺失账号均回退 `MODELS.codex`；已有选择缺席时保留自定义项。
目录只是建议，不是授权或模型支持保证，可信 Host/Runner 与 provider 仍裁决实际请求。
后续轮次发送允许符合既有有界模型语法的选择，不能再按静态建议列表丢弃动态模型。
原生 select 的 option 使用 `--av-canvas` / `--av-fg`，跟随 Host 的明暗主题。
