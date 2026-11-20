# 控制节点使用远端完整发布包

正常入口仍是工单“上线”或 `scripts/ops/deploy.sh v4`，落地仍走 `scripts/ops/land.sh`。远端发布不改变部署授权、精确水位、知识裁决、入口检查、排空和健康门。

部署管理员同时配置：

```yaml
selfhosting:
  deployment_build:
    mode: remote
    execution_devices: [gpu-box]
  ci_machine:
    owner: lht
    device: octopus-ali-4090-ci
    checkout_dir: /work/octopus
    workspace_id: <已注册的工作区 ID>
    remote_required: true
  build_warm: false
```

服务自己的 supervisor 环境使用 `SUP_RELEASE_MODE=artifact`，`SUP_REFERENCE_REPO` 指向主参考仓库。只修改服务配置，勿设置全局 shell/agent 规则。构建 provider 须支持 `workspace-jobs/v1` 以及 `workspace_job_artifact`；先升级选定的隔离 Runner，核对设备和工作区，再切换发布模式。

控制端每 30 秒检查一次新的 v4，按精确 SHA 串行准备完整发布包；不创建部署意图，也不自动切换生产。保存的工单执行设备与显式映射决定能否使用此构建 provider，真正部署时再次核验。远端完成冻结依赖安装、完整构建、全部仓库 App 打包和原生依赖探测后，产生绑定 commit、Node 版本、ABI、lockfile 和文件摘要的清单。控制端按摘要限速接收缺失的依赖/输出包，提前解包到完整目录。网页 /api/deploy.preparation 显示对应 SHA 和状态；只有 ready 才允许点击上线。原任务未知时只查询，不能换 ID 隐藏失败或重复执行业务任务。

提前准备阶段将包安装到 `releases/trees/<sha>`。点击上线后 supervisor 快速核验已暂存标记，执行有界数据库在线备份，再排空并切换稳定运行目录指针。构建/下载/解包均已完成，但数据库备份、排空和真实启动健康门仍需要时间，不能把 ready 当成已经上线。重启恢复使用原清单和上一完整目录；失败不执行本机 install/build。完整版本重启继续使用 `scripts/dev-restart.sh`，它识别发布标记并跳过构建。

排查顺序：

1. `/api/deploy` 的原部署 ID、目标 SHA 和状态。
2. 运行数据目录下 `deploy-artifacts/preparations/<sha>.json` 的提前准备状态，以及 `deploy-artifacts/intents/<id>.json` 的 provider、jobId、错误和接收字节数。
3. 同一 Runner 原任务 receipt/log；分清远端任务仍运行、设备离线和产物传输中断。
4. `deploy-artifacts/manifests/<sha>.json` 与 `objects/<digest>.tar.gz`；不手动把未完成目录标记 ready。
5. supervisor 日志、当前运行链接及上一 `.octopus-verified` 目录。只读传输支持原偏移续接；安装失败保留旧进程。

从控制节点创建开发源码树时使用 `OCTOPUS_SOURCE_ONLY=1 scripts/ops/worktree.sh dev/<owner>-<topic>`。依赖安装和测试在注册执行工作区运行。CLI 知识上下文使用现有 `--graph`，不在控制节点隐式新建图谱。

默认 `SUP_ARTIFACT_KEEP=2` 保留两个完整版本，当前、上一回滚版本、v4 和活动部署引用的版本额外保留。正常准备直接安装，旧版本清理在准备完成或服务启动后的 60 秒空闲窗口异步执行；活动部署时最多延后 30 分钟。只有磁盘空间不足时，准备入口等待一次有界清理再检查空间。清理每批最多处理 64 项，并在批次之间释放维护锁；新安装取得锁后清理立即让路，不能让递归删除占住整个安装等待路径。清理只操作本协议记录的完整 release worktree 和无引用产物；未知目录留待检查。不要通过删除当前/回滚目录回收空间，也不要把运行数据、模型或登录目录打进发布包。

## Head 资源边界

Head 的 supervisor 环境必须设置 `OCTOPUS_RELEASE_SYSTEMD=1`。`release-job.sh` 使用相互独立的资源配置；两者均无 swap、nice 15、idle I/O、45 分钟外部截止，Python 内部截止 40 分钟。权限或 systemd 失败不能绕过预算执行。

| 配置 | 安装 staging | 清理/备份 maintenance |
| --- | --- | --- |
| CPU 上限（相对于单核） | 125% | 25% |
| MemoryHigh / MemoryMax | 512 MiB / 768 MiB | 256 / 384 MiB |
| 块读取 / 写入 | 16 / 8 MB/s | 8 / 4 MB/s |
| 读取 / 写入 IOPS | 700 / 500 | 200 / 100 |
| Python 逻辑字节 / 条目 / CPU | 16 MiB/s / 500 项每秒 / 1.25 核 | 4 MiB/s / 250 项每秒 / 0.25 核 |

