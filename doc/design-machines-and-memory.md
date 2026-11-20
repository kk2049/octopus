# 设计：多机操作能力 + 用户中心化记忆区 + 临时文件回收

> **历史文档。** 记录 2026-07 Runner 与用户记忆能力的早期设计，工具面和可信资源接线已经演进；当前边界读 `.claude/rules/resource-bindings.md` 及相关包级文档。

> 2026-07-20。动机（用户原话）：①私聊 bot 时希望它有一套基础工具，能操作**不同物理机**上的文件与 bash；②每个用户在 octopus 主机上要有**私有文件夹**做中心化记忆（"什么东西在哪台机器、历史上干过啥"），避免某台 laptop 掉线就失忆；③秘书 report 产生的拷贝 buffer 要能**自动回收**。
> 前置：本轮已完成的加固（`baseTools` 显式工具策略、loopback 令牌绑定用户、`path-jail.ts` realpath 隔离）是本设计的安全地基。

## 1. 能力总览与边界

三类"地方"，能力刻意不对称：

| 位置 | 谁的机器 | 给什么能力 | 理由 |
|---|---|---|---|
| **用户自己的 Runner 设备**（laptop/工位机） | 用户本人（runner 以其身份跑） | 全量：`exec`(bash)、读/写/列目录 | 是他自己的机器，token 是他自己装的；bot 只是代他操作 |
| **bot 主机上的用户记忆区** | 共享主机的一小块私有目录 | 仅 jail 化文件读写/检索，**无 bash** | 主机上住着 config.yaml、bot.db、所有人的归档；给 shell 等于给全体数据 |
| **秘书/会议会话** | —— | 维持现状：仅归档目录只读 | 见 design-secretary-mvp；本设计不放宽 |

**一句话安全模型**：跨机器的"危险能力"只施加在**发起人自己的设备**上；bot 主机上人人只有自己的一小格，且没有 shell。

## 2. 多机操作（Runner 侧扩展）

### 2.1 新增 Runner RPC
在现有 `list/digest/search/read/copy_session/copy_file` 之外新增：

| RPC | 参数 | 说明 |
|---|---|---|
| `exec` | `{command, cwd?, timeout_ms?}` | 经 `bash -lc` 执行；默认超时 60s、上限 300s；stdout/stderr 各截断 100KB |
| `read_file` | `{path, max_bytes?}` | 读文本文件，默认上限 1MB |
| `write_file` | `{path, content}` | 写文件（自动建父目录） |
| `list_dir` | `{path, limit?}` | 列目录（名称/类型/大小/mtime） |
| `host_info` | `{}` | hostname/平台/cwd/磁盘概况，供 agent 认路 |

**Runner 侧不做路径 jail**：runner 以用户自己的身份运行在自己的机器上，OS 权限即边界。这与 sessions 调查工具不同——那里 jail 是为了限制"披露范围"，这里用户操作的是自己的东西。

**开关**：`config.runner.allow_exec`（默认 `true`）。设为 false 时 runner 侧直接拒绝 exec/write，仅保留只读。

**审计**：每次 exec 在 bot 侧 `log.info` 记录 `{username, device, command 前 200 字}`，runner 侧同样落 `runner.log`。

### 2.2 新 MCP 插件 `machines`
暴露给**普通私聊会话**（不给秘书会话）：

- `machines_list` — 我的设备清单与在线状态（含 `host_info` 摘要）
- `machine_exec` / `machine_read_file` / `machine_write_file` / `machine_list_dir` — 均需 `device` 参数

插件经 loopback 调 gateway，令牌是本轮加固的**用户绑定 capability token** → 结构上无法触达他人设备；`device` 参数只在本人设备集合内解析，不存在则报"你没有这台设备"。

### 2.3 接线位置
`Router.buildSessionConfig` 中，当 `runnerGateway` 存在且该用户**有已注册设备**时挂载该插件（无设备就不挂，避免给出一堆用不了的工具）。秘书路径走 `focus()`，插件被整体替换 → 天然不继承。

## 3. 用户中心化记忆区

