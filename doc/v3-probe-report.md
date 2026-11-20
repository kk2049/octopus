# v3 引擎探针报告 —— 六个问题的实践答案

> **历史文档。** 记录 2026-07 v3 引擎时间盒探针在实验分支上的证据，包路径、规模与结论只对当时探针成立；当前 Agentic App 边界见 `.claude/rules/agentic-app.md` 与 `doc/adr/`。

> ⚠ **工作假设，非 ground truth。** 本报告记录 2026-07-27 一个 2.5 小时时间盒里，把「agent 前端引擎」哲学落成可跑代码后得到的手感、证据与修正。它的每个结论都以「在探针里成立」为限，等待被更大的实践推翻。
>
> 代码：`packages/engine`（内核 2517 行 + 测试 794 行）+ `packages/v3-host`（宿主 115 行 + 三个应用）。分支 `dev/lht`，六个提交，37 个 vitest 全绿，生产系统零接触。

---

## 0. 探针做了什么 / 没做什么

**做了**：五原语内核（事件日志 / 单门 dispatch / 温热插纯函数投影 / agent 平面 / 声明式页面）；一个共享 web 运行时；飞书卡片第二渲染面（JSON 层，未真发）；三个应用——HQ 工作台（per-user）、汇报信箱（跨用户投递）、工单板（shared 多写者）；每个应用一个真 LLM 页面秘书（gpt-5.6-sol），全部活体验证。

**第二波（同日晚间，按用户指令逐项清偿后）**：上面那段「没做」已**全部做完**——claude-code/codex 双 adapter（§9）、correction/segment、飞书卡片回调闭环（e2e 形）、`fireDaily` 可触发可测试、elicitation 问询卡（§10）、deadlines 租约原语、section 容器；另加统一会话中间层与双呈现模式（§10）、可视化工厂与共笔文档（§11）。

**当前仍没做**（新的诚实清单）：飞书**真**发送/接收（回调闭环是 e2e 形，无真飞书 app）；openai-loop 面不吃 MCP 授予（进程内 loop 缺 MCP 客户端）；codex 会话发现法在同主机并发 codex 时有抢错窗；correction 是条目级 overlay，非块级 provenance；工厂保存的 YAML 结构可读、节点是 JSON（可手工美化）；工厂对 per-user 应用显示的 runtime 配置取查看者自己的 scope。

**验证矩阵**（全部活体，不是单测嘴上说说）：

| 假设 | 验证方式 | 结果 |
|---|---|---|
| T2 数据真热插 | 运行中写坏 `app.yaml` | 保留旧配置继续服务 + 红色横幅报错；改好即恢复 |
| 纯函数温热插 | 运行中改 `projection.ts` | 下一次请求即新逻辑，零重启 |
| 一体两面同门 | 网页按钮与 agent 工具各调一次 `close_item` | 同一 dispatch，同一校验，事件分别署名 `user:lht` / `agent:hq/page@lht` |
| 发现自动、授权不自动 | `human_only` 动作 / 他人 scope | agent 工具列表自动排除 human_only；bob 对 lht scope 读写全拒；admin 只读透镜可看不可写 |
| 跨用户投递带真实署名 | 秘书代发汇报给 bob | bob 信箱事件 `by: agent:reports/mailer@lht`，收件人看得见是代发 |
| 共享 scope 多写者 | lht 开单、bob 评论、agent 替 bob 补评 | 一份日志三种署名，投影同板 |
| race 由结构消灭 | 10 个并发 dispatch 各读状态+1 | 串行链下产出严格 1..10（测试钉死） |
| 崩溃撕尾自愈 | 日志尾写半行再 append | 读侧跳过、下笔换行，seq 不乱（测试钉死） |
| **实践→修词表闭环（第二轮迭代）** | §1 现形的三缺口中两个当场补进 DSL | `locals`/`$key` 选中态词表 + `enum_bind` 动态候选，双面生效（网页下拉 + 飞书卡「可选：…」提示）；信箱页重写为点选即看，域日志零污染 |
| **独立 agent 长第四应用（实验 #5）** | 子 agent 只读 CLAUDE.md+一个样例应用，禁碰引擎，写「clips 收藏夹」 | **270 行一次写对**：tsc/loadApp/自编 14 断言全过，宿主上 seed/视图/动作/卡片面首跑即通，连「删除后 id 不复用」都自行推理正确；同时交回 **11 条 DX 反馈**（含 loader 一个级联谎报 bug、两处静默放行、「CLAUDE.md 是哲学不是手册」）——反馈当场消化：校验器修三处 + 新增 `REFERENCE.md` 参考手册 |
| **claude-code adapter 双面同门** | tickets triage 切到 claude-code，经 MCP shim 写评论 | 真 `claude -p` 轮 ~14s；评论署名 `agent:tickets/triage@lht`；真会话 jsonl 落 `~/.claude/projects` |
| **codex adapter** | clips keeper 切到 codex，read_state + mark_read | rollout 文件 mtime 发现法回收会话 id；工具经同一 shim；头号坑=stdin 管道等待（§9） |
| **elicitation 问询卡** | 秘书按要求 `ask_user(form_action=add_clip)` | transcript 出现 `[elicit] (form:add_clip)`，网页渲染成带表单的问询卡，提交自动回灌 inbox |
| **deadlines（租约形）** | 测试: 0.1s 时钟 fire/cancel/重启恢复 三态 | `system:deadline` 追加 emit 事件，fold 保纯；reports 声明 3 天未读→逾期红条 |
| **工厂校验后保存** | 故意存坏 widget 的页面 YAML | 422 + loader 完整教学清单原样弹回；好保存落盘 + `file_saved` 审计（署名保存者） |
| **per-agent MCP 授予** | 工厂授 triage `echo-demo`，让它调用 | `last-mcp.json` 记录本轮真实接线 `['v3','echo-demo']`；agent 调 `echo → "echo: 工厂授予生效"`；顺手活捉 setAgentConfig 全量覆盖 bug（见 §11） |
| **共笔文档（docedit）** | HQ 主页新增「共笔文档」栏 | 点击即编辑，保存走 `edit_doc` 动作——人与秘书写同一份文档、同一扇门、全历史留日志 |

