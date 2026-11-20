# 内容纠错与来源回流

知识内容修正与管理员设计裁决分别记录。`knowledge_repairs` 只保存有界调查和回放收据，不修改派生图谱，也不批准改变人类强制要求。

## 按批纠错

1. 在节点页报告问题，或通过独立授权的 `knowledge_repairs` 工具 `report`，绑定 `record_id`、`repair_fingerprint`、问题类别。失效锚点每次构建最多收集 20 条；指向明确记录且属于当前图谱的检索反馈也建候选。未指明记录的反馈仍保留在检索审计中，不猜测错误对象。
2. `investigate` 保存完整 KnowledgeChange：原始动机、新动机、行为、替代方案、影响、验证。先在授权来源读取原话，不把整段私有对话复制到图谱或 Git。
3. 通过 Git 修改权威记录，同时在 `architecture/knowledge/repairs.json` 写入原候选身份、调查及 2–4 个回放步骤。批次最多 12 项，必须有正例和反例/未知判断。具体路径问题检索中，Sessions/Agent 等主体名称不能单独证明叙述条目的相关性。步骤复用 journeys 的 query/qrels/forbidden/expected_unknown 语法，以 `J001.1` 起编号；不同修复独立编号。旧批次可归档到 Git 历史，运行台账保留结果。
4. 在隔离验证设备上对已提交版本构图并执行 `pnpm knowledge:repairs --graph <graph.db>`；也可传入匹配的 `--code-index`、`--vector`、`--model`。此命令只提供候选验证报告，不写运行台账。
5. 图谱观察到修复目录后记 `landed`。只有服务当前激活的精确 graph/code/vector generation 完成全部回放，且期间未被替换，才记 `verified`。重启会重新核对；新的 SHA、目录内容或 generation 失败不能沿用旧通过结论。内容纠错页可手动重放，调用不构建、不部署。

按记录内容指纹和问题类别去重。重复 trace 幂等，不同 trace 增加观察次数（每候选最多 1000）；记录内容改变后形成新候选。人工调查不能设置 landed/verified，也不写 knowledge_reviews。

## 工单中的增量来源

`devpipe_context`、新一轮/中途输入和 workspace sync 返回简短提醒。`devpipe_sources` 从最早未处理消息分页，读取原文或保存来源处理草稿；读取游标不等于处理完成。初始消息与同字节原始 prompt 不重复展示。

每条草稿绑定 ref/hash，并分类为 requirement、constraint、revision、question、context、irrelevant。前三类映射 specifications 的完整 statement；不纳入须说明具体理由。已声明的要求漏映射与未分类来源都只以 `knowledge_next_actions` 提示，不阻断 submit，也不会自动升级为规格。已完成 landing 的映射可复用，prepared/aborted 不算完成。草稿只证明 Agent 的申报，无法机械证明自然语言理解。

## 本人的 CLI 来源

单独授权 `manage_knowledge_sources` 后，`knowledge_sources` 可导入一条选中的消息（provider/device/session_id/message_id/source_at/role/text），按本人所有权读取和分页。设备/会话字段是导入者声明的坐标，不能当作可信作者证明。同一坐标的不同字节拒绝覆盖；正文最多 12000 字，每用户最多 2000 条。删除账号时清除其私有导入及确认，重新创建同名用户不能继承旧证据。它不扫描设备、不读取任意 transcript 路径、不接收整段会话，数据不进入图谱或向量输入。

导入始终为 local_import。本人在知识页登录、读原文、亲自填写具体要求或认可的设计后，创建一个新的 human_message 事件（当前作者/时间/确认正文 hash），并保留导入来源指针；不追认历史文件的真实性。普通“好的”不能升级，assistant 来源不能确认。一次只确认具体设计，最多 120 字；不提供批量确认或 MCP 确认动作。

Agent 随后用 `knowledge_sources read` 获取本人已提交的确认事件，原样引用到 provenance.events。工单按 requester、CLI landing 按已认证的落地操作者校验来源；匿名 admin key 不能冒充具名用户。丢失来源、不同 owner、hash/作者/时间/原话不符都会拒绝人类证据。没有可信来源时继续使用 agent_inferred。

所有浏览器写操作经过既有 CSRF/Origin gate，确认额外要求具名 owner 的登录 session。两项新增 MCP operations 均须显式授权，旧知识读取/批注授权不自动扩权，撤销后立即拒绝。
