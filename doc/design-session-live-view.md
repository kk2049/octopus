# 会话实时视图(Live Session View)通用能力设计

> **历史文档。** 记录 2026-07 文件 tail 与 SSE 纵切，且混有已被 v4 React 替换的浏览器实现；当前会话前端从 `packages/dashboard-web/CLAUDE.md` 与相关代码进入。

> 状态:**已实现**。2026-07-24。
> 需求源:自举开发流水线(`doc/design-self-hosting.md`)的工单页要围观 dev agent
> 实时推进。用户点名:**做成通用需求**——以后线上系统任何地方要"看某个 session
> 实时推进",都走这套。


> **⚠ 2026-08-06（v4 Phase 1）起，本文的浏览器一侧已被取代。**
> 面板的全部浏览器代码现在是 `packages/dashboard-web` 的 React 单包，本文提到的
> `session-view.ts` 的渲染模块 等模板字符串渲染器已删除。**服务端契约（API、SSE 协议、授权、投递语义）不变**，
> 所以本文关于「服务端要保证什么」的部分仍然有效；关于「页面怎么拼出来」的部分请读
> `doc/adr/0003-dashboard-react-frontend.md` 与 `packages/dashboard-web/CLAUDE.md`。

## 需求与非目标

- **复用 transcript viewer 的整套渲染**(rich 解析、工具配对、连击折叠、
  markdown-lite):历史与实时必须是同一条渲染路径,不做第二套展示
- **前端 detach 零代价**:浏览器关掉/断网,会话继续推进;重开 = 历史全量 + 续订实时
- **多人同时围观**同一会话(自举面板是共享的)
- 非目标:双向交互不在本能力内(往会话里发消息走各业务自己的端点,如工单
  inbox,见自举文档);不追毫秒级延迟,秒级足够;不做 tmux 注入类活会话操控

## 核心决策:文件即真相,不建事件总线

实时 = 对同一份 session JSONL 的**增量重放**,而不是让 bot 把 agent 事件流
广播出去。理由:

1. 与历史渲染共用 `parseSessionRich`,一条路径零漂移——事件总线方案必然长出
   第二套渲染,两边慢慢长歪;
2. 事件总线只能覆盖 **bot 自己拉起的**会话;文件 tail 对"用户自己笔记本上
   正在跑的 Claude Code"同样成立(经 Runner),通用性正是本能力的立身之本;
3. detach/attach 天然正确:文件在,视图任何时刻都能完整重建,不存在
   "错过的事件"。

## 服务端

### 端点

`GET /api/sessions/live?device&source&id`(SSE,`text/event-stream`)。
权限与 read 完全一致(本人或管理密钥);**绕过压缩与响应钩子**(流式响应不可缓冲压缩),
心跳注释帧 `: ping` 每 20s 防代理断连。

> **2026-08-06(v4 Phase 2)起,「绕过」是 `reply.hijack()`**:传输层已交给 Fastify,
> 而 hijack 就是「这条回复归我了」——之后没有 serializer、没有 `onSend` 钩子、没有
> `@fastify/compress`,handler 直接写裸 `ServerResponse`(`LiveRegistry` 一直是按它写的)。
> 随之而来的纪律:**一条流式路由所有可能的拒绝都必须发生在 hijack 之前**,因为之后已经
> 没有 reply 对象可以用来拒绝了。加固头与 `x-octopus-build` 因此也不在 SSE 上——迁移前
> 这些流走 `res.writeHead`,同样没有。

### Tailer(每 `(device,source,id)` 一个,多订阅者共享)

- **本地(bot-host 伪设备)**:`fs.watch` + 2s 轮询兜底;`(mtime,size)` 变化
  即全量重读 + `parseSessionRich`。全量重解析在服务端实测 40ms/350 条,
  便宜;贵的是公网传输,而传输只发增量。不写增量解析器——scan 层保持无状态,
  cache 键 `(path,mtime,size)` 的既有 summary cache 也不受影响;
