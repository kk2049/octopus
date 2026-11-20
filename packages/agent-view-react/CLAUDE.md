# Agent View React — 可挂载 App 的共享 React 运行时

> 2026-08-06 新增（v4 Agent View React）；同日加入布局内核 `./workspace` 与展示子入口 `./ui`。
> 设计：`doc/development/agent-view-react-hot-plug-design.md`、
> `doc/development/agentic-app-module-system-design.md` §16、§18.2
> 边界：`doc/adr/0001-session-plus-trust-boundaries.md`
> 交付记录：`doc/development/agent-view-react-worklog.md`、
> `doc/deliveries/2026-08-06-agentic-app-module-platform.md`

## 一句话

Agentic App 发布默认导出的纯 React 组件，由普通 Dashboard 在同一个 React/Ant 树中挂载。
SDK 提供共享 context/hooks、无网络的 App runtime、错误边界、展示原语和布局内核。
HTTP/SSE、浏览器 draft/recovery 存储及 runtime teardown 由宿主所有；资源权限在后端校验。

Node 侧工具链在两个兄弟包里（2026-08-11 拆出，此前是本包的 `./build`、`./release` 与
`./preview` 子入口）：确定性构建与产物加载在 `packages/agent-view-build`，本机预览 harness 在
`packages/agent-view-preview`。本包重新只含浏览器代码。

## 入口，窄的那两个是边界

| 入口 | 给谁 | 有什么 |
|---|---|---|
| `.` | App 与宿主 | client types、hooks、Provider、错误边界、展示原语 |
| `./runtime` | 宿主与测试 | 纯 `createAppRuntimeClient`；不导入 React/UI/旧 frame bridge |
| `./ui` | 可复用的 **View 模块** | 只有展示原语与错误边界（外加设计令牌样式） |
| `./workspace` | 组合 View 模块的 App 与模块 | 静态 registry、layout reducer、fixed-slot `WorkspaceShell` 与 opt-in `DockWorkspaceShell` |
| `./shell` | **不想自己写组合根的 App** | `StandardApp`：三份 release 文档 + 模块表 + adapter 表 → 整个浏览器半边 |

## 两种同等合法的 App root

- 产品特有交互直接从 `.` 使用 hooks，自己拥有 React/DOM。
- 已有模块的新组合从 `./shell` 使用 `StandardApp`。

选择只取决于交互与复用，不取决于信任等级：同一 View 内模块不是独立 principal。
两种 root 都必须放在 `AgentViewProvider` + `AgentViewErrorBoundary` 内，并遵守下面的三条规则。

一个模块 import `./ui` 就**说不出** `SESSION_PLUS_PROTOCOL`——名字不在作用域里。依赖边界因此是
类型错误，而不是一条可以被沉默的 lint。`./shell` 是唯一同时碰传输与布局内核的那一份，所以它
单独一个入口：「这个文件需要哪个入口」因此仍然是一个可读的答案。

## 运行时与授权

SDK 不读取身份、凭据或浏览器存储，也不自行建立 HTTP/SSE 连接。宿主将这些动作绑定到正确的
App、release、scope 和 instance，再给 client 提供 `dispatch`。同源 App 的 DOM 与普通前端共享，
不再把浏览器 iframe 隔离作为新的 release 的授权边界；后端仍校验每个资源/动作请求。

## 文件

