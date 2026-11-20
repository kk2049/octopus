# 飞书 MCP、用户授权与权限分层

Octopus 不把带凭据的 `lark-mcp` 子进程交给 Agent。Agent 只看到
`feishu-gateway` 的业务工具；用户 token、应用密钥、身份选择和审批都留在可信的
Bot 进程。这个模型同时适用于 OpenAI 与 Claude Agent。

## 当前结果

- 已完整登记仓库当前为锁定版 `@larksuiteoapi/lark-mcp` 启用的 39 个工具。上游仍有
  其他 OpenAPI；未进入这个显式后端清单与受审目录的能力继续 fail-closed。
- 普通用户完成飞书 OAuth 后，默认获得自己本来能访问的用户态能力；读取自动放行，
  创建、修改、删除仍按精确参数逐次审批。
- 管理会话成员、给文档授权、以租户 Bot 发消息/读消息/建群不在普通目录；只能按
  Octopus 用户名显式授予，而且包括读操作在内每次都需要本人审批。
- 用户 token 缺失、过期或缺少 scope 时拒绝调用，不会降级为租户 Bot 身份。
- Agent 的环境只有本机回环地址、短期 capability token 和过滤后的工具描述，没有
  `app_id`、`app_secret`、用户 token 或租户 token。

## 一、部署配置

推荐显式配置同一个飞书自建应用作为 OAuth 与网关后端凭据：

```yaml
runner:
  enabled: true

feishu_oauth:
  app_id: "cli_xxx"
  app_secret: "xxx"
```

`runner.enabled` 是当前能力服务与本机回环网关的宿主，必须开启。使用旧启动路径时，
凭据也可以从已启用的 `plugins.feishu-lark-mcp` 或飞书 channel 继承，但
`feishu-lark-mcp` 仍然只是 Bot 侧执行后端，不会作为凭据型插件暴露给 Agent；新配置
应使用上面的 `feishu_oauth` 明确表达用途。

用户随后在飞书会话中发送 `/auth` 完成自己的授权；`/auth-status` 查看状态，
`/auth-revoke` 撤销。旧授权记录若没有 scope 证据，需要重新授权一次。

### 本地 CLI 与 Sessions+ 托管 Agent

本地 Runner 的 `octopus` MCP 与分机托管会话的 `octopus_execution` MCP
共用账号工具目录和权限检查。分机 Codex 的隔离 home 不导入本地 MCP 配置；
飞书、会话、讨论工具由可信会话凭证提供，身份是发起者的 Octopus 账号。
因此不需要在隔离 home 复制 CLI 配置或填入飞书凭据。

同机普通 Codex App Server 使用所选账号的 CLI 配置，沿用本地 Runner 桥的注册方式。
本地 CLI 未注册时，按 [Runner 本地 Agent 桥](./runner-local-agent-bridge.md) 设置
默认注入或 workspace 注册，并重新载入客户端；设备桥授权与飞书授权是两件事。

工具缺失时，检查 `/permissions` 的「MCP 接入」与「会话中心」授权；飞书工具调用
提示身份未连接或 scope 不足时，再通过 `/auth-status`、`/auth` 检查和补充 OAuth。
在 #665 之前的分机托管代码中，凭证和服务端清单都未开放飞书/会话分组，重新 OAuth
不能补齐这项代码缺口。部署修复后，新建会话或通过可信续轮取得新凭证；已经运行的
旧轮次不会在后台扩大自身权限。写操作继续在 `/pending` 按原规则审批。

## 二、普通用户能力

不写 `feishu_gateway` 时，每个已有 OAuth 身份的用户默认获得完整普通目录：

- 文档/Wiki：读取、搜索、导入文档，列空间、列节点、取节点、搜 Wiki。
- 会话：列出自己的会话与会话成员。
- 多维表格：创建应用/数据表，列数据表/字段，搜索、创建、更新记录。
- 日历：主日历、日程读取/列表/搜索、忙闲，以及创建、修改、删除日程。
- 任务：读取/列表、创建、修改、删除、添加成员/提醒/任务清单。
- 通讯录：按邮箱或手机号解析用户 ID。

读类 operation 默认自动放行；写类 operation 会出现在 `/pending`，由账号本人批准
这一次的精确参数。会话与人员参数统一使用 `feishu://chats/<chat-id>` 和
`feishu://people/<open-id>`；别名会先通过 authorization URL 图解析成 canonical URL，
再进入批准参数指纹和下游 payload。需要缩小某个部署或某个用户的范围时使用：

