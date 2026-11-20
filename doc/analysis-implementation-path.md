# 实现路径调研与分析 — 秘书 Agent 网络

> **历史文档。** 记录 2026-07 在 v4 之前选择秘书网络实现路径时的调研结论，其中分支、代码路径与完成度不再代表当前状态；当前模块边界从相关包级文档与 `.claude/rules/` 进入。

> 配套文档: `doc/vision-secretary-network.md`(愿景原文)
> 分析人: Claude Code ｜ 日期: 2026-07-15
> 依据: 对 `lvht/main`(原版)+ `lby fork`(二次开发,领先 26 提交)全部关键代码的通读,以及一次开源横向调研。评估打分是调研判断,非绝对值。

---

## 0. 结论先行(TL;DR)

1. **不要重写,也不要换开源框架。** 你自己识别出的"最麻烦、可共用"的两段——**和飞书握手** + **驱动 LLM**——**已经解决了**:飞书那段你早已外包给官方 `@larksuiteoapi/node-sdk`(WSClient + CardActionHandler),还额外做了**所有候选开源框架都没有的 per-user OAuth**;LLM 那段你用的是 Claude Agent SDK。采用 LangBot/AstrBot/CowAgent 等任何框架都会在这两点上**倒退**,不会更省。

2. **以 `lby fork` 为基线,而不是 `lvht/main`。** lby 是原版的 **0-behind 线性超集**,而且恰好把愿景**最难自研的两块**做进去了:**uid 级真 OS 隔离**(setuid+chown,皇冠明珠)和**跨用户投递底座**(ask-user MCP + ACL + 审批,调用方身份不可伪造)。在 main 上从零重造这两块是最贵的活。代价是 lby 压了一个 **1150 行手搓 OpenAI provider**(最大负债)——但它可分离、非愿景硬需求。

3. **真正要做的新工作,是愿景的另一半:"秘书网络"。** 它拆成两个具体缺口——(a) **常驻前端头**(现在的隧道随 CLI 进程死,这是最大架构 gap);(b) **秘书语义层**(调查→打包+判断→投递给对方秘书→按对方偏好重组),现状 0–40%。这两块没有现成方案能整体拿来,但有清晰的**设计蓝本**(AgentsMesh)和**官方机制**(Claude Code Channels / hooks / `transcript_path`;Codex 开放 rollout JSONL)可借力。

**一句话路径**:`lby fork 为基线 → 卸掉/降级 OpenAI 负债、还清跨用户与隔离的关键债 → 把"随 CLI 而死的隧道"改成常驻 Runner → 给 remote server 加 session 感知 → 在 ask-user 底座上把语义从"查人"翻转成"投递给对方秘书" → 最后接 skill 路线。`

---

## 1. 把愿景拆成 8 层,逐层定位现状

这是整份分析的骨架。**"最麻烦可共用"的前两层已解决;真正的工作在第 5–7 层。**

| # | 层 | 现状 | 在哪 | 结论 |
|---|-----|------|------|------|
| 1 | **飞书握手层** | ✅ 已解决 | `channel/feishu*.ts` + 官方 SDK + per-user OAuth | 别动。这是差异化资产 |
| 2 | **LLM 驱动层(Claude)** | ✅ 已解决 | `session/session.ts` + Claude Agent SDK | 别动。多 provider 是可选,非必需 |
| 3 | **调查用的远端文件访问** | ✅ 已解决 | `remote-mcp-server/server.py`(remote_read/bash/glob…) | 可直接用,只差 session 感知(见 §6) |
| 4 | **每用户 OS 级隔离** | 🟡 lby 已做,需加固 | `session/isolation.ts`(setuid+chown,仅 root 模式) | **lby 独有**,原版无。加 realpath 防护即可用 |
| 5 | **跨用户投递(传输+授权+身份)** | 🟡 lby 底座在,语义 ~40% | `plugins/ask-user/` + `router.ts` cross-user | **lby 独有**。需翻转语义 + 还债(见 §6) |
| 6 | **常驻前端头(frp 式反连)** | 🔴 骨架在,生命周期错配 | `cli/cli.py` + `ssh -R/-L` + workspace 隧道 | **最大架构 gap**:隧道随 CLI 死(见 §5) |
| 7 | **秘书语义层(调查/打包/重组)** | 🔴 0–40% | 无(git log 有 research secretary prompt 雏形) | **真正的新产品工作**(见 §6) |
| 8 | **skill 接入路线** | 🔴 ~0% | 无(仅有可复用的 WS 协议壳) | 有官方机制兜底(见 §7) |

