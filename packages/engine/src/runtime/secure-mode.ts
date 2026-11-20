/**
 * Secure mode: the switch that decides whether an unisolated execution path is
 * allowed to exist in this process.
 *
 * There is exactly one such path left, and it is not a small one. The
 * `claude-code` / `codex` adapters spawn a CLI with
 * `--dangerously-skip-permissions`, hand it the FULL host environment, and run
 * it as the same OS user as the Host. That CLI can read the capability
 * database, the bot's config, `~/.claude` credentials and every app directory,
 * and it can call any MCP server it likes. Nothing the capability service does
 * constrains it — it is a complete bypass of the single door, wearing the
 * costume of an agent adapter.
 *
 * So in secure mode it does not run. Not "runs with a warning", not "runs if
 * the operator remembered to configure it" — the turn fails closed with a
 * message naming the reason, and the inbox keeps the message for a day when a
 * real isolated worker exists. Insecure mode stays available for local probe
 * work, and says so loudly at boot.
 *
 * Deliberately a process-wide switch rather than a per-call option: it is a
 * deployment mode decided once, before any app or agent exists, and a
 * per-call flag is a per-call opportunity to get it wrong.
 */

/** Adapters that run untrusted code with no isolation boundary at all. */
export const UNISOLATED_ADAPTERS = ["claude-code", "codex"] as const;

let secure = true;

/** Called once at boot. Default is secure; opting out has to be explicit. */
export function setSecureMode(value: boolean): void {
  secure = value !== false;
}

export function secureMode(): boolean {
  return secure;
}

export function adapterAllowed(kind: string): boolean {
  if (!secure) return true;
  return !(UNISOLATED_ADAPTERS as readonly string[]).includes(kind);
}

export function adapterRefusal(kind: string): string {
  return (
    `适配器「${kind}」在安全模式下不可用：它以 --dangerously-skip-permissions 启动 CLI、`
    + `继承宿主全部环境变量、并以同一个 OS 用户运行——那是一条绕过统一权限门的完整通道。`
    + `要用它必须显式关闭安全模式（届时本进程不再是受保护模式），或等到隔离 worker 就绪。`
  );
}