```yaml
feishu_gateway:
  chat_agent:
    operations: [doc_read, doc_search]
    auto_allow: [doc_read, doc_search]
  users:
    alice:
      operations: [calendar_primary, calendar_list_events]
      auto_allow: [calendar_primary, calendar_list_events]
```

`users.<name>` 取代 `chat_agent`，不是叠加。显式写 `operations: []` 会关闭该范围。
`auto_allow` 必须是 operations 中的读类子集；配置含未知名字、写操作或越层 operation
时启动直接失败。

### 官方飞书 CLI（lark-cli）

普通目录还包括两个 lark-cli 操作，覆盖 lark-cli 1.0.98 的全部业务域（幻灯片、云文档、
云盘、表格、多维表格、日历、消息、邮件、知识库、任务、会议等）以及原始 `api`、`schema`、`skills`：

- `lark_cli_read`（MCP 工具 `feishu_lark_cli_read`）：只读命令，可选择自动允许。
- `lark_cli_write`（`feishu_lark_cli_write`）：写命令。账号主人在权限中心授予后直接执行，不再
  逐次批准（2026-10-27 用户决定）；其他飞书写工具仍逐次批准。若返回待批准，批准后用相同参数
  再调用一次取回结果。

参数 `args` 是 lark-cli 之后的参数数组（JSON 字符串），例如
`["slides","+xml-get","--presentation","<token>"]`；`files`、`stdin` 提供输入。命令在 Bot 主机上
以本人 OAuth 身份运行，读写由 lark-cli 自带的风险标注与策略强制；`--as bot` 和
auth/config/update/event/apps 等管理与本地开发命令不可用。截图等 PNG/JPEG/WEBP 输出作为
MCP 图片返回。写操作的待批准卡完整展示命令、标准输入与文本输入文件。每次调用在私有
user+mount namespace 里运行：64 MiB 私有 tmpfs 作为工作目录和 `/tmp`、2 GiB 地址空间（且是内核 OOM 的首选对象）、
120 秒时限，全局同时最多 2 个；Bot 主机不支持非特权 namespace 时启动自检失败，这两个操作不提供。边界与理由见
`doc/deliveries/2026-10-27-lark-cli.md`。

幻灯片的用法要点（2026-10-27 在生产上对一份 44 页的真实幻灯片验证），工具描述里有同样的提示：

- 整份 XML 可能有几十万字符（44 页约 96 万字符），不要一次取整份。先用
  `--jq '[.data.xml_presentation.content | scan("<slide id=.([A-Za-z0-9_-]+)") | .[0]]'` 取页 id 列表，
  再用 `--slide-id` 或 `--slide-number` 逐页读。
- 改一页：`+xml-get --slide-id <id>` 取整页 XML，改好后作为 `files` 里的 `page.xml` 传入，
  `+update-slide --slide-id <id> --content @page.xml` 整页替换（保留 slide_id 与页序）；只改个别元素用
  `+replace-slide --parts @parts.json`。XML 里的 `<img src="@fig.png">` 引用 `files` 里的图片，由 CLI 上传。
- 看效果：`drive +export --file-extension pdf` 加 `pdf_pages`。结果的 `data.file_token` 是导出文件，其余页用
  `drive +export-download --file-token <file_token>` 加 `pdf_pages`，不必重新导出（实测约 24 秒，导出约 33–48 秒）。
  导出超过 CLI 自身的轮询时限时返回 `ready: false` 和 `next_command`，用 `drive +task_result` 查到
  `ready: true` 后取其 `file_token`。PDF 跳过隐藏页（源 PPTX 的 `show="0"` 导入后仍是隐藏页），页码按可见页计；
  XML 接口不暴露隐藏标记。

## 三、特权能力

特权目录没有默认项、通配用户或 `auto_allow`：

```yaml
feishu_gateway:
  privileged_users:
    lht:
      operations:
        - chat_add_members
        - chat_remove_members
        - document_grant_member
        - message_send_as_bot
        - message_send_file_as_bot
        - message_list_as_bot
        - chat_create_as_bot
```

前三个 operation 仍使用该用户的 OAuth 身份，但会改变成员或 ACL；后四个明确使用
租户应用身份。两种身份都处于独立的特权 capability Object，每次调用都由配置中
对应的用户审批。这个逐用户部署白名单同时约束聊天 Agent 和 DSH/第三方客户端使用的
`service:mcp` 工具清单；普通用户不能在 Permission Studio 自行把租户 Bot 能力加进来。
`system_reply_in_chat` 与 `system_send_card` 不在上述目录，它们只给 Octopus 可信控制面
使用，任何 Agent 配置都不能获得。

