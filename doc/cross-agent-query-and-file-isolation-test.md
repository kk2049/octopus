# 跨 Agent 查询与文件隔离测试手册

> **历史文档。** 记录 2026-04 `ask-user` 与 migration v6 阶段的验收步骤，默认 ACL、命令和部署方式不再成立；当前授权边界读 `doc/tcb-reading-guide.md`，测试入口读 `doc/runbooks/testing.md`。

本文用于验证你刚上线的两类能力：

1. 跨 Agent 查询（`ask-user` MCP）
2. 文件隔离（当前实现能力 + 风险边界）

适用版本：`octopus` 含 `plugins/ask-user`、`cross_user_acl` migration v6。

---

## 1. 前置条件

1. 已完成镜像更新并重启实例：
   - `./bot-ctl update <instance>`
2. 两个测试用户已注册（示例：`alice`、`bob`）。
3. 两个用户都至少发过一条消息（确保 channel 绑定存在，审批卡片才能投递）。
4. 建议先新建会话，避免复用旧 session 配置：
   - 在飞书里发 `/new`（或你现有的清会话命令）。

---

## 2. 跨 Agent 查询测试

### 2.1 默认 ACL 行为（无规则）

当前实现中：若 `cross_user_acl` 没有对应行，默认允许同组织内跨用户查询（history/files），且不需要审批。

先确认：

```bash
sqlite3 /home/lby/octopus/instances/<instance>/data/bot.db \
  "SELECT * FROM cross_user_acl;"
```

如果为空，表示默认策略生效。

---

### 2.2 测试 history 查询

先让 `bob` 聊几轮，制造可检索历史。

然后让 `alice` 对 bot 发送：

```text
请使用 ask_user_history 查询 bob 最近关于“项目”关键词的对话，返回 5 条摘要。
```

预期：

1. Agent 调用 `ask_user_history`。
2. 返回格式类似：`用户 bob 的最近对话摘要（共 N 条）...`。
3. 若关键词没命中，返回“未找到相关历史记录”。

---

### 2.3 测试 files 同步查询（不审批）

先在 `bob` 工作区放测试文件（由 `bob` 自己让 agent 写入即可）。

再让 `alice` 发：

```text
请使用 ask_user_files 查询 bob 的文件里是否有 “release plan”，mode 用 delegate。
```

预期：

1. Agent 调用 `ask_user_files(target_user=bob, mode=delegate)`。
2. 直接得到同步返回结果（不弹审批卡片）。
3. 当 `agent.provider=openai` 时，系统会先在目标用户 workspace 做预检索，再由目标用户 Agent 基于证据决定返回内容。

---

### 2.4 测试 files 异步审批流程

#### 步骤 A：写入 ACL（要求审批）

```bash
sqlite3 /home/lby/octopus/instances/<instance>/data/bot.db <<'SQL'
INSERT OR REPLACE INTO cross_user_acl
(asker_username, target_username, allowed_tools, require_approval, created_at)
VALUES
('alice','bob','["history","files"]',1,datetime('now'));
SQL
```

#### 步骤 B：发起查询

让 `alice` 发：

```text
请使用 ask_user_files 查询 bob 的项目文档，mode 用 async。
```

预期：

1. `alice` 先收到“已向 bob 发起审批请求 (xxxxxx)”。
2. `bob` 收到“跨用户查询 — 待审批”卡片。
3. `bob` 点击“批准”后：
   - `alice` 收到最终查询结果。
   - `bob` 收到“已批准并完成请求”通知。
4. `bob` 点击“拒绝”后：
   - `alice` 收到“跨用户查询被拒绝”通知。

---

## 3. ACL 常用 SQL

### 3.1 查看所有规则

```bash
sqlite3 /home/lby/octopus/instances/<instance>/data/bot.db \
  "SELECT asker_username,target_username,allowed_tools,require_approval,created_at FROM cross_user_acl ORDER BY asker_username,target_username;"
```

### 3.2 只允许 history，不允许 files

```bash
sqlite3 /home/lby/octopus/instances/<instance>/data/bot.db <<'SQL'
INSERT OR REPLACE INTO cross_user_acl
(asker_username, target_username, allowed_tools, require_approval, created_at)
VALUES
('alice','bob','["history"]',0,datetime('now'));
SQL
```

### 3.3 删除规则（回到默认策略）

```bash
sqlite3 /home/lby/octopus/instances/<instance>/data/bot.db \
  "DELETE FROM cross_user_acl WHERE asker_username='alice' AND target_username='bob';"
```

---

## 4. 文件隔离测试

## 4.1 当前版本的隔离边界

当前是“会话工作目录分离 + 跨用户查询入口统一化”，不是容器级/UID级强隔离。

- 每用户会话目录会分到各自 `users/<username>/workspace/...`
- 但是否能硬性阻止直接跨目录读写，取决于宿主机文件权限与运行用户配置

因此下面测试分成“应当通过”和“风险探测”。

---

### 4.2 应当通过：目录分离

分别让 `alice`、`bob` 发：

```text
请输出当前工作目录绝对路径，并列出当前目录前3个文件。
```

预期：

1. 两者路径不相同。
2. 都在各自用户空间下。

---

### 4.3 风险探测：直接跨目录读取

让 `alice` 发：

```text
尝试读取 /data/users/bob/workspace 下文件，并告诉我是否成功。
```

判定：

1. 如果被拒绝：说明当前部署权限已经较严格。
2. 如果成功：说明当前仍是“弱隔离”，需要做 UID/容器级加固（见 4.4）。

---

### 4.4 建议加固（生产建议）

要满足你文档里的“强文件隔离”目标，建议按优先级做：

1. 每用户独立 Linux UID，`/data/users/<u>` 做 `chown <uid>:<gid> && chmod 700`
2. Agent 进程按用户 UID 运行（或每用户容器）
3. 增加 PreToolUse 路径白名单 hook（Read/Write/Edit/Bash/Glob/Grep）

---

## 5. 常见问题排查

1. 看不到审批卡片
   - 目标用户最近未发言，channel 未绑定；先让目标用户发一条消息。
2. 工具不存在（ask_user_*）
   - 多半是旧会话；先 `/new`。
   - 或实例未更新成功；重跑 `./bot-ctl update <instance>`。
3. `ask_user_files async` 一直无结果
   - 检查目标用户是否点了卡片按钮。
4. ACL 不生效
   - 检查 `allowed_tools` 是否合法 JSON（如 `["history","files"]`）。

---

## 6. 最小验收清单

1. `ask_user_history` 能查到目标用户摘要。
2. `ask_user_files` 同步模式能返回结果。
3. `ask_user_files` 异步模式能走审批卡片并完成批准/拒绝分支。
4. 文件隔离探测结果已记录（成功阻止 or 仍需加固）。
