# Agent Workspace Files View — 可复用的文件浏览模块

> 2026-08-06 新增（v4 read-only workspace browser）。
> 契约：`packages/workspace-files-contract/CLAUDE.md`
> 布局内核：`packages/agent-view-react/CLAUDE.md`（`./workspace`）
> 可信一侧：`packages/bot/src/workspace-files/CLAUDE.md`、`packages/bot/src/agent-resources/CLAUDE.md`
> 交付：`doc/deliveries/2026-08-06-read-only-workspace-browser.md`

## 一句话

两个模块（`workspace.file-tree/v1`、`workspace.file-viewer/v1`）加一个 Provider。它们只依赖
workspace-files v1–v4 的窄 typed-port face，所以同一份实现既跑在 Session Plus 上，也能跑在任何拿到
该 port 的 App 上——包括 `./harness` 那个从 fixture 作答的内存 port。

## 分工，写死

| 谁 | 拥有什么 |
|---|---|
| `WorkspaceFilesProvider` | **只有 roots**。枚举一次是一次 capability 调用，两棵树并排挂不能各花一次（一次调用就是一张批准卡） |
| 每个挂载的模块实例 | expanded / 目录 cache / selected / 每目录的拒绝 / viewer 的 reload 计数。**不写 App State，不写数据库**——树的形状不是持久 App 数据 |
| App（composition root） | 建 port、`destroy()` 它。能结束自己传输的模块也就能结束兄弟模块的 |

Provider 的 `refreshVersion` 只广播一次显式刷新意图；各目录实例仍独立持有展开、选中与 cache。
统一索引、独立树和手机外框刷新 roots 时都会重列已展开目录，不依赖根枚举完成或会话扫描的速度；
同一在途 roots 请求的重复点击合并，完成帧不再触发重列（工单 #537）。

### Provider 是模块化机制，不是第二道安全边界

说清楚，因为它容易被读成后者：整个 iframe 里**只有一个 View principal**。Provider 把 port 放进
React context，是为了让「哪个模块接哪个 port」由 composition 决定而不是由每个组件各写一遍——它是
**静态的组装机制**。它**不**在 React 模块之间划信任边界：同一个 bundle 里的任何代码都能拿到同一个
context，这在设计上就是如此，也没有别的可能。

真正的边界只有两处，都不在这个包里：**opaque origin 的 frame** 与那条 MessagePort（View 只能提议），
以及可信 Host 里的 **capability Gate**（binding → 精确 contract → provider → 封闭 action → 授权）。
Runner 能力始终在 Gate 后面；本包里的东西全部是 Gate **之前**的一次提议。

因此 `agent-resource-bindings/v1` 里「哪个实例接了 port」是一句**组装期**的话，用来决定布局内核该
复用哪个具名 panel；它不是运行时的隔离。反过来也成立：一个匿名 panel 之所以不该被造出来，不是因为
它能越权读到什么，而是因为**没有任何文档说过它连着什么**，而屏幕上它看起来是连着的。

## 三条不可协商

1. **不猜路径。** 一行由它自己那份 listing 携带的 opaque ref 寻址；本包**不拼接**父目录与名字，
   也不把 label 当位置读。`lib/tree.ts` 的合成 key 用 NUL 分隔（ref 是「有界可打印」，所以说不出这个 key）。
2. **不可寻址的东西不给控件，可寻址但不能预览的东西给下载。** `other` 条目（symlink / socket /
   设备文件）没有 ref，所以渲染成**一段文字，没有按钮**。普通文件即使超过文本预览上限也能打开；
   viewer 对 `not_text` / `too_large` 显示占位和显式下载，不再把「不能内嵌显示」误写成「不能取得」。
3. **拒绝是可读状态，不是异常，也不重试。** `approval_required` / `outside_workspace` /
   `unavailable` 全部渲染在 panel 内；下载与重读各自只响应一次显式点击。重发一次被 Gate 拒绝的读，
   就是把一次撤销变成一串批准卡。