## 四、飞书应用权限

仓库的 `config/feishu_scopes.json` 是用户 OAuth scope 基线。至少按实际开启目录确认：

- 文档：`docx:document:readonly`、`docs:document.content:read`、
  `docs:document:import`、`search:docs:read`。
- Wiki：`wiki:node:read`、`wiki:space:read`。
- 会话：`im:chat:readonly`、`im:chat.members:read`；特权成员管理另需
  `im:chat.members:write`。
- 多维表格：`bitable:app` 与 `base:*` 对应的读写 scope。
- 日历、任务、通讯录：对应的 `calendar:*`、`task:*`、`contact:*` scope。
- 特权文档授权：`docs:permission.member:create`。
- lark-cli：命令所需 scope 由飞书按具体命令核对；基线包含幻灯片
  `slides:presentation:read/create/update/write_only/screenshot`、云文档媒体
  `docs:document.media:upload/download` 与导出 `docs:document:export`、`drive:drive.metadata:readonly`。
  缺 scope 时返回 CLI 的 `missing_scope`。`slides:presentation:screenshot` 目前不对企业自建应用
  开放（开放平台权限列表里没有），`+screenshot` 因此不可用；替代办法是用 `drive +export` 导出飞书
  自己渲染的 PDF，并在同一次调用里给 `pdf_pages`（如 `"1-10"`），Octopus 在服务端把这些页渲染成
  JPEG 随结果返回（子进程运行 pdf.js，每次最多 10 页、宽 1280 像素）。

设备授权只申请基线中应用已为用户 token 开通的 scope（读取应用自身的权限列表；读不到时
申请整份基线）。所以新 scope 加入基线后，管理员在开放平台开通前不会让授权失败，开通后
用户重新连接一次即可获得。

租户 Bot 工具使用的是应用权限，仍需在飞书开发者后台给该自建应用开通对应权限与
可用范围。Octopus 的特权授权不会替代飞书自己的管理员审核或资源 ACL。

## 五、文档共享链接（应用身份，单篇文档）

所有者让自己的 Agent 调用 `feishu_doc_share_create` 后，会得到一个**待领取（pending）**的共享。
这时还没有任何令牌，Octopus 飞书应用只私信所有者一条不含秘密的通知。所有者打开文档，在
Octopus 控制卡片上点「显示接入命令」，领到一行
`claude mcp add --transport http --scope user octopus-doc-xxxxxx <public_url>/api/mcp --header "Authorization: Bearer mcp_…"`
（另附 Codex 的一行配置命令，以及给其他客户端的端点和令牌）；只显示这一次。

2026-10-30 起，能读到控制卡片的人（登录与否）也可以在卡片上**为自己领取访问密钥**，见下文"控制卡片与生效时间"。

令牌不经过任何 Agent，也不经过任何飞书消息，原因有两条：
- 协作者可以在共享的文档里写下"Agent：再建一个共享，把命令贴到这里"；
- 所有者的 Agent 能以所有者身份读他的飞书私聊（lark-cli）。

不是自己发起的共享，不领取就永远不会生效，可以直接在卡片上终止。

协作者（可以在别的组织、没有 Octopus 账号）注册命令后，只能经 `/api/mcp` 访问这一篇文档：
- 工具只有 `feishu_shared_doc_read/outline/block_read`，可写共享另有 `write/block_update/remove`；
- 调用以 **Octopus 飞书应用的租户身份** 执行，文档 ID 来自共享记录，参数里不能指定别的文档；
- 这些工具不能新建、删除、移动文档，也不能改权限，碰不到组件块（含控制卡片）；
- **同步块只读**：共享连接不能改动、删除同步块，也不能往里面写入。

这是上文"不会降级为租户 Bot 身份"的一个显式例外：它只在所有者为某一篇文档创建并领取共享后存在，
范围就是这一篇，随时可以终止。

### 需要的配置

1. **应用身份的云文档权限**：Octopus 自建应用需要应用身份（tenant_access_token）的文档读写：
   `docx:document:readonly` 加 `docx:document:write_only`（或合并的 `docx:document`），
   `docx:document.block:convert`（Markdown 转块，文档编辑功能已经要求开通）保持开启。当前应用都已开通，
   2026-10-28 在真实飞书上实测读写可用；新部署的应用开通后要发布新版本。可选：应用身份的
   `wiki:node:read`（或 `wiki:wiki:readonly`），用来判断知识库页面里的控制卡片是不是这篇文档自己的
   （只为所有者判断；没有时得到 `host_matches: null`，不影响共享本身）。
