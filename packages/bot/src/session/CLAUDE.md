# session/ — 共享的 LLM HTTP 与路径围栏工具

v2 聊天会话运行时(`SessionManager`、`AgentSession`、插件发现)已随 v2 组合根于
2026-10-15 下线;本目录只剩被现行代码复用的几个叶子模块。

- `path-jail.ts` — "这个路径是否在那个根之内"的唯一实现(realpath 两侧比较,写入解析最近的已存在祖先),被 user-memory/user-skills 能力平面使用。
- `file-window.ts` — 同两个平面的窗口化文件访问:按字节窗口读(只切在 UTF-8 字符之间,带 `next_offset`)、在 offset 处写一块并截断(重复同一块结果不变,所以分块写仍 retry-safe)、按全局路径序遍历(游标精确续页)。每次调用有界,文件和目录本身不设总量上限。

## LLM 直连的 HTTP 收口(`llm-fetch.ts`)

所有**直接对接 LLM HTTP API**(OpenAI 兼容 chat/completions、responses;不含 Claude Code / Codex CLI 子进程)都必须经 `fetchLlm()` 而不是裸 `fetch`。当前唯一调用方是 `managed-execution/loop.ts`(会议、知识对话、App agent 共用的托管 agent loop)。

**重试策略**(默认 5 次,base 400ms,指数退避,jitter=0.5,单次退避封顶 30s):
- 重试:429、408、425、5xx、网络错误、per-attempt 超时
- 不重试:400/401/403/404 等客户端错误、上游 `signal` 被 abort(drain/取消)
- 尊重 `Retry-After`(秒或 HTTP-date,同样被 `maxDelayMs` 封顶,防被恶意服务器拖死)
- 每次 attempt 独立 `AbortController` + 超时——一次挂死不吃掉整个重试预算
- `onRetry` 回调用于日志/进度;抛错被吞,不会拖死重试

**为什么收口**:工单#13 观察到秘书调查在 tool-call 第 9 步撞到 upstream 一句 `429 - Concurrency limit exceeded`,原先的裸 fetch 一次性抛错、report 卡片直接刷失败。现在同类错误由 `fetchLlm` 透明吞掉;耗尽后才把带 `status/body/attempts/reason` 的错误冒泡。**不适用于** Claude Code / Codex CLI 子进程——它们有各自的 CLI 层重试。