4. **请求打开不等于已经打开。** tree 只在 `workspace.open(...)` 返回 `true` 后更新 selected；v2 template
   达到容量上限或 composition 拒绝 route 时，左侧不能出现一个并不存在的“当前文件”。普通打开和编辑
   hint 遵守同一条规则。

## 长目录与多工作区：加载更多（2026-10-20）

一页最多 500 个条目 / 64 个 root 是**窗口**不是总量。`visibleRows` 在一个还有下一页的目录的最后
一个已载入子孙之后放一行 `kind: "more"`（`moreOf` = 该目录 ref，携带该页的载入/拒绝状态），
`FileTreeRow` 把它画成「加载更多」；`useWorkspaceDirectories().loadMore(ref)` 以最后一行的
`<kind>/<label>` 为游标取下一页并**追加**（契约已校验续页在游标之后）。roots 由 Provider 的
`loadMoreRoots()` 以最后一个 root ref 续页，页里出现已持有的 ref 即判定为旧 Host 并拒绝。一次点击
一页：每页都是一次 capability 调用，不做投机预取。编辑按钮只对超过整份载入预算（`wholeTextBytes`）
的文件禁用——保存不再有大小上限（见 `agent-editor-view`）。

## 文本表面去重

本包仍是资源读取层：Provider、目录 cache、`useWorkspaceText`、stream close/late-answer 纪律和
opaque-ref open intent 都在这里。`useWorkspaceDownload` 只把 v4 port/ref 接到
`workspace-files-contract` 的有界 stream collector；浏览器 Blob、下载动作、结果提示与不可预览占位由
`agent-view-react/ui` 的 trust-neutral 原语拥有。媒体流、PDF canvas 与 Markdown 相对图片的呈现由
`@claude-bot/agent-file-preview` 统一拥有。`FileViewer` 把已读取的 snapshot/metadata 交给
`@claude-bot/agent-text-view` 的 `DocumentPane`；Markdown 仍走 `agent-view-react/ui` 的安全 renderer，
但图片只从文件行实际 listing 携带的 root ref + label 链出发，经 typed-port `resolvePath` 重验后读取，
不把 label 拼成文件系统路径，也不向网页发 HTTP 请求。Markdown 文档链接也通过 `resolvePath` 重新核对，成功后保留标签链打开 Dock；App 自己的文档导航必须携带同一 `listedFileContext`。
其它文本走只读 `CodeMirrorTextSurface`。预览态的「编辑」只提交同一个 opaque ref 和 composition 声明的
view id，不复制文本或草稿；目标接受后才关闭当前只读 panel，因此同一文档的浏览/编辑是一个标签内的交接。

共享 surface 是 presentation dependency，不是另一个 provider：它不拿 port、不发 proposal、不解析 ref。
Viewer 的 CodeMirror 永远传 `readOnly`，所以有行号、查找、selection matches 和 wrap，但没有 replace、
保存键、dirty 上报或写契约。编辑/CAS 仍在 `agent-editor-view`，panel dirty/close negotiation 仍在
workspace coordinator。

手机文档栏保持一行：文件名截断，媒体类型/摘要隐藏，浏览与编辑合成一个分段控件，下载/重读/关闭保留
44px 触摸目标并用图标收窄。不可内嵌格式只在占位中留一个下载入口，不在栏里重复同一动作。

## 第四条：读到一半停了，不是读成功（2026-08-17，工单 #201）

「tab 打开了，header 写着 `text/plain · 76.8 KB`，正文是空的」——header 来自 open，正文来自 stream，
所以一次**永远不回来的 pull** 会让面板停在 `loading`、空白、且没有任何一句话，屏幕上与「空文件」和
「慢文件」完全一样。`useWorkspaceText` 因此多两个结局，**两个都不重试**：

