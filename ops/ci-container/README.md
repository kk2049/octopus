# lht-val15 CI 容器(CI 修复 agent 的工作机)

一个**常驻**容器,环境与 `.gitlab-ci.yml` 的 `full_suite` 逐条对齐(同一个
playwright 基础镜像、同一个 Node 22.23.2、同一个 pnpm),里面跑一个 octopus
Runner。设备 owner 名下的普通开发票和 CI 修复票都通过 `machine_*` 工具在里面
编译、跑相关测试；每票使用 `/work/tickets/ticket-<id>` 独立检出和 node_modules，
一个 session 里修到绿,再从自己的 worktree 落地。

## 为什么是一个常驻容器,而不是复用 CI job 的容器

CI job 的容器是一次性的:每次冷装依赖、跑完即毁。修复 agent 需要的恰好相反——
一个**热**的环境(node_modules、pnpm store、Playwright 浏览器都在),这样"改一行
再跑一遍"是秒级而不是十分钟级。这个速度差就是修复票会不会退化成"改一下就提交、
让下一批 CI 告诉我对不对"的分界线。

环境与 CI job 对齐是硬要求:agent 在这里看到绿、下一批却红,比没有这台机器更糟。
所以 `Dockerfile` 是 `.gitlab-ci.yml` `before_script` 的**抄写**,不是改进。

常驻 Runner 的远端终端另需 `tmux`（与 git、SSH、jq 一样属于常驻环境工具）；镜像安装时
执行 `tmux -V` 验证。旧容器不会随 Runner JavaScript 自更新获得系统软件，须按安装流程
重建镜像/容器后生效。设备工作区查询会上报终端是否可用，缺失时页面先解释原因；首次
打开真实 shell 仍需可信批准，不因安装 tmux 自动授权。

## 安装

在 **bot 主机**上运行(它有到 lht-val15 的 ssh):

```bash
OCTOPUS_URL=wss://bot.example.org/octopus-runner/v1 \
RUNNER_KNOWLEDGE_INPUT_ORIGIN=https://bot.example.org \
OCTOPUS_RUNNER_OWNER=<设备令牌所属的 bot 用户名> \
OCTOPUS_RUNNER_TOKEN=rt_xxx \
  ops/ci-container/install.sh
```

`OCTOPUS_RUNNER_TOKEN` 由 `/runner-token` 逐设备签发,库里只存 sha256。
`OCTOPUS_RUNNER_OWNER` 必须是签发该设备令牌的 bot 用户名；设备名只在 owner
名下唯一,系统不会按全局同名设备猜 owner。Runner 控制面必须走公网 TLS 的
`wss://…/octopus-runner/v1`; 可重放设备令牌和知识任务 RPC 不得走公网 `ws://`。
`RUNNER_KNOWLEDGE_INPUT_ORIGIN` 是一次性、隐私过滤索引输入唯一允许的 HTTPS origin；
缺失或不匹配时 Runner 不上报索引任务能力,安装健康检查也失败。
首次安装必须传 `OCTOPUS_RUNNER_TOKEN`; 后续重建若 `/work/.runner-token` 已存在且非空，
可省略该变量并复用 mode-0600 文件，避免为修改 WSS/origin 环境而重新暴露令牌。

安装器默认把 `OCTOPUS_KNOWLEDGE_MODEL_DIR` 设为持久卷内的
`/work/knowledge-model-cache`。首次知识构建先访问固定 revision 的 Hugging Face
源，直连不可达时使用镜像传输；七个模型文件（包括 tokenizer、config 和 470MB
ONNX weight）的 byte count 与 SHA-256 全部在代码中固定，任何传输端都不进入信任边界。
校验后的 cache 以 reflink/copy 写入每个 immutable artifact；cache 已存在但损坏时
构建失败关闭，不自动覆盖。自定义目录必须是 `/work/` 下的绝对路径。

装完在 `config.yaml` 里把修复通道指过去,然后重启 bot:

```yaml
selfhosting:
  ci_machine:
    owner: <设备令牌所属的 bot 用户名>
    device: lht-val15-ci
    checkout_dir: /work/octopus
```

