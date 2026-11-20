# 策展知识文件（`architecture/knowledge/`）

这里是开发知识图谱（`packages/bot/src/knowledge`）的**有来源的权威输入（入 Git 不代表经过人审）**，和
`architecture/atlas.json`、`architecture/capabilities.json` 同级。构建器把它们与
规则、ADR、包级文档、交付记录、CLI 简报和 `ticket_landings` 一起投影成可重建的
`graph.db`。任何只存在于数据库里的事实都是放错了层；要让图"记住"一件事，就
把它写进这里并经 Git 审阅。

| 文件 | 内容 | 谁写 |
|---|---|---|
| `patterns.jsonl` | 复发模式：一簇同类工单的归纳，说明下次必须捕获哪些事实 | 人，或 agent 提案后人审 |
| `curated/<batch>.jsonl` | 历史回填：从工单正文、消息、交付记录抽出的原子需求 / 决策 / 非目标 / 风险 / 原则 | 回填 agent 按本文合同产出，人抽检 |
| `contracts/<id>.md` | 能力合同：原则、义务、场景、例外、规范矩阵和稀疏代码实现选择器 | 人审；结构块由构建器严格投影 |

`patterns` 和 `curated` 是 JSON Lines；能力合同是同一份 Markdown 内的说明文字与**唯一一个**
`octopus-contract` 严格 JSON fenced block。`pnpm knowledge:validate` 校验这些权威源；
校验失败会让 `knowledge:build` 失败，因此**提交前必须通过校验**。

## 能力合同（`contracts/*.md`）

能力合同是跨 provider、跨工单仍需成立的规范，不是某次落地总结。文件 frontmatter 固定为：

```yaml
schema: octopus-capability-contract/v1
id: agent-loop-parity
title: Agent session loop parity
status: active
capabilities: [sessions-plus.agent-lifecycle]
effective_from: 2026-08-23
supersedes: []
reaffirms: []
```

