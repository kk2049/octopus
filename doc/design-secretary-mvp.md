# 秘书 Agent 网络 — MVP 架构设计(人因工程优先)

> **历史文档。** 记录 2026-07 首个飞书秘书纵切的设计与阶段性路径，不代表 v4 的当前接线；当前行为从 `packages/bot/src/report/`、Dashboard 对应页面和最近包级文档进入。

> 分支: `p0-baseline`(基于 lby fork)｜ 设计+实现: Claude Code ｜ 起草: 2026-07-15 夜
> 配套: `doc/vision-secretary-network.md`(愿景)、`doc/analysis-implementation-path.md`(路径分析)
> 目标: 一个能在飞书上真实跑通的端到端垂直切片。多机隧道扩展留待后续。

---

## 0. 设计原则(人因工程)

愿景的本质是**削减人的认知负荷**:老板不该读只言片语,汇报人不该手工整理。所以每个人机接触点都按这几条设计:

1. **人只做人该做的判断,机器做搬运和组织。** 汇报人只需一句自然语言("帮我跟老板汇报下 X"),调查/打包/措辞全部由秘书完成。老板只需读结论、必要时追问。
2. **渐进披露(progressive disclosure)。** 老板第一眼只看到"一句话结论 + 3 条要点 + 1 个待决"。细节、证据、原始材料折叠在下面,想看才展开。降低首屏认知负荷。
3. **人始终在关键环上有一次确认权。** 汇报人在"发出去前"过目草稿(可改可撤);老板对"是否接收某人的汇报"有同意权(复用 lby 审批)。机器不越过人替人拍板。
4. **可追溯、可反问。** 每条结论都能点开看到它依据哪个 session / 哪个文件 / 哪句原话。老板能就地追问,追问由秘书回答(必要时回问汇报方秘书)。
5. **按收方偏好措辞,不是原样转发。** 同一份材料,给"要数据的老板"和"要故事的老板"呈现不同。秘书用收方的 persona + 工作区上下文重组。
6. **失败要可见、可恢复。** 调查不到东西、对方拒收、超时——都给清楚的卡片反馈和下一步,不静默失败。

---

## 1. 角色与术语

| 术语 | 含义 |
|------|------|
| **汇报人 R** | 发起汇报的人(飞书用户)。有自己的秘书 agent。 |
| **老板 B** | 汇报的接收方。有自己的秘书 agent 和偏好(persona)。 |
| **秘书 agent** | 每个用户绑定的持久 agent session。用**该用户的身份**运行,能访问该用户自己的工作区/session/OAuth。 |
| **报告包 (ReportPackage)** | 秘书之间投递的结构化载荷:摘要 + 证据 + 己方判断 + 待决事项。见 §3。 |
| **调查 (investigate)** | 秘书读取**发起方本地**最近的 Claude Code/Codex session 与相关文件,形成事实底稿。 |

---

## 2. 端到端流程(MVP)

```
 汇报人 R (飞书私聊自己的秘书)                         老板 B (飞书私聊自己的秘书)
 ─────────────────────────────                       ─────────────────────────────
 [1] "/report @B 帮我汇报 X 项目进展"
        │
        ▼
 [2] R 的秘书:INVESTIGATE
     · list_recent_sessions(R 本地 ~/.claude, ~/.codex)
     · summarize_session(挑相关的)
     · 读相关文件(remote_* / 本地)
        │
        ▼
 [3] R 的秘书:PACKAGE → ReportPackage 草稿
        │
        ▼
 [4] 给 R 一张【草稿卡】: 摘要+要点+证据+判断
     R 点【确认发送】/ 【修改】/ 【取消】   ← 人因: 发出前确认权
        │ 确认
        ▼
 [5] DELIVER(跨用户): 复用 lby 身份/ACL/审批,
     但 payload=ReportPackage, 投递目标= B 的秘书 ────────────►  [6] B 侧: 若需同意, 给 B 一张
                                                                      【收取请求卡】(谁, 关于什么)
                                                                      B 点【接收】/【拒绝】 ← 人因: 边界同意权
                                                                          │ 接收
                                                                          ▼
                                                                  [7] B 的秘书: REFORMAT
                                                                      · 结合 B 的工作区上下文
                                                                      · 按 B 的 persona/偏好措辞
                                                                          │
                                                                          ▼
                                                                  [8] 给 B 一张【汇报卡】:
                                                                      一句话结论 + 要点 + 待决
                                                                      〔展开: 证据/原文/来自谁〕← 渐进披露
                                                                      〔按钮: 追问 / 采纳 / 回复R〕
        [9] R 收到回执:已送达 / B 已读 / B 的回复            ◄──────────
```

