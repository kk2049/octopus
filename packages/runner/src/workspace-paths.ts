/**
 * What a POSIX path relative to a workspace root is allowed to look like.
 *
 * A leaf on purpose. Three callers need this exact sentence and two of them
 * would otherwise import each other:
 *
 *   · `workspace-files.ts` checks it before a relative path becomes a syscall;
 *   · `workspaces.ts` checks it before this device REPORTS one it derived from
 *     a session's working directory;
 *   · the bot's `workspace-files` adapter imports it (re-exported from
 *     `workspace-files.ts`, so that import does not move) to check the same
 *     sentence before a request becomes a frame.
 *
 * A second implementation of "which relative paths are acceptable" is how an
 * approval card gets granted for something the device then refuses — the same
 * argument `launchDirectoryProblem` is shared for.
 */

import { MACHINE_LIMITS } from "./limits.js";

/**
 * Syntax only: no filesystem.
 *
 * Returns a human-readable problem or null. `""` is the workspace root and is
 * always acceptable.
 */
export function workspaceRelativePathProblem(value: unknown): string | null {
  if (typeof value !== "string") return "relative_path 必须是字符串";
  if (value === "") return null;
  if (value.includes("\0")) return "relative_path 里不能包含 NUL 字节";
  if (/[\r\n]/.test(value)) return "relative_path 里不能包含换行";
  if (value.includes("\\")) return "relative_path 里不能包含反斜杠";
  if (value !== value.trim()) return "relative_path 前后不能有空白";
  if (Buffer.byteLength(value, "utf8") > MACHINE_LIMITS.workspaceRelativePathMaxBytes) {
    return `relative_path 过长（最多 ${MACHINE_LIMITS.workspaceRelativePathMaxBytes} 字节）`;
  }
  if (value.startsWith("/")) return "relative_path 必须是相对路径，不能以 / 开头";
  for (const segment of value.split("/")) {
    if (segment === "") return "relative_path 里不能有空路径段";
    if (segment === "." || segment === "..") return "relative_path 里不能包含 . 或 .. 路径段";
    if (segment !== segment.trim()) return "relative_path 的路径段前后不能有空白";
  }
  return null;
}