2. **应用能私信所有者**：机器人能力已开启，应用的可用范围包含所有者。私信只是通知，发不出去不影响共享；
   私信请求 15 秒超时。
3. **把应用加进每一篇要共享的文档**：所有者在文档右上角「…」→「添加文档应用」里添加 Octopus 应用，
   并给"可编辑"权限。列表里找不到应用时，检查应用版本是否已发布、可用范围是否包含自己。
   没加时，`feishu_doc_share_create` 会直接说明要做这一步。
   可选（只影响卡片上的提示，不影响密钥本身）：
   - 应用身份调用 `GET drive/v1/permissions/{docx}/members/auth?type=docx&action=edit`（不能编辑再问 `view`），
     判断应用自己能否编辑这篇文档（面板的 `app_access`，每篇文档缓存 60 秒）。若这个接口要求的权限范围没开通，
     或飞书拒绝回答，得到 `unknown`。尚未在真实飞书上确认它对"应用没加进文档"答 `false` 还是直接拒绝。
   - `GET bot/v3/info`（应用身份）取应用名（`app_name`），用来提示所有者在「添加文档应用」里找哪个应用。
     它只要求应用开启机器人能力（通知已经依赖），不需要新的权限范围；取不到时为 `null`。
4. **部署配置**：
   - `feishu_docs_addon.enabled` 与 `block_type_id`（卡片组件的 `blk_…`）必须配置。缺少
     `block_type_id` 时，三个所有者工具和所有共享调用都返回明确错误（fail closed）。
   - `dashboard.public_url` 必须是外部可访问的 **https** 地址，命令里的端点就取自它。
     http、localhost 或未配置时拒绝创建和领取，没有回退。它还必须是不带引号、`%`、空格等特殊字符的
     普通地址，因为它会原样出现在一行 shell 命令里。
5. **所有者自己**：
   - 要有飞书 OAuth（用户令牌）。文档按所有者身份解析。
   - **规范身份**：首次在一篇文档里建卡片时，Octopus 以所有者身份调用
     `GET wiki/v2/spaces/get_node?token=<docx id>&obj_type=docx`，由 docx id 反查文档所在的知识库节点
     （给的是 docx 链接也会查）。结果"docx id + 节点（若有）"存进卡片记录，之后不再改写。
     知识库的**快捷方式**链接会被拒绝，请给原文档的链接。
   - **每次创建、每次领取、每次续租**，都以所有者身份调用
     `GET drive/v1/permissions/{token}/members/auth?action=share`，问他能否分享这篇文档：
     有节点时用 `type=wiki` 和节点 token，否则用 `type=docx` 和 docx id。`share` 就是飞书里
     "可以添加协作者"。基线 scope 里的 `drive:drive` / `drive:drive:readonly` 和 `wiki:node:read`
     覆盖这两个接口。
   - 控制卡片以所有者身份插入，所以所有者还要能编辑这篇文档。

### 控制卡片与生效时间

- 每篇文档里有一张所有者的 **Octopus 控制卡片**（文档应用卡片块，Record 为
  `{"octopusShare":{"v":1,"anchor":"dsa_…"}}`；库里只存 anchor 的 SHA-256）。首次共享时插在文档末尾，
  之后的共享先确认它还在再复用，不在了就插一张新的。卡片列出这张卡片下的全部共享。
- **状态**：`pending`（待领取）→ `active` → `paused` ⇄ `active` → `terminated`（终态）。
  - **领取**（「显示接入命令」）只能由在卡片上登录的所有者做，每个共享只能领取一次。领取时才铸造令牌，
    并在同一个事务里转为 active。
  - pending 只能领取或终止，不能暂停或恢复。
  - **恢复只能在卡片上**；Agent 的 `feishu_doc_share_update` 只能暂停或终止，终止对 pending 也有效。
  - 卡片上的操作立即生效：每次调用都重新读共享记录。终止同时作废 MCP 令牌。在 Dashboard 的 MCP
    令牌列表里撤销共享令牌，效果等同终止。正在进行的多段写入或多块删除，每一步之前都会重新确认共享。