**MVP 简化(明确记录,便于后续扩展):**
- R 和 B 都是**同一 bot 实例**上的用户(personal 模式),跨用户投递走 lby 的 **localhost 跨用户 API**,不需要多机隧道。
- 调查读**本机**的 `~/.claude/projects/**` 和 `~/.codex/sessions/**`(本机上真有 Claude Code session 可测)。多机场景后续用现有 remote-mcp 隧道扩展。
- 追问(step 8 的"回复R")MVP 先实现"B 的秘书本地回答",跨回汇报方秘书留作后续。

---

## 3. ReportPackage 数据契约

秘书之间投递的核心结构(JSON,存 DB + 经跨用户 API 传输):

```typescript
interface ReportPackage {
  id: string;                    // uuid
  from_user: string;             // 汇报人 username
  to_user: string;              // 老板 username
  topic: string;                 // 一句话主题(R 的原始诉求提炼)
  summary: string;               // 秘书写的执行摘要(结论先行)
  key_points: string[];          // 3-5 条要点
  decisions_needed: string[];    // 待老板决策/知晓的事项
  evidence: Evidence[];          // 证据链(可追溯)
  reporter_judgment: string;     // 汇报方秘书的"己方判断"(愿景强调)
  created_at: string;
  status: "draft" | "pending_approval" | "delivered" | "received" | "rejected";
}

interface Evidence {
  kind: "session" | "file" | "commit" | "note";
  ref: string;                   // session id / 文件路径 / commit hash
  excerpt: string;               // 关键摘录(给可追溯的"原话")
  source_machine?: string;       // 来自哪台机器(多机场景)
}
```

设计要点:
- **结论先行**(`summary` 在前,`evidence` 在后)= 渐进披露的数据基础。
- **`reporter_judgment` 独立字段** = 愿景强调"带上己方判断",且与客观 evidence 分离,收方能区分"事实"与"R 的看法"。
- **`evidence[].excerpt`** = 每条结论可点开看原文,支撑可追溯。
- 收方重组时**不改 evidence**(事实不可篡改),只重写 `summary`/`key_points` 的措辞与排序以贴合 B 的偏好。

---

## 4. 组件与复用映射

| 能力 | 新建 / 复用 | 位置 |
|------|-----------|------|
| 调查:枚举/摘要本地 session | **新建** MCP 工具 `sessions` | `plugins/sessions/`(list_recent_sessions / read_session / summarize) |
| ReportPackage 存储 | **新建** store 表 + 方法 | `store/` migration + `reportPackage*` |
| 汇报编排(投递/审批/回执) | **改造** lby 跨用户管线 | `router/` 新增 `SecretaryService`(从 god-object 里抽出来) |
| 跨用户身份/ACL/审批卡 | **复用** lby | `plugins/ask-user` + `router` cross-user |
| 秘书 persona/偏好 | **复用** presets + system_prompt | `config` presets, `/config` |
| 卡片(草稿/收取/汇报) | **新建** 卡片构造器 | `channel/feishu-card.ts` 扩展 |
| `/report` 命令 | **新建** 命令 | `router/commands.ts` |
| 自主验证 harness | **新建** | `test/verify/`(合成注入 + 断言) |

**关键改造 — 翻转跨用户语义(见路径分析 §6.3):** lby 现状是"asker 拉取 target 数据、且禁止读 target 本地文件"。MVP 改成"R 的秘书**推送** ReportPackage 给 B 的秘书;B 的秘书以 **B 的身份**运行、允许用 B 自己的上下文重组"。复用其**审批+不可伪造身份**,反转数据流。

---

## 5. 人因工程 — 三张核心卡片

### 5.1 草稿卡(给 R,发出前确认)
```
┌─ 📤 汇报草稿 · 发给 @B ──────────────┐
│ 主题: X 项目进展                       │
│ ─────────────────────                 │
│ 结论: 〔一句话摘要〕                    │
│ 要点:                                  │
│   • 要点1  • 要点2  • 要点3            │
│ 我的判断: 〔reporter_judgment〕         │
│ ▸ 证据 (3)  〔折叠, 点开看来源+原话〕    │
│ ─────────────────────                 │
│ [✅ 确认发送]  [✏️ 修改]  [✖️ 取消]     │
└───────────────────────────────────────┘
```
人因: R 一眼看全,证据折叠不干扰;三个明确动作;"修改"= 追加一句话让秘书重写。