安装器默认要求 CI 持久目录和 rootless Docker data-root 各自至少有 50GiB 可用空间,
并在启动后核对容器 `/work` 的真实 bind source。阈值可以用
`OCTOPUS_CI_MIN_FREE_GB` 提高；容量盘挂载点变化时,用
`OCTOPUS_CI_ROOT=/容量盘上的自有目录` 指向新位置。不要只移动 `/work`:镜像层和
build cache 也会增长,`docker info` 的 `Docker Root Dir` 同样必须位于容量盘。
可随时执行 `ops/ci-container/install.sh --check-storage` 做只读容量与挂载检查；该模式
不需要 Runner token,不会重建容器。

当前 lht-val15 的根盘只剩约 13GiB,所以不能承载 CI 数据；`/mnt/disk` 是 1.8TiB
NVMe 卷,安装默认值 `/mnt/disk/octopus-ci/agent` 与 rootless Docker 的
`/mnt/disk/octopus-ci/docker` 都在这块盘上。迁移已有目录时先停止
`octopus-ci-agent`,用保留权限的文件复制工具把整个 `agent` 目录复制到新盘,
再以新的 `OCTOPUS_CI_ROOT` 重跑安装器；不要跨文件系统直接移动正在运行的工作树。

没配 `ci_machine`、显式 owner/device 对未登记或设备不在线时,bot 启动/工单会失败关闭，
不会按同名设备推断 owner,提示词也不会声称自己持有机器工具。

## 布局与约束

- 容器内一切可变状态在 `/work`,映射到宿主 `/mnt/disk/octopus-ci/agent/work`。
  **不要放到 `/`**:那块盘 95% 满(228G 只剩 13G),而热检出 + pnpm store 是几十 G。
  `/mnt/disk` 本身是 root 所有,`/mnt/disk/octopus-ci` 才是 `lht` 拥有的目录,所以放在它下面。
- 复用已有的 rootless Docker daemon(`/run/user/1000/octopus-ci-docker.sock`),
  与 GitLab runner 同一个,数据根同样在 `/mnt/disk`。
- 检出用 **git bundle** 播种,不从 GitLab clone:clone 一个私有仓库意味着把长期
  凭据放进一个 agent 有 shell 的容器里,去取 bot 主机本来就有的字节。bundle 是
  一个文件,不携带任何权限。
- **容器只负责环境,代码由流水线维护。** 同步走的是 **Runner 通道**(2026-08-21 起):
  bot 进程以设备 owner 身份开一张仅含 `exec` 的临时授权,把缺的 commit 打成一次性
  bundle URL 让容器自己 `curl`,再在容器里 `worktree add/reset`、`pnpm install`、
  构建三个测试前置包(`packages/bot/src/devpipe/runner-machine-sync.ts`)。这与贡献者
  开发机用的是同一条路。`sync-workspace.sh`(ssh 经堡垒机)只在 Runner 不在线或没有
  `dashboard.public_url` 时作为回退,也可手动运行；`sync-base.sh` 保留给人工维护共享
  对象检出。同步仍是增量传输(容器报告自己有什么,只有缺的 commit 上路)。流水线在
  **每一轮开发开始时**后台发起它,提示词写「正在同步到 X」,agent 的第一次
  `devpipe_ci_sync` 会等它完成；工单 #285 量过 ssh 路径:堡垒机间歇性挂起,每次失败
  固定耗 240 秒,一张票丢了四次共二十分钟,这就是换通道的原因。
- 每票工作树是**流水线拥有的草稿纸**:同步只 reset/clean 自己的目录(保留自己的
  node_modules/dist),不会碰其它并发工单。不要在容器里 commit；在本票源 worktree
  commit 后用 `devpipe_ci_sync` 送入精确 HEAD。每次同步都会重建 runner、
  plugin-sessions 与 dashboard-web 三个测试前置产物,避免新 worktree 的类型解析和
  测试错误来自缺失 dist 而不是候选代码。
