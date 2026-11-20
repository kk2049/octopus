import { workspaceTextWindows } from "@claude-bot/workspace-files-contract";
import type { Call } from "./client.js";

/**
 * What one `document_write` / `file_write` call carries: the contract's `text`
 * window (196,608 characters). Windows are cut by UTF-8 bytes at this size,
 * which also bounds their characters, and by encoded JSON size.
 */
export const TEXT_SAVE_WINDOW_BYTES = 196_608;

const utf8 = new TextEncoder();

/**
 * Save a whole body of any size (2026-10-20).
 *
 * One window is the ordinary one-call save, byte-identical to what every
 * earlier build sent. More windows are one staged save: begin → append × N →
 * commit, each one call. The host replaces the body only at commit, with the
 * same compare-and-swap as a one-call save (against `expected`, or the version
 * `begin` reports), so a stale editor still cannot clobber a newer body and a
 * failure anywhere leaves it untouched. Nothing is retried here; the caller's
 * request id lets a retried save join the first one's receipt.
 */
export async function saveText<T>(
  call: Call,
  action: "document_write" | "file_write",
  base: { request: string; node: string; expected?: string },
  text: string,
): Promise<T> {
  const windows = workspaceTextWindows(text, TEXT_SAVE_WINDOW_BYTES);
  if (windows.length === 1) return call<T>(action, { ...base, text });
  const begun = await call<{ upload: string; size: number; digest?: string; revision?: string }>(action, { ...base, stage: "begin" });
  if (begun.size !== 0) throw new Error("分段保存未能开始，文件没有被改动；请重新保存");
  let offset = 0;
  for (const window of windows) {
    const appended = await call<{ size: number }>(action, {
      request: base.request, node: base.node, stage: "append", upload: begun.upload, offset: String(offset), text: window,
    });
    offset += utf8.encode(window).length;
    if (appended.size !== offset) throw new Error("分段保存的回执与提交的内容不一致，文件没有被改动；请重新保存");
  }
  return call<T>(action, {
    request: base.request, node: base.node, stage: "commit", upload: begun.upload, size: String(offset),
    // The version this save is based on: the caller's, else the one begin reported.
    expected: base.expected ?? begun.digest ?? begun.revision,
  });
}