### 5.2 收取请求卡(给 B,边界同意)—— 仅首次/未授权时
```
┌─ 📨 @R 想通过秘书向你汇报 ─────────────┐
│ 主题: X 项目进展                        │
│ 预览: 〔summary 前两行〕                 │
│ [✅ 接收]  [🚫 拒绝]  [🔕 以后不提醒此人] │
└────────────────────────────────────────┘
```
人因: 最小信息量做决定;"以后不提醒"= 写入 ACL 免打扰(修 lby "无限流轰炸"债)。

### 5.3 汇报卡(给 B,消费)—— 渐进披露
```
┌─ 📋 来自 @R 的汇报 · X 项目进展 ────────┐
│ 〔按 B 偏好措辞的一句话结论〕            │
│ ─────────────────────                  │
│ • 要点1   • 要点2   • 要点3            │
│ ⚠ 待你决定: 〔decisions_needed〕         │
│ ▸ 证据与原文 (3)   〔折叠〕              │
│ ▸ R 的原始判断      〔折叠, 与B视角区分〕 │
│ ─────────────────────                  │
│ [💬 追问]  [👍 采纳]  [↩️ 回复R]         │
└────────────────────────────────────────┘
```
人因: 结论最大、决策项高亮、证据/他人判断折叠;三个动作对应"想更懂/接受/回话"。

---

## 6. 实施阶段(今晚)

- **P-A 地基**: 自测 harness(合成注入+断言)、修 §9 关键 bug(stderr 吞、pnpm build 固化、跨用户内存态)。
- **P-B 调查**: `sessions` MCP 工具 + 单测(读真实本机 session)。
- **P-C 契约与存储**: ReportPackage 表 + store 方法 + 单测。
- **P-D 编排**: `SecretaryService`(打包/投递/审批/回执),从 router 抽出。
- **P-E 卡片+命令**: 三张卡 + `/report` + 回调。
- **P-F 端到端测试**: harness 驱动 R→B 全流程 + 真实飞书往返冒烟。
- **P-G 交付**: PROGRESS.md 总结 + 提交。

每阶段:实现 → verify 全绿 → 自审 → commit。

---

## 8. v2 修订(2026-07-15 下午 · 全面复审后)

对昨夜 MVP 做了一次不带感情的设计+代码复审(用户未审过原设计)。结论:**分层与 ReportPackage 契约成立,保留;交互层与执行层按下列裁决重做**。全部已实现并有测试。

### 8.1 交互裁决

| 原设计/实现 | 问题 | 裁决 |
|---|---|---|
| `/send /accept` 等纯命令确认 | 飞书上打命令是最差交互;设计文档自己也说按钮更优 | **卡片按钮为主**(草稿卡[确认发送/取消]、收取卡[接收/拒绝],action_data 带包 id),命令保留为兜底且支持 id 前缀 |
| `/send`、`/accept` 取"find 到的第一份" | 多草稿/多来件时行为不可预测,卡片上的编号只是摆设 | 按钮天然带 id;**同收件人新草稿自动 supersede 旧稿**;真歧义时报错并列出候选编号 |
| 起草 90s 只回一行静态文本 | 盲等,用户会重发或以为挂了 | 诚实预期话术(1-2 分钟)+**每人同时仅一份起草任务**的防重;点按钮后原卡片即时替换为状态卡 |
| 「修改」在设计里有、实现缺失 | 确认权残缺:只能发或废,改一个词要重跑 90s 调查 | 新增 **/revise <意见>**:同一包 id 原地重写,携带旧稿上下文,可增量调查 |
| persona 参数存在但无人传 | "按老板偏好重组"是愿景核心却接了个空 | 新增 **/report-persona**,存 per-user setting,/accept 自动取用 |
| 状态 `pending_approval` 定义了从未用;取消被记成 `rejected` | 状态机撒谎,统计/排查无法区分 | 收敛为 `draft→delivered→received/rejected` + `cancelled` + `superseded` |
| 汇报卡后无追溯入口 | 卡片被聊天流冲走即失联 | 新增 **/reports** 总览;`/accept <id>` 对已接收包幂等重看(不再计费) |