**判据核对**（Q1 裁决：下一个 HQ 级子系统 ≈1/5 代码、零新写权限/刷新/投影逻辑）：

| 应用 | v3 行数（yaml+纯函数+prompt） | 老实现对照 | 比值 | 备注 |
|---|---|---|---|---|
| HQ | 458 | hq/ 2087 + hq-page 752 = 2839 | **≈1/6** | 语义大头已移植（四格、三时态、逾期进今天、秘书巡检）；未移植 segment/correction/15 工具的细粒度 |
| 汇报信箱 | 251 | report/ 1542 + secretary-page 504 | ≈1/8（**不可比**） | 老流程有状态机/lease/归档/对齐群，mini 只覆盖发-收-读-回芯子；只证明「跨用户原语够用」，不证明等价 |
| 工单板 | 192 | devpipe 2690 + tickets-page 892 | 刻意缩水 | 只探 shared scope 与对话即控制；git/门禁没碰 |

三个应用**都没有写过一行**权限判定、SSE/轮询、渲染、agent 调度代码。判据在 HQ 上以 1/6 达成；另两个以「原语够用」的弱形式达成。

---

## 1. 前端如何构造（Q1）

**成立的部分**：页面=数据这个赌注赢了。一张 HQ 主页是 24 行 YAML：列 × 槽 × `{widget, bind, props, on}`，schema 校验把所有错误一次性列全（错误文案本身是教学：`wiring targets are "action:<name>" — pages may wire, never compute`）。写第二、第三个应用的页面时体感接近填表——这正是「乐高」该有的手感。组件目录收在 10 个以内（8 卡片档 + 2 富组件），**收窄本身就是生产力**：没有选择，所以没有犹豫。

**被实践打脸的部分（本次最有价值的发现）**：

1. **「选中态」无处安放。** 信箱页想要「点某封→右侧显示那封」，但选中是**视图局部状态**——它既不是域事实（不该进事件日志），也不是投影输出（投影是纯函数，不知道你点了谁）。
   **→ 第二轮迭代已闭**：T2 增加 `locals` 词表——页面声明 `locals: {selected: {default_bind: view.latestId}}`，连线目标多了 `local:<key>`，bind 路径允许 `$key` 段（`bind: view.threadsById.$selected`），按钮参数可写 `"$selected"` 点击时注入。全部仍是数据、仍被 schema 校验（`$ghost` 未声明会报教学级错误），生命周期在浏览器里，域日志零污染。信箱页已重写为点选即看+选中高亮。
