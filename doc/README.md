# Octopus 文档按需入口

这里是人和 agent 的按需入口，不由 `CLAUDE.md` 自动导入。先选择与任务匹配的最小路径，不要把 `doc/` 当作开始编码前的必读目录。

## 时效词汇

- **现行**：描述当前系统行为或当前操作方式，可以照着执行；若文档与代码或路径作用域内的 `.claude/rules/` 冲突，以后两者为准。
- **历史**：记录当时的决策、验证或交接，不要照着执行；只在追溯“为什么长成这样”时读取。

本仓库只使用这两档。没有状态标记的非顶层旧文档不能据此推定为现行，先从本页、最近的包级文档或 `.claude/rules/` 找入口。

## 最小任务路径

- 前端与 Agentic App 迭代：先读现有界面、用户已确认的交互和对应包文档；保留已有设计语言与交互模型，按明确需求修改。
- 分支、worktree、落地与远端同步：读 `doc/runbooks/development-workflow.md`。
- 重构级 CLI 开发的独立完整灰度、真实 Agent 验收与整体晋级：读 `doc/runbooks/refactor-staging.md`。
- 定向测试、完整测试与 post-submit CI：读 `doc/runbooks/testing.md`；CI 失败处置读 `doc/runbooks/ci-triage.md`。
- 前端真实点击、输入、截图及 CLI/工单共用浏览器：读 `doc/runbooks/browser-acceptance.md`；部署耗时分析与改进顺序读 `doc/runbooks/release-latency.md`。
- 部署、确认、重启与回滚：读 `doc/runbooks/deployment.md`。
- 收敛生产 Dashboard、Runner、DSH 与 Personal Mesh 的公网边界：读
  `doc/runbooks/production-network-boundary.md`。
- 发布 Agentic App 或处理待发布记录：读 `doc/runbooks/app-release.md`。
- 给没有飞书的新同学开号、接入他自己的开发容器、审批贡献者的合并提案：读
  `doc/runbooks/contributor-onboarding.md`。
- 修改 Dashboard 浏览器或服务端：先读 `.claude/rules/dashboard.md`、`.claude/rules/frontend-stability.md` 和最近的包级文档。
- 配置本机 Codex、Claude、OMP 经 Runner 操作同账号其他端点：读 `doc/runner-local-agent-bridge.md`。
- 查看每个 Runner 的内建/扩展能力，或不停机登记本机 MCP provider：读 `doc/runner-capabilities.md`。
- 通过 Octopus MCP 在 Runner 之间复制大文件：读 `doc/runner-file-transfer.md`。
- 安装、启停、升级、卸载 Runner 或登记 workspace：读 `doc/runbooks/runner-installation.md`。
- 给朋友打包 Windows 访客客户端（Claude 以所有者本人在主机上运行，守卫 hook 限定目录，经终端窗口操作朋友的电脑）：读 `doc/runbooks/guest-client.md`。
- 共享工单的执行隔离、沙箱容器与拆分 home 不带指令：读 `doc/runbooks/shared-ticket-sandbox.md`。
- 修改 Agentic App/View：先读 `.claude/rules/agentic-app.md`；涉及 typed port 或可信资源时再读 `.claude/rules/resource-bindings.md`。
- 修改飞书通道或卡片：先读 `.claude/rules/feishu.md`。
- 修改 CRDT 或协作语义：先读 `.claude/rules/crdt.md`。
- 查当前架构裁决：读 `doc/adr/`；查某个模块的边界与测试：读最近的 `CLAUDE.md`、`README.md` 或 `DEVELOPMENT.md`。
- 写大型改动的交付记录：读 `doc/deliveries/README.md` 的模板；详细调查过程放在 `doc/development/` 或 `doc/worklogs/`。

## 什么时候不要读文档

要理解当前行为时，先读将要修改的代码、最近的包级文档和匹配路径的 `.claude/rules/`，不要从全库搜索出来的旧设计或交付记录开始。

`doc/deliveries/*` 是一次性交付记录，写给未来考古的人，不是知识库，也不要求 agent 在开发前搜索。只有一种情况值得读某份交付文档：你要改的正是那次交付改过的代码，并且需要知道当时为什么选择该边界、拒绝了什么方案或留下了什么风险。

同理，`doc/worklogs/`、`doc/experiments/` 和标为“历史”的顶层文件不能证明当前实现；它们只能解释某个时间点发生过什么。

## `doc/` 顶层文件完整路由