### 8.2 执行层裁决

- **repair 轮丢上下文(严重)**: 原 runTurn 每轮新建 session,JSON 修复提示发给一个"什么都没见过"的新 agent,等于邀请它编造报告。改为 **runAgent lease**:一次任务一个 session,repair 在同一 session 内追问,结束销毁。
- **秘书 session 能力过宽(严重)**: 原实现继承全套全局插件+内建 delegate/project-creator(起草时理论上可建群、发委派),claude 路径还叠在 claude_code 编码预设上。改为 `focus()`:草稿/修订轮仅 sessions 插件,重组轮零插件,`usePreset=false`、`enableDelegate=false`。
- **调查边界失守**: 所有用户的秘书都扫 `/home/ubuntu`,且 sessions 工具的 `home`/`path` 参数可指向任意目录/文件。改为 config `secretary.scan_homes` 运维声明信任 + 工具删除 home 覆盖 + path realpath 越狱防护。
- **投递竞态(e2e 仿真抓到的真 bug)**: 先通知后落状态 → 老板手快点"接收"会撞上"没有待接收"。改为先落 `delivered` 再投递,失败回滚 `draft`。
- **临时 session 残留**: 秘书轮与 cross-user 一次性 session 标记 `ephemeral`,销毁即清;进程崩溃残留启动时清扫;cross-user file query 顺带修掉"从不 destroy"的泄漏。

### 8.3 验证

- 单测 138 项(原 124),覆盖上表全部新语义。
- **无飞书 e2e 仿真** `packages/bot/src/e2e/secretary-flow.e2e.test.ts`:真实 Store/Router/SessionManager + SimChannel + 脚本化 OpenAI mock,草稿轮真实 spawn sessions MCP 并断言工具往返内容;覆盖注册→/report→按钮发送→跨用户收取卡→按钮接收→重组→双向回执→/revise→/reject→/reports。
- 活体 demo(真 gpt-5.5): `node_modules/.bin/tsx scripts/demo-secretary-draft.ts` 现在跑全流程(调查起草→投递→老板侧按 persona 重组)。

### 8.4 已知边界(诚实清单)

- 收取卡的"🔕 以后不提醒此人"(ACL 免打扰)未做——等接 lby ACL 表。
- 汇报卡上的[追问/采纳/回复R]按钮未做(需要跨秘书会话通道,属 P3 语义层下一步)。
- 起草期间无实时进度卡(仅诚实话术+防重);可复用 agent-card 进度机制,列为后续。
- 单机 MVP:R/B 同实例;多机常驻 Runner 见路径分析 §5。

### 8.5 对抗复审补刀(同日,独立 agent 带复现脚本)

v2 落地后又跑了一轮对抗式复审(每个发现都写了复现),追修:
- **[高] /revise 盲写竞态**:修订轮跑 1-2 分钟,期间旧草稿卡仍可点「发送」;完成后整行 REPLACE 会把已 delivered/received 的包打回 draft 并抹掉重组。→ store 层 CAS(`UPDATE … WHERE status='draft'`),失手时明确报错。
- **[中] reformat 无条件落 received**:/send 失败回滚窗口内,飞行中的重组完成后会把已回滚的包直接改成 received。→ `updateReportPackageReformatted` CAS 化(`WHERE status='delivered'`),失手报"状态已变化"。
- **[中] /revise 多草稿死锁**:报错让用户"带上编号"但语法无处放。→ `/revise [编号] <意见>`。
- **[中低] /accept 前缀劫持**:旧 received 与新 delivered 前缀撞车时会静默重放旧报告。→ delivered 优先,received 重看仅在无待接收时;歧义列候选。
- **[低] ephemeral workdir 空目录堆积** → destroy/清扫时 rmdir(仅空目录,防误删产物);destroy 失败落日志。
- 卡片标题改码元安全截断(emoji 不再被劈成半个代理对);e2e 缺 dist 从静默 skip 改为显式失败。

复审同时**逐项验证通过**:guard 释放路径、sessions jail(realpath 前缀+无注入面)、makeRunAgent 无竞态捕获、秘书会话事件不外漏、卡片 JSON 全合规、cross-user destroy 修复。单测 142。

---

