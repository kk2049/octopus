# Dashboard Web — 可信面板的浏览器层（React + CSS）

> 2026-08-06 新增（v4 Phase 1）。架构决策：`doc/adr/0003-dashboard-react-frontend.md`
> 交付记录：`doc/development/dashboard-react-migration-worklog.md`

## 一句话

面板的**全部浏览器代码**在这里：一个 React 挂载树与按需加载的页面/组件，由 `packages/bot` 在鉴权通过之后交给浏览器。
服务端仍然是唯一的授权者——这一层渲染服务端已经作出的判定，从不代替它作判定。

## 它替换了什么

| 退役的东西 | 为什么 |
|---|---|
| `dashboard/{page,shell,sessions-page,unified-sessions-page,tickets-page,hq-page,secretary-page,admin-page,pending-page,session-view}.ts`、`permissions/page.ts`、`session-plus/{page,consent-page}.ts` | 九个页面 + 一个壳层是 TypeScript 模板字符串里的 HTML/CSS/JS，编译器看不到，测试只能 `new vm.Script()` 解析 |
| 内联 `<script>`（每页数个，靠 per-response nonce 放行） | 现在**一个** `<script type="module" src="/ui/…">`，CSP 收紧成 `script-src 'self'`，没有 nonce、没有 `unsafe-inline` |
| `innerHTML` + `esc()` 手工转义（约 30 处） | React 元素树；不可信内容走 `react-markdown`，路径上根本没有 HTML 字符串 |
| 幂等重绘 / `paint()` / 手工保留 fold 与 scroll | 组件状态 + `<details>` 的浏览器自有开合状态 |
| `document.head` 里给 `window.fetch` 打补丁以附加 CSRF | `lib/api.ts`，一个模块，不动全局 |
| 手写 resizer（pointer events，无键盘） | `react-resizable-panels`（ARIA separator、方向键、持久化） |
| `window.confirm` / `alert` | Radix Dialog（焦点陷阱、Escape、`aria-modal`） |
| 手写 `mdLite`（120 行正则） | `react-markdown` + `remark-gfm`（并且第一次支持表格） |

## 文件

