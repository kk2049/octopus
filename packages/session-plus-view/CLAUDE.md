# Session Plus View — 薄 composition root

> 2026-08-06 新增（v4 Agent View React）；同日改为模块平台的第一纵切。
> SDK 与布局内核：`packages/agent-view-react/CLAUDE.md`
> 可复用会话模块：`packages/agent-sessions-view/CLAUDE.md`
> 模块 ABI：`packages/agent-module-contract/CLAUDE.md`
> 后端与边界：`packages/bot/src/session-plus/CLAUDE.md`
> 交付记录：`doc/deliveries/2026-08-06-agentic-app-module-platform.md`

## 一句话

`/sessions-plus` 那个 iframe 里跑的**组合**：把这个 App 的传输适配成 `agent-sessions/v1` port、
注册本 release 的模块、画自己的 chrome、选择可复用 workbench presentation。产物仍然是两个文件，由
`packages/bot/src/app-core/view-app.ts` 内联进那一个 digest 定址的文档。

**它不再拥有资源逻辑。** transcript 分页、单飞读、工作区队列、operation 去重与全部会话协议 action
字符串在 `@claude-bot/agent-sessions-view`；目录遍历、流循环与文件拒绝文案在
`@claude-bot/agent-workspace-files-view`；资源 action 词表在 `workspace-files-contract`。
这里只剩 `App.tsx`（≤160 行代码，实测 110）、一个 adapter、一个 plan 和一份主题。

## 这个程序被允许是什么

它跑在一个 opaque origin 的 frame 里：没有 cookie jar、没有父文档 DOM、没有
fetch/XHR/WebSocket/EventSource、没有表单、没有弹窗、不能导航 top、不知道谁登录了。唯一被支持的
通道是可信外层转交的那个 MessagePort；在那条通道上，`propose` 是它**唯一能请求动作**的消息。
另有一条每分钟聚合的 content-free `performance` 诊断窗口，只含固定 count/duration/DOM-node 数字，
不请求动作、不经过 Gate、不携带身份或内容，Host 可丢弃；它不改变这条授权边界。

所以下面每个文件都按一个前提写：**假设它是敌意的，然后看它能做到什么。** 它能渲染乱七八糟的
东西、用任意参数提议动作、把自己卡死。它学不到任何身份，因为没人告诉过它。

## 文件

| 文件 | 职责 |
|---|---|
| `src/main.tsx` | 入口。**没有 `StrictMode`**——那是开发期辅助，发布的 View 不能与测过它的东西行为不同 |
| `src/App.tsx` | 组合：适配 port、注册模块、把 Host 的 content-free session wake 交给 provider、画 chrome，并 opt in `DockWorkspaceShell`；不拥有 docking/resource 状态。**挂 `AgentViewAlerts`（工单 #191）**；本组合不挂 `session.operations/v1`，operation 历史由可信外层消费同一 SSE |
| `src/view-performance.ts` | iframe 内无内容性能窗口：投影接收→commit/下一帧、input→下一帧、Long Tasks、可见页 timer lag 与 DOM 节点数；输入/投影 burst 各自一帧只排一个 rAF，每分钟至多发一组固定数字 |
| `src/adapter.ts` | **本包唯一知道会话 action id 存在的文件**（资源读取的词表在 `workspace-files-contract/src/remote.ts` 里，本包只调 `createRemoteWorkspaceFilesPort`）：把 `agent-sessions/v1` 的方法映到 `propose(action, params)`，包括 provider-neutral 的交互回答。用的是 **provider 的** `propose`（它记录并清除 Host 的拒绝文案），不是 client 的 |
| `src/drafts.ts` | 把 runtime 的 identity-free browser draft seam 映到会话模块 persistence；已有 chat 按 opaque resource 分键，新建 Agent prompt 用保留键，viewer/release scope 仍只由 Host 决定；文件批注直接使用同一 seam，并由 preview 以完整文件+选区/批注 id 分键 |
| `src/plan.ts` | 本 release 组装什么、依赖什么：module lock + composition + **`agent-resource-bindings/v2` template**，以及它们作为 release 资产的**规范字节**。依赖轻（无 React、无 CSS），因为 Node release builder 也读取它 |
| `src/styles/app.css` | App chrome 与共享元素默认样式。workbench 几何在 `agent-view-react` docking adapter；模块样式跟随各模块包 |
| `src/paths.ts` | **Node 侧**：产物、构建命令与完整 source closure。当前覆盖 17 个源码根、相应 package manifest、构建配置与 lockfile |

