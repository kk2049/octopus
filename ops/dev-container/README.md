# 贡献者开发容器(跑在贡献者自己的电脑上)

CI 环境的笔记本版本:与 `.gitlab-ci.yml` 的 `full_suite` 和 `ops/ci-container`
同一基础镜像、同一 Node 22.23.2、同一 pnpm,外加 Codex CLI。容器里运行一个 octopus
Runner,用贡献者本人的 `rt_` 设备令牌注册到 bot;贡献者的工单 agent(运行在 bot 主机)
通过 `machine_*` 工具在这里编译、跑相关测试。

**容器里没有任何仓库凭据。** 代码由流水线在每一轮开始前打成 git bundle,经一次性 URL
(`/api/contrib/bundle/<token>`,120 秒内单次有效)让容器下载并 fetch 进
`/work/octopus`,再为每张工单建 `/work/tickets/ticket-<id>` 独立检出。容器不能 push,
也不知道 GitLab 在哪里;推送到 `contrib/<用户>/ticket-<id>` 分支的是 bot 主机。

## 安装(贡献者本人操作)

1. 登录 dashboard(维护者给的 `dt_` 密钥),在「总览」给自己签发一个设备令牌,设备名建议
   `<用户名>-dev`。
2. 拿到本仓库的 `ops/dev-container/` 三个文件(维护者发给你,或从 GitLab 只读取),在有
   Docker 的机器上执行:

   ```bash
   OCTOPUS_RUNNER_TOKEN=rt_xxx RUNNER_DEVICE=lilei-dev ops/dev-container/install.sh
   ```

   默认连到 `https://bot.example.org` / `wss://bot.example.org/octopus-runner/v1`;
   其它部署用 `OCTOPUS_DASHBOARD_URL` / `OCTOPUS_URL` 覆盖。令牌写进
   `~/.octopus-dev/runner-token`(0600)并以只读文件挂进容器,不进容器定义。
3. 看到 `Runner registered as device ...` 后,把设备名告诉维护者,由维护者在
   `config.yaml` 的 `selfhosting.dev_machines.<用户名>` 登记并重启 bot。

升级镜像:`ops/dev-container/install.sh --update`(保留 `/work` 下的代码、node_modules
与 pnpm store)。

## 用自己的 Codex

```bash
docker exec -it octopus-dev codex login
```

登录态留在容器的 `/work/home`。之后在 dashboard 的 Sessions+ 选择这台设备新建会话,
工作区选 `octopus-dev`(即 `/work/octopus`)——这是你自己的 agent、自己的额度,与工单
系统无关。

## 布局

- `/work/octopus`:对象库 + 工作区登记;由流水线 fetch,不要手改。
- `/work/tickets/ticket-<id>`:每张工单的独立 detached 检出,各自 node_modules。
- `/work/pnpm-store`、`/work/cache`:共享缓存。
- `/work/runner.js`:每次启动从 dashboard 重新下载的 Runner 独立包。

首次同步要冷装依赖,可能超过 Runner 单条命令 5 分钟的上限;流水线会如实告诉 agent
「再次 devpipe_ci_sync 会接着装」,第二次是热的。

## 排查

```bash
docker logs --tail 100 octopus-dev
```

- `no device token`:令牌文件没挂进去,重跑 install.sh。
- `download failed and no cached runner.js`:检查 `OCTOPUS_DASHBOARD_URL` 与令牌是否已被
  维护者吊销。
- 设备离线:检查出站到 443 的网络;Runner 只做出站连接。

## 常见问题

- 首次同步要冷装依赖,可能超过 Runner 单条命令 5 分钟上限,第二次
  `devpipe_ci_sync` 会接着装。
- 容器离线时,工单会退回 bot 主机最小范围验证。