2. **动态候选项。** `add_item` 的 project 参数本该是「现有项目的下拉」，但 params 的 enum 是静态声明。
   **→ 第二轮迭代已闭**：param 声明加 `enum_bind: view.projectIds`（候选从投影取），网页面渲染成真下拉，飞书面渲染成「可选：v3-probe、octopus-rl」的输入提示；**服务器刻意不按它校验**——handler 的自校验仍是唯一真相，过期下拉降级为一条有用的报错而不是无声谎言。
3. **一槽一件。** 布局槽位只挂一个组件，逼出了 `[a, b]` 列堆叠语法——够用，但「标题+列表」这种惯用对偶暗示卡片档也许需要一个 `section` 容器组件。
4. **富组件才是护城河的另一半。** 卡片档八件套一天成型；但 sessions 实时视图那种交互密度（fold、钉底、断线补发）在探针里完全没碰。80/20 裁决（复杂页面允许手写）目前仍是**假设**，没被检验。

## 2. 按钮如何映射到应用逻辑（Q2）

一条链：`按钮/表单（从 ActionSpec 自动生成）→ POST /api/act → dispatch 单门（谓词→校验→读投影→纯 handler→原子追加）→ SSE 把新投影推回所有面`。按钮**没有自己的逻辑**，它只是动作声明的一次渲染；表单字段、必填、enum、确认对话框全部从声明推导。

意外收获：**校验错误消息成了人与 agent 的共享 UX**。handler 里 `throw new Error("没有项目「x」。现有：v3-probe、octopus-rl")`——人看到它是 toast，agent 看到它是 tool error，一份文案两个受众，写一次。这不在设计里，是单门结构白送的。

代价也清楚：所有交互都收敛到「提交-刷新」节奏。拖拽排序、乐观更新、局部动画这类交互不经过 action 门就没有位置——它们属于富组件内部，探针未涉。

## 3. MCP 风味的工具如何映射到同一逻辑（Q3）

agent 的工具列表不是配置出来的，是**查询出来的**：`listActions(agentActor)` 用与渲染按钮完全相同的谓词过滤，返回什么就生成什么工具（加一个 `read_state`）。所以：

- 页面上多declare一个动作，人多一个按钮，agent 自动多一个工具——**发现性保证从纪律变成结构**；
- `human_only`（死人开关类）在工具生成层就消失，agent 连「试着调用被拒」的机会都没有；
- agent 的每次调用走同一 dispatch，署名 `agent:<app>/<agent>@<user>` 由引擎盖章，handler 里**不存在**伪造署名的 API 形状。

与生产 bot 对照：hq/ops.ts 用纪律维持「两个客户端调同一 ops 层」，探针把它反转成「只有一个门，两个面是投影」。前者要 code review 守，后者违反不了。

局限：目前工具即动作，粒度天然一致；但真实系统里 agent 常需要「查询类工具」（搜会话、读文件）——它们不是动作（无写入），探针只给了 read_state 一个。查询工具词表是下一个要设计的面。

## 4. agent 和 GUI 如何互相同步、互相感知（Q4）

答案比预想的简单：**不要让它们互相感知，让它们感知同一个东西。**

- 人做了什么，agent 下轮 `read_state` 看投影就知道——投影里有 id（it-3、pl-2），人机对话可以精确指称；
- agent 做了什么，append 触发 SSE，页面秒级更新——活体验证时，秘书闭环 it-2 的瞬间网页四格就变了；
- 人对 agent 说话本身也是域事件（`agent_inbox`）：聊天、按钮的「让秘书巡检」、04:00 定时器，三种来源在日志里是同一种事实，pump 只认未读。

这带来一个反直觉的推论：**「agent 看得见按钮」是伪需求**。agent 不需要看见按钮，它需要看见按钮背后的动作（有）和按钮呈现的状态（read_state 有）。按钮只是人类专用的皮肤。探针跑下来没有任何一处需要把 UI 结构喂给 agent。

未解的半边：transcript 的跨轮衰减（工具细节压成一句 note）原样继承了生产 bot 的取舍；富组件里的**流式**中间态（agent 正在打字）也仍然只有转圈，没有逐字。

## 5. 状态管理器与状态机怎么设计（Q5）

探针立了三条，都站住了；第四条没检验：

