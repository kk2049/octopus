/**
 * Where a new Agent may be started, decided on the device that will run it.
 *
 * ── Why this is the Runner's decision and not the bot's ─────────────────────
 *
 * The bot cannot know what exists on somebody's laptop. It can bound the STRING
 * (so an approval card shows exactly what was asked for and nothing was
 * smuggled), but "is that a directory, does this account have it, what is it
 * really after symlinks" are questions only the filesystem in front of them can
 * answer. So the bot freezes the request and this file adjudicates it, at the
 * moment of execution, after the approval.
 *
 * ── What a directory is, and what it is NOT ─────────────────────────────────
 *
 * It is a working directory. It is **not** a sandbox: the CLI runs as the
 * device's own system account and can reach everything that account can reach,
 * exactly as it could if the user had typed `cd` and run it themselves. The
 * security boundary is the OS account plus the per-call approval — the same
 * boundary `machine_exec` has always had. Containment in a registered workspace
 * is deliberately NOT required, because requiring it would suggest a
 * confinement that does not exist.
 *
 * ── The three shapes accepted, and why nothing else is ──────────────────────
 *
 * ```text
 *   /abs/path        an absolute path on this device
 *   ~                the Runner's scan home
 *   ~/rel/path       relative to the Runner's scan home
 * ```
 *
 * A bare relative path (`src`, `./src`, `../x`) is refused, and the refusal is
 * the point: "relative to what?" has two plausible answers — the Runner
 * process's cwd, which is wherever it happened to be launched, and the user's
 * home — and picking one silently means a person approves a card naming `src`
 * and gets a directory they did not mean. `~` is accepted precisely because it
 * names its base explicitly.
 *
 * `~` resolves to the Runner's SCAN HOME, which is the same root the session
 * roster, the workspace registry and the launch journal already use. In the
 * default deployment that is the system account's home directory; when an
 * operator points `SESSIONS_SCAN_HOME` elsewhere, `~` follows it, so the one
 * sentence "`~` is this Runner's root" stays true.
 *
 * Absolute paths are deliberately POSIX-only in this release. The Bot executes
 * this same syntax check before it knows anything about the remote filesystem,
 * and deployed Runners resolve on Linux. Merely accepting a Windows-looking
 * `C:\\…` here would make the approval card name one thing while `path.resolve`
 * on the device launches relative to its process cwd. Real Windows support must
 * carry the trusted device platform through the operation binding and let that
 * device apply matching native validation and resolution; a second path parser
 * in the Bot is not a substitute for that protocol change.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { MACHINE_LIMITS } from "./limits.js";

export interface ResolvedLaunchDirectory {
  /** The canonical path, after `realpath`. This is what becomes `cwd`. */
  path: string;
  /** The request as it was written, for the journal and for diagnostics. */
  requested: string;
}

/**
 * Syntax only: no filesystem, no `realpath`, no `stat`.
 *
 * Split out because the BOT runs exactly this function too. The bot must be able
 * to refuse a malformed request before it becomes an approval card — a card
 * naming a path with a newline in it is a card that does not say what it will
 * do — while still leaving every question about what exists to the device.
 */
export function launchDirectoryProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "请填写要启动 Agent 的目录";
  if (value.includes("\0")) return "目录里不能包含 NUL 字节";
  if (Buffer.byteLength(value, "utf8") > MACHINE_LIMITS.pathMaxBytes) {
    return `目录过长（最多 ${MACHINE_LIMITS.pathMaxBytes} 字节）`;
  }
  if (/[\r\n]/.test(value)) return "目录里不能包含换行";
  if (value !== value.trim()) return "目录前后不能有空白";
  if (value === "~" || value.startsWith("~/")) {
    if (value.includes("\\")) return "目录里不能包含反斜杠";
    return null;
  }
  if (value.startsWith("~")) return "只支持 ~ 或 ~/… 形式的家目录写法";
  if (!path.posix.isAbsolute(value)) {
    return "请写 POSIX 绝对路径，或以 ~/ 开头的路径；含糊或非当前平台的路径不被接受";
  }
  return null;
}

/**
 * Turn a validated request into a real directory on this device, or throw.
 *
 * `realpath` first, then `stat`, then an access probe: the order matters only in
 * that the error messages stay distinguishable, and each of the three is a
 * different thing the person who approved the card would want to hear.
 */
export async function resolveLaunchDirectory(
  home: string,
  requested: string,
): Promise<ResolvedLaunchDirectory> {
  const problem = launchDirectoryProblem(requested);
  if (problem) throw new Error(problem);

  const root = path.resolve(home);
  const target = requested === "~"
    ? root
    : requested.startsWith("~/")
      ? path.join(root, requested.slice(2))
      : path.resolve(requested);

  let canonical: string;
  try {
    canonical = await fs.realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") throw new Error(`目录不存在：${requested}`);
    if (code === "EACCES" || code === "EPERM") throw new Error(`没有权限访问这个目录：${requested}`);
    throw new Error(`无法解析目录 ${requested}：${message(error)}`);
  }

  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new Error(`这不是一个目录：${requested}`);
  try {
    // Readable and traversable by THIS account. A directory that exists but
    // cannot be entered would otherwise fail later, inside the CLI, as an error
    // nobody can attribute to the launch.
    await fs.access(canonical, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new Error(`没有权限进入这个目录：${requested}`);
  }
  return { path: canonical, requested };
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