正文给人审阅；只有 frontmatter 和恰好一个 ```` ```octopus-contract ```` JSON block 具有机器语义。
结构块是 closed schema：未知字段、重复局部 key、越界维度、悬空引用、仓库外路径、隐私内容、
生命周期错误和超长原子文本一律拒绝。它包含：

- closed `providers / launch_modes / states / actions` 维度；
- 只有指针和可选短引文的 `sources`，绝不含工单正文、transcript、凭据或私有绝对路径；
- contract-local `principles / obligations / scenarios / exceptions`，局部 key 决定稳定 id；
- `desired` 规范单元；数组维度由投影器确定性展开成显式 tuple；
- repo-relative `artifacts` 和有来源的 `realizations`；不从“同一次落地改过”猜实现关系。

稳定 id 是 `capability_contract:<contract>`、`obligation:<contract>/<key>`、
`scenario:<contract>/<key>`、`exception:<contract>/<key>`、
`desired_conformance:<contract>/<cell>`、`observed_conformance:<contract>/<cell>`、
`source:<canonical-coordinate>` 与 `artifact:<repo>/<kind>/<key>`。合同中的原则也使用
`principle:<contract>/<key>`；它们不参加全局 statement 折叠。

每个 `required` 单元必须有场景、义务和来源。`degraded / unsupported` 必须指向当前、
有到期日且精确命中该单元的 waiver；`not_applicable` 必须指向带来源和复核日的
not-applicable exception。例外不改变规范单元本身，只解释观察结果。

`graph.db` schema v2 的 `contract_cells`、`conformance_observations` 和
`conformance_artifacts` 都是可重建投影。只有 `repo_sha === code_index_sha === verified_sha`
且所声明 action/test 选择器全部精确解析时，观察值才可为 `conformant`；缺索引为
`unverified`，SHA 不同为 `stale`，两者都不产生精确 symbol/test 证据。旧 schema v1
不会原地迁移：reader 拒绝它，owner 从上述权威源重建 v2。

## 回填记录合同（`curated/*.jsonl`）

```jsonc
{
  "id": "cur:b03:256:1",                 // cur:<batch>:<ticket>:<n>；无工单时 cur:<batch>:<n>
  "kind": "decision",                    // requirement | decision | non_goal | risk | principle
  "statement": "手机端从 chat 点导航必须回到导航面板，文件面板不得抢占路由。",  // ≤ 400 字符，单行，一条陈述
  "ticket": 256,
  "source": {"type": "ticket_message", "ref": "ticket:256", "message_id": 1102},
  "capabilities": ["sessions-plus.mobile"],          // 必须是 capabilities.json 里的 id
  "modules": ["session-plus-view"],                  // 可选；必须是 atlas 模块 id
  "paths": ["packages/session-plus-view/src/App.tsx"], // 可选；必须存在于 HEAD
  "status": "active",                    // active | superseded | rejected | historical
  "supersedes": ["cur:b03:189:2"],       // 可选；被本条取代的记录
  "superseded_by": "cur:b05:274:1",      // status=superseded 时必填
  "certainty": "exact",                  // exact | inferred | ambiguous
  "rationale": "用户在 #256 正文明确要求；#274 落地后仍成立。",  // ≤ 200 字符，说明依据
  "quote": "从 chat 页面点导航，没有跳转到导航，而是跳转到了文件",  // 可选，≤ 120 字符原话
  "conflict_note": "…"                   // certainty=ambiguous 时必填，≤ 300 字符
}
```

`source.type`：`ticket_body` | `ticket_message`（需 `message_id`）| `delivery` | `commit` |
`cli_report` | `package_doc` | `adr`。`ref` 是 `ticket:<id>`、文件路径或 commit。

### 四类陈述怎么写

- **requirement**：用户想要什么（复述用户意图，现在时，不写实现）。
- **decision**：最终选了什么、为什么；"为什么"放 `rationale`，拒绝的替代方案单独一条
  `decision` + `status: rejected`。
- **non_goal**：明确不做 / 不得出现的事。
- **risk**：后续改动必须留意的事。
- **principle**：只在用户或 agent 明确提出**跨工单**的通用规则时使用；单票的取舍是 decision。

一条记录只陈述一件事；叙事、过程、测试结果不是知识。

## 去重与冲突消解规则（回填 agent 和构建器共同遵守）

R1 **证据优先，不能用时间冒充授权**：较新的 Agent 实现或总结不能自动取代用户原始要求。先调查两边动机；Agent 判断的轻微修订可由 Agent 记录理由并提交，只有用户原始／强制要求冲突需要上线前管理员裁决。
R2 **规格与实现分别记录**：代码或包级文档与旧要求不一致时，记录实现偏差和冲突，不能仅因代码变了就把人类要求改为历史。单次任务的“本轮没有修改 X”属于历史范围记录，不是长期非目标。
R3 **取消 / 放弃**：工单被取消，或后续消息明确"不做"，标 `rejected` 并引用依据。
R4 **先复用再新增**：dossier 里列出了该工单能力范围内已有的语句（来自包级文档、ADR、
   落地台账、其他批次）。同义语句不要重写；需要表达取代关系时引用其 id。构建器按
   归一化文本折叠完全相同的陈述，但语义重复只能靠你避免。
R5 **不确定就标 ambiguous**：填 `conflict_note` 说明两种读法，不要替用户裁决。
   构建器会把它列入冲突候选交给人。
R6 **粒度与证据**：≤ 400 字符、单行、**一条陈述只说一件事**——用"并且 / 以及 / 同时 / 顿号"
   串起多个动作或对象的要拆成多条；statement 必须能由引用的证据直接支持，证据没有的数字、名称、
   原因不要补，需要概括或推断就把 `certainty` 设为 `inferred` 并在 `rationale` 写明依据；
   `quote` ≤ 120 字符。kind 的判定：用户提出的要求（含验收项、流程要求、持续性安全要求）→
   requirement；讨论中选定的做法 → decision；"不做 / 不得" → non_goal；"以后改动要小心" → risk。
   （2026-08-21 首轮回填的独立抽检里，这三类是最常见的扣分项。）
   **机械保证**：`certainty: exact` 的记录必须带 `quote`，且 `pnpm knowledge:validate -- --evidence <dossier-dir>`
   会逐字核对 `quote` 出现在所引用的工单正文 / 消息 / 文件里；statement 的含义不得超出 quote。
   找不到原话就降级为 `inferred`（rationale 写明推断依据）或删除。
R7 **范围**：只处理批次文件里的工单；CI 修复票不回填；`kind=cli` 工单的 v2 简报字段已被
   自动解析，只补简报没有写到的东西。
R8 **隐私**：不写 token、密码、私钥、个人信息、transcript 内容；引用只用 `quote`。
R9 **只用存在的词汇**：能力 id、模块 id、路径必须真实存在（校验器检查）。
R10 **id 稳定**：同一批次内 `n` 递增，重跑时不要改已有记录的 id。

## 复发模式合同（`patterns.jsonl`）

```jsonc
{"id": "file-affordance-not-open-pipeline", "title": "可见文件链接不等于端到端可打开或预览",
 "detail": "≤ 400 字符的说明", "capabilities": ["sessions-plus.files"], "tickets": [201, 243, 256],
 "modules": ["agent-sessions-view"], "paths": ["packages/agent-sessions-view/src/lib/file-link.ts"],
 "tests": ["packages/agent-sessions-view/src/lib/file-link.test.ts"],
 "mandatory_facts": ["clicked href", "opaque ref 与 runner"], "false_positive": "…", "confidence": 0.98}
```

模式至少引用两张工单。它只进入启动包作为"必须捕获的事实"提示；`tests` 缺失或改名只会在
构建报告里出现，**不会**阻断落地。

## 回填与复核流程（2026-08-21 起）

1. `tsx packages/bot/src/knowledge/backfill/export-dossiers.ts` 把工单正文、消息、commit、交付记录、
   已有语句整理成每能力一批的 dossier（输出在仓库外，含正文）。
2. `run-backfill.ts` 为每批启动一个无头 agent，按本文合同写 `curated/<batch>.jsonl` 并跑校验。
3. `judge-backfill.ts` 抽样 20% 记录，把每条和它引用的证据一起交给独立 agent 打分
   （supported / atomic / kind / status / capability / privacy）。
4. `run-backfill.ts --repair <judge.json>` 把抽检意见回喂给 agent，按规则复核整个文件：拆分、
   降级为 inferred、删除无依据记录、修正 kind/status。
5. `run-backfill.ts --repair-evidence <judge.json> --evidence <dossier-dir>`：为每条 exact 记录补逐字
   `quote`，校验器强制核对；这是唯一不依赖 LLM 判断的"证据支持"保证。
6. 再次抽检（`--seed` 换样本）；低于门槛（supported < 0.8）的批次删除重做，而不是保留。
7. 构建图并看 `knowledge:report` 的冲突候选与 coverage；用 `architecture/knowledge/journeys.md`
   的固定 actor journeys 对比词法基线与激活后的混合检索。

## 精确代码与向量产物

代码索引和向量索引都是派生缓存，不是权威知识。发布链先在 AWS 从当前图导出
`octopus-contextual-record-input/v1`：只含稳定 id、kind、短 statement、规范化来源坐标、
生命周期、authority/certainty、能力/模块/路径和有界合同选择器；明确不含 SQLite、
工单正文、消息、transcript、凭据、私有绝对路径或任意 metadata。

val15 Runner 只接受配置 origin 上一次性 HTTPS 输入，按精确 Git SHA 在隔离 checkout
构建 SCIP/Vitest case 索引、固定 revision 的本地 embedding 和 conformance manifest。
每个成员、总字节、清单、模型身份、输入 SHA、record-set digest 和 repo SHA 都有固定
上限或完整性绑定。AWS 拉回后用代码索引重新解析合同，只有解析后的 record-set 与
vector manifest 一致才原子切换本地 generation。查询永远读 AWS 本地 immutable
generation；val15 断线只延迟刷新，不触发 SSH 或网络查询回退。

## 验证与构建

```bash
pnpm knowledge:validate                                  # 校验 curated/*.jsonl（工作树）
pnpm knowledge:build -- --at WORKTREE --out /tmp/graph.db --bot-db <bot.db>
pnpm knowledge:report -- --graph /tmp/graph.db           # 冲突候选与覆盖缺口
```

## 三档证据与归因（#522，现行）

`authority` 只说明来源类别与检索排序；`certainty=exact` 只说明抽取能找到引文。
两者都不证明有人背书。`provenance` 分别记录 `author`（kind/name/model/ref/at）、
`basis` 原始依据和 append-only `events`。历史模型未知必须写 null，不能从当前工单模型倒推。
每条人类证据事件记录 kind、actor、at、ref、source_kind、source_sha256、quote（≤120 字）与 design（本人明确指代的设计原话）。

- `agent_inferred`：默认。包括未经核实的人类归因、Agent 提案和落地简报；“好的”“收到”“你看看”不升级。
- `human_reviewed`：本人在可核实的消息里明确指代设计并表达支持。提问和审阅事件单独保存，运行时不会把普通对话自动升级成背书。
- `human_required`：可核实的原始用户 prompt 中直接给出的设计，或人类明确说必须／不得的要求。新背书必须通过落地门核对原始消息作者、角色、时间、全文哈希和短引文；来源不可用则不升级。

不得批量按 requester、文件“已审阅”字样、后来的实现或 agent model 字段升级历史记录。
旧回填此次保留为最弱档；经逐条原话核实的知识系统规格另列在 `curated/k522.jsonl`。
`provenance.critical` 说明为何需要真人审阅，并引导人复述具体设计、接受的行为与代价。
`realized_by` 只列实现文件，`verified_by` 只列测试文件；不可把一次提交的所有路径都挂到每条规格上。

## 开发、裁决与外部 MCP 管线

知识库目前只要求记录（#522）。工单可按路径调用 `devpipe_context` 读取相关原则、约束和历史决策，
提交后写入知识、生产模型和引用记录；检索是参考，不是落地门槛，没有覆盖改动路径也不会被拒绝。
向量缺失不影响本地路径/词法检索。
CLI / MCP 外部开发 Agent 可显式授权 `knowledge_context` 和 `knowledge_annotate` 工具组，
先查相关规格、冲突及批注；CLI 可用 `pnpm knowledge:context -- <paths>` 生成工作树检索回执并在 v3 简报引用，
也可以写 `not_run`；回执缺失或无效只记为遥测状态。新增工具权限须每个用户分别同意；旧 token 的工具组不会被拓宽。

设计修改在 submit 的 `knowledge.changes` 或 CLI v3 简报 `changes` 中记录：
`record_id`、`original_motivation`、`proposed_motivation`、`proposed_behavior`、`alternatives`、`impact`、`verification`。
任何 supersedes 都要配完整调查，低档冲突可由 Agent 调整并留下提示。第三档可先实现和落地，
但部署和 App 激活前必须有管理员在真实浏览器会话中对当前指纹的明确审阅。
普通关闭、确认冲突、旧版本批准和 Agent 批注都不能消除上线义务。删除/降级原要求也会生成裁决候选。

知识 Chat 独立于开发工单；裁决页可打开常驻 Sessions+，选择运行环境和模型，并将可见的冲突资料放入新会话草稿。
用户提问的 actor/time/subject 记录在审阅台账，个人对话正文仍只按原有个人权限访问。
Git 来源是规格权威，运行时 append-only 裁决候选与审阅台账是审批证据，graph.db 仍可删除重建。

冲突调查通过 `knowledge_investigate` 提交七个有界字段，并绑定当前双方原文。
`knowledge_annotate` 保存自由批注；批注不替代调查，也不构成背书。管理员批准前
必须有完整调查，修改调查会改变审阅指纹。旧冲突也可补交调查后再处理。
人类证据必须覆盖整条命名设计；在已背书短句后拼接 Agent 推断，不继承强证据。

### 落地规格完整性（#522 续轮）

工单 `knowledge.specifications` 与 CLI v3 简报 `specifications` 使用同一契约，二者都是可选记录：
可以不写，也可以只为部分 `requirements` / `decisions` 写同 kind/statement 的规格，落地不会因此被拒绝。
写了的条目按下述契约校验，不得以摘要里的 `human_required` 字样代替证据。

```json
{
  "kind": "decision",
  "statement": "冲突队列长文本在侧栏内换行，不覆盖正文和 Agent 栏。",
  "strength": "agent_inferred",
  "provenance": {
    "author": { "kind": "agent", "name": "开发 Agent", "model": null, "ref": "ticket:522" },
    "basis": ["ticket:522#message:3037"],
    "events": []
  },
  "realized_by": ["packages/dashboard-web/src/pages/KnowledgePage.module.css"],
  "verified_by": ["packages/dashboard-web/src/pages/KnowledgePage.layout.test.ts"]
}
```

强度由整条设计的原始证据计算，声明必须一致；人类归因不能缺少该证据。
`devpipe_context` 附带本票原始 prompt 与最近八条人类消息的 ref、actor、at、
source_kind、source_sha256；Agent 从已收到的原文摘取 quote/design，不必读取运行时数据库。
该身份清单不输出对话正文、不涵盖其他工单、不把 Agent 消息列为人类，也不自动背书。
两道落地入口在本机核对 Store 原始消息作者、时间、角色、全文 SHA-256 和短引文，
原文不传往 CI。映射必须指向候选 Git 树里的普通文件，目录、缺失文件和符号链接均拒绝。
每条规格要么列出测试文件（落地门会执行），要么保留空 `verified_by` 并以
20–400 字 `verification_note` 说明原因，不新增无意义测试。
规格随不可变 landing payload 保存，图重建时逐条产生实现、测试、路径和模块关系；
不将整次提交的全部文件挂到所有规格。工单 Agent 模型取服务端 producer，CLI 未核实时为 null。

`curated/k522-followup.jsonl` 补录 #529/#520 的两条原始用户设计及八条实现决策/约束，
后者保持 Agent 档；#520 的后续反馈作为独立历史事件保存，不算新背书。
已经落地的旧摘要不改写，补录通过 Git 记录并保留来源与取代关系。
这组机械检查证明记录完整和文件存在，不证明任意自然语言与代码在语义上完全一致。

Sessions+ 新建会话的活跃执行凭证允许请求知识工具组，但仍交集检查用户单独授予的
MCP 知识操作。没有该授权、旧凭证不含该组或会话已结束时均拒绝；不会扩大工作区范围。

## 内容迭代与来源覆盖

纠错批次、激活回放、工单来源草稿和本人 CLI 确认见 [内容纠错与来源回流](./iteration.md)。内容修复队列与管理员设计裁决相互独立。