1. **事件日志是唯一真相**，`{seq, at, by, type, data}` 封皮引擎盖章，`by` 不可伪造——审计不是功能，是存储格式。
2. **状态机活在 fold 里**：四格流转、closed 终态、未读→已读，全是投影函数里的 switch。改状态机=改纯函数=温热插——探针里运行中改投影立即生效，这让「调状态机」的循环从『改-重启-复现』变成『改-刷新』。
3. **投影可牺牲**：`.cache` 哲学继承自 HQ——投影 bug 是渲染 bug，不是数据损失。
4. **没检验的**：report 那种带 lease、超时、多方会签的**重型状态机**。它的状态转移有时间维（lease 到期）和外部副作用（发飞书），纯 fold 装不下时间驱动的转移——大概率需要「引擎级定时器往日志投事件」（04:00 巡检已经是这个形状），让 fold 保持纯。这是下一个要压的点。

## 6. 如何用框架设计防死 race、保证人机一致（Q6）

**核心手段是把并发问题变成排队问题**：每个 (app, scope) 一条串行 dispatch 链，`读投影→跑 handler→原子追加`是一个不可分割的段。测试用 10 个并发「读计数+1」钉死了顺序性——这类竞态在生产 bot 里要靠 lease/挡板/UPDATE-WHERE 各写一遍，这里是**结构免费**。配套的小件：整批事件一次 write（dispatch 的原子性）、撕尾自愈（崩溃窗）、pump 的 consume-at-start（失败轮不重投）、每 agent 串行+全局并发 2。

**诚实的剩余风险**：

- **单进程契约**：没有 flock。带外写者只会触发全量重读，不被保护。多进程化（或 bot 与 v3 合体）之前必须加进程级锁或单写者约定。
- **跨 scope 非事务**：本地已写、投递未达的崩溃窗存在，可见可修，不回滚（沿用网页发飞书的裁决）。
- **SSE 是全量视图推送**：30ms 防抖合并中间帧。投影大了（千级条目）会烧带宽，升级路径是 view-diff patch——先不做，等疼。
- **温热插的模块泄漏**：Node 不卸模块，每次编辑漏一个旧版本，编辑频度下无所谓，长期跑要认。
- **agent 并发写同一 scope**：与人共用一条串行链，所以 agent 与人「同时」操作也只是排队——但 agent 读到的状态可能在它思考期间过期（read_state 与 dispatch 之间无锁）。dispatch 时 handler 重新拿最新投影做校验，所以坏写进不来，但 agent 可能基于旧观察做出语义上过时的动作。这是「乐观并发+校验兜底」，与人类协作的语义一致，明说即可。

---

## 7. 计划之外学到的（比验证清单更值钱）

1. **DSL 的缺口在实践第二小时就现形**（local 状态、动态 enum、section 容器），而且每个都有保持数据材质的解法——「先造再设计词表」的顺序是对的。
2. **谓词词表比想象中够用**。三个应用只用了 any/owner（admin 只在引擎层）。「复杂权限」的需求在 app 层被 scope 切分吸收了。
3. **prompt 纪律不可替代但可以变薄**：mailer 主动在代发正文里自注「秘书代发」，因为 prompt 里写了一句；但署名的**硬保证**在引擎，prompt 只管礼貌。硬的归结构、软的归 prompt，这个分层探针里非常舒服。
4. **seed.yaml 意外好用**：声明式假数据让每个应用天生带演示态，测试、演示、开发共用一套世界。
5. **写第三个应用只花了约 15 分钟**（192 行），且没有打开过引擎源码——「dev agent 声明式长应用」的前置条件（不懂内核也能写对）初步成立。
6. **实验 #5 当天执行了，结果超预期也打脸并存**：一个只许读文档和样例、禁碰引擎的独立 agent，270 行一次写对第四个应用（clips 收藏夹），首跑即通——**但它的 11 条 DX 反馈把「文档=样例逆向」的真相扒了个干净**：具体语法 100% 靠逆向 reports 样例（「没有 reports 这个任务做不出来」）、`layout` 列主序纯靠交叉推理猜中、loader 对 typo 键/缺 prompt 文件/缺 handler 三处静默放行、widget 报错后还会级联谎报「slot 未定义」把人引向不存在的问题。反馈当场消化：级联谎报修掉、三处静默放行改为报错（各配测试）、补写 `packages/engine/REFERENCE.md` 一页纸手册（schema/组件目录/handler 契约/惯用法）。**方法论结论：让陌生 agent 写一个应用，是给声明式系统做可用性测试的最高性价比手段**——它一小时内找到的真 bug 和文档洞，比作者自省一星期都多。
7. **样例即文档的双刃**：实验 #5 同时证明了行内注释携带设计裁决（「selection is not a fact about the world」）可以被陌生 agent 完整吸收并迁移——样例是最好的老师，但**只有**样例时，读者分不清「惯例」与「必须」。手册管必须，样例管品味，两者都要在。

