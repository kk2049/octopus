import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** Bound optional display-metadata IO independently of transcript size. */
export const CODEX_TITLE_INDEX_BYTES = 8 * 1024 * 1024;

/**
 * Codex appends { id, thread_name, updated_at } to session_index.jsonl.
 * File order, not the timestamp, determines the latest name. This lookup only
 * decorates discovered sessions; an index entry never discovers/authorizes one.
 * Omitting ids returns the bounded index for a device-owned version cache.
 */
export async function readCodexSessionTitles(
  codexHome: string,
  ids?: ReadonlySet<string>,
): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>();
  if (ids && !ids.size) return titles;
  const handle = await fs.open(path.join(codexHome, "session_index.jsonl"),
    constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return titles;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return titles;
    const start = Math.max(0, stat.size - CODEX_TITLE_INDEX_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, CODEX_TITLE_INDEX_BYTES));
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, start + length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    let text = buffer.subarray(0, length).toString("utf8");
    if (start) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : ""; // Ignore the cut leading record.
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0 && (!ids || titles.size < ids.size); i--) {
      try {
        const row: unknown = JSON.parse(lines[i]);
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const { id, thread_name: name } = row as Record<string, unknown>;
        if (typeof id !== "string" || (ids && !ids.has(id)) || titles.has(id) || typeof name !== "string") continue;
        // Keep an explicit empty latest name so an older name cannot reappear.
        titles.set(id, name.trim().replace(/\s+/g, " ").slice(0, 240));
      } catch { /* Partial writes and malformed rows are not names. */ }
    }
  } catch { /* Optional names must not hide otherwise readable sessions. */ }
  finally { await handle.close(); }
  return titles;
}