## 本 App 的组合

```text
navigation  session.directory-index/v1（导航器：会话列表 / 文件树 / 全文搜索）
primary     agent.chat/v1
            + open rule：session / remote-terminal（按物理机复用 tab）
documents   workspace.file-viewer/v1 + workspace.editor/v1 + crdt note
            + open rule：new-session/workspace-text/crdt-note
```

composition 仍声明封闭 logical slots；`DockWorkspaceShell` 把 document surface 映射为可拖动 tab/group，把
navigation 当不可拆的 flow surface。拖动只改 presentation，不改 binding、ResourceRef 或 panel lifecycle。
手机端用导航/主区/资源单层切换；operation/批准结果由主站右上角的可信紧凑面板承载，不再用底部
flow 占用工作区高度。

> 2026-08-28（工单 #438）：删除 `bottom` 中的 `session.operations/v1` 常驻实例；统一目录索引的每个
> 物理机行右侧用 `remote-terminal` resource 打开 primary Dock tab，同设备重复点击只聚焦既有 tab。
> 终端仍只经过 `agent-sessions/v1` 的 open/read/send/close 与原 Gate，composition 未新增 binding 或权限。
> operation SSE 继续送入 View controller 完成生命周期刷新，同时可信 Dashboard 在「会话信息」中保留
> 本页最近 20 条状态；不会把可信记录或身份回投 iframe。

> 2026-08-10：navigation 里原来的 `session.roster-tree/v1` + `workspace.file-tree/v1` 两个实例被
> **一个** `session.directory-index/v1` 取代——会话 cwd 树与工作区文件层按 `directoryKey` 相等联结成
> 一棵懒加载索引；binding 从 `workspace-files/v1` 切到 **v2**（同词表、同 Object、同权限契约 digest，
> 不需重新同意）。交付：`doc/deliveries/2026-08-10-session-plus-unified-index.md`。
>
> 2026-08-13（工单 #96 / #109）：同一个模块改成**文件优先**的目录树。session 不再作为第二类行常驻左栏；
> 根按 exact key 归入以 `~` 开始、外部位置用 `..` 表示的显示树。目录旁计数在按钮右侧打开无底色紧凑列表；
> 导航顶部另有默认折叠的全局最近会话。文件目录仍按用户展开懒加载，不为计数预取。
>
> 2026-08-14：普通文件 intent 的第一条规则改为 editor；挂载仍只读，只有显式保存才调用写能力。
> session 行也不再只改 controller selection：首个选择绑定 standing chat，之后每个不同 session 在 primary
> document group 生成一个可复用 Dock tab，重复打开只聚焦原 tab。
>
> 2026-08-16（工单 #189）：手机层不再是「堆起来的桌面」。布局内核在窄屏把每个 family 收敛成**一个**
> document（一次一个 agent、一次一个文件），coordinator 的 focus 变化直接切层（导航里点会话/文件、chat 里点
> 文件都是「跳过去」），顶栏只给本 composition 真有 panel 的层出按钮——所以本 App 的第四个「状态」按钮消失了
> （这里从来没有 `bottom` 实例）。`App.tsx` 另外给出 `mobileSectionLabels`（导航 / 会话 / 文件）与
> `mobileActions`（`SessionsRefreshAction`，手机上唯一的刷新入口）。composition、binding、权限契约一个字节没动。
>
> 2026-08-20（工单 #274）：手机首次进入明确落在导航层，不再由 standing chat 的 primary 默认焦点抢走；
> 全局最近会话在窄屏默认展开，桌面仍默认折叠，手动开合覆盖保持 sticky。默认 chat 只等 settled roster
> 再选，避免渐进首帧里最快的只读 observer 成为与历史列表手动打开行为不同的会话。
>
> 2026-08-18（工单 #254）：桌面与手机都不再把投影 `notice` 画成 Workspace 上方的常驻说明；
> 可信外层的 App 身份、连接状态和授权表合并进主导航首栏的「会话信息」，授权表在其中再次默认折叠，
> 重建按钮同列保留。会话模块自己的运行时/权限动作统一进入 composer 右下角设置卡。投影、binding、
> permission contract 与动作语义均未改变。
>
> 2026-08-16（工单 #181）：`crdt.doc-list/v1` 的常驻实例 `docs` 从 navigation 移除。navigation 是 flow
> slot——桌面端同列分高度、手机端占整个导航层——所以一条本 App 不办事的常驻栏等于从目录索引手里
> 拿走高度。`crdt.note/v1` 的 `doc` 实例、`docs` binding 和权限契约**一个字节都没动**：空的 secondary
> 面板本来就 dormant（不占 tab），而收窄 ask 会作废每个用户的同意、要求重新授权，那是另一个决定。
> 现在 App 内没有任何入口发 `crdt-note` 的 `open-resource/v1`，`doc` 是保留的已声明表面。