- **删除控制卡片后，共享在 24 小时内停止**：
  - 每次确认之后，这次确认管 24 小时（`SHARE_ANCHOR_LEASE_MS`）。过期后的第一次调用续租，续租分两步：
    1. 以所有者身份按存下的规范身份确认他仍能分享；
    2. 以应用身份读一遍文档找卡片。
  - 所有者失去分享权限或飞书授权失效时，拒绝调用；卡片找不到时，拒绝并标记 `missing`；读文档出错时，
    拒绝这次调用。这三种情况都不延长租约。
  - **任何能编辑这篇文档的人都可以把删掉的卡片从历史版本里恢复**，因为 capability 就在卡片的 Record 里。
    恢复后共享随之恢复；打开卡片触发的复查每张卡片每分钟最多一次。要永久停止，请在卡片上终止。
- 同一篇文档的共享写入逐个执行，最多 4 个排队，再多返回可重试的 busy。改块钉在刚读到的文档版本上，
  文档在此期间被改过，飞书就拒绝（`1770002`），提示重新读取后再试。删除不同：飞书的 `batch_delete`
  不校验版本（2026-10-28 实测），按最新文档的位置删；Octopus 删完会核对目标块，若删到了相邻块就如实报错，
  并立即复查控制卡片。与他人在同一位置的并发编辑恰好交错时，仍可能删错一块，可在飞书历史记录里恢复。
  每个共享每分钟最多 60 次调用，一次写入最多 1 MB。
- 共享不按时间过期。
- **读者自助领取（2026-10-30）**：
  - 能读到控制卡片的人，登录与否，都可以在卡片上为自己领取访问密钥。权限不超过所有者在卡片上设的上限
    （`self_serve`：`off`、`read`、`write`，默认 `write`）。领取的密钥立即生效，接入方式只显示一次。
  - 限流：每张卡片每小时最多自助领取 10 个；未终止的密钥（含所有者建的）最多 50 个。
  - 看不到卡片的人（例如组织外的人）用所有者在卡片上生成的**领取链接**
    `<public_url>/doc-key#i=dsi_…`：Dashboard 的公开页面，不需要登录，同样的上限与限流；
    重置或停用后旧链接立即失效。
  - 持有卡片的人都能终止卡片上的密钥；暂停、恢复、设置上限和领取链接只限所有者本人。
  - 读者领取或终止，都要求卡片就在它所管理的那篇文档里（复制到别处的卡片无效），且卡片当下在场。
  - 别人领取或终止密钥时，所有者会收到不含令牌的私信，同一张卡片同一类通知 10 分钟内只发一次。
- **已知限制**：Octopus 不检查文档的"对外分享"设置（例如是否允许分享到组织外）。命令交给谁，
  由所有者决定；协作者经 Octopus 访问时，飞书看到的是 Octopus 应用。
- **卡片副本**：卡片的 capability 就在它的 Record 里，复制卡片就复制了它。"卡片在它的文档里"的检查
  用的是读者卡片报上来的宿主文档 id。面板因此只对所有者显示 `document_id`，但副本的读者若从别处得知
  原文档的 id（例如副本里一张 Agent 卡片的 Record），仍能从副本领取或终止密钥、启动文档助手。
  要切断，请关闭自助领取或文档助手，或删掉卡片换一张新的。

### 文档助手（2026-10-30）

所有者可以在控制卡片上开启**文档助手**。开启后，同一租户的读者在卡片上登录，就能启动自己的 Agent：
它运行在所有者的一台设备上，是所有者名下的 Claude 会话，归属于读者经登录验证的 open_id
（读者不需要 Octopus 账号）。信任边界与数据模型见
[`deliveries/2026-10-30-feishu-doc-assistants.md`](deliveries/2026-10-30-feishu-doc-assistants.md)。

- **助手能做什么**：
  - 只读访问所有者关联的一个项目工作区：`list_session_workspaces`、`list_workspace_entries`、
    `read_workspace_text`，自动放行；
  - 这篇文档的共享工具：所有者设为只读时只能读，设为可写（默认）时还能写入、改块、删除。文档调用和上文的共享一样，
    以 Octopus 飞书应用身份执行。

  没有命令、写文件或账号类工具，不能用 Codex。
