# 共享工单的执行沙箱

`runner_tickets.shared_pool` 允许其他开发者使用所有者的模型来源（`source_devices`、`codex_accounts`、`claude_devices`）。
`split_only` 规定：共享工单的模型留在来源设备上，所有工具都在 `shared_pool.workspaces` 指定的工作区执行。
本文定义这条边界，以及 4090 上的现行部署。

## 不变量

1. `shared_pool.workspaces` 只能指向专用的隔离执行容器。不得指向所有者的个人宿主、个人研究容器，或任何能读到所有者 home 与登录的 Runner。
   - 同一宿主上的另一个 Runner 也不算隔离：它与研究容器用户 uid 相同、带免密 sudo，或者能经由 bind mount 路径访问那些文件，都不行。
2. 拆分执行 home（Runner 的 `.octopus/codex-split-home` 及 `accounts/*`）同时承接所有者和其他用户的会话，所以不能带 `AGENTS.md` 或 `AGENTS.override.md`。
   - `prepareIsolatedCodexHome` 在每次启动拆分宿主时删除这两个文件，以及 `config.toml`、`rules`、`skills`、`plugins`、`prompts`。
   - 运维脚本不得再把个人指令链接进来。
3. 沙箱里没有任何 Agent 登录。Codex 在沙箱里只作为 `exec-server` 运行。
4. Claude 拆分会话以 SDK 隔离模式运行（不设 `settingSources`），内置工具为空，只挂远端 MCP，不加载 CLAUDE.md。

## 4090 现行部署（2026-10-20）

| 项 | 值 |
|---|---|
| 设备 / 容器 | `octopus-4090-shared`，所有者 lht |
| 工作区 | `ws_a3573053de911c5505122959`（`/work/tickets`） |
| 运行身份 | uid/gid 23000，`--cap-drop ALL`、`no-new-privileges`、只读根、8 CPU / 16 GiB / 4096 pids |
| 挂载 | 仅有：`/srv/octopus-ci-ali/shared/work` 读写；Runner bundle、`codex-0.161.0-x86_64-musl`、令牌、`resolv.conf` 只读 |
| 网络 | `octopus-provider-network@shared`（sing-box，只走 TCP，私有网段一律拒绝） |
| Runner | 普通模式（非 `RUNNER_EXECUTION_ONLY`，因为需要 Codex 中继与开发工作区），`RUNNER_SELF_UPDATE=0` |

宿主上的创建与准备脚本在 `/srv/octopus-ci-ali/provision/shared-sandbox-{prepare,start}.py`（root 所有，与 CI 的 `start.py` 同目录），运维记录见 `/home/ubuntu/lht/ops/octopus/ticket-concurrency-20261020.md`。

## 升级与重建

- **升级 Runner**：从 `/download/runner.js` 下载新 bundle，核对 `x-octopus-runner-bundle-sha` 并通过 `node --check`。以 root 只读文件存为 `provision/runner-<sha8>.js`，然后用这个参数重建容器，或原地覆盖当前挂载的文件后 `docker restart octopus-4090-shared`。
- **重建容器**：只需重新执行 start 脚本。工作区登记保存在 `/work`，id 不变。
- **轮换令牌**：通过 `/api/runner-token` 为同一设备重新签发，经管道直接写入宿主上 600、uid 23000 的文件，不打印。

## 验收

用独立测试身份 `codex_acceptance` 建一张只读工单（例如 #775），在工作区执行：

```sh
id; pwd; ls /home; test -e /home/ubuntu/.codex; test -e /home/lht; test -e /srv/research
grep -E '^Cap(Eff|Bnd)' /proc/self/status
timeout 5 bash -c 'echo > /dev/tcp/<宿主局域网地址>/22'
sudo -n true
```

期望结果：uid 23000；工作目录在 `/work/tickets` 下；三个 `test -e` 都失败；capability 全为 0；私有网段不可达；没有 sudo。

还要检查这张工单的 Codex 会话记录：开头的指令只能是仓库自己的 `AGENTS.md`，不能出现所有者的全局规则。验收后取消该工单。

## 已知限制

沙箱内的进程能读到本设备的 Runner 令牌。它最多只能冒充 `octopus-4090-shared` 这一个设备，接触不到所有者的其他设备、登录或文件。如果以后要让互不信任的使用者共用这个沙箱，需要再拆分 Runner 与执行进程的身份。
