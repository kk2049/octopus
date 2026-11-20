# Claude Bot v2 — 完整设计 Spec（归档）

> **历史文档。** 记录 2026-03 Claude Bot v2 的重构设计，v4 已是当前可部署水位，文中的 `v2/CLAUDE.md` 与模块路径不能作为现行入口；当前路线见 `doc/README.md`。

> 本文件是重构设计文档的归档副本。实时状态请查看 `v2/CLAUDE.md`（项目看板）和各模块的 `CLAUDE.md`。

## v2 修订说明

相比 v1 的核心变化：
1. 从"单用户实例"改为"多用户单容器"——Router 以 root 运行，每用户一个 Linux user，通过文件系统隔离
2. 恢复 Delegate 子任务系统——作为特殊的 AgentSession 融入 Router 架构
3. 保留 RAG 知识库
4. 去掉连接池，但优化 session 创建和 resume 速度
5. **Skill 与 Plugin 分离**——Plugin 只做 MCP 工具能力，Skill 利用 Claude Code 原生 `.claude/skills/` 发现

---

## 0. 重构动机

当前 Python 实现的核心问题：

1. **engine.py 是 god object**（~1200 行）：消息路由、Agent 生命周期、卡片逻辑、队列管理、RAG 注入、委派系统全部耦合
2. **多租户复杂度**：`context_key` 同时承担路由键、会话归属键、群组配置键
3. **连接池过度设计**：三级策略 + refill + reaper
4. **卡片/文本双模式**：engine 里大量 `if supports_card` 分支
5. **不可测试**：所有子系统通过 engine 的内部 dict 互相访问

---

## 1. 核心设计决策

### 1.1 三层架构

```
Channel（I/O 管道）→ Router（路由 + 用户解析 + 绑定）→ AgentSession（持久 Agent）
                          ↑
                     UserManager（用户目录 + 身份映射）
```

### 1.2 技术栈

| 组件 | 选型 |
|------|------|
| 语言 | TypeScript 5.x, ESM, Node.js 22+ |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` |
| 飞书 | `@larksuiteoapi/node-sdk` |
| 持久化 | `better-sqlite3` |
| 包管理 | `pnpm` workspace monorepo |

### 1.3 去掉的东西

- QQ 后端、连接池

### 1.4 保留的东西

- Delegate 子任务、RAG 知识库、Skill 工作流

---

## 4A. Skill 系统

### 设计理念

Skill = 轻量工作流定义（`SKILL.md`）。Claude Code 原生支持 `.claude/skills/` 自动发现。

Plugin vs Skill：
- Plugin = MCP 工具服务器（重），需要 manifest + config + 重启
- Skill = 系统提示词注入（轻），放个 SKILL.md 即可，Agent 可自建

### 三层 Skill 架构

1. **Global Skills**（管理员配置）→ `config.yaml → skills.global_dirs`
2. **User Skills**（用户管理）→ `{HOME}/.claude/skills/`
3. **Session Skills**（会话级临时）→ `{workdir}/.claude/skills/`

优先级：Session > User > Global。

### 全局 Skill 注入

通过 SDK `plugins` 选项（`type: "local"`）注入全局 skill 目录。Preset 可通过 `skills` 字段过滤启用的全局 skill。用户级 skill 始终可用，不受 preset 控制。

### SKILL.md 格式

```yaml
---
name: auto-ppt
description: >-
  当用户要求制作 PPT/演示文稿时使用。
user-invocable: true
allowed-tools: [Bash, Read, Write]
---
# 工作流指令...
```

---

## 8. 配置文件

完整 `config.yaml` 结构参见 `config.yaml.example`。核心字段：

- `instance.name` / `instance.data_dir`
- `channels.feishu` / `channels.websocket`
- `agent.model` / `agent.max_turns` / `agent.max_concurrent_sessions` / `agent.system_prompt`
- `anthropic.base_url` / `anthropic.api_key`
- `plugins.<name>.enabled`
- `skills.global_dirs`
- `remotes.<name>.host` / `remotes.<name>.workdir`
- `presets.<name>.model` / `.system_prompt` / `.plugins` / `.skills`
- `feishu_oauth.app_id` / `.app_secret`
- `rag.enabled` / `.embedding_model` / `.top_k`
- `group_mode`: "shared" | "personal"
- `notify_on_start.open_id` / `.prompt` / `.delay_ms`

### vs v1 配置变化

| v1 | v2 | 原因 |
|----|-----|------|
| `backend: feishu` | `channels.feishu.enabled: true` | 多 channel 并发 |
| `qq: {}` | 删除 | 不再支持 |
| `pool: {}` | `agent.max_concurrent_sessions` | 简化 |
| `agent.role` | `agent.system_prompt` | 更直白 |

---

## 9. 项目结构

```
claude-bot-v2/
├── packages/bot/src/           # Bot 主进程
│   ├── index.ts                # 入口
│   ├── config.ts               # 配置
│   ├── logger.ts               # 日志
│   ├── channel/                # Channel 层
│   ├── router/                 # Router 层
│   ├── session/                # Session 层
│   ├── user/                   # 用户管理
│   ├── rag/                    # RAG 知识库
│   └── store/                  # 持久化
├── packages/cli/               # CLI 前端（TS 基础版）
├── cli/cli.py                  # CLI 前端（Python Rich）
├── plugins/                    # MCP 插件
├── skills/                     # 全局 Skill
├── remote-mcp-server/          # 远端 MCP Server
├── ctl/bot-ctl.ts              # 实例管理 CLI
├── Dockerfile                  # 生产镜像
└── Dockerfile.dev              # 开发镜像
```

运维基础设施：Graceful shutdown（SIGTERM, 30s timeout）、pino 日志、文件心跳 Health check、MAX_QUEUE_SIZE = 10。

---

## 11. 迁移策略

Phase 1 先实现单用户模式（与 v1 一致），Phase 2 再实现多用户单容器 + uid 隔离。

---

## 12. 风险与决策点

| 风险 | 应对 |
|------|------|
| Claude Agent SDK TS 版本 API 不稳定 | 封装 `session.ts` 隔离 SDK 变更 |
| 多用户文件权限泄露 | `chown + chmod 700`；Agent cwd 限制在用户目录 |
| Claude Code session 目录冲突 | `CLAUDE_CONFIG_DIR` per-user |
| Node.js RAG embedding 性能 | 预计算索引 + 增量更新 |
| Delegate 递归 | 禁用 delegate 插件 + max_depth 兜底 |
| better-sqlite3 同步阻塞 | < 50 并发用户不是瓶颈 |
| FeishuChannel 卡片状态 | 接受 Channel 持有卡片状态，Router 不知道卡片存在 |