> 2026-08-21（工单 #301；工单 #547 补全 bot-host）：chat composer 的 paste 图片扩成任意文件按钮与
> drag/drop。当前 App 动作 `attach_file` 通过 session resource 在所选 Agent 所在的 Runner 或 bot host 上
> 分块写入新建临时目录（Linux 为 `/tmp`），完成后绝对路径才成为 chip，并在下一条 prompt 发送。
> 机器写入花 `upload_session_file`，所以权限契约
> 升到 `sessions-workspace-write-crdt-self-service/v4`，现有用户必须重新同意；动作仍是 `human_only`。
> 桌面按钮与输入框并列，手机按钮只在默认关闭的 composer 设置卡里。旧 `attach_image` 只保留给已经
> 安装的 rollback release，仍按它原来的 bot-host scratch 语义执行，不属于当前 bundle。
>
> 2026-08-22（工单 #316）：chat 设置卡允许为当前 session 写 App 自有标题；同一标题同步进入
> 最近会话、搜索、chat header 与 Dock tab。空值清除覆盖并恢复 provider 标题。动作只携带 opaque
> session resource 与标题，不花 Gate operation；Host 将覆盖持久化进 App event stream，最多接收
> 48 个 Unicode code point。
>
> 2026-08-25（工单 #369）：运行中的 session 行把静态点换成共享小旋转；完成后若
> `completedAt > reviewedAt[resource]` 则显示待验收点。只有显式打开会话才发 App-owned
> `review_session`，开机默认选择不写；该动作不花 Gate operation、不改变 permission contract。
> roster 改按 provider 缓存产出的最后用户输入/Agent 完成时间排序，普通输出不再移动行。
>
> 2026-08-25（工单 #376）/ 2026-08-27（工单 #419）：chat header 可把导航从最近会话切回文件索引，
> 并从 exact-key 登记根逐级展开到 session 的真实 `cwdDisplay`；手机显示同一入口的紧凑图标。成功后先聚焦
> 导航层，等待该层实际可见后 focus 目标目录按钮并只滚动文件索引自身，保证目标在桌面与手机视口中可见。文件链接
> fallback 命中的 root label 只称“目录根”，不再称“工作区”。
>
> 2026-09-25（工单 #669，替代 #435 的恢复策略）：账户隔离的浏览器缓存保留最近工作区，
> v2 checkpoint 按 Dock group 只保存一个前台文档（最多 16 个）和分栏比例、视口尺寸、手机层。
> 启动先通过 reducer 重建文档，再把保存的 group 映射到新 panel id；旧 v1 只迁移活动会话，
> 不沿用无法关联 runtime 窗口的旧布局。文件只保存唯一根显示标识与实际 listing label 链，
> 通过当前 roots + resolvePath 重新获得引用；缺失、歧义、拒绝或 10 秒未完成即降级，不重试。
> 文件读写仍经原 Gate；草稿、后台 tabs、文件正文和旧 file/root ref 不进入布局缓存。
> 手机保留桌面拓扑，不把 maximization 写成桌面布局；浏览/编辑交接必须保留 listing context。
>
> 2026-08-22（工单 #317）：普通文件点击改为 viewer-first；Markdown 先安全渲染，点「编辑」才把同一个
> opaque ref 交给 editor。所有 viewer 状态都有显式下载，`not_text` / `too_large` 不再拒绝打开，而是
> 显示下载占位。下载使用独立 `download_workspace_file` 权限词元，权限契约升到
> `sessions-workspace-write-crdt-self-service/v5`，既有用户必须重新同意。Session Plus frame 仅增加
> `allow-downloads`；仍是 opaque origin，且没有 forms、popups、same-origin 或网络能力。
>
> 2026-08-26（工单 #399）：本人访问自己 Runner 上的绝对路径改走独立
> `access_owner_files` read 词元，权限契约升到 `sessions-workspace-write-crdt-self-service/v6`。可信
> provider 在该权利实际存在时铸 `/` opaque root；View 只沿 ref + label 下钻，不提交路径或设备 selector。
> 已登记 workspace 的授权、containment 与 CAS 写入语义保持不变。
>
> 2026-09-25（工单 #668）：self-service/v7 增加独立 `replace_owner_text`，让本人 Runner 根下的文本
> 也能经 Gate、expected-digest 与原子替换保存。用户须重新同意新契约；历史读取和 workspace 写入授权不扩大。
>
> 2026-08-23（工单 #320）：opaque-origin App sandbox 不再调用 Chrome 内置 PDF extension，而由
> release 内静态打包的 PDF.js 在 canvas 绘制；不加 `allow-same-origin`、popup 或网络。Markdown 相对图片
> 只沿文件行实际 listing lineage 调 `resolvePath`，再走同一媒体流；外部 URL 保持不可加载。

