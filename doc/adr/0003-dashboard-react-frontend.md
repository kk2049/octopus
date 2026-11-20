---
decision_status: accepted
realization_status: implemented
supersedes: []
superseded_by: []
tickets: []
---
# ADR 0003 — Dashboard 浏览器层改为 React + CSS 单包

- 状态：已采纳（v4 Phase 1，2026-08-06）
- 影响面：`/`、`/sessions`、`/sessions-plus`、`/hq`、`/secretary`、`/tickets`、`/admin`、
  `/pending`、`/permissions`、`/login` —— 即面板服务的全部浏览器页面
- 不影响：Dashboard 的 HTTP 服务器、Cedar 路由授权、mutation gate、capability kernel、
  Session Plus 的不可信 Agent View（Phase 2 与另行决策）

## 背景

面板此前的浏览器层是九个 TypeScript 文件里的模板字符串：HTML、CSS 和 ES5 风格的 JS 拼在一起，
由服务端逐页拼接后作为自包含文档发出。它一路支撑到了相当复杂的产品（实时 transcript、
操作生命周期、四栏工作台、权限三列表），但代价已经明确到可以列举：

1. **编译器看不见页面代码。** 模板字符串里的一个反引号或一个 `\n` 转义就能让整个 IIFE 变成
   语法错误——而 HTML 依然良构、nonce 依然正确、页面依然渲染。批准抽屉就这样静默失效过一次，
   最后靠一个专门 `new vm.Script()` 解析所有内联脚本的测试文件抓住。
2. **测试只能读源码字符串。** 「Agent 渲染在 App 卡片内」这类断言写成
   `expect(script).toContain("function groupSubjects")`，改一个函数名就删掉一条安全覆盖。
3. **XSS 纪律靠人记。** 约 30 处 `innerHTML`，安全性依赖每个调用点先 `esc()`、以及 `mdLite`
   里十几条正则的先后顺序。
4. **重绘与状态互相打架。** 幂等 `paint()`、手工保存/恢复 fold 与 scrollTop、
   「有输入框获得焦点就跳过这次刷新」，都是在补同一个洞。
5. **可访问性系统性缺席。** 拖拽分隔条没有 role、没有 tabindex、没有键盘；批准抽屉能用
   Tab 到达却从不获得焦点；`confirm()` 无法样式化且阻塞事件循环。
6. **CSP 只能停在 nonce。** 每页都有内联脚本，所以 `script-src 'nonce-…'` 是能达到的上限。

## 决策

### 采用 React 19 + CSS Modules，构建为**一个**产物

- **Vite** 打包，`base: "/ui/"`，内容哈希文件名，产出 `.vite/manifest.json`。
- **不做代码分割**（`manualChunks` 固定为一个 chunk，应用内没有动态 `import()`）。
- 产物由 `packages/bot/src/dashboard/assets.ts` 从磁盘读取并在 `/ui/` 下提供；
  `@claude-bot/dashboard-web` 成为 `@claude-bot/bot` 的 workspace 依赖，所以
  `pnpm -r build`（`dev-restart.sh` 与 supervisor 都跑它）自然会构建它。

**为什么不分割**：分割之后，部署前打开的标签页会去请求一个当前构建不再发布的 chunk，屏幕
中途变白。这块面板的工作包括批准危险调用和确认一次部署的存活——那是最不能白屏的时刻。
一个不可变的完整包意味着旧标签页**永远不需要**再取第二个文件；它通过每个响应上的
`x-octopus-build` 头发现有新版本，并显示一句「可刷新」，而不是被打断。

### 页面文档仍然由服务端逐页组合

没有 SPA 通配回退。`authorizeRoute` 先答，然后才组合文档，文档里带着它被授权的 route id。
这保住了三件事：直接访问一个无权页面仍是服务端的 403、一个本组合没构建的页面仍是 404、
未登录仍是 401 + 登录屏。通配回退会把这三种答复统一变成 200 + 一块渲染好的界面。

### CSP 收紧到 `script-src 'self'`

文档里**没有可执行的内联脚本**：一个来自 `/ui/` 的 module，一个 `<link rel=stylesheet>`，
以及浏览器不会执行的 `<script type="application/json">` 数据块。因此不再需要 per-response
nonce。这比 nonce **更强**：nonce 放行的是「渲染器放在它旁边的任何东西」，`'self'` 放行的是
「这台服务器发布过的文件」。`style-src` 保留既有的 `'unsafe-inline'`（React 的 `style` 属性
需要它，而样式不能执行代码）。

### 一个 payload 传递可信身份上下文

`<script type="application/json" id="octopus-bootstrap">` 携带：谁在问（服务端判定的）、
这套组合为这个人服务哪些页面、这是哪一页、以及该页的服务端事实（引导命令、owner、hubUi…）。
它**不携带任何凭据**：不是 bearer、不是 session id、不是 CSRF 值（只有 cookie 的**名字**，
浏览器从自己的 jar 里输入）。类型定义是 package subpath，两侧 import 同一份。

