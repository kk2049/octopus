# Engine 应用参考手册

> 面向「要写一个应用的人或 agent」的一页纸 schema。哲学与法则见 `CLAUDE.md`；本页只讲语法与契约。
> ⚠ 与整个 v3 探针同级：工作假设，随实践修订。

## 应用目录布局

```
apps/<app>/
  app.yaml          # 必需：应用声明（本页主角）
  projection.ts     # 必需 project(events)；长历史另导出 projectIncremental(snapshot, tail)（纯函数，温热插）
  actions.ts        # 声明了 actions 就必需：每个动作一个同名导出
  pages/*.yaml      # 页面（app.yaml 里引用）
  prompts/*.md      # agent 系统提示词（声明了 prompt 就必须存在）
  seed.yaml         # 可选：首次启动的演示数据
```

loader 会在加载时校验：未知键、缺文件、坏引用**一律报错**，一次列全。

## app.yaml

```yaml
app: clips              # 必需，小写 slug
title: 收藏夹            # 页面顶栏与索引用
scope: per-user         # per-user（每用户一份日志）| shared（全体一份日志）

actions:                # 动作 = 唯一写入口，一份声明三个面（按钮/HTTP/agent 工具）
  add_clip:
    title: 收藏          # 按钮/工具的显示名
    description: …      # 补充给 agent 的说明（可选）
    predicate: owner    # 必需：any | owner | admin（owner 拒绝 admin——代写=伪造署名）
    human_only: true    # 可选：绝不生成 agent 工具（死人开关/审批类）
    agent_only: true    # 可选：不渲染按钮（内部管道）
    confirm: true       # 可选：网页端点击前弹确认框
    feishu: true        # 可选：进入 L2 标准卡的按钮集（预留位）
    params:             # 见「参数」
      url: { type: string, required: true, description: 链接 }

agents:                 # 页面常驻 agent（可多个）
  keeper:
    adapter: openai-loop        # openai-loop | claude-code | codex（运行时可被 config.json 覆盖）
    prompt: prompts/keeper.md   # 系统提示词文件；{{user}} 会被替换为 scope 主人
    model: gpt-5.6-sol          # 可选，覆盖宿主/CLI 默认
    effort: high                # 可选：推理深度，透传给底层 loop
    daily: "04:00"              # 可选：每天此刻（宿主本地时区）投一条 inbox
    daily_prompt: 巡检一遍。     # daily 触发时的消息文本

deadlines:              # 声明式时钟（lease 形）：到点由引擎以 system:deadline 追加 emit 事件
  reply_nag:
    start: report_received      # 这类事件（按 data.id）起表
    cancel: [report_read]       # 这些类型（同 id）拆表
    after_s: 259200
    emit: report_overdue        # 到点追加的事件类型——fold 像处理任何事件一样处理它

flows:                  # 纯描述性状态机（工厂页可视化用，引擎不执行）
  report:
    states: [sent, received, read]
    transitions:
      - { from: received, to: read, via: mark_read }

pages:
  main: pages/main.yaml         # 值=相对路径或内联 map
feishu:
  cards: [digest]               # 声明为卡片页：只许 card-grade 组件，可经 /api/card 渲染
```

## 参数（params）

| 键 | 说明 |
|---|---|
| `type` | `string` \| `number` \| `boolean` \| `object`。表单按类型渲染（checkbox/number/textarea-JSON）；HTTP 层做宽松强转（"5"→5，"true"→true） |
| `required` | 缺失/空串时引擎在 dispatch 前拒绝 |
| `enum` | 静态候选；下拉渲染 + 服务端校验 |
| `enum_bind` | **动态候选**：`view.…` 路径，元素为字符串或 `{id}`。网页渲染成下拉、飞书卡渲染进 placeholder；**服务端刻意不按它校验**——handler 自校验才是唯一真相，过期下拉降级为一条有用报错 |
| `description` | 表单 label 与 agent 工具参数说明 |

引擎只做形状校验；**业务校验写在 handler 里并 throw**（见下）。

## 页面 yaml

