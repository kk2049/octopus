# Dashboard + Runner Gateway 对外暴露 · 安全说明

面板和 Runner 需要让公网用户抵达，但生产进程本身不应裸露：`9820`(HTTP)与
`9910`(WebSocket)绑定回环，由 Caddy 在 `443` 上终止 TLS；本文说明它们的暴露面、身份凭据和
回滚边界。

## 结论

**认证是可靠的,漏的是传输层。**

- Runner token = `rt_` + 128 位随机(sha256 存库);面板 token = 96 位随机。
  未知 token 立即断开,**无法枚举、无法爆破**。
- 例外一条:`/download/runner.js` 额外接受**有效 runner token**(用户凭
  `/runner-token` 的令牌即可自助下载,无需面板管理令牌)。bundle 是公开构建
  产物、不含机密,此面仅泄露"该 token 有效"这一位信息,与网关连接探测等价。
- 真正的问题:两个端口都是**明文**。token 在网络上裸奔,链路上的人(公共
  WiFi、ISP、任何中间节点)可以嗅探到 token,进而冒充。

因此：**公网只开放 Caddy 的 80/443；应用监听不直接对所有 IP 开放。** 外部用户经 TLS
可以安全抵达对应路由；把明文应用端口暴露到公网仍然危险。

## 逐端口风险(明文直接暴露时)

### 9910 Runner 网关(ws://)
- 网关是**服务端**,笔记本反向拨入。攻击者连上来但没有有效 token → 立即断开,
  **碰不到任何笔记本**(笔记本是出站连接,不可被反向访问)。
- 风险 1(主要)——**token 嗅探 → 冒充笔记本**:明文传输,链路上的人抓到某用户
  的 runner token 后,可冒充其设备连入。后果是**完整性与可用性**,不是数据外泄:
  攻击者拿不到该用户笔记本上的真实文件(那些在用户机器上),但可以①返回**伪造的
  session 内容**污染针对该用户的汇报,②把真实笔记本挤下线(每设备仅一条连接,重连
  顶替)。TLS 后 token 不再明文,此路即断。
- 风险 2——**DoS**:未认证连接洪泛。已有 10 秒认证超时 + payload 上限兜底,但无
  每-IP 限流(考虑到 NAT,每-IP 限流反而会误伤整个办公室,故不加)。反代层做限流
  更合适。

### 9820 面板(http://)
- 所有接口都要 token,无未授权面。token 比较已改**常数时间**。
- 风险 1——**明文 + token 在 URL**:query 里的 token 会进代理日志、浏览器历史、
  Referer,且链路可嗅探。泄露后果 = 组织元数据(用户名/真名/设备名/活跃度)可见 +
  可篡改任何人的 persona/响应档。**注意:面板不暴露任何 session 内容**(健康检查只
  回延迟和 session 计数,不回内容),所以泄露是隐私/完整性问题,不是内容外泄。
- TLS 后 URL query 在链路上是加密的,残留风险只剩服务器日志留存——由反代日志策略
  控制。

## 解法:Caddy 反向代理(自动 HTTPS)

当前生产的执行顺序、精确路由与 receipt 模板以
`doc/runbooks/production-network-boundary.md` 为准。本节保留边界原理与可读示例；不得再用旧的
`/runner*` 宽匹配代替生产的 `/octopus-runner/v1*`。

Dashboard/Runner 使用一个专属域名和 Caddy，即可让“全网可达”走 TLS。只对外开 **443**
（和 ACME/HTTP redirect 使用的 80），`9820`/`9910` 收回到 localhost。启用 C3 时还要增加
每用户专属 dsh host，见下一节。

### 1. 域名
把一条 A 记录指向本机公网 IP(`203.0.113.8`)。Let's Encrypt 不给裸 IP 发证,
所以需要一个域名(或你已有域名的子域,如 `octopus.你的域名`)。

### 2. 把两个端口收回 localhost
`config.yaml`:
```yaml
runner:
  enabled: true
  port: 9910
  host: 127.0.0.1        # 只让 Caddy 连,不再对外
dashboard:
  enabled: true
  port: 9820
  host: 127.0.0.1
  auth_token: "……"
  runner_public_url: "wss://bot.example.org/octopus-runner/v1"
```

### 3. Caddyfile
```
bot.example.org {
    # 必须位于 Dashboard catch-all 之前；只把这个 Runner namespace 交给 9910。
    handle /octopus-runner/v1* {
        reverse_proxy 127.0.0.1:9910
    }
    # 其余都给面板
    handle {
        reverse_proxy 127.0.0.1:9820
    }
}

mesh.16-58-204-8.sslip.io {
    # Personal Mesh 使用独立无共享 Cookie 的 host，且只开放 /v1 namespace。
    handle /v1* {
        reverse_proxy 127.0.0.1:9932
    }
    respond 404
}
```
`curl -fsSL https://get.caddy.io | bash` 或用包管理器装;`caddy run` 即自动申请证书。

### 4. 安全组
只保留:
- **443** TCP ← 0.0.0.0/0(面板 + Runner,全走 TLS)
- **80** TCP ← 0.0.0.0/0(仅 ACME 证书签发/续期)
- ~~9820 / 9910~~ **不再对外**(已绑 127.0.0.1)

### 5. 面板与接入地址
- 面板:`https://octopus.你的域名/?token=……`
- 笔记本接入:面板教程会自动显示
  `OCTOPUS_URL=wss://bot.example.org/octopus-runner/v1`。

本机 DSH 固定使用 exact origin `http://127.0.0.1:9931`，不经 Caddy；Personal Mesh 后端固定
监听 `127.0.0.1:9932`。`9931`、`9932` 都不得绑定 `0.0.0.0`、`::` 或加入公网安全组。远端
Runner 全部确认从 WSS 重连后，才允许把 `dashboard.host` 与 `runner.host` 收到
`127.0.0.1`。

## C3 fleet(已下线)

每用户 dsh fleet(C3:`9830` FleetGateway、root helper、fleet session、Tentacle 发行分发)的
代码已于 2026-10-15 删除;此前生产一直是 `fleet.enabled: false`。`9822` on-demand TLS
`ask` 仍随 Session Plus 存在,只判定已发布 App origin。

代码删除不会清理主机上可能残留的 C3 运维件。若某台主机曾启用过 fleet,运维应另行:

- 用 `octo-fleet` 运维仓库的 `sudo /home/ubuntu/lht/octo-fleet/bin/rollback.sh` 停用 fleet
  units、删除 C3 的 nftables table 与 helper/unit/sudoers/AppArmor 入口,并移除指向 `9830` 的
  Caddy 站点块(按 `/var/lib/octopus-fleet/last-caddy-backup` 记录的精确备份恢复);
- 在面板撤销残留的 `dsh:<username>` Runner 令牌和标签为 `fleet:` 的 `mcp_` 令牌
  (它们仍能在 Tentacle Gate 注册,直到被撤销)。

用户数据 `/var/lib/octopus-fleet/users` 的删除是另一次明确的破坏性操作。

## 如果暂时不能上 TLS(仅临时/内网)

- 明白风险 = 链路上的人可窃取 token → 冒充笔记本(伪造证据、顶下线)+ 面板元数据
  泄露。**不要在公共网络这样跑生产。**
- 把面板 `auth_token` 设成强随机(已默认 96 位);token 只经私聊 bot 下发,别贴群。
- token 泄露/换人时:面板 token 改 config 重启即失效;某设备 runner token 用
  `/runner-token revoke <设备名>` 立即吊销。
- 生产务必回到上面的 TLS 方案。
