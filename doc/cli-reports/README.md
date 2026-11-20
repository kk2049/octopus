# CLI 开发简报

注册过原生 Codex 或 Claude Code CLI 的工作树须在 v3 简报中填 `native_ticket_id`，其值由 `scripts/ops/development.sh register` 返回；落地会更新原工单及完整会话。未注册的 CLI 省略此字段。简报仍必须是实现提交之后的独立最终提交。

在线工单开发天然有工单、agent 会话和部署状态；从终端直接创建 feature
branch 的开发没有。为让两条开发通道在 `/tickets` 汇合，每次通过
`scripts/ops/land.sh` 落地的 CLI/human-lane 分支，最后一个 commit 必须新增
一份简报：

```text
doc/cli-reports/YYYY-MM-DD-<lowercase-slug>.json
```

简报也不是 CLI 任务的交付终点：默认完成点是 `land.sh` 成功、只读工单进入
`landed/pending`，并且所有受影响 Agentic App 都在开发后端显示为待发布；只提交
功能分支不算完成。何时继续部署以 `AGENTS.md`「Change and delivery discipline」为准。

基本字段示例（`specifications` 与检索 receipt 都是可选记录，没有也能落地）：

```json
{
  "$schema": "./schema.json",
  "version": 3,
  "base_sha": "0123456789abcdef0123456789abcdef01234567",
  "title": "工单列表显示 CLI 交付",
  "summary": "CLI 分支落地后自动出现一条只读工单，并进入统一部署状态机。",
  "requester": "lht",
  "requirements": ["CLI 与在线工单进入同一部署和验收状态机"],
  "decisions": ["以最后一个 commit 内的不可变 JSON 简报作为 Git 恢复源"],
  "non_goals": ["不把 CLI 开发伪装成不存在的 agent 会话"],
  "risks": ["base_sha 变化时必须 rebase 并 amend 最后一个简报 commit"],
  "supersedes": [],
  "retrieval": { "traces": [], "context_keys": [], "feedback": [{ "code": "not_run" }] },
  "verification": [
    "npx vitest run --project node --maxWorkers=1 packages/bot/src/devpipe：通过"
  ],
  "acceptance": [
    "工单页能看到带 CLI 标记的简报条目",
    "部署后条目从待上线进入上线待验证，并可统一判定"
  ]
}
```

字段语义：

- `base_sha`：分支最终 rebase 所基于的完整本地 `v4` SHA；landing door 要求它与落地前水位一致，崩溃恢复据此重建精确范围。
- `summary`：已经得到的结果，不写开发过程。
- `requirements` / `decisions`：本次必须保持的需求与实际作出的设计选择。
- `specifications`：可选的结构化记录（#522「目前只要求记录」）。不写就省略整个字段（不要写空数组）；可以只覆盖部分 requirements/decisions。写了的条目仍须完整：kind、原样 statement、strength、provenance（author/basis/events）、realized_by 与 verified_by，路径必须是候选提交里的具体文件，verified_by 必须为测试（会在落地门中执行），空 verified_by 须有 verification_note。来源与强度以 `packages/bot/src/knowledge/specifications.ts` 为准；Agent 对用户话语的归纳标记为 agent_inferred，离线 CLI 通道不能附带无法核实的人类证据事件。
- `non_goals` / `risks`：明确没做什么，以及后续改动必须留意什么；没有时写空数组。
- `supersedes`：本次明确取代的知识记录 id（`pnpm knowledge:context -- <paths>` 或 `/knowledge` 页每条语句末尾的 `⟨id⟩`，或
  `ticket:<n>`）；没有时写空数组，不能用模糊文字冒充取代关系。
- `retrieval`：可选的检索记录，但字段本身保留——没运行检索就写示例里的 `not_run` 占位（部署在本改动之前的服务端解析
  v3 简报时仍要求这个字段）。`traces` 可列 `pnpm knowledge:context` 输出的 trace id 与 receipt SHA-256（最多 8 条），
  `context_keys` 列实际引用的稳定记录 id（最多 50 条），`feedback` 只接受有界反馈码；有 trace 时不写 `not_run`。
  receipt 文件位于 Git common dir 下 `octopus/knowledge-retrieval/`（mode 0600，七日过期，不进 Git），由服务端在能读到时导入；
  缺失、过期、未覆盖改动路径或校验不符都只记为 missing/invalid 状态，从不阻止落地，也不会触发重放检索。
- `requester`：已注册的 Dashboard 用户；其成为生产验收人之一。
- `verification`：开发侧实际执行的检查及结果；没运行时必须如实写原因。
- `acceptance`：上线后人能观察和判定的事项，会进入聚合生产验收清单。

落地门验证 JSON 形状、长度、唯一性、位置与 `base_sha`，并执行已写规格的 verified_by 测试和改动路径上现行架构约束的
证据测试；规格与检索 receipt 缺失或不完整都不会拒绝落地。分支最后一个 commit 必须只新增这一份简报；实现树是它的父
commit，也是 receipt 绑定的精确 `repo_sha`。既有 v1/v2 简报继续用于历史对账，但新落地必须写 v3；既有简报不可修改/删除，
一次落地不可复用或夹带多份简报。receipt 只能被一个 landing 原子导入并消费；同一 landing 的崩溃重试幂等，不同 landing
的重放为 invalid。
成功后服务把简报投影成 `kind=cli` 的只读工单，状态从「已合入·待上线」开始；landing door
同时按完整 diff 记录 App 发布债务。部署页把两者放在同一次操作里，部署、回滚、
上线待验证与聚合验收全部复用普通工单的状态机。

GitLab 原生落地及崩溃恢复也按 v2/v3 简报的精确 `base_sha...report_commit` diff 补齐 App 和 Runner 待发布项。工单、待发布项和按提交记录的投影标记在同一事务中写入；发布清空待办后，重复对账不会重建它们。已有较新的 App 待办不会被旧简报覆盖，同一待办的失败回执也不会因重试被清空。升级时保留旧工单的验收结论；已 `verified` 的旧简报仅补标记，不重新要求发布。未验收且缺少投影记录的 v2/v3 简报保守补齐缺失债务，v1 因没有精确 base 不推测变更范围。登记债务本身不激活 App 或 Runner。

追踪从不保存查询、工单正文、会话、引用原文、凭据或错误堆栈，只保存进程专用 HMAC、字符数、稳定 id、有界代码、分数和不可变索引绑定。
普通成功的详细证据保留 30 天；缺失、错误或显式反馈在 30 天后去掉候选等明细并以紧凑证据保留到 90 天；总量上限为 10,000 条。
Dashboard 的检索审阅沿用知识页的 Contribute 权限，只提供逐条脱敏审计，不提供查询回显、原文钻取或人员分析。

在线工单通过 `devpipe_submit` 落地时已有工单记录，不创建这份简报；
`doc/cli-reports/` 也属于该通道的保护路径。紧急 `scripts/ops/land.sh --no-lock --expected-sha … --reason …`
仍要求简报，新进程启动后会从 Git 对账并补建缺失条目。