```yaml
title: 信箱
locals:                              # 客户端局部状态（不进事件日志）
  selected: { default_bind: view.latestId }   # 用户未点过时随视图重derive
layout:                              # ★ 列主序：每个条目是一列；[a, b] 表示一列内纵向堆两个槽
  - [stats, compose]
  - inbox
  - [thread, ops]
widths: [3, 4, 4]                    # 可选，列 flex 权重，长度=layout 长度
slots:
  inbox:
    widget: list                     # 组件名，见目录
    bind: view.inbox                 # 数据路径，必须以 view 起头；允许 $key 段读 locals
    props: { title: 收件箱 }          # 组件参数（自由 map；多数组件认 title）
    on: { select: "local:selected" } # 连线：事件 → "action:<name>" 或 "local:<key>"
```

- **连线只许指名，不许计算**：目标只有 `action:`（以 `{id: <条目id>}` 调用该动作）与 `local:`（把条目 id 写进局部键）两种。
- `$key` 出现在 bind 里时，必须有 locals 声明或某处 `local:key` 连线，否则加载报错。
- `actions` 组件的按钮 `params` 里，值为 `"$key"` 的字符串在点击时替换为局部值。

## 组件目录

| widget | 档位 | bind 形状 | 事件 | 说明 |
|---|---|---|---|---|
| `heading` | 卡片档 | `{title, subtitle?}`（或 props） | — | 标题块 |
| `section` | 卡片档 | —（`children:` 节点列表） | — | 容器：一张卡里纵向堆多个子组件（标题+列表惯用对偶） |
| `markdown` | 卡片档 | `string`（md-lite：**粗体**、`code`、链接、- 列表、## 标题） | — | 正文 |
| `kv` | 卡片档 | `Record<string,string\|number>` 或 `[{k,v}]` | — | 事实表 |
| `list` | 卡片档 | `[{id, title, subtitle?, badge?, tone?}]`，tone∈ok/warn/err | `select` | 条目列表；`local:` 选中时自动高亮 |
| `table` | 卡片档 | `{columns: string[], rows: (string\|number)[][]}` | — | 表格 |
| `banner` | 卡片档 | `{tone, text}` \| `null` | — | 状态横幅 |
| `form` | 卡片档 | —（`props.action` 指名动作） | — | 从该动作 params **自动生成**表单 |
| `actions` | 卡片档 | —（`props.items: [{action, label?, params?}]`） | — | 按钮行；按查看者谓词自动隐藏无权按钮 |
| `timeline` | 富 | `{past, today, future}: [{id, at?, text, tone?}]` | `select` | 三时态时间线（网页独占） |
| `agent-chat` | 富 | —（`agent: <名>`） | — | 页面秘书聊天（网页独占；窄端的兜底面） |

卡片档=在飞书卡片有映射；`feishu.cards` 页面只许卡片档。目录收窄是纪律：**加组件必须先证明每个端都有映射**。

## handler 契约（actions.ts）

```ts
export function add_clip(ctx, params) {
  // ctx = { actor, scope, scopeOwner, state, now }
  //   state = 你自己 projection 的输出（dispatch 串行段内读取，天然最新）
  //   now   = ISO 时间戳（注入以保持可测）
  // 校验失败就 throw new Error("人话")——同一句话，人看是 toast，agent 看是工具报错。
  //   最佳实践：报错里列出现有合法值（"没有项目「x」。现有：a、b"）。
  const id = `clip-${ctx.state.counts.added + 1}`;   // 惯用法：用「历史总数」铸 id，删除不复用
  return {
    events: [{ type: "clip_added", data: { id, ...} }],  // 引擎盖章 seq/at/by 后原子追加
    reply: "已收藏",                                      // 给人 toast / 给 agent 工具回执
  };
}
```

**handler 只能写自己这一条日志**（SEC-01）。`events` 没有 scope 参数，也没有第二个出口：旧的
`deliveries: [{ toScope, events }]` 已删除——那是一个不经任何 gate 的通用跨用户写入口，
目标 scope、事件类型和正文全由 handler（= 一个模型选出来的、热加载的代码）说了算，
而 scope 同时又是文件路径片段。返回它现在什么也不会发生，只会在 `warnings` 里被指出来。

跨用户投递是**一次能力调用**，和读文件、跑命令走同一扇门：