| 文件 | 职责 |
|---|---|
| `src/client.ts` | 兼容 import 路径的共享 type definitions，无 frame transport 实现 |
| `src/runtime.ts` | 单一投影入口、动作与 operation 账本、同源 dispatch seam、关闭后的 late-result 防护 |
| `src/provider.tsx` | 必传 caller-owned client；共享 context 与最后拒绝文案；不创建、不关闭连接 |
| `src/hooks.ts` | `useProjection` / `useOperations` / `useAgentViewStatus` / `usePropose` / `useProposals`（动作生命周期账本：in-flight 与有界保留的拒绝，`dismiss` 清除）/ `useRefusal` / `useWake`；全部经 `useSyncExternalStore`，并发渲染下不撕裂 |
| `src/alerts.tsx` | `AgentViewAlerts`（工单 #191）：读 proposal ledger + operation 流，把**被拒绝的动作**与**失败的 operation** 变成右上角非阻塞通知，默认摘要、按需展开有界详情，不抢焦点或遮罩工作区。只读、不重试；`approval_required` 不在其中——那是可信外层拥有的待批准决定，不是失败。`resource.open_text` 的 `not_text`/`too_large` 由文件视图说明并提供下载，避免重复通知干扰恢复动作；其它拒绝仍报警。首帧就已终态的 operation 算历史不算新消息 |
| `src/ErrorBoundary.tsx` | App 渲染崩溃 → 一行降级，**通道保持打开**；不重载、不导航、不定时重试 |
| `src/controls.tsx` | antd 之上的薄壳（`AvButton`/`AvInput`/`AvTextArea`/`AvCheckbox`）。`AvTextArea` 另外持有**受控光标守卫**（工单 #189、#297、#486）：普通编辑在受控提交后按原快照恢复 selection；IME 的 `input` 在 capture 阶段只记快照、不碰 selection，`compositionend` 后覆盖两种浏览器顺序——尾随 change 值未变就恢复原快照，候选文本在 end 后才提交则用预览光标之后的未变后缀把光标映射到替换段末尾（重复字符不靠最长公共前缀猜）；`compositionend` 自身等到下一任务才恢复，先让 WebKit 延迟的候选/自动空格 input 落下，避免提前移动 selection 打断输入法；快照下一任务过期，元素失焦、后缀也变化或 selection 未动时仍不碰 DOM |
| `src/ui.tsx`（subpath `./ui`） | `StatusChip` / `Banner` / `EmptyState` / `ModalDialog` / `Markdown` / `SplitHandle`，以及 permission-free browser download state/action/notice/empty presentation；全部 trust-neutral。`Markdown.renderImage` 只是一处渲染注入缝，不读取文件或 URL。设计令牌样式在这里装载，所以模块不必记第二个 import |
| `src/workspace/`（subpath `./workspace`） | 布局内核：`registry.ts`（静态 module registry）、`layout.ts`（**唯一**能改 panel/resource/dirty/open/close 的 reducer）、`WorkspaceShell.tsx`（小 App 的 fixed-slot 默认呈现）、`DockWorkspaceShell.tsx` + `dock-layout.ts`（opt-in docking 与有界 presentation codec）、`api.ts`（模块操作 + dirty-close + 窄屏返回）、`viewport.ts` |
| `src/shell/`（subpath `./shell`） | `StandardApp`：`{composition, bindings?, modules, adapters, providers}` → registry + plan + 每个 port 一个 provider + `WorkspaceShell` + 默认 chrome + 状态行。**它从不构造 port**（只调 App 给的工厂），**从不恢复**（不重试/重连/超时），**从不把装不起来的组合降级成 panel**（装不起来是 fatal 横幅）。第一个消费者是 `app:preview`，不是 Session Plus——那样「一行装出一个工作区」这条主张才不是自证 |
| `src/styles-index.css` / `src/styles.css` | 前者提供构建期主题注入标记；后者拥有几何、密度、字号、字重令牌与原语样式。色板和主题覆盖由 Dashboard 的纯数据 registry 在构建期生成 |
| `src/AgentViewUiProvider.tsx` | Ant 适配只读取当前 `--av-*` 计算值；不认识 Apple、DeepSeek 或任何主题 id，新增主题不改 SDK |

`Markdown.renderCodeBlock` 与 `renderImage` 一样只是展示注入缝：SDK 不引入图表库或网络行为；
会话模块可选择将已解析的 Mermaid 围栏交给中立图表组件，其它消费者保持默认代码块。

浏览器下载的 Blob 始终使用一次性沙箱子 frame 作为导航退路：WebKit 忽略 `download` 时只会替换那个
隐藏 frame，不会把整个 App View 导航走。共享下载状态同时保留可信 collector 报告的已收/总字节；
连接建立时显示不定进度，header 到达后显示原生 determinate progress，失败后保留最后进度并把按钮明确
变成「重新下载」。presentation 自身不重试、不读 port。PDF 与 workspace Markdown 图片的呈现属于
`@claude-bot/agent-file-preview`，不在布局 SDK 里。Ant 的点击波纹是纯视觉层，在 View 配置中关闭；否则手机上快速切换时
它的退场容器会短暂盖住相邻的工作区页签。

## 布局内核的四条性质

1. **`moduleId + resourceRef` 是身份。** 同一个资源打开两次是 focus 已经在的那个；只有显式
   `mode: "new"` 才产生第二个实例——**除非**这个模块被 App 的 binding plan 连接过（见下）。
2. **panel id 是稳定的 React key。** composition 实例保留 composition 给的 id，所以一个读者写了一半
   的消息在整个文档生命期里不会因为投影更新而消失。**关闭一个 composition 实例是清回未绑定的常驻态，
   不是删掉它**——一个 release 声明了六个 surface、点一下之后只剩五个，正是 `initialLayout` 已经拒绝
   产生的那种失败；运行时铸出来的 `panel-N` 关闭时仍然移除。