## 8. 下一步实验清单（按信息量排序）

1. **headless-cli adapter**（演示板 tk-1）：把 `claude -p --resume` 接到 AgentHandle 后面，host 挂一个最小 MCP HTTP 端点复用同一 ActionRegistry——这是「工单开发流」上引擎的前提，也是双 adapter 假设的真正检验。
2. ~~local 状态词表 + 动态 enum~~ **已在本次第二轮迭代完成**（见 §1），剩 `section` 容器组件未做。
3. **重型状态机**：把 report 的 lease/超时语义在引擎上重做一遍（定时器投事件、fold 保纯），检验 Q5 第 4 条。
4. **飞书真发送闭环**：卡片按钮回调 → /api/act 的通用 dispatcher，e2e 仿真先行。
5. ~~让 dev agent 长第四个应用~~ **已执行**（见 §7.6）：clips 应用 270 行一次写对 + 11 条 DX 反馈已消化（校验器三修 + REFERENCE.md）。下一档升级：把同样的实验交给 devpipe 真工单道跑一遍。
6. **与生产的关系**：探针不并轨；下一个真实新需求若落在引擎能力内，用引擎长，否则继续喂生产——用真需求决定引擎的命运，而不是迁移工程。

## 9. CLI adapter 实现困难记（claude-code / codex 上 AgentHandle，2026-07-27 晚）

两个 adapter 都已活体验证（claude-code：tickets triage 经 MCP shim 写评论，14s/轮；codex：clips keeper read_state + mark_read，rollout 会话文件回收成功）。按踩坑顺序：

1. **codex exec 的 stdin 陷阱（头条）**：stdin 是管道时，codex 会打印 `Reading additional input from stdin...` 然后**无限等 EOF 才开工**。终端里永远复现不了（stdin=tty），只有 execFile 里咬人——一类「实验环境天然遮蔽」的 bug。修复一行：spawn 后立刻 `child.stdin.end()`。定位靠两件事：失败注记里带 stderr 尾巴（plane 的设计还了债），以及「终端最小复现 19.9s 通过 vs 进程内挂 5 分钟」的对照。
2. **codex 不吐 session id**：`codex exec` 完成后不打印会话 id，`resume` 却需要它。解法=按 mtime 在 `~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl` 里发现最新文件、从文件名抠 uuid。已知残余风险：同主机并发 codex 会话可能抢错文件（诚实记录；后续可解析文件内 meta 的 cwd 做二次确认）。
3. **codex 的 MCP 接线是 `-c` TOML 内联表**：引号跨两层语法（argv→TOML→字符串）是雷区，工具定义 JSON 直接放弃走 env，改走临时文件（`V3_SHIM_TOOLS_FILE`）——「拒绝打引号仗」是正确策略。实测 `-c mcp_servers.v3.env={ ... }` 内联表可用。
4. **claude-code 一次通过**，因为 devpipe 已把所有 argv 都踩平了（`--session-id` 预铸 / `--resume` / `--strict-mcp-config` / `--dangerously-skip-permissions` / `--disallowed-tools Skill`）——组织级经验直接照抄 executor.ts。**在活系统里提炼框架的红利具体长这样**。
5. **shim 手工握手单测**是最快隔离手段：`printf` 三段 JSON-RPC（initialize / initialized / tools/list）管进 shim，20 秒内证明「shim 无罪」，把嫌疑收敛到 codex 侧。
6. 小坑：TS 对闭包内赋值的 `let` 不做跨调用窄化恢复（`best` 被判 never）——holder 对象绕开。
7. **架构上的省钱点**：CLI 面的工具回环没有新协议——per-turn capability token（devpipe 的 DEVPIPE_TOKEN 模式）+ 既有 `/api/shim/call` 一个路由，谓词/署名仍在进程内同一扇门；plane 一行未改地服务三种 loop（callTool 闭包在 openai 面直接调、在 CLI 面被 token 间接调）。

## 10. 统一会话中间层与呈现模式（「3 个 loop → 1 个中间层 → N 个前端」的落地）