- **远程(Runner 设备)**:v1 **不改 Runner 协议**,gateway 以 3–5s 节奏轮询
  现有 `read_session`(rich + 尾部 offset)动词,增量判断在 bot 侧做;
  WS permessage-deflate 已在。真需要更低延迟时再加 `session_tail` 推送动词,
  SSE 面不变;
- 订阅者归零即关 watcher/停轮询,tailer 销毁。

### 增量协议:「不稳定边界」重放

JSONL 是 append-only 的,但 rich 解析后的消息**不是**:在途工具调用的
tool_result 落在后续行、回填进**先前**那条 assistant 消息的 tool block。
因此维护:

- `frontier` = 最早一条仍含未配对 tool block 的消息下标(无则 = 消息总数);
- 每次文件变化,发 `event: delta`,数据
  `{ from, total, messages: RichMessage[] }`,其中
  `from = min(frontier_prev, last_sent)`——从可能被回填的最早位置起整段重发;
- 前端从 `from` 起替换本地尾部,之前的消息永不变;
- SSE `id:` = from。断线重连浏览器自动带 `Last-Event-ID`,服务端从该下标
  补发一次全量 delta,**重连不丢也不重**。

### 活性判定

summary/list 带 `live: true` 当:文件 mtime < 60s,**或**业务方显式标注
(如 dev ticket 处于 developing/gating)。侧栏红点、打开即自动进入 live 模式。

## 前端

- **渲染核心抽成共用模块 `session-view.js`**:消息数组 → DOM(气泡、thinking
  折叠、工具一行展开、连击折叠、`countVisibleUnits`),sessions 浏览器与
  自举工单页共同消费。这是本能力最大的一笔重构,抽完后 sessions-page 只剩
  侧栏树 + 搜索 + 翻页编排;
- live 模式:`EventSource` 订阅,delta 到达 → 从 `from` 替换尾部、按既有折叠
  规则重渲染该区段;自动滚动带**钉住**语义(用户上翻即停止跟随,回到底部
  恢复);「加载更早」照旧向前翻页,与 live 不冲突(live 只动尾部);
- 断连:EventSource 自动重连 + Last-Event-ID;连续失败超阈值降级为手动刷新
  按钮(即现状行为),UI 明示「实时连接已断开」。

## 活动状态(activity)——工单 #1 补齐

live 视图最初只解决「新内容一到就出现」,没解决「**什么都还没到**的那段时间
里前端是空白的」:agent 在 thinking、在构造工具入参、在等一个跑 10 分钟的
build,日志都不写行,页面与已结束会话长得一模一样。

**结论:这不用猜,日志尾部就有答案。**

| 来源 | 判据 |
|------|------|
| Claude | assistant 行的 `message.stop_reason`(`end_turn`/`stop_sequence` = 收尾,其余 = 还在写);已发出但无 `tool_result` 的 `tool_use` id = 正在等这个工具 |
| Codex | `task_started` 未被 `task_complete`/`turn_aborted`/`error` 关闭 = turn 开着;`function_call` 无 `*_output` = 等工具 |

推导落在 `plugins/sessions/src/parse.ts`(flat 与 rich 共用同一个 tracker——
列表用 flat、详情用 rich,两者结论不一致就是可见的谎),产出
`meta.activity = { state: thinking|tool|responding|idle|unknown, tool?, since?,
observed_at? }`,经 `SessionSummary` / `readSession.meta` / SSE delta 三条既有
通道下发。
**Runner 协议一行没改**:设备端跑同一份 scan/parse,老版本设备不返回该字段。

### 降级纪律

- 服务端没给 → 前端只用已解析消息能证明的东西:最后一条消息有未配对工具
  = 「正在执行 X」(这是硬证据);否则只说泛化的「运行中」。**绝不声称在
  thinking**——那是猜的。
- 模型流式吐字的中间态**拿不到**(CLI 整条消息落盘才写文件)。这是承认的
  缺口,由转圈动画覆盖,不做逐字预览。