## 9. 多机形态:Runner + 显式 session 快照(2026-07-15 晚,与用户对齐后实现)

### 9.1 决策(用户提出,评估后采纳)

- **push(显式 copy)优于 pull(实时拉取)**,三个理由:①老板的阅读/追问是异步的,不能依赖汇报人笔记本在线;②session JSONL 是 append-only 的,汇报后还会增长——copy 在汇报时刻落盘,天然是**披露边界**(之后的工作永不泄漏),pull 反而要打补丁;③copy 模型下跨用户边界的只有"报告包+其引用的证据副本",老板永远摸不到笔记本。时序自洽:**写路径(copy)只发生在汇报人主动 /report 的时刻(笔记本必然在线),读路径永远在中心副本上**。
- **笔记本单进程**:Runner 吸收 反连/心跳/token + session 调查 + copy 执行,不另开进程。O(人数) 的运维负担必须最小化。
- **协议分层**:网络面(Runner↔中心)= 自家 WS 设备协议(register/ping/rpc),不是 MCP;agent 面保持 MCP 不变——sessions 插件加"远程模式"(env 切换),经 gateway loopback HTTP 转发到 Runner,**秘书 agent 与调查代码零改动**。

### 9.2 组件

| 组件 | 位置 | 职责 |
|------|------|------|
| Runner | `packages/runner`(常驻于用户笔记本) | WS 反连+每设备 token+心跳+指数退避重连;serve list/search/read/copy_session(复用 `@claude-bot/plugin-sessions/scan`) |
| RunnerGateway | `packages/bot/src/runner/gateway.ts` | WS 服务端(config `runner.port`);loopback HTTP(127.0.0.1 随机口+每次启动随机内部 token)给 sessions 插件子进程;多设备 list/search 合并(带 device 标签)、read/copy 逐设备首中 |
| 归档 | `packages/bot/src/runner/archive.ts` | `data/archive/<report_id>/` 镜像 scan-home 结构(`.claude/...`,`.codex/...`),rel_path 视为不可信输入(相对+归一化+根白名单+前缀校验);removeArchive/hasArchive |
| scan 层 | `plugins/sessions/src/scan.ts`(新抽) | 纯文件系统层,server(本地)/Runner/归档三方共用;`exportSessionFile` = copy 原语(25MB 上限) |
| 凭据 | migration v8 `runner_tokens` | (user,device) 唯一;库里只存 sha256;`/runner-token [设备]` 签发(同名重签即吊销旧token)、`revoke` 吊销;`/runners` 看在线状态与心跳 |

### 9.3 数据流(多机)

```
/report → 秘书 session(中心) → sessions MCP(远程模式,env: SESSIONS_REMOTE_*)
   → gateway loopback HTTP /rpc → WS RPC → 笔记本 Runner → 真实 ~/.claude ~/.codex
   → 结果回流 → LLM 起草 → evidence 定稿
→ 服务层按 evidence(kind=session 去重)发起 copy_session → 快照落 archive/<report_id>/
→ 草稿卡显示「发送时将随报告披露 N 个 session 快照(截至此刻)」← 显式披露确认
取消/替代/重订 → removeArchive;老板未来的【追问】读的是 archive(SESSIONS_HOME 指过去即可,零新代码)
```

调查目标三级决策(`investigationFor`):**在线 Runner(用户装 token 即自证机器归属)> config scan_homes / dev env > 用户托管 home(诚实为空)**。

### 9.4 验证

- 单测+集成 160 项:gateway(注册/假token拒绝/多设备合并/首中路由/loopback鉴权/超时/掉线清 pending)、archive(路径穿越四连拒)、scan(export/越狱/超大拒绝)、service(归档钩子/revise重建/取消清理/runner模式env)。
- **Runner e2e**(`e2e/runner-flow.e2e.test.ts`):真 WS + 真 runner core,bot 本地 scan_home 刻意置空——LLM 看到的 fixture 内容和落盘快照**只可能来自 Runner 链路**,同时证明 runner-first 优先级;含取消删归档与 /runners 在线显示。
- 待跑:真进程 smoke(本机 runner 连 dev bot)+ 飞书联调。

### 9.5 已知边界