---

## 2. 自研 vs 开源:为什么不换框架

**核实过的硬事实**:`feishu.ts` 直接 `import * as lark from "@larksuiteoapi/node-sdk"`,飞书 WS 长连接、`card.action.trigger` 回调都来自官方 SDK——你没在手搓验签解密,**"省握手"的红利已经吃到**。而你在其之上叠的 **per-user OAuth(Device Flow + 自动续期)**,是横评的 5 个完整框架(LangBot / AstrBot / CowAgent / Koishi / feishu-openai)**无一具备**的——它们全是应用/租户级 token。

**换框架 = 两处倒退**:(a) 丢掉 per-user OAuth;(b) 它们是"IM channel 多路复用 + 聊天式 LLM"的形状,而你的价值在"多用户 × 分散本地 agent × 秘书网络",不是聊天 bot 的形状。

**该借的不是框架,是模块和设计**:

| 借力对象 | License | 借什么 |
|---|---|---|
| [cc-connect](https://github.com/chenhg5/cc-connect) | MIT | "飞书 WS ↔ 本地 Claude Code/Codex"的现成参照,走 **Agent Client Protocol (ACP)** 而非 spawn+解析 stdout |
| [AgentsMesh](https://github.com/AgentsMesh/AgentsMesh) | BSL-1.1 | **愿景的产品化蓝本**:中心 Backend + 每机 Runner **反向长连** + 本地隔离 agent pod。借设计不依赖 |
| [frp](https://github.com/fatedier/frp) / [rathole](https://github.com/rapiz1/rathole) / [piko](https://github.com/andydunstall/piko) | Apache/MIT | 传输层。**piko 的 endpoint-id 天然映射"每用户一条命名隧道"** |
| Claude Code **Channels** + `type:"http"` hook | 官方 | skill 接入路线的官方双向管道(见 §7) |

---

## 3. 基线选择:以 lby fork 为基线

**为什么是 lby 而不是 main**:

- lby = 从 `de5a800`(lvht 当前 HEAD)**领先 26 提交、0 落后**、+4211/−285 行的**线性超集**。将来拉 lvht/main 的更新几乎零成本。
- 愿景三个关键原语(uid 隔离 / 跨用户底座 / 飞书精确投递)**全在 lby、原版全无**。在 main 上重造它们 = 最贵的活。
- **uid 隔离(commit `ee364ad`)是皇冠明珠**:真 setuid + chown + 应用层 PreToolUse 牢笼,几乎可直接用。

**代价与处置**:lby 最大负债是 **1150 行手搓 OpenAI provider**(`session/llm-query.ts`,影子实现了 SDK 的会话状态/MCP 客户端/文件工具,维护面翻倍,且默认 provider 被翻成了 openai/gpt-4.1-mini)。**它不是愿景硬需求**——愿景要的是"秘书**读**本地 Claude/Codex session+文件"(工具侧、provider 无关),不是"秘书大脑必须跑 OpenAI"。

**两条可执行路线,推荐 A**:

- **路线 A(推荐,若想保留多 provider / 不想重造轮子)**:基于 lby,**默认 provider 改回 claude**,OpenAI 降为实验开关;优先还清 llm-query 与跨用户的关键债(见 §9)。好处:并发 rounds、飞书精确投递、per-round 卡片这些体验层也一并拿到。
- **路线 B(若对"手搓影子 SDK"零容忍,要最小新增面)**:在 `lvht/main` 上 **cherry-pick** `ee364ad`(uid 隔离)+ 跨用户四件套(`d424057`/`aa420b5`/`d24f538`/`da917c3`)+ store migration,**丢掉 `111a785` OpenAI provider**。这些提交可分离度高。代价:漏掉并发/投递体验层,需自己补。

> 决策点(需你拍板):**秘书大脑要不要 provider 无关?** 若团队里有人没有 Claude 额度、或你要用 OpenAI 控成本 → 保留并加固(A);否则 → OpenAI 当实验件或直接不背(A 的裁剪版 / B)。

---

## 4. 你点名的"最麻烦可共用"两段:确认已解决

用户原话:"最麻烦的、可共用的,就是和飞书握手的这段,以及驱动 llm 推理的这段。"——**这两段现在都不是瓶颈了**:

- **飞书握手**:官方 SDK 兜底 WS 长连接 + 卡片回调;你叠了 per-user OAuth、CardSlot per-source 隔离、同步回调握手、消息分片、并发建 channel 去重。成熟度 4/5。**唯二要补的洞**:OAuth 有兄弟方法漏查 `code!==0` 会崩(`feishu-oauth.ts` `getAppAccessToken`/`exchangeCode`);入站消息无 `message_id` 幂等去重。
- **驱动 LLM**:Claude Agent SDK,依赖注入可测,MCP 装饰器在传输层强制注入 UAT(全库最聪明的复用件)。成熟度 4/5。

**言下之意**:你不需要在这两段上再投入结构性精力,精力应全部压到第 5–8 层。

---

## 5. 中心架构决策:把"随 CLI 而死的隧道"改成常驻前端头

**这是愿景落地的头号架构 gap。** 现状(已核实):

- 本地 MCP daemon(`server.py`,`mcp-daemon.sh` 用 nohup)是**持久**的;但**反向隧道 `ssh -R` 是 `cli.py` 的子进程**——**CLI 一退,隧道就断**,daemon 活着也没用,中心从此够不到那台机器,**没有重连/心跳/存活探测**(`cli.py:472-534`)。
- 愿景要的恰恰是"**常驻的前端头**"(用户干完活关掉 CLI,秘书网络仍要能反连这台机器读 session)。二者直接冲突。
- 另有真实 bug:隧道端口分配在 `suggestedPort` 分支**不查重**(`workspace/manager.ts:120`),而 CLI 每个 workspace 默认都建议 19000 → 多机默认参数下**静默串台**(第二台的 `remote_*` 打到第一台的 daemon)。

**重设计(核心决策)**:把"隧道"从**交互式 CLI 的子进程**里剥离,做成**独立常驻 Runner**:

1. **Runner = 每台机器一个常驻服务**(systemd / launchd),职责:维持反连、读本地 session、当 skill 通讯管道。CLI 退出不影响它。**AgentsMesh 的 Runner 模型是现成蓝本**。
2. **传输层二选一**:
   - **务实升级**:把 `ssh -R` 换成 **frp/rathole** 常驻 client(自带重连/鉴权/多路复用),或 **piko**(endpoint-id = 用户名,天生多用户)。改动最小、最稳。
   - **更 Claude-native**:用 **remote MCP over WebSocket**(`claude mcp add --transport http`,SSE 已弃用;WS 支持服务端 push + 指数退避重连)替代自建隧道协议的一部分。
3. **修端口分配**:`allocateTunnelPort` 的 suggestedPort 分支必须查重;CLI 侧别把 "address already in use" 当成功。
4. **认证升级**:现在是静态明文共享密钥(靠 SSH 隧道兜底传输安全),无设备身份/过期/轮换。多用户多设备下应给每设备独立可吊销凭据(frp/rathole/piko 都自带 per-endpoint token)。

---

## 6. 秘书语义层:真正的新产品工作

愿景四步——**调查 → 打包+判断 → 投递对方秘书 → 按对方偏好重组**——现状与做法:

### 6.1 调查(investigate)— 现状 30%
- `remote-mcp-server/server.py` 已能 `remote_glob '~/.claude/projects/**/*.jsonl'` + `remote_read` **摸到** session 文件,但**没有 session 感知**(不知道那是 session、更不会"调查")。
- **做法**:给 server 加一层薄壳工具 `list_recent_sessions` / `summarize_session`。但**别硬解析 Claude 的私有 JSONL**——官方明说该格式内部私有、跨版本会变。优先用官方稳定接口:
  - **Claude**:`SessionEnd`/`Stop` hook 的 `transcript_path` 字段 + `/export` + `claude -p --output-format json`;
  - **Codex**:直接读**开放**的 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`(含 prompt/响应/tool call/token),或 `codex mcp-server`。
- git log 里已有 `Enhance research secretary prompt` 雏形,`/idea` + project-creator 也在做"对话式收集需求"。**在此之上加"调查最近 session"的 prompt + 工具即可**。

### 6.2 打包+判断 — 现状 ~10%
- lby 的跨用户 query 现在发的是**一条裸字符串**。愿景要的是"**材料 + 证据链接 + 己方判断**"的结构化报告包。
- **做法**:定义一个"报告包"schema(summary / evidence(session/文件引用) / sender_judgment / ask),让汇报方秘书填。这是 schema + prompt 工作,压在 ask-user 之上。

### 6.3 投递 + 6.4 按偏好重组 — 关键洞察:**翻转 lby 的语义**

**lby 现在的跨用户流程方向,恰好和愿景相反**——这是本次分析最重要的发现:

- lby 是 **"asker 的 agent → 目标本人审批 → 以目标身份跑一个一次性剥壳 session"**,而且那个 responder session 被系统提示**明确禁止读目标的本地 workspace/项目文件**(`router.ts:496`,出于防越权,可理解)。
- 但愿景要的是:**目标的"自己的、常驻的、被信任的秘书"**,用**目标自己的工作区上下文**,把收到的报告按**目标偏好的格式**重组。

**这两者不矛盾,而且愿景的模型更干净、更安全**:
- lby 模型里"asker 拉取 target 的数据"→ 必须防 target 本地文件被越权读,所以锁死。
- 愿景模型里**只有"报告包"跨越用户边界**,**处理它的是 target 自己的秘书、用 target 自己的身份和数据**——target 的本地文件从不暴露给 asker,反而**天然安全**。
- **可复用 lby 的**:调用方身份不可伪造(env 注入)、ACL、审批卡、target 本人校验这套**授权+身份管线**;
- **要翻转的**:responder 从"锁死的一次性 session"改成"**投递到 target 的持久秘书/收件箱**",允许它用 target 自己的 workspace CLAUDE.md + per-user persona(`/config` + `prompts/*.md`,落点已存在)重组。

> 换句话说:**lby 把最难的"跨用户身份+授权+审批"管线修好了;愿景需要的是换一个更安全的数据流方向来复用它。** 这是"改造"不是"重写"。

---

## 7. 两条接入路线

- **路线 A(飞书 bot)**:✅ 基本就绪。lby 还补了群内**精确 @mention**(不再逢消息就答)、wiki 工具、异步卡片替换。作为"老板读成品材料 + 审批"的界面直接可用。
- **路线 B(Claude Code / Codex skill 直接提交汇报)**:~0%,但**有官方机制兜底,是正道**:
  - **Claude Code Channels**(研究预览):一个把事件 push 进运行中 session、且能**双向 reply** 的 MCP server——精确对应"秘书收到对方汇报请求"的管道。`claude --channels plugin:xxx`,支持自建 webhook receiver。
  - **`type:"http"` hook**:把 `SessionEnd`/`Stop` 等事件 POST 到中心(带 `Authorization` header),天然是"干完活自动触发汇报"。
  - **读 session**:用 hook 的 `transcript_path`,别硬解析私有 JSONL。
  - **Codex 对等**:hooks(事件名几乎照搬 CC)+ `codex mcp-server` + 开放 rollout JSONL。
  - 现成同类参照:[cc-connect](https://github.com/chenhg5/cc-connect)、[feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge)、[Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote)。

---

## 8. 分阶段路线图

| 阶段 | 目标 | 关键动作 | 复用什么 | 新增面 |
|------|------|---------|---------|--------|
| **P0 固基** | 选定基线、还清致命债 | 采用 lby;默认 provider 改回 claude;修 OAuth 崩溃点 + 入站去重;修隧道端口查重;跨用户 pending 持久化+过期+限流+销毁临时 session;uid 隔离加 realpath | lby 全部 | 小(bug 修复为主) |
| **P1 常驻前端头** | 隧道不随 CLI 死 | 抽独立 Runner(systemd);传输换 frp/rathole/piko 或 remote MCP-WS;心跳+重连 | AgentsMesh 蓝本;现有 server.py | 中(新常驻件) |
| **P2 调查能力** | 秘书会读本地 session | server 加 `list/summarize_sessions`(优先官方 `transcript_path`/Codex JSONL);research-secretary prompt | remote server;git log 已有 prompt 雏形 | 中 |
| **P3 秘书语义层** | 打包+判断+投递对方秘书+按偏好重组 | 定义"报告包"schema;**翻转** cross-user 语义为"投递给 target 常驻秘书";target 用自身上下文+persona 重组 | **lby 的身份/ACL/审批管线** | 大(核心产品工作) |
| **P4 skill 路线** | 干完活在 IDE 直接汇报 | Claude Code Channels + `type:http` hook;Codex hooks + mcp-server | 官方机制 | 中 |

**顺序理由**:P0 让基线可靠;P1 让"常驻反连"这个物理前提成立(否则 P2/P3 无处落地);P2 喂给 P3 原料;P3 是价值核心;P4 是第二入口,可与 P3 并行。

---

## 9. 必修 bug / 债清单(四路调查汇总)

**原版(lvht/main)也在的**:
- OAuth `getAppAccessToken`/`exchangeCode` 漏查 `code!==0` → 崩溃点。
- 入站飞书消息无 `message_id` 幂等去重。
- 委派"实时发现"文档宣称但**未实现**(`watch` import 了没用,只在回合结束后轮询)。
- 隧道端口 `allocateTunnelPort` suggestedPort 分支不查重 → 多机静默串台。
- 反向隧道生命周期 = CLI 进程(§5 头号 gap)。
- 全局并发信号量 = 5,跨所有用户共享(多用户吞吐瓶颈)。
- 分布式核心(workspace/tunnel/binding)零单测。

**lby 引入的新债**(采用 lby 必须知道):
- 跨用户 pending 仅内存 → 重启丢、无过期、Map 泄漏、asker 异步结果可能永不到达。
- 跨用户 file query 每次新建 session **从不 destroy** → session+DB 行泄漏。
- 审批处理器**同步阻塞整轮 agent** 在飞书 action 回调里 → 回调超时/重投。
- 跨用户**默认开放**(无 ACL ⇒ 人人可申请查人人)+ 无限流 → 通知轰炸向量。
- 默认 provider 翻成 OpenAI/gpt-4.1-mini。
- OpenAI 会话状态 = 模块全局 Map(无界 + 并发竞态);工具桥**跳过 http/sse MCP**(用不了 remote MCP);成本恒为 0;MCP server 每轮 spawn/kill + 吞 stderr。
- 并发 rounds 共享 claude resume → 历史发散(靠 prompt 注入打补丁)。
- isolation 路径牢笼**无 realpath** → 非 root 模式软链接可越狱。
- `router.ts` 再涨 678 行,跨用户逻辑未抽 `CrossUserService`,god object 更重。

---

## 附:关键代码位置索引

**原版核心**:
- `session/session.ts:368-540` `buildQueryParams`(驱动 LLM 的心脏)
- `session/session.ts:542-652` `buildMcpServers`(MCP 能力组合)
- `plugins/mcp-decorator/src/index.ts:170-216`(传输层注入 UAT)
- `router/delegate.ts:57-118` + `router.ts:1159-1180`(委派 spawn + 结果回注)
- `channel/feishu.ts:234-386`(卡片回调同步握手)
- `remote-mcp-server/server.py`(远端文件工具,待加 session 感知)
- `workspace/manager.ts:112-134` `allocateTunnelPort`(端口碰撞 bug)
- `cli/cli.py:472-534`(隧道随 CLI 死 + 串台 bug)

**lby 新增**(相对路径在 fork 内):
- `plugins/ask-user/src/server.ts`(跨用户查询工具)
- `router.ts` `startCrossUserApi` / `resolveCrossUserPermission`(:257)/ `runCrossUserFileQuery`(:544)/ `cross_user_approve`(跨用户管线)
- `session/isolation.ts`(uid 隔离 PreToolUse 牢笼)+ `isolation.test.ts`
- `session/session.ts:483`(setuid spawn)/ `:530`(凭据拷贝+chown)
- `user/manager.ts` `restrictUserTree`(chown 收敛)
- `session/llm-query.ts`(OpenAI provider,最大负债)
- `store/migrations.ts` v6(`cross_user_acl` 表)