| 路径 | 职责 |
|---|---|
| `src/contract.ts` | 服务端 ↔ 浏览器的**唯一**交接类型（package subpath，两侧 import 同一份） |
| `src/lib/bootstrap.ts` | 读 payload；Session Plus instance handle **读一次即删块**，只留模块私有绑定 |
| `src/lib/api.ts` | 唯一的请求出口：同源、CSRF、无重试、空响应可读化、绝不落盘凭据 |
| `src/lib/browser-drafts.ts` / `browser-drafts-react.ts` | 按 viewer + 语义输入框分键的浏览器本地文字草稿；延迟写入、空墓碑立即写、TTL/容量/大小有界，结果不确定时不复活可能已提交的文字 |
| `src/lib/query.ts` | TanStack Query 缺省：普通 GET 网络/5xx 失败有界重试两次、60 s 后切回/重连才重取、不随挂载重取；轮询只走 `REPLAY_SAFE` 白名单 |
| `src/lib/sse.ts` | `useEventSource`：一条连接、StrictMode 双挂载安全；浏览器放弃的连接按 1 s→30 s 退避重连并如实报告状态，`err` 帧即终止 |
| `src/live-contract.ts` | Dashboard sessions/tickets SSE 的 unstable-frontier 协议；server/client 同源 |
| `src/projection-delta.ts` | 托管 App 投影的结构化 patch 协议（`x-projection-delta: 1` 协商、`view-patch` 帧、act 回包的 `x-projection-base` / `projection_patch`、diff/apply）；server/client 同源。Bot 先把 patch 应用到自己的 base 校验后才发送；浏览器只对它持有的那一帧应用 |
| `src/lib/projection-stream.ts` | 可信宿主一侧：用上一帧重建完整投影（流帧与 act 回包）再交给 host/App（App、runtime 与 revision 守卫看到的仍是完整投影）；流 patch 对不上就断开重连拿整帧，连续 3 次后本页退回整帧协议；act 回包重建不了就当作不带投影的回包 |
| `src/lib/transcript.ts` | 中立 `chat-ui-commons/transcript` 的兼容入口；只含展示派生，不 import Agent View 实现 |
| `src/app/` | 路由、壳层、批准抽屉、额度条、死人开关横幅；窄屏页面级动作通过 `ShellPageActions` portal 进入可信首栏，页面不复制导航 |
| `src/pages/` | 可信面板页面；会话功能只保留 `/sessions-plus`，旧 `/sessions` 无前端实现、由服务端兼容跳转。不需要登录的公开页面只有 `/login`、`/register`、`/share` 和飞书文档的领取链接页 `/doc-key`（`DocKeyPage`：秘密只在 URL 片段里，读一次就从地址栏去掉，只放进同源 POST 的请求体） |
| `src/pages/session-plus/OperationHistory.tsx` | Sessions+ 可信 operation SSE 的本页有界历史；按 operation id 更新、最多 20 条，只把服务端显示字段作为 React 文本放进「会话信息」 |
| `src/pages/knowledge/` | `/knowledge` 知识库：能力索引 / 全量节点关系图 / 能力与模块阅读清单 / 节点 / 搜索 / 试算启动包 / 裁决队列；状态全在 URL，裁决只 POST 审阅台账，从不在页面里改知识 |
| `src/transcript/` | Dashboard 专属虚拟化/活动外壳；chat 滚动、分组/turn 与结构 CSS 来自中立 `chat-ui-commons`（工单页也在用） |
| `src/session-plus/app-host.tsx` | 当前 ESM App 的同树挂载、共享 runtime、样式引用、草稿/恢复 seam 和异步关闭；`frame-host.ts` 仅用于已安装旧 IIFE release 的回滚兼容 |
| `src/session-plus/recovery-store.ts` | Sessions+ 账户隔离的浏览器 `localStorage` 最近布局缓存（兼容旧 `sessionStorage`）；共享 token 与存储失败都降级为不恢复 |
| `src/ui/` | Markdown、Dialog、SplitPane（横向/纵向分组 + 可折叠 panel）、`Attachments`（粘贴文件的 hook + chip 条，三个输入框共用；只有栅格图片有本地预览链接）、`PageErrorBoundary`（一页渲染出错只换成带「重试 / 刷新页面」的小面板，壳层保留）、小件 |
| `src/app/DebugDock.tsx` | 🐞 提单坞。由 `Shell` 挂载，**每个页面都有**；模型/effort、Runner 来源与工作区可选，选取元素先给可反向解析的选择器链，支持粘贴图片与 Screen Capture 截图。开合状态归 `Shell`：宽屏是右下角浮标，≤720px 浮标隐藏、入口在顶栏菜单折叠卡片里（工单 #207） |
| `src/lib/element-path.ts` / `element-picker.ts` | 可信页面自己的元素地址与 picker；Session Plus 的元素由 View 通过 debug channel 答（两侧不 import 彼此，只共享字段名） |
| `src/lib/attachments.ts` | 粘贴任意文件 → 按 `ATTACHMENT_CHUNK_BYTES`（`contract.ts`）顺序分块 `POST /api/attachments`（每块在默认 1 MB 请求窗口内，总大小不设上限）→ chip；ref 在**发送那一刻**由仍在草稿上的 chip 组成并进入正文。不重试；草稿换代即停发后续分块 |

## 三条不可协商的规则

1. **服务端是唯一授权者。** `bootstrap.nav` / `pages` / `viewer` 是**导航提示**，不是权限。
   隐藏一个页签不是边界；每个请求仍然过 Cedar、mutation gate 和 capability Gate，页面被写成
   **渲染服务端的拒绝**而不是预测它。直接访问一个不该访问的地址，拿到的仍是服务端的
   401/403/404——文档是逐页在鉴权**之后**组合的，没有 SPA 通配回退。