文件 viewer/editor **有常驻连接原型**，和启动表单相反；其中 viewer 是普通文件点击的默认表面，editor
由 viewer 的「编辑」或文件树显式编辑动作打开。v2 template 允许它们各自在上限 8 内派生
独立 panel；不同文件不再 rebind 覆盖前一个 tab。同一 family 的全部 panel 继承一个 `workspace` binding，
所以它们仍是一个 provider scope/ref vault/grant，不是每个 tab 自己发现或授权文件。

启动表单**没有常驻实例**：它只在有人要求时存在（`open-resource/v1`，合成资源 kind `new-session`），
所以「关掉它」是关一个 panel 而不是翻一个模式开关，重复点 `＋` 会 focus 已经开着的那个而不是叠第二个。
启动成功后，可信 Host 随 operation 给出新会话的 opaque resource；表单用同一条 `open-resource/v1`
会话规则聚焦 chat，因此桌面和手机共享一个导航动作，View 不自行拼 owner/session 身份。

> 2026-10-20（工单 #767）：启动面改成空聊天——对空输入框发第一条消息即启动，设备/目录/后端/模型/Effort
> 是输入框下方与会话 composer 共用的运行配置条，账号、权限与进阶放置折进 ⚙。新会话的 chat 打开后，启动
> panel 自行关闭。外部终端启动的 Agent 在显式接管时也能选模型/effort。动作、参数、binding 与权限契约
> 一个字节未变；细节见 `packages/agent-sessions-view/CLAUDE.md`。

> 2026-10-22：navigation 只剩一个 `index` 实例。它是导航器：活动栏下的会话列表（收藏、用户文件夹、最近、
> 默认收起的自动化任务）、文件树与全文搜索三个视图；独立的 `search` 实例退出组合，`session.search/v1`
> 留在 module lock 里供其它组合与回滚 release 使用。收藏与文件夹是 App 自有状态，新增的
> `save_session_folder` / `delete_session_folder` / `file_sessions` 与 `pin_session` 同为 runtime 动作，
> 不花 Gate operation、不改变权限契约。DOM id `search` / `doSearch` / `railHidden` / `railRefresh` /
> `newAnywhere` 保留，但分别在各自视图里；新增 `navFilter`、`navRefresh` 与 `data-av-nav-*` 锚点。
> `examples/session-plus.preview.tsx` 是带交互 fixture 的本机预览（App 动作经预览控制台句柄写回投影）：
> `node_modules/.bin/tsx packages/agent-view-preview/src/cli.ts packages/session-plus-view/examples/session-plus.preview.tsx --port 5181`，
> `?theme=apple` 等参数切换主题。

四条编排规则（单飞读、按可见单位扩尾窗、工作区串行队列、succeeded 只处理一次）现在在
`@claude-bot/agent-sessions-view` 的 controller 里，本包不再持有它们——
`src/architecture.test.ts` 会在它们回来的那一刻失败。

> 2026-08-16（工单 #191）：`.actionnotice` 那一行退役，换成 runtime 的 `AgentViewAlerts`。原因是它只覆盖
> 「提议被拒绝」，而这个组合真正丢失的是另一半——提议**被接受**、durable operation 之后失败：本 App 没有
> `session.operations/v1` 实例（底部 flow 在 #189 已移除），所以失败帧到达、被 client 收下、无人渲染。
> 新面同时覆盖两者，对本 App 挂的每个 typed port 生效，`approval_required` 除外（那是可信外层的批准面）。
> composition、binding、权限契约一个字节没动。

## 浏览器验收锚点