3. **每一种拒绝都是 panel-local。** 模块没登记、资源类型没有声明视图、slot 不被模块接受、Host 拒绝了
   这次读、渲染抛异常——每一个都变成**一个** panel 的状态加一个机器可读的 reason，没有一个能清空外壳。
4. **窄屏是 drill-in 不是缩放，而且不可见的 slot 是隐藏不是卸载（2026-08-07）。** `secondary` 变成盖在
   `primary` 上的一层并给一个返回按钮；被挡住的 slot 只是容器带上 `hidden`，panel 全部保持挂载——
   草稿、滚动与订阅在 drill-in 的两个方向都存活，`onPanelClosed` 只观察真实卸载。
5. **窄屏一个 family 只有一个 document（2026-08-16，工单 #189）。** `reuse`/`rebind` 的 open 重绑
   slot 里已有的那个 panel，不派生也不铸新的：手机一次只画一层，多出来的 document 就是一个够不着的
   tab。这条写在 reducer 而不是渲染层——只把 tab 藏起来会留下活着、仍在订阅、仍能被 focus 的 panel，
   等于第二套布局模型。显式 `mode:"new"` 不受影响，**dirty 的 panel 一律不抢**（视口不是丢草稿的理由，
   此时退回桌面路径派生同级）。

### `availableViews()`：同一个 resolver 的只读查询面（2026-08-10，工单 #46）

`availableViews(plan, resource)` 按 **composition open rules 的顺序**返回这个 release 能用来打开
该资源的模块（`{moduleId, title, slot, mode}`，数组与元素都冻结）。它给 Open-with 菜单与多文件
tab 用，**不是**第二个 router：候选枚举（`routesFor`）与可用判据（`routeIsUsable`）只有一份，
reducer 的 `resolveOpen` 读的是同一份。

两条不可协商：

- **不排序、不打分。** `[0]` 就是一次不指定 view 的 open 会落到的模块，所以按标题排序的菜单会与
  「直接点一下」的结果静默分歧。
- **只读 `kind`，永远不读 `mediaType`。** `workspace-files/v1` 的 listing 没有可靠 MIME，按文件名
  后缀猜 viewer 就是把显示名当路径读；一次猜错的结果是一个说不出自己为什么空的 panel。所以今天
  只支持**同 resource kind** 的多个 viewer/editor，跨 kind 路由要等可信侧给出可信的 kind。

它不引入状态、不缓存、不问 Host、不 import。空数组与 `no_viewer` 是同一件事的两种说法。

### 连接过的 surface：v1 排他，v2 有界派生

`createWorkspacePlan({composition, registry, bindings})` 可以收下 App 的 v1 或 v2 binding plan；被
`connections` 点名的 composition 实例就是**连接过的**。v1 对这些模块保持原语义：

- 同一个资源 → focus；**不同的资源 → 重新绑定那一个具名 panel**，不铸第二个；
- `mode:"new"` → **拒绝**（`open()` 返回 false，布局不动）。v1 的 binding 文档没有 template schema 能
  描述「第二个连接实例」，静默降级成 reuse 会回答一个不同的问题，静默放行则造出一个没有任何文档说过
  它连着什么、屏幕上却看起来连着的 panel。

这只是具名模块组合规则：Provider 的 context 对同一挂载树可见。binding plan 接的是具名实例，
布局里只能有那些具名实例。真实的资源授权边界是
服务端 Host 的 capability Gate；前端 client 只是一条动作调用接口。

v2 的 `templates` 给连接原型一个包含原型本身的 `maxInstances`。不同 ref 默认从原型派生独立 panel；同 ref
仍 focus/reuse；`mode:new` 也必须在 ceiling 内。派生实例继承原型的 module/slot/config/connection family，
但不会把 panel/template id 送给 provider，也不会产生第二个 binding、scope、vault 或 grant。达到 ceiling 时
fail closed，不 evict 或 rebind 现有文档。

不给 `bindings` 的 App（会话 harness、任何还没有 typed port 的组合）走的是原来那条路，逐字不变。