2. **能力型 GET 不许自动重放。** `/api/session`、`/api/sessions`、`/api/sessions/search`、
   `/api/sessions/live` 会穿过 capability kernel，一次被拒的读会**生成一张待批准卡**，所以对它们
   不重试、不轮询、不随切回或重连重取。面板现在不读这四个端点（`lib/query.test.ts` 扫描源码钉住）；
   其余 GET 都是服务端本地读：网络或 5xx 失败有界重试两次，数据超过 60 s 才在切回窗口或网络恢复时
   重取，挂载不重取；轮询仍只对 `REPLAY_SAFE` 开放，要通过 `pollInterval()` 拿到间隔。出口流量按量
   计费，缺省不增加任何轮询。
3. **不可信内容永远不是 HTML。** 没有 `dangerouslySetInnerHTML`，没有 `rehype-raw`；
   Markdown 只走 `Markdown` 组件，链接协议白名单 http/https/mailto。

## 界面语言

`src/i18n/language.ts` 是页面语言的唯一来源，默认简体中文；现有五个选项均保留。
语义键文案使用 `useMessages()`；其余页面的源文案键集中在 `i18n/ui-copy.ts`，通过
`uiText()` 显式引用。使用该文案的 React 组件订阅 `useDashboardLanguage()`，不以语言
作组件 key，也不把语言加进数据请求键或 Host 生命周期 effect。缓存展示派生值时才加入
语言依赖；静态标签表用 `localizedLabels()` 分语言缓存。

异步通知和已打开表单的系统文案用 `uiMessage()` 保存键与参数，并在渲染时用 `uiValue()`
读取，避免切换语言后停留在旧译文。`uiValue()` 对普通字符串保持原样：工单标题与正文、
会话、用户输入、Agent/工具内容、命令和服务端业务数据不送进翻译函数。已知界面状态可以
按稳定标识查表，未知值保留原文。闽南语对本次补齐的系统词条沿用繁体中文回退。

`i18n/coverage.test.ts` 扫描 Dashboard TSX 中未接入目录的中文文案，例外限定为具体路径和内容；
`i18n/pages.test.tsx` 覆盖页面正文、已打开的确认框、待显示通知、输入连续性与原文边界。

## 构建与部署

```bash
pnpm -r build            # 包含 vite build；dev-restart.sh 与 supervisor 都跑这个
pnpm --filter @claude-bot/dashboard-web dev   # vite build --watch
```

产物在 `dist/`（`.gitignore` 覆盖），由 `packages/bot/src/dashboard/assets.ts` 读
`.vite/manifest.json` 后从 `/ui/` 提供。

页面使用 React.lazy；共享 React/Ant/SDK 运行时经 manifest import map 供独立 App 使用。
Bot 将公开 hashed `/ui/a` 资产归档到运行数据目录 `dashboard-assets`，旧标签页延迟加载仍取
自己的版本。归档不存用户数据，当前不自动 GC。不能在部署时删除仍被旧标签页引用的 chunks。
import map 的精确 JSON SHA-256 加入 CSP；没有放开 inline JS 或 eval。

## 测试

```bash
npx vitest run --project web --maxWorkers=1   # 这一层
npx vitest run --maxWorkers=1                 # 两个 project 都跑
```

> `--maxWorkers=1` 不是仪式：这台开发机是 2 核 / 3.8 GB，而仓库里有每次 handler 调用都 spawn
> 一个沙箱子进程的 engine 套件和三套真浏览器套件。用缺省并行度跑会把它撑爆，症状是一批 5 秒
> 超时和 `TypeError: fetch failed`——那是资源饥饿，不是断言失败。

`vitest.setup.ts` 做两件事：在任何模块求值之前装好 bootstrap payload（`lib/bootstrap` 在
import 时读它，和真实文档一样），以及**把未打桩的网络调用变成失败**——在 effect 里偷偷发请求
正是这套测试要抓的缺陷。