- copy 未做 secret 脱敏(设计选择:先显式披露清单+按报告限权,脱敏 pass 列为后续)。
- 老板【追问】按钮未做(数据基础已就位:archive 目录即追问的 SESSIONS_HOME)。
- Runner 无自动升级/打包分发(手动 node dist;bot-ctl pack 类似物列为后续)。
- gateway WS 明文(生产应置于 TLS 反代后,或后续内建 wss)。

---

## 10. 汇报对齐群(2026-07-15 深夜,与用户对齐后实现)

### 10.1 决策(用户提出拉群设想,共同修订后落地)

- **群按 (R,B) 对复用**(用户拍板):一对用户一个长期「📋 A⇄B 汇报对齐」群,跨汇报复用、双向共用(normalizePair 字典序归一),避免临时群爆炸;"每轮干净上下文"在逻辑层解决(每轮一个新会议 session),不在物理群层解决。
- **双路径保留,auto 为调试默认**(config `secretary.group_delivery: auto|choice`,默认 choice):auto=收取卡直接进群(B 的确认权保留——仍需点【接收】);choice=私聊收取卡三按钮【🤝拉群对齐】【✅私下接收】【🚫拒绝】。私聊 /accept 在两种模式下都可用(老板的私密消费权)。
- **角色按空间划分,单头像靠卡片抬头消歧**:R 私聊=R 的秘书;B 私聊=B 的秘书;群内=第三角色「会议秘书」——语义上代表 B 整理信息(persona 生效),把 R 的发言当补充材料,答不了的显式请 R 补充(人肉兜底=LLM 系统的 escape hatch)。群内卡片抬头带「🤵 {B} 的秘书」。

### 10.2 机制

- migration v9 `report_rooms`(chat_id PK, 归一化 user_a/user_b UNIQUE, active_report_id/session_id=当前轮)。**群只是呈递场所,报告状态机零改动**。
- **会议秘书 = 绑定群 channel 的持久 session**(非 ephemeral,重启可续):owner=B、focus() 收权、`SESSIONS_HOME=data/archive/<report_id>/`——**披露快照在此兑现**:追问答案可引用原文,且只能看这份报告披露过的材料(目录即权限)。输出经现有 binding 广播回群(复用进度卡机制)。
- 群内消息**免 @**(feishu provider 注入 `isMentionExempt`=report_rooms 命中),带 `[username]` 前缀路由进会议 session;两位当事人都可发言。
- 群内接收 → `startAlignmentMeeting`(幂等);【✔ 本轮结束】/`/report-close` → 会议秘书按固定提示词出总结(结论/已拍板/遗留归属)→ session 销毁、房间归 idle;空闲群消息回引导语。
- 建群复用 workspace 管线(`createFeishuGroup` 泛化);发群卡片优先走活 channel,否则直连 API(chat_id);建群失败自动回退私聊收取卡,汇报永不卡死。

### 10.3 验证

- 163 测试全绿。新增 `e2e/room-flow.e2e.test.ts`:auto 投递进群(B 私聊零打扰)→ 群内接收(群版汇报卡带结束按钮+角色抬头)→ B 免 @ 追问 → 会议秘书真实读归档快照答疑(断言工具结果含归档路径与原文)→ R 补充([alice] 前缀进 LLM)→ 结束总结 → 房间 idle → 空闲提示。choice 模式三按钮在单机 e2e 断言。
- 待活体:真飞书建群/群卡片/免 @ 时序(联调清单 §PROGRESS)。

### 10.4 边界

- 一群同时只有一轮活动对齐(第二份 delivered 需先结束当前轮或私下接收;收取卡可正常进群排队展示)。
- 群成员变动(有人退群/加人)未做同步校验;飞书群解散后房间行残留(下次 ensureRoom 仍复用旧 chat_id 会发失败→回退私聊;/room 修复命令列为后续)。
- B 在群里的追问 R 全程可见——私密追问请走私聊 /accept 路径(设计使然,收取卡 note 已提示)。

---

## 11. 首轮真人联调修复 + 材料披露的自动/手动选择(2026-07-18)

### 11.1 联调抓到的四个问题与修复

