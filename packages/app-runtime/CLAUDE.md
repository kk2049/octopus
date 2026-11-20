# App Runtime — 无状态的 release-bound 计算

Runtime 对固定 `backendCodeDigest` 的 release 执行两件事：action 把 JSON context/params 变成事件，
projection 把事件变成 JSON View。持久状态始终在 App State 外部。

投影 release 可额外导出 `projectIncremental(snapshot, events, context?)`。`snapshot` 只来自可信
Host 按当前 backend digest 读取的 canonical checkpoint；viewer 输出另按可信 context digest 缓存。旧 release 未导出时，Runtime 以
稳定的 `incremental_projection_unsupported` 拒绝，Host 分页读完**完整**历史后一次性调用
`project(events)`（超过一帧的请求/结果由 child-rpc 分片传输），绝不把尾部静默当作完整历史。
完整折叠的代价是该 release 自己的契约；长历史 App 应导出 `projectIncremental`。

边界：

- 只从 `@claude-bot/engine/sandbox` 复用 `AppSandbox`/SES；不要导入 engine 根 barrel，
  否则 Runtime 子进程会把 Host、卡片与 Agent adapter 的依赖一起装入。每次调用只处理有界 JSON，
  不向 App 暴露 Node、进程或状态路径。
- 当前 Runtime 没有 capability callback；sandbox facade 的任何 capability 调用都拒绝。真实资源
  只能由可信 Host 在后续明确接线，不能在这里偷接 Session Hub。
- release digest 不匹配立即拒绝；App handler 的任意错误文本不跨回可信协调器，只保留稳定 code。
- production 使用独立子进程 `src/main.ts`，只通过继承 IPC；`InProcessRuntimeClient` 仅供测试。
- Runtime 可随时重启；恢复结果只依赖 release + State 事件，不依赖进程内缓存。

不要把数据库、HTTP listener、浏览器 credential、instance handle 或权限 ledger 放进这个包。