`DockWorkspaceShell` 使用 Dockview 提供 tab/split/拖放，但它只是 presentation adapter：Dockview params 只有
panel id/封闭 flow slot；close/focus 必须回到 coordinator；move/reorder 不成为 close。持久化公开面是过滤后的
`DockPresentation`（有界 surface、split/group、size/order/active），不是 Dockview JSON；它不含 ref、provider、
config，也不读写 localStorage。默认排版是 navigation + 中央 document stack + compact bottom；
未绑定的 secondary/overlay standing surface 是 dormant lifecycle placeholder，不形成 tab 或空白列。它仍保持
mounted，并留在用户选择的安全 group/order；一个 group 全部 dormant 时只折叠该 group，重新绑定按原位置恢复。
SDK 仍不读写浏览器存储；组合若要跨 iframe 重建恢复，只能把 codec 已过滤的 presentation 连同自己有界、
重新验证过的语义提示交给通道 owning App，再由可信 Host 决定是否保存。
恢复方可显式把 coordinator 已创建的 runtime panel 纳入 codec scope；presentation 不创建资源。
快照保存原视口宽高，恢复时按视口缩放 group 尺寸；嵌套 split 使用整个子树的尺寸。
App 在模块挂载前通过 reducer 形成 `initialState`，避免默认布局先落盘或回放后台 tabs。

Dockview 7 没有 single-tab visibility API，也不能从其 document-capture keyboard service 过滤隐藏 group/panel。
所以这层集中维护一个有浏览器测试保护的 tab DOM marker，关闭 overflow dropdown（tab strip 仍可滚动），并设置
`keyboardNavigation={false}` 后实现 visible-only 的 F6、Ctrl+[ / ]、Ctrl+Shift+方向/反斜杠和 tab Arrow/Home/End；
每次 focus 仍回写 coordinator。手机层还有三条（工单 #189）：coordinator 的 **focus 变化就是跳转**（open 被接受后
落到哪个 slot 就切到哪一层，来回都算，离开资源层同时清 drill-in）；**本 composition 没有 panel 的分区不渲染按钮**
（长期 disabled 的按钮读起来像坏了，不像不存在）；`initialMobileSection` 让组合选择第一次进入窄屏时的
可用层，随后仍由 focus / drill-in / 用户切换接管；`mobileSectionLabels` 让组合给自己的层命名，
`mobileActions` 是 App 自己的手机 chrome 插槽（刷新键之类）。手机栏保持 sticky 且高于 Dockview overlay，
浏览器聚焦编辑器并自动平移 App 文档时也不能滚出 frame 可视区或被 panel chrome 盖住。Ctrl+M keyboard docking 暂不提供；要恢复
必须先给 Dockview 上游/补丁增加
navigability filter，不能把 dormant panel 暴露给键盘导航。surface inset 由 composition 通过 slot/module class 声明，
平台不猜模块 DOM。手机只显示导航/主区/资源/状态之一并 maximization；状态区投影 `bottom` flow，确保批准与
operation 结果可达；窄屏禁止 DnD，单个可见 document tab 不重复占一层 header。

dirty 由模块报告给 coordinator。close 一个 dirty panel 只产生 `closePendingPanelId`；取消不卸载，明确放弃才
执行真正 close。普通 docking move、切 tab、窄屏返回都不会触发这一生命周期。

`bottom` 与 `overlay` **不是列**：shell 把 navigation/primary/secondary 放进一个 `.av-columns` 行，
另外两个是那一行的**兄弟**。用「五个都放进一个 flex 行然后让最后两个 wrap」会让换行的那一行占掉
一半高度——这条结构是被一次真实的浏览器回归换来的。

## 失败不是可选渲染（2026-08-16，工单 #191）

View 只有两条得知「没成功」的路：提议被拒绝（在 ledger 里），以及提议**被接受**、之后 durable
operation 失败（在 operation 流里）。第二条原本靠一个**可选模块**渲染——Session Plus 没挂，于是失败帧
到达、被收下、无人渲染。所以这条性质属于 runtime：`AgentViewAlerts` 挂一次，本 View 里任何 typed port
的拒绝与失败都变成右上角可关闭通知（工单 #588），默认仅显示最新一条摘要，展开最多六条详情；不抢焦点、不遮罩、不自动消失；它不提议、不重试，`approval_required` 除外（那是可信外层的批准面）。

## 动作生命周期

1. client 只把 `action/params` 交给宿主提供的 dispatch；后端重新核对资源和权限。
2. 一个挂载实例使用一个 caller-owned runtime；Provider 不再自动创建 frame 或握手。
3. 失败、拒绝和结果未知是可见状态；不自动重放动作。关闭会结清在途 promise 并拒绝晚到回复。

## 发布契约（工具链在 `packages/agent-view-build`）