| 问题(用户实测) | 根因 | 修复 |
|---|---|---|
| 群里接收后无法追问("没有活跃中的") | 卡片回调不带 chat_type,未知 channel 分支**硬编码建 P2P**,群按钮被路由成伪 p2p → 房间判定失败、会议秘书从未启动 | `resolveActionChannel` 纯函数:对齐群(room 表命中)强制 group 语义;含单测 |
| 员工也能点收取卡且卡片直接变"已接收" | 渠道层乐观替换无权限概念;业务层报错文案误导 | 按钮 action_data 注入 owner/owners(open_id),替换层不匹配不替换;业务层报"⛔ 只有 @x 能接收" |
| 群里收取卡预览太小 | 私聊版"最小信息量"设计被带进群 | 群版收取卡放开:完整摘要+要点(双方都在场,渐进披露约束不适用) |
| /report-persona 不生效 | 提示词约束弱;且已接收的报告无法重整理(CAS 只认 delivered) | persona 升为"最高优先级+输出前自查"硬约束;CAS 放宽至 received;新增 **/reformat [编号]** 按当前偏好重整理 |

### 11.2 evidence 机制澄清与去重

evidence **不是程序 grep 出来的**——是起草秘书(LLM)调查时自行引用的(ref+原文摘录),`validateSubmittedContent` 只做防御性截断。新增:**同一 ref 最多保留 2 条**(validate 硬截断+提示词约束),防同源刷屏。

### 11.3 材料披露:自动 + 手动(用户需求)

- **自动**:evidence 里 kind=session 的 ref 照旧归档;kind=file 且 ref 为绝对路径的**文件也纳入归档**(提示词告知秘书可引用关键产出文件)。
- **手动钦点**:`/sessions [n]` 列出可调查会话(Runner/本地同源);`/report`、`/revise` 文本里 `#<会话id前缀>` 钦点必查会话、`#file:/绝对路径` 钦点披露文件——**钦点即披露**(即使 LLM 未引用),提示词同时注入"必须纳入 evidence"。
- **文件披露的安全边界**:`exportPlainFile` jail 在 scan home 内(realpath),黑名单目录(.ssh/.gnupg/.aws/.kube/.claude/.codex/.config)与凭据文件名(auth.json/credentials/id_rsa/.env* 等),单文件 ≤2MB、每报告 ≤12 个;Runner 新增 copy_file RPC 同 jail。
- **归档布局**:`archive/<report_id>/files/<home相对路径>`;会议秘书新增 `list_report_files`/`read_report_file` 工具(仅 env SESSIONS_FILES_DIR 设置时暴露,jail 到该目录)——老板追问文件内容同样只能看这份报告披露过的材料。
- 草稿卡披露清单同时列 session 数与文件数;取消/替代/重订仍整体清档。

