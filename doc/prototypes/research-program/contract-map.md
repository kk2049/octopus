# Fieldnote：C1/C2 契约映射

## 结果与 View profile

采用 **hybrid**：项目身份、项目导航、主导 Agent/文档、历史和接入说明使用 bespoke shell；聊天正文、思考/工具折叠、Markdown 排版和文件意图继续复用 `@claude-bot/agent-sessions-view` 的 `TranscriptView` 以及 Agent View SDK 的安全 Markdown renderer。没有复制 Session Plus 的 transcript、文件意图或 Markdown 主体代码。

每个资助科研项目对应一个 `shared` App instance。实例 key、当前用户和角色只来自可信外层；View 与动作参数不携带项目 id、用户、成员资格、批准状态、设备、宿主路径或 capability。共享实例成员目录就是项目授权门，项目事件流就是隔离的数据分区。跨项目目录与成员邀请留在可信实例选择/成员面；一个已打开的 View 只接收当前项目数据。

当前平台的 declared shared App 不能直接组合账户级 `agent-sessions/v1` 与 workspace resource binding。因此 C2 没有伪装成实时 Session Hub：它保存的是由项目成员或已绑定 Agent 明确发布的、大小有界的项目镜像。Agent 走现有第一方 Apps MCP / `external-app-host/v1` 的同一份 manifest action surface；真实会话、目录和 token 仍留在原信任域。

## 原型状态到权威数据

| 原型状态 | C2 权威来源 | View-local 状态 |
|---|---|---|
| 项目身份、生命周期、查看者角色 | shared instance 的 viewer-scoped projection | 无 |
| Agent、workspace、session 列表 | `publish_agent_update` 事件折叠出的项目内稳定 key 与安全标签 | 搜索、当前选择、滚动 |
| 会话 transcript | `publish_chat_message` 的有界消息镜像；复用 `TranscriptView` 呈现 | turn fold、滚动锚点 |
| 状态文档 | `publish_document` 的安全 Markdown 镜像与显示路径 | 当前文档选择 |
| 当前主导 Agent/文档 | `set_lead_agent` / `set_lead_document` 事件 | 无；初次打开从绑定值选择 |
| 两类主导历史 | 同一项目事件流；操作者与时间由 coordinator 盖章 | 展开与视图 tab |
| 成员与角色 | shared-instance membership directory | View 不接收成员表；只显示可信外层入口说明 |
| 提议处理中/拒绝 | proposal ledger + bounded refusal | 保留候选与原因，按 rid 对账 |
| 归档/只读 | 项目事件流 + viewer role | 无；移除写控制 |

项目工作区的 `workspace_key` 与文档 `path` 都只是 App-local equality/display claim，不是 Runner workspace id、真实路径、资源 ref 或能力。消息文件意图只能选择当前投影中路径唯一匹配的已发布文档；零匹配时明确说明没有读取工作区，多匹配时要求人明确选择。

## 精确动作表

| 用户/Agent 意图 | 动作与参数 | 角色与业务门 |
|---|---|---|
| 设置项目资料 | `configure_project(title, funding_label, summary)` | Owner、human-only |
| 登记 Agent 最新会话 | `publish_agent_update(agent_key, agent_label, provider, workspace_key, workspace_label, session_key, session_title, status)` | Owner/Member；项目归档后拒绝 |
| 追加会话镜像消息 | `publish_chat_message(session_key, role, text)` | Owner/Member；session 必须已登记；时间与作者不用参数表达 |
| 发布/替换现状文档 | `publish_document(document_key, path, title, summary, body, workspace_key, workspace_label)` | Owner/Member；path 只作显示；正文安全 Markdown |
| 切换主导 Agent | `set_lead_agent(agent_key, session_key, reason)` | Owner/Member；session 必须属于该 Agent；追加历史 |
| 切换主导文档 | `set_lead_document(document_key, reason)` | Owner/Member；文档必须已发布；追加历史 |
| 归档项目 | `archive_project(confirm=确认, reason)` | Owner、human-only；冻结其它写入 |
| 重新开放 | `reopen_project(confirm=确认, reason)` | Owner、human-only；显式可逆 |

动作全部来自 `app.yaml` 的一份声明。View 的按钮、Apps MCP 的 schema 派生、参数归一化、共享实例成员门与 runtime handler 没有平行词表。Agent principal 看不到 `human_only` 动作，直接猜动作名也会在 door 被拒绝。

## 角色与披露

| 角色 | 可见数据 | 控制 |
|---|---|---|
| `owner` | 当前项目的安全镜像、主导值与历史 | 设置资料、发布/绑定、归档/重开；成员管理在可信外层 |
| `member` | 与 Owner 相同的项目工作数据 | 发布状态、切换主导对象；不能管理成员、设置资料或归档 |
| `viewer` | 项目工作数据与有界历史 | 只读 |
| Apps MCP agent | token policy 与 shared membership 求交后允许的 action schema | 只能调用非-human-only 动作；不能声明 owner、role、instance 或批准 |

实际 View open 缺少有效 `viewer.user` 或固定角色时，projection 返回空项目数据而不是只靠 CSS 隐藏。成员邮箱、成员列表、真实 workspace id/path、App instance handle 和 token 均不进入 projection。

## 动作生命周期

1. View 从权威投影显示旧主导值和合法候选。
2. `usePropose` 提交唯一声明动作；proposal in-flight 时禁用同一表单。
3. pending 不改 projection；接受结果也不在 View 合并业务状态，等待 Host 已先发送的新权威帧。
4. refused entry 显示 bounded message 并保留候选/原因；重试前 `dismiss(rid)`。
5. projection 替换时保留人的 session/document 选择；所选稳定 key 暂时缺席则显示占位和“改看最新”按钮，不自动跳项。
6. archived、Viewer 或 closed channel 不提供可成功的写流程；trusted door 仍处理竞态拒绝。

## 复用与未跨越的边界

- 复用：`TranscriptView`、chat neutral CSS、文件意图识别、SDK Markdown、proposal ledger、shared App membership、declared App Apps MCP 派生、external host agent authority。
- 未复用 harness 到发布包；fixture 仅在 `examples/` 与测试 devDependency。
- 未给 generic declared App 偷接 account-scoped session/workspace resource binding。
- 未创建 OS symlink，也未让 View 或 Agent 参数指定真实目录。
- 未在 iframe 中复制成员管理 API；现有可信 shared-instance surface 是唯一成员门。
- 未自动给任意既有 Session 铸造或插入 MCP token。C2 依赖现有受信 token/外部 host 绑定，把 policy 收窄到 app、instance、actions；自动化这一绑定需要独立的可信 session-to-instance orchestration，而不是 App runtime handler。

## C2 验收结论

- Owner/Member/Viewer、empty、archived、closed、pending、refused、stale selection 均有明确呈现或测试。
- 参数候选来自当前 projection；runtime 重新检查项目内候选与归档状态。
- 文档 HTML 保持纯文本，URL/path 不变成资源能力。
- 真实 preview 在 1440px 与 390px 检查；主导航、双主导层级、chat/document 双栏与窄屏顺序保持。
- 构建与 pack 真实完成；包为 7 个资产，单资产在现行 5 MiB 上限内。
