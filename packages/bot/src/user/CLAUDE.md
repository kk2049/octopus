# 用户管理层设计

UserManager 管理用户身份、目录创建、身份绑定（飞书 ↔ CLI）、OAuth token 存储。

## 核心概念

用户身份（User）是系统中第一等公民，Channel 是 User 的 I/O 端点：

```
飞书私聊 (open_id: ou_xxx)  ──┐
飞书群聊 @Bot (open_id: ou_xxx) ──┼── User "alice" ── owns ── Session[]
CLI WebSocket (token: alice)  ──┘
```

## 用户目录结构

```
/data/users/alice/
├── .claude/skills/          # 用户级 Skill（Agent 可读写）
├── workspace/               # Agent 工作目录
├── claude-sessions/         # Claude Code session 缓存
├── oauth/feishu_token.json  # 飞书 user_access_token
├── rag/docs/                # 个人 RAG 文档
└── config.yaml              # 用户级配置覆盖（可选）
```

## 用户识别流程

```
飞书消息 → resolveByFeishu(open_id)
  → 查 user_identities 表 → 找到 → 返回 User
  → 未找到 → 触发注册流程

CLI WebSocket → resolveByToken(token)
  → 返回 User
```

## 注册竞态保护

使用 `registrationInFlight: Map<string, Promise<User>>` 防止同一用户快速连续发消息导致重复注册。已在注册中的 identity 复用同一个 Promise。

## 用户名校验

```typescript
/^[a-z][a-z0-9_]{1,31}$/
```
保留名：root, admin, bot, system, shared, data。

## 多用户隔离

Router 以 root 运行。Phase 1 用方案 A：`query()` 的 cwd 设为用户目录，`CLAUDE_CONFIG_DIR` 指向用户目录。Phase 2 可选 `chown + chmod 700` 更强隔离。

关键环境变量注入：
```typescript
env = {
  HOME: userAccount.homeDir,
  CLAUDE_CONFIG_DIR: `${userAccount.homeDir}/claude-sessions`,
}
```