- `tool` 状态会永久卡在被 kill 的会话上(结果永远不会来)。服务端不判断
  「现在几点」,由前端按静默时长超 10 分钟降级为「可能已中断」,并且不再
  为这类会话开 tailer(`svShouldFollow`)——否则一具尸体会钉住一个 tailer。

### 结束判定(工单 #2 修复)

第一版能说出「在干什么」,却说不出「已经不干了」:线上出现过一个早就结束的
会话,面板一直显示「⏳ 运行中 · 已 1 分 43 秒」并继续往上涨。两个原因,都已
修掉:

1. **没有终止记录可读。** 一次 headless 轮次跑完后日志不再写任何行,末条
   assistant 行的 `stop_reason` 又常常不是终止值,于是「还在写」与「早写完了」
   在日志里长得一模一样。现在额外认 `type:"result"` 收尾记录与
   `isApiErrorMessage` 行(命中即 idle 并清空在途工具),但这只覆盖认得出的
   格式,兜底靠第 2 条。
2. **状态推导一次、却永远重绘。** 前端曾在推导那一刻校验一次新鲜度,之后每秒
   的计时器只是把同一个对象重画一遍——过期永远不会发生。现在每次绘制都重新
   判定:
   - `thinking` / `responding` / `unknown` / 降级的 `running`:模型欠着输出,
     静默超 `SV_QUIET_MS`(90s)即判定轮次结束,活动条自行清空并停掉计时器;
   - `tool`:构建/测试确实能安静跑很久,保留 10 分钟宽限再降级为「可能已中断」。

**静默从 `observed_at`(日志最后一行)量,不是从 `since`(状态开始)量**——
一个持续写日志的长工具调用是活的,一个不再写日志的短思考不是。老 Runner 不带
`observed_at` 时,前端拿 `meta.last_activity` 顶上,至少还能过期。

代价写明:真有一次超过 90 秒不落盘的长思考,活动条会提前消失(下一条日志一到
就自己回来)——比永远假装在跑诚实。工单页不受这个启发式影响:那里有
`turn_started_at`(流水线自己握着子进程),它一旦为空就立刻收条,不等 90 秒。

### 两条硬约束

1. **活动条是 `#msgs` 的兄弟节点,不是它的一部分。** 它每秒刷新一次计时,
   若走消息渲染路径,会把读者手动展开的工具折叠全部收起。页面测试直接断言
   `paintActivity` 体内不出现 `renderCurrent`/`renderMsgs`/`el("msgs")`。
2. **活性判定不能只看写入新鲜度。** 原先「最后活动 <2min」的门槛,恰好在
   最需要跟随的场景(一个安静跑 10 分钟的工具调用)判会话已死、拒绝订阅。
   现在 `activity` 非 idle 即视为活着。

## 测试

| 层 | 覆盖 |
|----|------|
| 增量协议纯函数 | frontier 计算(未配对 tool block 回填)、from 取值、重连补发幂等 |
| activity 推导 | `parse-activity.test.ts`:四态 × Claude/Codex,flat 与 rich 结论一致;并行工具、部分回填、噪声行、无 id 工具、空日志给 `unknown`、`result`/API-error 收尾、`observed_at` 取末行时间 |
| activity 前端 | `session-view.test.ts`(vm 跑真实 JS 串):文案/降级不谎称 thinking、10 分钟中断降级、**90s 静默即结束(含一小时后仍不复活)**、长工具不被误杀、`observed_at` 语义、只标记最后一条消息的在途工具、XSS 转义 |
| tailer | 假 JSONL 持续 append → delta 序列断言;双订阅者共享一个 tailer;归零销毁 |
| e2e | dashboard SSE 全链:登录态订阅、越权 403、gzip 旁路、心跳 |

## 消费方

1. 自举开发流水线工单页(首个,见 `doc/design-self-hosting.md` 人机交互节);
2. sessions 浏览器:任何 `live` 会话自动实时跟随(如从手机围观自己笔记本上
   正在跑的 Claude Code);
3. 未来:秘书汇报的调查过程围观等。