验证:170 测试全绿;room e2e 新增文件链路(#file 钦点→归档 files/ 落盘→会议秘书 read_report_file 真往返)。


### 11.4 调查动线重构:通读优先(2026-07-18 下午,用户观察 search 泛滥后)

用户实测发现起草秘书大量 `search_sessions("修复")` 式猜词调查——根因是工具面信息密度:list 每会话只给两句 120 字预览,无法判断相关性,逐个 read 又贵,模型只好赌关键词(recall 完全看运气)。修复采纳用户方案:

- 新工具 **digest_recent_sessions**:一次返回最近 N(默认8) 个会话的**对话骨架**——只保留用户提问与 agent 自然语言回复(工具调用/结果/思考全滤掉),每会话取开头 2 条(任务定义)+最近若干条(结论),每条截断 160 字。秘书从"猜词搜索"变为"通读锁定"。
- **read_session 增加 tool_detail 参数**:默认只有工具名;true 时附带输入参数摘要(截断 160 字)——工具细节按需深挖,不默认膨胀。
- 提示词动线改为:**digest 通读 → read 细读 → search 仅查特定关键词(文件名/报错),明示"不要靠猜搜索词发现工作内容"**。
- 三层(MCP server/Runner RPC/gateway 多设备合并)同步支持;会议秘书对归档同样可 digest。

172 测试全绿(digest 骨架/头尾保留/截断/无工具行 + tool_detail 单测)。

---

## 12. 全卡片化交互 + 一体化会议秘书(2026-07-18 下午,用户两项要求)

### 12.1 全卡片化(不再要求用户记命令语法)

- **裸 `/report` → 发起汇报向导卡**(一张卡完成全部选择):联系人 checker(勾一人)、预取的最近 5 个会话 checker(多选钦点)、"🤖 允许秘书自行调查更多"开关(默认开;关=exclusive,提示词禁止扩展调查)、诉求输入框、【🚀 开始起草】提交。带参数的 /report 命令与 #钦点语法保留为快捷路径。
- **草稿卡内嵌修改表单**:反馈输入框+【✏️ 按意见修改】与【确认发送/取消】同卡,revise 不再需要打命令。
- 新按钮回调:report_wizard_submit / report_revise_submit(含即时替换卡)。

### 12.2 一体化会议秘书(用户对"整理和答疑是两个 agent"的修正)

群内接收重构为**同一个 agent 从头到尾**:先创建会议 session(挂归档+persona 系统提示词),整理稿作为它的**第一轮**产出(此时未绑定群,JSON 不外漏),解析落库、发出汇报卡后才把这个 session 绑进群答疑——于是**完整原始报告包、persona、它自己的整理过程都留在同一份对话历史里**,追问的上下文天然连续。service 层新增 `acceptDeliveredViaTurn`(状态机/防重/解析仍归 service,session 生命周期归 Router)。私聊接收保持原一次性重组(无后续对话场景)。

### 12.3 persona 群内自助修改("毕竟只是一个 md")

会议系统提示词加协议:老板在群里要求改风格时,秘书立即照办并在回复末行输出 `PERSONA_UPDATE: <合并后的完整偏好>`;Router 捕获会议 session 的 result 中该行→写入 settings→群内发「✒ 呈现偏好已更新」确认卡。之后所有汇报(含 /reformat)都按新偏好。

验证:173 测试全绿;room e2e 覆盖 向导卡→exclusive 钦点起草→卡内 revise、统一 agent 存活、群内说一句话改 persona 落库+确认卡。

### 12.4 实时进度 + 发送方风格 + 原生人员选择器(2026-07-18 晚,用户三条反馈)

- **秘书不再静默**:runAgent lease 新增 progress 通道——起草/修订/私聊整理的 tool_start/tool_result/text/result 事件实时转发到发起 chat,复用现有 agent 进度卡机制(标题如「🔍 秘书调查起草中」,工具调用逐条可见);群内整理轮同样把工具活动投进群。
- **发送方风格可指定**:此前草稿风格无处设置(纯提示词默认+模型天性,故显絮叨)。新增 `/report-style`(per-user `draft_style` 设置),注入起草/修订系统提示词为最高优先约束;同时默认风格收紧为"凝练直接、summary 3-5 句、要点一行、宁少勿滥"。与收方 `/report-persona` 对称:style 管"我发出去的草稿",persona 管"我收到的整理"。
- **向导卡人员选择**:checker 换飞书原生 `select_person`(搜索/头像/姓名渲染),候选=有飞书身份的注册用户;提交按 open_id 经身份表反查,未注册引导先注册。提交后替换卡回显所选(诉求/钦点数/auto)为只读文本。注:select_person 真机渲染待联调确认,命令路径兜底。

---

## 13. 收集者/撰写者分工(2026-07-18 晚,用户的语义修正)

**发送方秘书不再写汇报**。用户的洞察:发送方产出成品文案(summary/要点/判断)会**锚定**接收方的重组——发送方絮叨,接收方也被带着絮叨。修正后的分工:

- **发送方 = 忠实的材料收集员**:调查、选材、摘录原文,产出**材料包** = topic + evidence(覆盖面优先,同源≤3条) + reporter_note(汇报人自己说过的立场,原话转记,秘书不发挥)。校验层**主动丢弃** LLM 越界写的 summary/key_points/decisions——发送方文风从物理上无法泄漏给接收方。
- **接收方 = 从零撰写者**:基于材料包(摘录为索引+**归档快照全文**,重组轮现在也挂 sessions 工具)+ persona,自己归纳结论、提炼要点、**识别待拍板事项**(decisions 归接收方写,ReformattedView 新增该字段)。写作纪律:结论须可追溯到材料 ref。
- 卡片随之改:草稿卡=「汇报材料包」确认卡(主题/诉求原话/材料清单展开,无成品文案);收取卡预览=主题+诉求+材料规模;汇报卡全文=接收方撰写稿,折叠区改名"原始诉求"。/revise 语义=调整材料范围。
- **/report-style 移除**(发送方不写文案,风格失去对象);成品风格唯一控制点=接收方 /report-persona。
- fallback 变化:整理失败时无发送方 summary 可回退,改为诚实的材料清单卡。

173 测试全绿(validate 断言"越界文案被丢弃"、fallback 材料清单、卡片/e2e 全量适配)。