| 文件 | 测什么 |
|---|---|
| `lib/api.test.ts` | CSRF 只加在同源不安全方法上、cookie 名按部署来、跨源直接拒、空响应变人话、**只发一次请求** |
| `lib/browser-drafts.test.ts` | 输入框分键、约 1 秒延迟写、删除/提交墓碑、在飞期间新编辑不被旧回执清掉、Web Storage 不可用时安全降级 |
| `lib/query.test.ts` | 只对网络/5xx 重试且至多两次、60 s 内切回/重连不重取、`REPLAY_SAFE` 不含任何能力型端点、`pollInterval` 拒绝表外路径、没有页面读能力型端点 |
| `lib/sse.test.tsx` | StrictMode 双挂载只有一条连接、卸载即关、浏览器关闭后退避重连且从调用方当前游标续接、`err` 帧终止不重连 |
| `live-contract.test.ts` | SSE frontier 的 lookback、open-tool 与绝对 offset 语义 |
| `projection-delta.test.ts` | patch 往返逐字节一致（含键序、数组插删、随机投影）、不改动 base、拒绝对不上的 patch、`__proto__` 不污染原型 |
| `lib/projection-stream.test.ts` | 只对持有的那一帧应用 patch、失败即要求重连、重同步过多后停止协商 |
| `lib/transcript.test.ts` | activity 是 NOW 的函数、fold 单位与渲染器一致 |
| `ui/Markdown.test.tsx` | `<script>`/`onerror`/`javascript:`/`data:` 全部当文本、外链带 `noopener` |
| `app/Approvals.test.tsx` | 只发 pending id、附 CSRF、单飞、202 说“正在执行”而不是“完成” |
| `pages/PermissionsPage.test.tsx` | 三列不合并、Agent 渲染在 App 内、受信服务无控件、不做权限运算 |
| `session-plus/frame-host.test.ts` | 陌生 window 拿不到端口、重复握手忽略、身份字段丢弃、陈旧 generation 无权、熔断与重建；草稿桥只读写绑定后的本地 store，不进入 server dispatch |
| `ui-kit/primitives.test.tsx` | 适配器保住原生语义；**`primitives.module.css` 手写的每个 Ant 类名在真实 DOM 里存在** |
| `styles/css-modules.test.ts` | **没有页面 CSS Module 用裸 `input`/`textarea` 选择器画背景** |

> 最后两条都来自工单 #202,一起读才完整。
>
> **真因**：Ant v6 在每个 Select 内部放了一个真的 `<input type="text">`
> （`.ant-select-input`），`position: absolute; inset: 0` 铺满整个触发器、正盖在选中值上。
> Ant 自己用 `@layer antd` 里的规则把它保持透明，而 `styles/index.css` **刻意**让页面
> CSS Module 留在 layer 之外（这样页面能做本地调整而不必和特异性搏斗）。unlayered 无视
> 特异性赢过 layered，于是本来写给标题输入框的
> `.newPane input[type="text"] { background: var(--card) }`
> 在选中值上刷了一块不透明的板子。**给 Ant 组件写样式要瞄适配器类（`.ant-input`），
> 不要瞄裸元素。**
>
> **为什么它能活过三次「修好」**：值本身从来没错——在 DOM 里、颜色对、`opacity: 1`。
> 所以 `getComputedStyle` 说它可见，`toHaveTextContent` 通过，用户框选还能把字粘出来，
> 只有眼睛不同意。jsdom 不合成 layer、不画像素，这类缺陷对组件测试**天然不可见**；
> 前三次都在改文字颜色，而文字从来不是问题所在。定位它靠的是在真浏览器里构建真实的
> `NewTicketPane` 读 computed style。
>
> 顺带修掉的另一个真问题：那几条覆盖样式还停留在 v5 类名
> （`.ant-select-selector`/`.ant-select-selection-item`）上，v6 根本不渲染它们，
> 从落地起就匹配零个元素——**匹配不到元素的 CSS 规则不会报错**，这是 `primitives.test.tsx`
> 那条守卫存在的理由。

服务端一侧还有一条 **`packages/bot/src/dashboard/pages.e2e.test.ts`**：把每一个页面在真浏览器里
打开一遍（真 bundle、真 CSP、真 API），要求 React root 有内容、可信导航在、无未捕获异常、
**无任何 CSP 拒绝**。它替掉的是「解析内联脚本源码」那条——那条看不出脚本有没有**运行过**。