`session-view.ts` 定义了唯一的条目词表 `ViewEntry{kind: user|assistant|thinking|tool|file|subagent|elicit|note}`，三个生产者把三种 loop 的原生日志归一进来：plane 自己的 transcript、Claude Code 会话 jsonl（thinking 块、tool_use/result 按 id 配对、Write/Edit→file 条目、Task→subagent、剥 `mcp__` 前缀）、Codex rollout（reasoning 摘要、function_call/output 配对、apply_patch→file、跳 environment_context 噪声）。解析全防御、按 (mtime,size) 缓存。

上层因此可以便宜地长出**多种呈现**：`agent-chat` 的 `props.mode` + 页内切换 chip 给了两种——**富**（思考折叠、工具折叠带结果、文件 chips、子代理块、问询表单卡、“本会话改过 N 个文件”）与**简**（同一份条目过滤到 user/assistant/elicit + 转圈）。两种模式相差约 30 行渲染代码——这就是中间层存在的证明。意外之喜：富视图把 claude CLI 的**内部行为**也如实呈现（例如它先 ToolSearch 自查可用工具再调 echo），没有写过任何胶水。

配置侧：每个 chat 头部有 adapter/model/effort chip + ⚙ 面板，改动写 `agents/<name>/config.json`（owner-only；shared 应用 admin-only），**下一轮生效不重启**；换 adapter 开新会话、旧会话成为历史（活捉过一个语义 bug：切走后旧 CLI 会话文件仍被当作现在时渲染，已修——「会话文件只在同 adapter 在任时是现在时」）。延迟：轮内 1.2s 轮询（闲时 3s），服务端只重解析长大了的文件。

## 11. 工厂：把系统画成它本来的样子

`/factory`（admin-only，手写页——80/20 裁决的合法使用）把任意应用解剖成：页面=列×槽位芯片（HTML5 拖拽 + 磁吸投放区 + FLIP 弹性落位）、动作=芯片显示三面（🖱 被几处按钮引用 / 🤖 除非 human_only / 🃏 飞书旗）+ SVG 贝塞尔连线到每个引用它的槽位、agent=声明与运行时配置对照 + prompt 原地编辑（下一轮生效）+ MCP 授予勾选、`flows`=状态机 SVG。检查器改槽位（组件/bind/props/连线），页面序列化回 YAML 保存。

两条硬保证：**保存必过 loader**——`/api/factory/save` 在临时副本上跑真校验，坏 YAML 422 弹回完整问题清单，工作台救不出引擎会拒绝的东西；**保存必留名**——每次落盘在 factory 应用日志追加 `file_saved`（保存者署名），审计页就是工厂应用自己的标准页。建筑师 agent 的「特权」实现得非常便宜：它就是 claude-code adapter 的原生工具集（devpipe 同款信任模型），领地靠 prompt 钉死在 `apps/**`，工作台右栏用一个 iframe 嵌它的标准页——零重复聊天代码。

**本节的活捉 bug**（比功能更值钱的部分）：`setAgentConfig` 原是全量覆盖，工厂只发 `{mcp:[…]}` 时把 `adapter: claude-code` 无声冲掉，下一轮悄悄跑在 openai 上——暴露它的是 agent 汇报的工具名前缀（`functions.*` 是 openai 命名空间）。修为合并语义（缺席保留、空值清除），并给每轮留 `last-mcp.json`（「这轮到底接了哪些服务器」永远不该靠猜）。教训入库：**多客户端各改一个字段的配置，必须合并语义**；以及**可观测性文件是最便宜的防猜工具**。

## 附：怎么打开看

```bash
# 主机上（或 ssh -L 18930:127.0.0.1:18930 转发后本地开）
npx tsx packages/v3-host/src/index.ts        # 已在跑则略过
# 浏览器: 打开 http://127.0.0.1:18930/login ，把令牌粘进输入框（令牌不能放进网址——
#   URL 会留在浏览历史、下一跳的 Referer 和各级日志里）
#   令牌: v3-lht-dev（lht，admin）/ v3-bob-dev（bob，普通用户，可另开隐身窗）
# 应用: /a/hq（含共笔文档）/a/reports /a/tickets /a/clips /a/factory ；每页右栏是页面秘书
#   聊天头部: adapter/model chip · 富/简切换 · ⚙ 配置（换 openai-loop/claude-code/codex、模型、effort）
# 工厂: 顶栏「🏭 工厂」(admin) —— 解剖图/拖拽组装/prompt 编辑/MCP 授予/flows 状态机
# 卡片面: 页面右上「🃏 卡片面」看同一页的飞书 JSON
# 重置演示数据: 停进程后 rm -rf packages/v3-host/data
```