- **落地门禁也在这里跑**(2026-08-21 起,`packages/bot/src/devpipe/remote-gate.ts`):
  `/work/land` 是流水线自己的落地工作树,`/work/land-gate-cache` 放增量 tsc 的
  buildinfo 与步骤日志。两条落地门(`devpipe_submit` 与 `land.sh`)都先把候选 sha
  同步到这里,再按原来的步骤单跑 install → 类型依赖构建 → 增量 tsc → `pnpm -r build`
  → 点名的测试 → diff 涉及的测试。每一步以 `setsid` 脱离启动、轮询 rc 文件,所以
  Runner 单次 `exec` 的 5 分钟上限不会替代门禁自己的超时。Runner 不在线、同步失败
  或机器中途失联时,同一份步骤单回到 bot 主机的 `_land` 执行;`selfhosting.ci_machine.gate: false`
  可强制留在本机。agent 不会被告知 `/work/land`,也不要去碰它。实测(负载 ~48):
  install 3s、缓存命中的 `pnpm -r build` 3s、tsc 热 8s/冷 26s、单个浏览器项目测试 7s;
  同一套步骤在 2 核 bot 主机上是 30–47s 的 tsc 和 147–234s 的知识回归测试。
- 令牌通过 mode-0600 的 `/work/.runner-token` 进入容器,不写进容器定义,
  `docker inspect` 看不到。

## 权限模型

符合 owner 条件的开发 agent 拿到 `MACHINE_OPS`(exec / 读 / 写 / 列目录 / host_info)并且
**auto-allow**,即不弹逐次批准卡。这不是新开的口子:

- `MACHINE_AUTO_ALLOW` 本来就是给"用户自己的 agent 操作用户自己的设备"用的
  (见 `packages/bot/src/runner/capability.ts`),这里的授权只派生自
  `ci_machine.owner` 这个显式用户及其**自己注册的同名设备**;
- 凭据**按轮次**签发,轮次结束即吊销,Context 随之销毁;
- 它只能触及这一台设备——Object 是 owner-bound 的。

逐次批准卡的意义是让在场的人点头。修复通道按设计是无人值守的:那里放一张卡不会
增加监督,只会让修复停在那里直到有人发现。

## 排查

```bash
ssh lht-val15 'DOCKER_HOST=unix:///run/user/1000/octopus-ci-docker.sock \
  docker logs --tail 100 octopus-ci-agent'
```

- `no device token` — 没给令牌,或令牌文件没落进 `/work/.runner-token`。
- `knowledge index jobs unavailable` — 缺少/写错 `RUNNER_KNOWLEDGE_INPUT_ORIGIN`,或
  `/work` 不满足索引任务约束；安装健康检查不会把“仅注册成功”误报为完整健康。
- `seeding … from /work/seed.bundle` 之后卡住 — 首次冷装依赖,几分钟,正常。
- 设备不在线但容器在跑 — 检查 `OCTOPUS_URL` 是否为公网 `wss://…/octopus-runner/v1`。
- `onnxruntime-node` 安装时下载 CUDA provider 失败 — 知识索引只使用包内自带的 CPU
  binding；根 `package.json` 必须保留 pnpm 9 的
  `pnpm.neverBuiltDependencies: [onnxruntime-node]`，根 `pnpm-workspace.yaml` 必须保留
  pnpm 10+ 的 `allowBuilds.onnxruntime-node: false`，避免运行仅用于可选 GPU provider 的
  postinstall。升级 pnpm 或该依赖时先做一次全新安装，再加载 native binding 并完成
  远端向量索引验收。
- `model-stage` 报 `fetch failed` — 先确认容器安装参数包含
  `OCTOPUS_KNOWLEDGE_MODEL_DIR=/work/knowledge-model-cache`；固定 revision 直连和镜像
  都不可达时首次构建会失败。不得手工跳过 checksum；恢复任一传输后重建 cache。

## 相关

- 修复通道的规矩:`doc/runbooks/ci-triage.md`
- GitLab runner 本身(另一件事):`ops/gitlab-runner/README.md`
- 交付记录:`doc/deliveries/2026-08-17-ci-repair-machine-lane.md`

## Runner 自更新与热替换(2026-08-22)