staging 按服务容器自身 cgroup（读 32 MB/s、写 16 MB/s、1400/1000 IOPS、2.5 CPU）的约一半标定（2026-10-15）。
安装前还检查容器根 cgroup 的 `io.max`：快速配置必须在读取/写入吞吐与 IOPS 四项都给前台至少保留相同的额度，父层太小自动选 maintenance，并把实际 profile 记入安装回执。
4090 发布构建不经过这些预算：`release-index.py` 在专用发布容器内运行，资源边界是该容器自己的 cgroup。单独提高子进程限额无法绕过父层总额，也不能保证前台优先。

安装配置可用 `OCTOPUS_RELEASE_STAGING_PROFILE=maintenance` 回退到较小配额。Node 接收/校验默认 16 MiB/s。所有逻辑限速使用实际经过的时间支付预算，最多保留 100 ms 空闲额度；真实 I/O 已经慢于目标时不会再逐文件附加完整睡眠。`nice`/`ionice` 仅为辅助，不能替代这些预算。配置前核对实际 `cpu.max`、`io.max`、`memory.events`；路径默认 `/home/ubuntu/lht`，systemd 应解析至真实整盘，不能仅凭配置文件宣称限额生效。

安装阶段在 `deploy-artifacts/preparations/<sha>.install.json` 持续记录 PID、启动 ticks、固定 SHA、阶段时间、处理字节/条目、显式睡眠时间及 cgroup 计数。主接收状态保留在 `<sha>.json`，后台清理在 `deploy-artifacts/maintenance.json`；`/api/deploy.preparation` 合并这些证据，网页可展开查看。相同 SHA 的快速复核和重复调用不覆盖首次安装耗时。时间是具体阶段的墙钟时间，累计计数字节包含多遍校验，不是网络传输量。

测试/非 systemd 执行环境默认使用 Python 内部预算和 nice/ionice；生产 Head 不得只依赖优先级。主 Bot 的 Node old-space 默认上限 768 MiB，可用 `SUP_NODE_HEAP_MB` 配置；该值不是整个容器的内存限额。飞书 MCP 的完整目录本身较大，不能盲目设置 384/640 MiB heap：只用于启动目录审计的子进程审计后立即退出，实际调用仍保持身份隔离和既有空闲回收。

准备失败保留旧进程。`failed`/`unknown` 不自动换任务重试；先核对对应 Runner receipt、资源预算和完整性，解决原因后由运维显式恢复该 SHA 的准备状态。删除/修改 readiness marker 不是恢复办法。发布过程中应同时观察宿主 MemAvailable、磁盘队列/await 和容器 memory.events；不能把容器空闲等同于整机有余量。


## 已校验依赖层与恢复

`releases/dependencies/<key>` 保存生产专用的只读依赖层，key 同时绑定依赖包摘要、lockfile、Node 版本、ABI、平台与架构。4090 构建端从最终依赖压缩包生成逐文件 SHA-256 索引，放在 outputs 包内的 `packages/bot/dist/release-dependency-index.jsonl`；清单的可选 `dependencyIndex` 同时绑定索引摘要、大小、依赖包摘要与展开总量。原有两个压缩包格式保持兼容。

冷准备先校验压缩包，解开 outputs 取得已验证索引，再将依赖安全展开到独有 partial 目录。每项在写入时与 CI 索引比较、立即创建当前版本的私有目录/相对链接及普通文件硬链接，最后封存依赖层。已在本次操作验证的新文件不再全量重读；无 CI 索引的历史包仍在本机生成索引，但同样单遍组装。中断后已有完整缓存走暖路径重验，未完成树不能变成 ready。

暖准备仍检查缓存清单以及每个文件的内容/权限后硬链接普通文件；每个版本仍有自己的可写目录、pnpm/workspace 相对符号链接和独立 dist。共享整个 node_modules 符号链接会改变 Node 的真实路径解析，不属于此协议。共享开发 worktree 的可写 node_modules 也不在此协议内。读取缓存校验和目录创建的成本提前支付；ready 不代表这些成本不存在。

内容变化、锁文件变化或运行时变化都产生新 key。缓存损坏拒绝准备，不能当作普通 miss 静默忽略。运维可显式设置 `OCTOPUS_RELEASE_DEPENDENCY_CACHE=0`，以原始压缩包重新校验并私有解包；先保留错误证据、检查原任务已停止，并沿既有恢复入口处理该 SHA。不要 chmod 共享普通文件来“修复”运行版本：同一 inode 可能被多个保留版本使用。只读权限用于防止误写，不构成隔离同 UID 恶意操作者的安全边界。

清理仅退休有完整身份的无引用层；当前、回滚、主线、活动/准备版本、近期清单及正在接收的摘要均受保护。退休层原子改名后分批删除，未知目录、未完成 partial 与缺乏归属的文件不自动删除。回滚直接使用原完整树；旧版 supervisor 可以读取未改变的 `.octopus-release.json`，不依赖新缓存格式。升级固定 ring0 脚本时必须同步带上 `release-layer.py`、`release-progress.py` 及对应 budget/install/prune/job，不能只替换入口脚本。