## 稳定 DOM 钩子（显式属性，不是 CSS class）

浏览器验收依靠显式 DOM 钩子观察宿主、App 挂载与真实批准卡；不依赖 CSS module 名。
旧 frame 的诊断钩子仅保留给兼容加载器：

| 钩子 | 谁读 | 说明 |
|---|---|---|
| `document.body` 的 `data-sp-*` | Session Plus 浏览器套件 | 可信外层对自己所作所为的记账：state / generation / ports / accepted / refused / ignored / answer |
| `[data-testid=trust-app]` / `[data-testid=reconstruct-agent-view]` | 同上 | 两道门与重建按钮 |
| `[data-testid=session-plus-workspace]` / `[data-testid=session-plus-frame]` | 同上 | 「框拿到剩余视口」及跨源 frame 身份 |
| `[data-testid=approval-activity-toggle]` / `[data-testid=approval-count]` / `[data-testid=approval-card]` / `button[data-action=approve\|reject]` | 同上 | 从应用外部打开抽屉并决定一张卡 |
| `a.tab[href=…]` | 同上 | 重建 View 之后可信导航仍在 |

CSS module / compatibility class 只负责样式，不是验收 API。删掉显式属性会让 Session Plus 浏览器套件
失去语义定位；`app/Approvals.test.tsx` 里有一条便宜的组件级守卫钉住其中几个。

## 当前前端边界

- App 是内部受审阅前端，与 Dashboard 共享同源 DOM、React/Ant 与 SDK context。资产仍独立
  按 package digest 热发布；新 App 无 iframe、MessagePort 或第二个 React root。
- 所有身份、instance/release/resource 绑定和动作权限仍由后端核验。共用 DOM 意味着不承诺
  隔离恶意 App 脚本；任意会话文本、Markdown、文件内容仍按不可信数据渲染。
- `app-host.tsx` 拥有 runtime；SDK Provider 不连接/关闭网络。按资源订阅缩小重绘范围，
  close 后晚到 import/投影不得复活旧挂载，已派发动作仍保留其不确定性和原 operation identity。
- App CSS 与 portal 限定在 `data-app-surface`。文档外壳、资源授权与构建规范见
  `doc/development/shared-app-frontend.md`。
- 旧 IIFE release 继续由 `frame-host.ts` 接载，以便 App 回滚。回滚到不认识 ESM 格式的旧
  Dashboard 服务版本需要刷新标签页；当前代码不把旧产物强行解释成 module release。

## 工单源码浏览

工单的 Markdown 上下文向中立扫描器注入文件打开意图，SessionChat 的工具卡复用同一回调。
`pages/tickets/TicketFiles.tsx` 负责目录、行号、Markdown 预览、下载与当前请求的 AbortController；
显式点击才请求 `/api/tickets/:id/files`，不轮询、不预取、不重试。贡献者只访问自己的工单；
服务端使用已绑定工单的 Git 版本与仓库别名，不接受浏览器指定 owner、branch、revision 或机器。
只读已提交的普通 blob/tree，不读取主机文件、未提交凭据、symlink 或 submodule。每次显示版本，
无工单分支时明确标为主线。Dashboard 与 App 保留明确的 Markdown sanitizer 和文件动作回调。

## 工单输入气泡

工单详情只保留一条聊天流，排队输入经 `pages/tickets/chat-receipts.ts` 放入
`SessionChat.tail`，首份日志未出现时也可见。服务端消息 id 关联本地回显；接收回执停止
等待动画，完整用户输入出现在较新的 transcript 后移除回显。匹配需发送时间或本地绝对
日志边界，同文多次发送各占一个记录位置；未知发送结果保留说明，不自动重发。
正式记录未同步时，已接收气泡暂留流尾并说明同步状态。历史分页继续由 transcript 拥有。
`TicketsPage.test.tsx`、`pages/tickets/chat-receipts.test.ts` 覆盖布局收敛与消费状态。