- `stalled`：每次未答复的 pull 前后各 arm / disarm 一个 `READ_STALL_MS`（20s）看门狗。触发时发布
  这句话、保留已到达的正文并标为部分、关流。重读仍然只有按钮。
- `incomplete`：`end` 帧一个字节都没送，而 header 自称非空。这是生产者自相矛盾；跨 wire 的 client
  已经会拒，进程内 port 没有那层 adapter，两种情况都不该渲染成一块空白编辑器。

`DocumentPane` 拥有这两句文案。空文件（`sizeBytes === 0`）仍然是 `ready`。

## 第五条：open 也会没有回音（2026-08-18，工单 #253）

#201 给每次 pull 装了看门狗，却把它们上面的 `openText` 留成整条路径上唯一没有结局的一段。open 在手机上
是一次 proposal、一次 HTTP 往返和一次全文哈希；答复永远不回来时，hook 停在 `loading` 且
`document` 为 null——header 只剩 panel 的 label、一个转圈、一条空的行号栏，一句话都没有。屏幕上它与
「慢」无法区分，于是人会反复点「重新读取」，而设备那边其实每次都已经把文件读完了。

- `unanswered`：open 超过 `READ_STALL_MS` 没有答复。发布这句话、结束本次读取、**不重发**；晚到的
  成功 open 会在 liveness 检查处被关掉，不留 broker slot。

三个结局共用同一个 `READ_STALL_MS`，因为它们等的是同一条链。

## 下载也必须有进展或结局（2026-09-09，工单 #544）

下载最初只在点击后显示「正在准备」，`downloadFile` open 或任一 pull 永不回答时会永久禁用按钮；健康但
缓慢的多块下载也没有已收字节可看。现在 contract collector 在 header 与每个可信块后报告
`receivedBytes / totalBytes`，并给 open 和每个 pull 各自设置 20 秒**连续无进展**看门狗。每个新块都会
重新计时，因此没有总下载时限。停滞、断线与不完整流都关闭且绝不生成部分 Blob，panel 保留已收进度和
明确的「重新下载」入口。它不自动重发 capability-bearing read；一次人工点击仍只开始一次下载。

## 一套 chevron 与 glyph（2026-08-17，工单 #201）

`FileTreeChevron` 是导航里唯一的展开标记（`open === null` 渲染叶子占位，图标才会同列）；glyph family
增加 `device` 与 `parent`，因为组合索引原来用 emoji 画这两行，而 emoji 在每个平台上的尺寸、基线与颜色
都不一样，一条栏里因此有三个对不齐的图标列。

## 依赖边界（`src/architecture.test.ts` 读本包源码强制）

| 允许 | 禁止 |
|---|---|
| React、`@claude-bot/workspace-files-contract`、`@claude-bot/resource-stream-contract`、`@claude-bot/agent-module-contract`、presentation-only `@claude-bot/agent-text-view` 与 `@claude-bot/agent-file-preview` | 任何 App、`@claude-bot/bot`、`dashboard-web`、`web-trust`、`@claude-bot/runner`、capability-kernel、`node:*` |
| `@claude-bot/agent-view-react/ui` 与 `/workspace` | `@claude-bot/agent-view-react` **根入口**（它 re-export 传输与 wire 常量） |
| — | `RESOURCE_ACTIONS` / `resource.*` 字符串 / stream handle 词表 |
| — | `username` / `credential` / `deviceId` / `workspaceId` / `relativePath` / `contextId` / `grant` 这些字段名 |

最后一条不是洁癖：`workspace-files/v1` 根本不携带它们，所以本包里出现这样一个名字，只可能是编造出来的。

## 文件