- `doc/README.md` — 现行 — 你不知道该从哪份规则、runbook、ADR 或包级文档开始时读。
- `doc/analysis-implementation-path.md` — 历史 — 你在追溯 2026-07 秘书网络(2026-10-15 已下线)为什么沿用既有飞书与 Agent 底座时读。
- `doc/changelog.md` — 历史 — 你在追溯 2026-03 项目起步阶段修过哪些问题时读。
- `doc/cross-agent-query-and-file-isolation-test.md` — 历史 — 你在调查早期 `ask-user` 与文件隔离验收方式时读。
- `doc/data-flow.md` — 历史 — 你在追溯 2026-03 的 Router、Session 与飞书消息流(v2 组合根,2026-10-15 已删除)时读。
- `doc/deploy-dashboard-security.md` — 现行 — 你要调整 Dashboard、Runner、Caddy、TLS 或公网监听边界时读。
- `doc/design-architecture-observatory.md` — 现行 — 你要改架构快照、约束见证或 Dashboard 的架构页时读。
- `doc/design-dashboard-sessions.md` — 历史 — 你要追溯个人密钥登录、会话读取或 append 契约最初为何这样设计时读。
- `doc/design-dashboard-shell.md` — 历史 — 你要追溯 React 重写前 Dashboard 壳层与导航取舍时读。
- `doc/design-hq.md` — 历史 — 你要追溯已下线(2026-10-15)的 HQ 工作台的事件日志、投影与动作层取舍时读。
- `doc/design-lifecycle-persistence.md` — 历史 — 你要修改 drain 或恢复逻辑且需追溯 2026-07 的故障与设计取舍时读。
- `doc/design-machines-and-memory.md` — 历史 — 你要修改 Runner 设备能力或用户记忆区且需追溯早期安全边界时读。
- `doc/design-secretary-mvp.md` — 历史 — 你要追溯已下线(2026-10-15)的秘书汇报流程及其首个飞书纵切的人因取舍时读。
- `doc/design-self-hosting.md` — 现行 — 你要改开发工单流水线、合并锁、落地顺序或部署信任环时读。
- `doc/design-resource-recovery.md` — 现行 — 你要改 agent 外部工具在资源离线/恢复时的行为(机器车道、等待登记、恢复通知)时读。
- `doc/design-session-live-view.md` — 历史 — 你要修改会话实时读取且需追溯文件 tail 与 SSE 契约的来源时读。
- `doc/design-spec.md` — 历史 — 你在追溯 2026-03 Claude Bot v2 重构基线时读。
- `doc/feishu-deploy-quickstart.md` — 历史 — 你在调查旧 Docker、`bot-ctl` 或明文端口部署方式时读。
- `doc/feishu-openai-setup-and-permissions.md` — 现行 — 你要配置飞书 OAuth、MCP 工具目录或普通用户与管理员权限时读。
- `doc/runner-local-agent-bridge.md` — 现行 — 你要启用、审查或排查本地 coding agent 经 Runner 跨设备执行时读。
- `doc/handover-api-land.md` — 历史 — 你要追溯人工落地为什么收编到流水线全局 git 锁时读。
- `doc/handover-dashboard-sessions.md` — 历史 — 你要复盘 2026-07 网页会话浏览器首次人工验收时读。
- `doc/handover-security-migration.md` — 历史 — 你要追溯 capability kernel 安全迁移中曾拒绝哪些方案时读。
- `doc/handover-ticket-10.md` — 历史 — 你要复盘工单 #10 的域名、Caddy 与秘书选项卡部署步骤时读。
- `doc/handover-ticket-15.md` — 历史 — 你要复盘工单 #15 的多用户隔离审计与管理员配置迁移时读。
- `doc/tcb-reading-guide.md` — 现行（2026-10-15 复核路径；行号为快照，以函数名为准）— 你要审查 capability kernel 的可信闭包或跨账户访问证明时读。
- `doc/v3-convergence-roadmap.md` — 历史 — 你要追溯从 v2 控制面向 v3 权限平台收敛的排序依据时读。
- `doc/v3-probe-report.md` — 历史 — 你要追溯 v3 引擎时间盒探针验证过哪些假设时读。
- `doc/v3-security-remediation-backlog.md` — 历史 — 你要追溯 v3 阶段接受、延期或完成过哪些安全项时读。
- `doc/vision-secretary-network.md` — 历史 — 你要追溯秘书 Agent 网络(2026-10-15 已下线)的原始产品愿景时读。

## 文档职责

- `AGENTS.md` 保存所有 coding agent 始终要知道的小规则；`CLAUDE.md` 只做 Claude 适配。
- `.claude/rules/*.md` 保存路径作用域内的现行不变量；包级文档保存模块边界与本地开发说明。
- `doc/runbooks/` 保存可执行步骤与恢复路径；`doc/adr/` 保存仍有效的架构裁决及理由。
- `doc/deliveries/` 保存单次大型改动的审阅入口；`doc/development/`、`doc/worklogs/` 和 `doc/experiments/` 保存按需调查材料。

修改 always-on 或路径作用域说明后运行 `pnpm docs:check`。