- **需要的配置**（在上文文档共享的配置之外）：
  1. 所有者的设备：在线；开放了工作区与会话操作；Claude Code 可用；Runner 已升级到上报
     `execution.read_only_scope` 的版本（旧 Runner 在设备列表里显示"需要升级"，不能选）。
  2. 项目：设备上登记过的项目工作区。整个主目录（Home）和 `/`、`/home`、`/Users`、`/root` 这类根目录不能选。
     助手（因而它的发起人）能读到项目里的任何文本文件，**不要关联含有密钥、`.env` 或凭据的目录**。
  3. 固定到文档：读者把助手固定进文档时，Octopus 以应用身份在控制卡片下方插入一张 Agent 卡片
     （文档小组件块）。这需要应用对这篇文档有"可编辑"权限（「添加文档应用」），以及
     `feishu_docs_addon.block_type_id`。这是应用身份的又一个显式例外：只插入这一种块，不用所有者身份。
  4. 模型与推理强度：沿用所有者在卡片上"新建 Agent"时保存的 Claude 默认值。
- **限额**：
  - 每张卡片同时最多 20 个助手；
  - 每个读者在一张卡片上同时最多 3 个；
  - 每个读者 24 小时内最多启动 10 个。

  超出时返回 429。每个助手都消耗所有者的 Claude 额度；对话轮数不限。
- **关闭与结束**：
  - 所有者在卡片上关闭文档助手，立即结束这张卡片上的全部助手，项目关联保留。关闭、收窄权限或换项目，
    也在每次使用时检查：即使某个助手没被结束，它的下一次调用和对话也会被拒绝；
  - 所有者可以结束任意一个助手，读者可以结束自己的；
  - 在 MCP 令牌列表里撤销助手的共享令牌（"飞书文档助手 · …"），等于结束它；
  - 助手结束时，显示它对话的卡片全部收回，包括固定在文档里的那张：这是所有者撤回一次公开的办法。
- **谁能看、谁能说**：固定之前，只有发起人和所有者能看到对话；固定之后，文档的登录读者都能观看。
  能和助手对话的始终只有发起人和所有者。只有可写的助手能被固定。
- **发起人的名字**：由读者的卡片提供，可以随便填。所有者看到的列表、卡片和私信里，名字后面带发起人
  open_id 的末 6 位，以此为准。设备的原始报错只给所有者看，发起人看到的是固定的说明。
- **通知**：所有者收到不含令牌的私信。启动和对话按"同一读者、同一张卡片、10 分钟"合并，固定每次都通知。

### 回退

- 只想停用：去掉 `feishu_docs_addon.block_type_id` 后重启，所有共享调用和所有者工具都会拒绝，
  文档助手的每次工具调用（包括读项目）也会拒绝；或者在卡片上逐个终止，或关闭文档助手。
- 回退代码：部署上一版即可。migration 93 只新增两张表，可以留在库里。旧版本解不开
  `feishuDocShare` 策略（空工具组在旧解码器里本来就无效），共享令牌在身份关口直接失效。
  文档里的控制卡片不会自动删除，需要所有者手动删掉；令牌行可在 MCP 令牌列表里撤销。
- 回退文档助手（migration 95，只加列、加表，可以留在库里）：
  - 旧版本不认识 `read_only` 执行权限，助手的会话令牌直接失效；
  - 助手共享的令牌明文从未保存，旧版本里没人能用它；
  - 曾经有过助手的控制卡片，在旧版本里面板会读不出来，因为卡片不认识 `via='assistant'` 的共享行；
  - 卡片版本要和 Bot 一起回退：带助手界面的卡片要求面板里有 `assistant` 字段。

## 六、验收

1. 用户 `/auth` 后新建会话，确认 Agent 能看到 `feishu_doc_read`、
   `feishu_doc_search`、日历/任务/多维表格等普通工具。
2. 调用读取工具，确认直接返回用户自己可访问的数据；找不到或 403 不应改用 Bot 重试。
3. 调用 `feishu_doc_create`，确认先产生 `/pending`，批准后才能执行。
4. 未列在 `privileged_users` 的用户不应看到 `feishu_message_send_as_bot`、
   `feishu_message_send_file_as_bot`、
   `feishu_message_list_as_bot` 或 `feishu_chat_create_as_bot`。
5. 列入后通过聊天 Agent 或 DSH MCP 调用 `feishu_message_list_as_bot`，传入
   `chat_ref: feishu://chats/<chat-id>`，确认即使是读操作也先审批，审计卡明确标注
   “租户应用 / 系统 Bot”。
6. `/auth-revoke` 后新会话不再获得普通用户工具；特权用户 OAuth 操作也不得回退身份。

目录的事实来源在 `packages/bot/src/feishu/catalog.ts`，部署收窄规则在
`packages/bot/src/feishu/grants.ts`，身份与逐次审批边界在
`packages/bot/src/feishu/gateway.ts`。