| 文件 | 职责 |
|---|---|
| `src/manifests.ts` | 两份 manifest + 资源 kind `workspace-text`，**纯数据**：Node 侧 release builder 要读它产出 module lock 与 binding plan，不能被迫 import React 或 CSS。`ports` 明确声明 v1–v4；只有 v4 带通用下载 |
| `src/context.tsx` | `WorkspaceFilesProvider` / `useWorkspaceFiles()` / `useOptionalWorkspaceFiles()`（无 Provider 返回 null：文件面是别的模块的**增强**时，缺席是组合的陈述不是错误）；单飞的 roots 刷新 + 卸载后不落地 |
| `src/lib/directories.ts` | `useWorkspaceDirectories(port)`：从树模块抽出的**懒加载目录簿**（一目录一次、事件处理器发 RPC、换 port 丢迟到答案），第二个表面（统一索引）与本包的树共用同一套语义 |
| `src/modules.tsx` | manifest + 挂载组件；每实例状态、懒加载、发 `workspace.open(link)`；打开 intent 保留 listing lineage，且仅在接受后 select |
| `src/components/FileTree.tsx` | 展示型：行、展开、选择、打开意图；`FileTreeRow` 单行导出并接受可选目录 peer action——`data-av-file-*` 测试锚点只有一份，组合索引直接复用 |
| `src/components/FileViewer.tsx` | 展示型：Markdown 安全渲染并委托相对图片；其它文本复用只读 CodeMirror；不可预览格式接入共享下载占位 |
| `src/lib/tree.ts` | 纯函数：把 roots + 目录 cache + expanded 摊平成可见行，并保留 v2 `directoryKey` 与每行 listing lineage；`displaySize` |
| `src/lib/text.ts` | `useWorkspaceText`：开一次、拉到明确的 end、每个出口关流、迟到的块不落地；open 与每次 pull 各有一个 `READ_STALL_MS` 看门狗 |
| `src/lib/download.ts` | `useWorkspaceDownload`：把版本化 workspace port/ref 接到 contract collector 与共享 browser-download hook，并转发逐块进度；不另存状态、不自动重试 |
| `src/workspace-files.css` | 文件树与 Markdown 容器样式；下载/空态原语样式由 `agent-view-react` 拥有，PDF/图片样式由 `agent-file-preview` 拥有，文档 chrome / 文本表面样式由 `agent-text-view` 唯一拥有。浏览器验收只认 `data-av-file-*`，class 不构成测试契约 |
| `src/harness/` | 第二个真实实现：fixture 后端的内存 port。**单独的入口**，生产 bundle 不会顺手 import 到 |

## 测试

```bash
npx vitest run --project agent-workspace-files-view --maxWorkers=1
npx tsc --noEmit -p packages/agent-workspace-files-view/tsconfig.json
```

| 文件 | 测什么 |
|---|---|
| `src/modules.test.tsx` | 挂载只枚举 roots（**不预走树**）、一个目录只列一次、`other` 没控件、超限普通文件仍可打开、open/edit 拒绝不假选中、Markdown 默认渲染且同 ref 切到 editor、不可预览格式仍能单次下载、viewer 拉到 end 并释放流、共享只读表面没有 replace、卸载时关流、**切换 port/ref 后旧字节在 paint 前消失且迟到块不落地**、拒绝不重试 |
| `src/lib/tree.test.ts` | 摊平、排序、懒边界、合成 key 不可能与 ref 相撞 |
| `src/architecture.test.ts` | 依赖边界与禁用名字（读本包源码，注释在扫描前被剥掉，所以文档可以谈论一条它禁止的东西） |

文件树的真实行在异步 listing 后才出现，且目录/文件行是 Ant button。它们必须在
`.wsrow-main` 规则中明确 `justify-content: flex-start`；不能只给首帧 synthetic home 行左对齐，否则加载
转圈结束时导航内容会从左侧跳到居中。架构测试与真实浏览器验收都钉住这个后加载状态。

**改了本包任何源码都要重新构建 View**（`pnpm --filter @claude-bot/session-plus-view build`）：
本包已进入 `SESSION_PLUS_VIEW_SOURCE` 的源码根，陈旧产物会被加载器拒绝。
