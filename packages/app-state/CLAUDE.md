# App State — 可恢复的隔离应用状态

事实源是 `streams/<id>/commits/*.json` 的不可变 commit 链；SQLite 只负责单写者协调、幂等索引与
快速定位。snapshot 是可删除、可重算的缓存。

写入顺序承重：临时文件写入并 fsync → rename → 目录 fsync → SQLite `BEGIN IMMEDIATE` 推进
head。若 rename 后数据库事务失败，恢复器从文件重新收养该 commit；同一 `dispatchId` 不会生成
第二份事件。没有更新或删除历史的 API。

边界：

- scope 由可信协调器给出，stream 以 `(app, scope.kind, scope.key)` 唯一解析；浏览器看不到路径。
- 状态根、stream 目录始终 0700，SQLite 文件始终 0600，包括重开已有目录时。
- 本服务不持 capability、Runner、浏览器凭据或 App instance handle，也不执行 App 代码。
- production 使用独立 State 子进程；`InProcessStateClient` 仅供测试。
- 生产运行预构建的 `dist/main.js`，以普通 Node 启动，不在停机窗口中加载 tsx。
  构建内联最小 child-rpc 依赖；源码入口仍供开发测试。数据库、schema、恢复和 ready
  阶段只输出有界诊断，不输出 stream 身份或内容。ready 仍表示恢复已完成。
- 数据库可以由 commit 文件恢复；反过来不能把数据库行当作唯一历史。

`readSince` 必须显式分页（单页最多 16 个事件 × 每事件 64 KiB，是单次调用的窗口而不是历史上限；
需要完整历史的调用方按 `cursor` 读完所有页）。snapshot
按 projection digest 写入 gzip 文件，并由 SQLite 建最新索引；每个 digest 只保留最新 3 份。索引可在
`recover()` 时从文件重建，snapshot 缺失或损坏仍只能回到不可变 commit 链重算。

新增状态能力优先扩展事件/投影契约；不要增加任意文件读写或让 App 自己选择文件路径。
