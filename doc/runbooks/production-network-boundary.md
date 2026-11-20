# 生产网络边界收口

本 runbook 记录生产宿主 (`bot.example.org` / `203.0.113.8`) 上 Dashboard、Runner、
本机 DSH 与 Personal Mesh 的公网边界与迁移顺序。所有代码内嵌接入地址、教程展示的
`OCTOPUS_URL`、以及 Caddy 站点块必须与本文一致；本文变了才允许改代码/config/Caddyfile。

## 现行边界

| 服务 | 监听 | 公网入口 | Namespace | 备注 |
|---|---|---|---|---|
| Dashboard | `127.0.0.1:9820` | `bot.example.org` (443) | catch-all | `__Host-octopus_sess`；Cookie 不共享 |
| Runner 网关 | `127.0.0.1:9910` | `bot.example.org` (443) | `/octopus-runner/v1*` | wss，必须位于 Dashboard catch-all 之前 |
| 本机 DSH | `127.0.0.1:9931` | **不经 Caddy** | — | canonical origin `http://127.0.0.1:9931`；永不公网 bind |
| Personal Mesh | `127.0.0.1:9932` | `mesh.16-58-204-8.sslip.io` (443) | `/v1*` | 独立 host，Cookie 与主站互不见 |

不变量：

- `9931`、`9932` 都不得绑定 `0.0.0.0`、`::`、任何公网网卡地址，也不得加入公网安全组。
- Personal Mesh 域名与 Dashboard 域名之间不得共用 Cookie；Mesh host 不给主站
  `Set-Cookie`，主站 Cookie 不带 `Domain`。
- Runner namespace 只 `/octopus-runner/v1*`；旧的 `/runner*` 宽匹配不得再出现在
  Caddyfile 或文档示例里，因为它会挡住未来任何以 `/runner` 开头的 Dashboard 路径。
- `runner_public_url` 只能是 `wss://bot.example.org/octopus-runner/v1`；非 TLS 或
  非回环 hostname 启动即失败（见 `config.yaml.example` 里的 `dashboard`
  `runner_public_url` 契约）。

## 迁移顺序（收 Dashboard/Runner 回环）

按以下顺序执行；跳序会把远端 Runner 打成不可达。

1. Caddy 增加 `bot.example.org` 的 `handle /octopus-runner/v1*` 与 Personal Mesh 站点块，
   `reload` 前用 `caddy validate` 通过。
2. 面板下发新 `OCTOPUS_URL`，等所有活跃 Runner 从 WSS 重连；`/runner-token status` 全绿
   之前不进第 3 步。
3. `config.yaml` 设置 `dashboard.host: 127.0.0.1` 与 `runner.host: 127.0.0.1`，
   `runner_public_url: "wss://bot.example.org/octopus-runner/v1"`。
4. 用 `scripts/dev-restart.sh` 做 drain 重启（不得裸 kill）。
5. 安全组撤销 `9910`/`9820` 的公网入站规则；只保留 `443`、`80`（ACME）、`9820-9910`
   的回环访问。

回滚只回到第 1 步之前的 Caddy 备份（`/var/backups/caddy/Caddyfile.*`）并
`systemctl reload caddy`；不要在 config.yaml 里把 `host` 改回 `0.0.0.0` 作为兜底，
它会绕过 Caddy 的 TLS 终止。

## Receipt 模板

生产 dry-run/apply 每次操作都要留一行日期化 receipt（谁做的、走的哪个入口、验证结果）：

```
production-network-boundary
date: 2026-08-19 UTC
actor: <lht>
change: <caddy-reload | config.yaml runner.host | 安全组收口>
verify: <curl -I https://bot.example.org/octopus-runner/v1/health => 401；
         ss -ltnp | grep 9931 => 127.0.0.1 only；...>
```

Receipt 落 `doc/deliveries/YYYY-MM-DD-*.md` 的“验证结果”一节；受本 runbook 影响的所有
后续操作（例如 DSH 端口调整、mesh 上下线）都必须在正文引用本文件路径。

## 与其它文档的关系

- `doc/deploy-dashboard-security.md` 保留边界原理与可读示例；执行顺序以本文为准。
- C3 fleet 已于 2026-10-15 下线；主机上可能残留的 `9830` 入口与清理步骤见
  `doc/deploy-dashboard-security.md` 的“C3 fleet(已下线)”一节。本 runbook 只覆盖
  Dashboard/Runner/DSH/Personal Mesh 四条主线。
- 系统 Caddy 的实际变更由 `octo-fleet` 运维仓库脚本（`caddy-install.sh` /
  `rollback.sh`）负责；本仓库不直接改 `/etc/caddy/Caddyfile`。
