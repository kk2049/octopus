# Octopus 飞书接入与部署快速手册

> **历史文档。** 记录旧 Docker、`bot-ctl` 与明文端口部署路径，不能用于当前 v4 上线；当前部署读 `doc/runbooks/deployment.md`，飞书权限配置读 `doc/feishu-openai-setup-and-permissions.md`。

本文目标：先把当前版本跑起来，接入飞书做真实联调，再决定增量开发优先级。

## 1. 适用范围

- 仓库：`octopus`
- 当前模式：单实例多用户（路线 B）
- 重点验证：飞书消息收发、卡片交互、会话与路由、基础命令链路

## 2. 前置条件

1. 机器安装：
- Docker + `docker compose`
- Node.js（建议 20+；项目 Dockerfile 使用 22）
- Python 3（仅 CLI/远端工具链需要）

2. 你已经有：
- 飞书自建应用（拿到 `app_id`、`app_secret`）
- Anthropic Key（`anthropic.api_key`）

## 3. 最快启动（推荐：bot-ctl + Docker）

### 3.1 创建实例

```bash
cd /home/lby/octopus
./bot-ctl create prod
```

会生成：
- `instances/prod/config.yaml`
- `instances/prod/docker-compose.yml`

### 3.2 编辑配置

编辑 `instances/prod/config.yaml`，至少修改这些字段：

```yaml
instance:
  name: "prod"
  data_dir: "/data"

channels:
  feishu:
    enabled: true
    app_id: "cli_xxx"
    app_secret: "xxx"
  websocket:
    enabled: true
    port: 9800
    auth_tokens:
      alice: "token-alice-xxx"

anthropic:
  base_url: "https://api.anthropic.com"
  api_key: "sk-xxx"
```

需要文档、日历、任务、多维表格等用户态飞书能力时，开启 Runner 能力服务并配置
OAuth（建议与 channel 使用同一个飞书应用）：

```yaml
runner:
  enabled: true

feishu_oauth:
  app_id: "cli_xxx"
  app_secret: "xxx"
```

用户发送 `/auth` 后，网关会自动把完整的普通用户目录接给新会话；不需要、也不应把
带应用密钥和用户 token 的 `feishu-lark-mcp` 直接挂给 Agent。普通读取默认开放，写入
逐次审批；特权能力按用户名配置。完整说明见
`doc/feishu-openai-setup-and-permissions.md`。

参考模板：`config.yaml.example`

### 3.3 启动与看日志

```bash
./bot-ctl start prod
./bot-ctl logs prod -f
```

## 4. 飞书应用侧检查清单

1. 事件订阅已开启，至少包含消息接收事件（机器人可见消息）。  
2. 机器人已被加到目标私聊/群聊。  
3. 权限范围按你需求开通；可参考 `config/feishu_scopes.json`（尤其 user token 场景）。  
4. 测用户态飞书 MCP 时，配置 `runner.enabled` 与 `feishu_oauth`，并在会话中执行 `/auth`。

## 5. 联调验证脚本（建议顺序）

### 5.1 基础通路（飞书）

1. 私聊机器人发送：`/help`
2. 发送普通消息：`你好`
3. 发送：`/sessions`（确认会话列表可展示）
4. 发送：`/new` 再发一条消息（确认新会话生效）

### 5.2 卡片与动作回调

1. 发送：`/config`（表单卡片是否出现）
2. 勾选配置并提交（是否返回保存结果）
3. 发送：`/resume`（会话选择卡片是否可点击切换）
4. 发送：`/resumecard`（飞书端是否能带历史回放进入该会话）

说明：
- `/resume`：只切换当前 channel 绑定到的活跃会话，不会把历史消息重新渲染到飞书里。
- `/resumecard`：会从 DB 重建历史，并在飞书卡片里继续 follow-up，更适合“回到之前那段对话”的场景。

### 5.3 CLI 并发通路（可选）

```bash
python3 cli/cli.py -t token-alice-xxx -u ws://<host>:9800
```

在 CLI 发消息，观察飞书是否同步收到 `user_input` 广播。

## 6. 常见问题

### 6.1 容器启动了但飞书没响应

先看日志里是否有：
- `Feishu provider started`
- WebSocket 连接异常/鉴权异常

再检查：
- `app_id/app_secret` 是否正确
- 飞书应用事件订阅与可见范围是否配置完整

### 6.2 功能看起来“没完全好”

这是预期范围内的：当前版本仍有已知缺口（例如 shared 群模式、RAG engine 等），但不影响先做联调验收。

### 6.3 回滚/重启

```bash
./bot-ctl restart prod
./bot-ctl stop prod
./bot-ctl start prod
```

## 7. 建议的“先验收后开发”流程

1. 先完成第 5 节联调清单并记录问题。  
2. 把问题分两类：
- P0/P1：阻塞消息主链路或权限安全链路
- P2/P3：体验增强与规划功能
3. 再进入增量开发（避免边开发边猜现状）。