**`nav`/`pages` 是导航提示，不是权限。** 它们与路由读的是同一个 `routeIsAvailable`，所以
页签不可能指向一个会 404 的页面；但每个请求仍然完整过 Cedar，页面被写成渲染服务端的拒绝。

### 服务端状态：TanStack Query，缺省全部收紧

这台服务器的某些 GET **不是免费的**：`/api/session`、`/api/sessions`、`/api/sessions/search`、
`/api/sessions/live` 会穿过 capability kernel，而一次读是否免批是账号级、可被用户在
`/permissions` 撤销的决定。免批被收回时，一次读会**变成一张待批准卡**。于是这个库的每一项
便利行为，在这些路由上都是「请同一个人再批准一次同一次读」的方式：

- `retry` → 同一次被拒的读再来三次
- window focus → 每次切回标签页一张卡
- reconnect → 每次网络抖动一张卡
- remount 重取 → 每次导航一张卡
- prefetch → 为一个没人打开的页面生成一张卡

所以四个自动重取全部关闭，`staleTime: Infinity`，轮询只对 `REPLAY_SAFE`（纯服务端本地读，
不进 `gate.invoke`）开放，并且必须经 `pollInterval()` 才能拿到间隔——给能力型端点加轮询
不能只靠打一个数字。Mutation `retry: false`：append/approve/deploy/land 都不幂等。

### 生态复用清单（`dev-conventions.md` 的三问）

| 关注点 | 选择 | 替代了什么 |
|---|---|---|
| 路由 | `react-router` v7 | 页面之间的整页跳转 |
| 服务端状态 | `@tanstack/react-query` | 手写轮询 + `paint()` 幂等重绘 |
| Markdown | `react-markdown` + `remark-gfm` | 120 行 `mdLite` 正则（并首次支持表格） |
| 虚拟化 | `@tanstack/react-virtual` | 整份 transcript 一次 `innerHTML` |
| 对话框/抽屉 | `@radix-ui/react-dialog` | `confirm()` + `hidden` 切换的 `<aside>`（都没有焦点管理） |
| 分栏 | `react-resizable-panels` | 80 行 pointer-event 脚本，无键盘、无 ARIA |
| 表单 | `react-hook-form` | 手写「标红 + focus 第一个空字段 + 输入即清错」 |
| 打包 | Vite | 无（此前不存在构建步骤） |

仓库里没有做同一件事的既有实现（`view-kit` 当时是**不可信 View 的**字符串渲染器，见下；它已在 2026-08-06 的 Agent View React 阶段随之退役）。
自研保留的只有 `lib/api.ts` 与 `lib/query.ts` 的策略——它们编码的是**这台服务器特有的**性质
（能力型 GET 会生成批准卡），没有库会知道这件事。

## 后果

### 好的

- 页面代码进入 `tsc` 与 `vitest` 的视野；「脚本静默不执行」这一整类失效消失。
- 安全断言变成组件测试与 payload 断言，不再依赖源码字符串匹配。
- CSP 从 nonce 收紧到 `'self'`。
- 长 transcript 走虚拟化，成本跟随视口而不是日志长度。
- 对话框、抽屉、分隔条、表单获得焦点管理与键盘操作。
- `/hq` 与 `/secretary` **恢复可用**：它们此前用不带 `script-src` 的默认 CSP 发出，
  而 `default-src 'none'` 会挡掉它们的内联脚本。

### 代价（写下来，不粉饰）

- 多了一个构建步骤。忘记 `pnpm -r build` 会让页面路由答 500 并明说要跑哪条命令。
- 首包约 700 KB（gzip 约 230 KB）。用换来的零版本错位偿付。
- Session Plus 的 instance handle 在文档解析到首帧之间存在于 DOM 里（旧实现在内联脚本闭包中）。
  能读它的只有同源脚本，而 `script-src 'self'` + 无内联 + 无 `eval` 让注入一个同源脚本不可行。
  这是边界，不是「已消除」。

## 明确不做

- **不迁移不可信 Agent View。**（**2026-08-06 已被后续阶段取代**：它现在也是 React，但仍然是
  另一个包、另一个 bundle、另一个 origin，见 `doc/development/agent-view-react-worklog.md`。
  下面这条当时的理由仍然成立，且正是那次迁移遵守的约束。）
  `session-plus/view-app.ts` 跑在另一个 origin、按 package
  digest 定址、`connect-src 'none'`、只经 MessagePort 通话。把它和可信父页放进同一个 React
  root / origin / 包会直接抹掉那条边界。它当时继续使用 `@claude-bot/view-kit`，后者因此变成
  **只服务那一个消费者**的展示包。
- **不改 HTTP 服务器、不改授权架构**（Phase 2）。本次的服务端改动限于：提供并版本化前端产物、
  组合可信身份上下文、以及把页面处理器换成同一个 `appPage()`。
- **不引入 service worker、不引入离线队列。** 这个产品没有这个需求，而它们会给不幂等的
  mutation 增加一整套需要证明的语义。
- **不要求生产 HMR、不引 CDN、不放宽 `connect-src`/`frame-src`。**