一个 Agent View 发布为**按名字排列的 UTF-8 资产**，它们的字节**就是** release 身份：
**改一个 React 组件仍然会换 URL**——当前挂载代码由不可变资产 URL 和 module manifest 标识。
强制这件事的构建配方（`agentViewViteConfig()`）与产物加载器（缺失 / 截断 / **陈旧** 一律拒绝）
2026-08-11 拆去了 `@claude-bot/agent-view-build`——改构建前先读那个包的 `CLAUDE.md`。

对本包留下的含义只有一条：**本包 `src` 是每个 View 的 source-digest root**，这里任何文件
（包括测试）变了都要求重建；而 release 身份只取产出字节，所以仅测试变化不改变最终字节时，packageDigest 保持不变。

## 与 Dashboard 的关系

宿主与 App 共享 React、React DOM、SDK context、Ant 与 CSS-in-JS runtime。App 发布资产仍独立
按 digest 定址；当前 SDK 不提供 frame factory。旧 IIFE artifact 的恢复由宿主兼容加载器处理，
旧桥实现留在旧 artifact 中，不混入新 SDK/ESM App。App CSS 由构建入口限定在挂载 surface；
portal 与拖动类必须留在同一个 `data-app-surface` 内。

## 测试

```bash
npx vitest run --project agent-view --maxWorkers=1
npx tsc --noEmit -p packages/agent-view-react/tsconfig.json
```

| 文件 | 测什么 |
|---|---|
| `runtime.test.ts` | revision 单调、关闭时结清 promise、晚到结果失效、operation 有界单调、draft/recovery 不扇出 App snapshot |
| `hooks.test.tsx` | 投影/operation 无需轮询即到达；拒绝变成有界文案并在下一次提议时清除；卸载不销毁调用方 runtime；StrictMode 的模拟重挂载后通道仍然是活的 |
| `alerts.test.tsx` | 拒绝与失败显示非阻塞通知、输入与其它动作仍可用、`approval_required` 与首帧历史不起、同一条 operation 重发不复活已关掉的提示、条数有界 |
| `ErrorBoundary.test.tsx` | 崩溃后 frame 不消失、**通道仍在收投影**；文案有界；只有 App 主动要求才重试；抛异常的 observer 不会带走 fallback |
| `ui.test.tsx` | 敌意字段是文本不是标记；Markdown 不产出 HTML 字符串、`javascript:`/`data:` 链接失效、支持表格；modal 有可访问名称与标准关闭动作；splitter 是可键盘操作的 ARIA separator |
| `workspace/layout.test.ts` | reducer：复用/显式新建/focus/close、composition 实例作为稳定 key、模块缺失与无视图与 slot 被拒的三种 panel-local 拒绝、denied 的置位与清除、窄屏 drill-in 与返回；以及 `availableViews`：同 kind 两个 viewer 的顺序/title/slot/mode、未知 kind 为空、显式 `view` 与 `suggestedView` 的允许与拒绝、registry/manifest/composition 任一缺失都不成为候选、**候选表与 reducer 给同一个答案** |
| `controls.test.tsx` | 受控写回把 selection 收到别处时光标回到编辑处；合成期间不动 selection；没有编辑就不恢复；未聚焦不动；ref 仍指向真正的 textarea |
| `workspace/WorkspaceShell.test.tsx` | 渲染之后仍然成立的三件事：草稿随挂载存活、关闭真的跑了模块的 cleanup、一个模块抛异常只带走自己那个 panel；以及 `bottom` 是列的兄弟而不是列 |

`release.test.ts` 随工具链搬去了 `packages/agent-view-build`（root node project 运行）。

浏览器才能证明的性质（cookie、跨源 DOM、CSP 真的挡住 fetch、崩溃后外层存活）在
`packages/bot/src/session-plus/browser.e2e.test.ts`，**不在这里用字符串断言复述**。


## Ordinary frontend runtime (2026-09-14)

The pure `@claude-bot/agent-view-react/runtime` entry exports
`createAppRuntimeClient`. It owns one authoritative projection, bounded action
and operation ledgers, and lifecycle guards. The caller owns same-origin HTTP/SSE,
server-bound instance headers and browser persistence. Ingress is
`update`, `operation`, `wake` and `updateAppearance`; `close` resolves
pending calls and rejects late results without replaying an action.
It creates no frame, MessagePort, network connection or React root.

Existing App hooks consume this client through `AgentViewProvider`.
The ordinary Dashboard passes `uiProvider={false}` and
`reflectAppearance={false}` because its shell owns those document-wide services.
Draft and recovery callbacks do not publish a full App snapshot.
The Provider requires a caller-owned client. The current SDK contains no frame
factory; historical artifacts retain their own legacy implementation.