```ts
const out = await ctx.capabilities.request("delivery", "send_report", {
  to: "bob",                    // 用户名。由可信目录解析，不是路径
  title: "周报", body: "…",
  delivery_id: `rp-${ctx.scope}-${n}`,   // 稳定 id ⇒ 重发只留一份回执
});
// out.status: succeeded | approval_required | denied | failed
```

Gate 会依次问：这条授权有没有 `send_report`？收件人解析得出来吗？**对方的信箱授权接收
你的投递吗**（默认不接收）？这次发送是本人点的按钮（授权条款放行）还是要逐次批准？
落到信箱里的是引擎写的固定 envelope（`report_received` / `reply_received`，作者
`system:delivery/<发送人>`）——app 伪造不了事件类型，也冒充不了收件人。

纯函数纪律：**不碰 fs/网络/全局**；状态只来自 ctx，输出只有 events。署名（`by`）由引擎盖章——handler 的参数里永远不该有「作者」字段。

**这条纪律现在由运行时执行，不再靠自觉**（`runtime/sandbox-child.mjs`）。应用代码跑在 Hardened JavaScript 的 Compartment 里，作用域里只有 JS 语言本身加下面这张表：

| 有 | 没有（标识符就是 `undefined`，模块名解析不到） |
|---|---|
| `Promise` `JSON` `Map` `Set` `Proxy` `Reflect` `BigInt` 等语言内建 | `fetch` `process` `require` `setTimeout` `XMLHttpRequest` `WebSocket` `Buffer` |
| `Date`——**冻结在本次调用的那一刻**（`Date.now()` 每次读到同一个值） | `Math.random()`（会抛；投影里用随机数是 bug） |
| `console.log/warn/error`(转发到宿主日志) | `node:*` 任何内建模块；仓库里任何文件；`node_modules` |
| `import "./helper.ts"`——**自己应用目录内**的相对路径 | 绝对路径、`../` 越界、裸包名 |
| `ctx.capabilities.request(slot, operation, args)` | 别的一切拿资源的方式 |

要时间用 `ctx.now`；要随机数让 handler 收一个 params。`eval()` 与 `new Function("… import …")` 会在**编译期**被拒（fail closed，模块整个加载不了），所以别用。这些拒绝都带清楚的报错，agent 写错了看得懂。

## projection 契约（projection.ts）

`export function project(events) → view`。纯 fold；`view` 的形状就是页面契约（bind 路径指进来）。惯例字段：`counts.*`（铸 id 用的历史计数）、`stats`（kv）、`digest`（卡片页 markdown）、`latestId`+`byId`（配 locals 的详情选中）、`*Ids`（enum_bind 候选）。改这个文件**不用重启**（温热插）。

长历史 App 还应导出 `projectIncremental(snapshot, tailEvents, context?) → view`。`snapshot` 是同一
backend digest 无 viewer 的 `project` 输出，只由可信 Host 从 App State 快照传入；函数必须等价于
对“快照所覆盖的前缀 + tailEvents”完整折叠，并在有 `context.viewer` 时只做原有披露过滤。不要在
旧 projector 上把 tail 当完整历史；Runtime 会用 `incremental_projection_unsupported` 明确拒绝。

## seed.yaml

```yaml
scopes:
  lht:
    - { type: clip_added, by: "user:lht", at: "2026-07-26T09:00:00Z", data: {…} }
```

仅当该 scope 的日志**不存在**时在宿主启动阶段回放（seq 自动编号；`by` 缺省 `system:seed`）。seed **不过 dispatch**，写什么进什么——它是造世界，不是操作世界。

## agent 的内建工具（除应用动作外自动获得）

- `read_state`：当前投影视图 JSON。写前必读。
- `ask_user {prompt, form_action?}`：向用户弹**问询卡**（可附某个动作的表单）。用户提交表单或回话都会变成新 inbox 消息；调用后应收束本轮。

## 引擎保留事件与署名词表

- `agent_inbox {to, text, from?}`：给页面 agent 的消息。聊天框、按钮 handler（`effect` 风格）、daily 定时器都投它；pump 只认未读。**projection 应忽略它**（管道不是域真相）。
- deadlines 的 `emit` 事件由引擎以 `system:deadline` 署名追加，data 带 `{id, deadline}`。
- `by` 词表：`user:<name>` / `agent:<app>/<agent>@<user>` / `system:<name>`。投影想显示作者就解析它，不要在 data 里另存作者。