验收使用 `[data-av-chat-transcript]`、窗口数值属性 `data-av-chat-offset/count/total`、
`[data-av-session-composer]`、`[data-av-dock-*]` 与 ARIA role/name。聊天顶部窗口条与
`#loadOlder` 已移除；自动历史分页通过真实向上滚动验证，手动入口保留在会话设置中。
CSS class 只服务样式，不作为新的跨表面测试 API。

## 构建

```bash
pnpm --filter @claude-bot/session-plus-view build   # pnpm -r build 已包含
```

产出 `dist/agent-view.js`、`dist/agent-view.css`、`dist/build-manifest.json`（`.gitignore` 覆盖）。

## 重新构建 ≠ 上线（2026-08-11，工单 #61 踩到）

构建只让**本机 checkout** 变新。线上服务的是 registry 里**已激活的那个 release**，而
**部署可信代码不会移动这个指针**——所以改了下面的 release source closure 之后，代码合入并部署了，用户看到的
仍然是旧 View。只有 `kind: "app"` 工单会在合入时自动 pack → install → activate；`simple` /
`complex` / `discuss` 工单**不会**，哪怕它改的正是这里。

release 身份是**内容 digest**，没有语义版本可以 bump：字节一变它自己就变了。要往前迭代的是
「已安装 + 已激活」这个指针。完整步骤与「我这次要不要重新发布」的判据见
`doc/runbooks/app-release.md`。
**改了 source closure 里的任何字节就必须重新构建**——`SESSION_PLUS_VIEW_SOURCE` 现在覆盖
Session Plus、中立 chat UI、sessions/files/editor/text/CRDT 模块、资源 contract、typed-port/stream/module contract、
Agent View runtime、flight-recorder(运行时内嵌调试通道的时间线,工单 #138)、web-trust 与
agent-view-build recipe,共 18 棵源码树及其 manifests/config/lockfile；否则 `packages/bot` 的加载器会拒绝启动
并说明原因：一个用旧源码构建的产物是自洽的（digest 与那些字节相符、主机名与那个 digest 相符），
唯一不对的是它不是树里的代码。`packages/bot/src/session-plus/view-source.test.ts` 逐个包证明它们
真的参与了这个判定。

## 测试

```bash
npx vitest run --project session-plus-view --maxWorkers=1
npx tsc --noEmit -p packages/session-plus-view/tsconfig.json
```

| 文件 | 测什么 |
|---|---|
| `src/App.test.tsx` | 用假 Host 通过**真 MessagePort** 驱动整个组合：boot 的三件事、提议里没有任何身份字段、敌意投影是文本不是标记、投影整体替换、composer 跨投影更新保住值/焦点/选区、live→append 与 idle→resume（含后续轮次模型/effort）、AskUserQuestion/request_user_input 卡片只回传 opaque resource + interaction id + answer、有界拒绝文案、尾窗与分页、单飞读、operation 生命周期、表单复用与关闭、启动新 Agent 的参数与 effort 收窄、搜索、DOM 钩子守卫、通道关闭后不再提议。模块各自的单元测试在它们自己的包里；这里测的是**接线** |
| `src/drafts.test.ts` | 新建 Agent prompt 与 opaque session chat 使用不同语义键 |
| `src/view-performance.test.ts` | input/projection burst 只排一个 frame callback；commit/frame/Long Task/timer lag 与 DOM 数量只形成封闭数值窗口；无活动不发送、卸载取消 observer/timer/rAF |
| `src/architecture.test.ts` | App.tsx ≤160 行代码；协议 action 字符串只出现在 `adapter.ts`；资源算法（`countUnits`/`buildDirTree`/…）不在本包；依赖方向只指向模块包；`plan.ts` 不 import React |

浏览器才能证明的性质在 `packages/bot/src/session-plus/browser.e2e.test.ts`，这里**不用字符串断言
复述**。


2026-10-21（工单 #786）：新建 Agent 的 open rule 属于 primary，与已有聊天同组。
首条消息支持文件按钮、drop 和文件/图片 paste；先完成原 attach_file 分块上传才可发送。
新建草稿使用执行设备与可选登记工作区，可信服务铸造 instance/target 分键的 multipart 身份；
只接受本人 Sessions+ 页面，访客与其它 App 仍须使用原会话资源。没有新增操作词元、授予或权限契约，
既有 upload_session_file 仍逐次过 Gate；Runner 构造新目录，View 不能指定文件路径。
