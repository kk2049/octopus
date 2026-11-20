# Fieldnote：C3 原型—集成对照

## 结论

C2 集成保留了 C0 的产品层级，并把原型里无法由当前可信契约诚实支持的部分收窄到现有平台边界。比较对象是未修改的 `index.html`；没有用集成实现反向改写原型来消除偏差。

## 保持一致

- 顶层心智模型仍是“资助科研项目”，不是通用文件或 session 目录。
- 项目进入后先显示主导 Agent 与主导文档，再并排显示 chat 和现状报告。
- 左栏按 workspace 分组 Agent 与 session；搜索、当前状态、主导历史和项目接入仍处在项目语境。
- 第一次打开优先主导绑定，否则选最新镜像；人的后续选择不会被无关 projection 更新覆盖。
- 主导切换保留原因、作者和时间；pending 不乐观切换，refusal 保留输入并支持重试。
- Owner、Member、Viewer 与 archived 的写控制不同；手机布局保持项目 → 主导对象 → 内容的阅读顺序。

## 有意偏差

1. C0 左栏同时展示多个项目；C2 的一个 View 只显示一个 shared instance。跨项目选择留在可信外层目录，避免 iframe 枚举实例 handle。
2. C0 的成员按钮看起来位于项目 View；C2 只提供“成员与 Agent 接入”说明，真实邀请/角色变更使用现有可信 shared-instance member surface。
3. C0 把 chat/file 视作实时资源；C2 在 generic declared App 的现行空 permission contract 下保存明确发布的有界镜像。它没有声称得到 Session Hub/workspace capability。
4. 文件意图不打开任意宿主文件，只选择当前 projection 中唯一匹配的已发布文档。多匹配或缺失都明确降级。
5. C0 写“agent 发起绑定可能需策略批准”；C2 的 runtime project-state 写入经过 membership/action door，但不是 capability resource operation。human-only 仍机械隔离，真正资源访问没有被引入。

## 实景检查

- 1440×960：项目 rail、双主导 strip、transcript 与 Markdown 文档在首屏形成清晰主次；长文档和聊天各自滚动。
- 390×844：rail 变成上方项目区，主导卡与视图切换纵排，主内容继续在其后，不出现横向溢出。
- 交互测试覆盖文件意图、精确主导参数、拒绝保留、Viewer 只读、selection 缺席不跳项和 raw HTML 不执行。

## 未消除的产品风险

- 若希望“任意现有科研 session 自动得到只针对当前项目的 Apps MCP token”，需要可信侧新增 session ↔ shared-instance 绑定、token 生命周期和撤销 UI；不能由 untrusted View 或 runtime event 自行完成。
- 项目镜像是显式发布而非 Session Hub 的强一致副本。调用方需用稳定项目 key 做幂等 upsert；消息是追加事件，重复提交会形成重复消息。
- 历史在 projection 中有界为最新记录；完整事件日志仍在 State Service，尚未提供历史分页 action。