### 3.1 位置与结构
```
<dataDir>/users/<username>/memory/          # 新增，0700
├── MEMORY.md          # 索引/首要事实（agent 每轮自动读取前 N KB 注入）
├── machines/          # 建议约定：一台机器一个文件，记"什么在哪"
└── <任意用户自定义>
```
选 `users/<username>/` 之下，与既有 `workspace/`、`oauth/` 同级，复用已有的 0700 + `ensureOwnership` 机制。

### 3.2 工具（新 MCP 插件 `memory`，或并入 `machines` 插件同一 server）
`memory_read` / `memory_write` / `memory_append` / `memory_list` / `memory_search`（grep）。**无 exec**。

### 3.3 自动注入
每轮 prompt 前，若 `MEMORY.md` 存在则把前 4KB 作为 system prompt 的一节注入（"你对该用户的既有记忆"），使"哪台机器有什么"无需 agent 主动查询即可生效。超出部分靠 `memory_read` 自取。

### 3.4 文件隔离方案（用户点名要方案，这里是裁决）
**三层，主力是第 2 层**：

1. **OS 层（有则更好，非依赖）**：目录 0700 + 属主为用户 uid。仅当 bot 以 root 运行、`uid_isolation` 开启时生效；当前 dev/prod 均以非 root 跑 → **不能作为唯一防线**。
2. **工具层 realpath jail（always-on，主力）**：所有记忆工具经 `path-jail.ts` 的 `resolveForRead/resolveForWrite`，root = 该用户的 `memory/`。已覆盖 `../`、绝对路径、软链接指向外部、经软链接目录写入四类逃逸（本轮已配 11 个测试）。**jail root 由 session 的 `ownerUsername` 在服务端推导，绝不接受 agent 传入的用户名**——这是不可伪造性的关键。
3. **写入形态限制**：只写普通文件，不提供创建软链接/改权限的能力；单文件上限 1MB、目录内文件数上限 1000，避免把主机塞爆。

补充：记忆区**不进 archive、不随 report 披露**（`exportPlainFile` 的黑名单再加 `memory` 目录名，防止用户 `#file:` 误钦点自己的记忆文件外泄给对方）。

## 4. 临时文件自动回收

现状（已核实）：`<dataDir>/archive/<report_id>/` **无任何 TTL**，只在"取代/重起草/取消"三个事件点删除；`workspace/session-<ts>/` 目录里，非 ephemeral 的**从不清理**，ephemeral 的仅在空目录时 rmdir。两处都是无界增长。

**回收器 `maintenance/gc.ts`**，启动后延迟 1 分钟跑一次 + 此后每 6 小时一次：

1. **孤儿归档**：`archive/<id>/` 在 `report_packages` 里查无此 id → 直接删。
2. **超期归档**：报告处于终态（`received/rejected/cancelled/superseded`）且 `updated_at` 早于 `secretary.archive_ttl_days`（默认 7 天）→ 删。
   **例外**：该 id 是某个 `report_rooms.active_report_id`（对齐会还开着，归档是追问弹药）→ 跳过，无论多久。
3. **空会话目录**：`users/*/workspace/session-*` 中**空**且 mtime 早于 24h、且不属于任何存活 session → 删。非空目录一律不动（可能有用户资料）。

每轮 GC 打一条汇总日志（各类删了几个、跳过几个）。全部为幂等的可重入操作；失败只记录不抛。

## 5. 测试策略
- Runner RPC：exec 超时/截断、write 后 read 往返、host_info 字段（core 层单测，不依赖真 WS）。
- machines 插件：device 不属于本人 → 明确报错；token 绑定用户的越权已在 gateway 测试覆盖。
- 记忆工具：jail 逃逸四类（复用 path-jail 用例形态）、大小/数量上限、`ownerUsername` 推导不可被参数覆盖。
- GC：孤儿删除、TTL 未到不删、活跃房间的归档不删、非空 workspace 目录不删（用真实临时目录 + 真 Store）。

## 6. 明确不做（本轮）
- bot 主机上的 shell（见 §1 理由）。
- 记忆区的跨用户共享/授权读（需要新的 ACL 语义，另议）。
- Runner exec 的细粒度命令白名单（用户操作自己的机器，白名单只会碍事；靠 allow_exec 总开关 + 审计日志）。