容器里的 Runner 曾经是**冻结的**:`entrypoint.sh` 只在 `dist/index.js` 不存在时构建一次,
`sync-base.sh` 只送代码不重建,于是 08-17 provisioning 出来的 Runner 一直跑到 08-22,
期间落地的 Runner 修复一个也到不了它。现在:

- Runner 注册时上报自己入口文件的 sha256;bot 的 `registered` 应答带上它部署的
  `packages/runner/dist/standalone.js` 的 sha。不一致时 Runner 在**同一条已认证的
  socket** 上请求 bundle(`bundle_request` → `bundle`,base64 + sha),校验后原子落到
  **托管路径** `$RUNNER_SCAN_HOME/.octopus/runner/standalone.js`(这里是 `/work`,
  随卷持久),上一份留作 `standalone.prev.js`。
- 容器入口 `export OCTOPUS_RUNNER_SUPERVISED=1`,Runner 落盘后以 **75** 退出,
  `--restart unless-stopped` 把入口再拉起来,入口**优先执行托管路径**。没有这个
  变量(例如旧镜像的入口、或者笔记本上手工 `node runner.js`)时,Runner 自己变成
  shim:释放本机资源后 spawn 托管路径的新构建并等待;新构建 30 秒内死掉则回退到
  自己原来的文件并关掉自更新,日志会说明。
- **不必重建镜像就能把一台旧 Runner 拉到新版本**(旧 Runner 没有自更新代码,只能
  人工换一次):经 Runner `exec` 或 ssh 在容器里执行
  `cp <新 standalone.js> /work/octopus/packages/runner/dist/index.js && kill 1`,
  容器重启后跑的就是新构建,之后的版本由它自己跟进。旧镜像的入口仍先执行
  `dist/index.js`:它会下载一次当前 bundle 并以 shim 身份带起托管路径;重建镜像
  (`install.sh`)后入口直接执行托管路径,不再有这一次下载。
- 关掉某台设备的自更新:`RUNNER_SELF_UPDATE=0`。dashboard 的设备列表带
  `bundle_sha` / `bundle_current`,能看出谁还没跟上。

## 负载预算(2026-08-22)

这台机器 48 核,但它同时是 GitLab runner、sshd 和实验室其它用途的宿主。08-22 05:00–05:15 三张票
同时做工作区同步(各一次 `pnpm install` + 三个包构建)把它打到负载 48:Runner 的事件循环静默近一分钟
(网关判离线),sshd 的密钥交换卡过 `LoginGraceTime`(120s 后被服务端关闭)。四道约束:

- **并发**:`selfhosting.ci_machine.sync_concurrency`(默认 1)限制同时进行的工作区同步;落地门禁
  本就由合并锁串行。
- **优先级**:同步的 install/build 以 `nice -n 10 ionice -c 3` 跑;门禁步骤 `setsid nice -n 5`;
  容器里 Runner 执行的每个 `exec`(agent 的 machine_exec)按 `RUNNER_EXEC_NICE=10` 降级
  (`install.sh` 通过 `OCTOPUS_CI_EXEC_NICE` 设置;0/不设 = 关)。
- **配额**:`install.sh` 在 daemon 报告支持 CPU CFS 配额时用 `--cpus ${OCTOPUS_CI_CPUS:-24}`(默认一半核)
  创建容器,可选 `--memory $OCTOPUS_CI_MEMORY`。**val15 当前的 rootless Docker 没有委派 cpu 控制器**
  (`docker update --cpus` 报 "NanoCPUs can not be set",08-22 实测),要先在宿主上给用户 slice 委派
  cgroup v2 的 cpu 控制器(`/etc/systemd/system/user@.service.d/delegate.conf`:`Delegate=cpu cpuset io memory pids`,
  需要 root)才能生效;在那之前靠 nice/ionice 与并发上限。
- **不再用 ssh 刷它**:Runner 离线时默认不再回退到经堡垒机的 `sync-workspace.sh`
  (`ci_machine.ssh_fallback: true` 可恢复);工单登记等待,Runner 回来即收到通知。
