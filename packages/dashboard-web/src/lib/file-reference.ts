import { filePathOf } from "@claude-bot/chat-ui-commons/file-mentions";

export interface FileReference { path: string; line?: number }

/** Display intent only. The ticket backend resolves and authorizes the path. */
export function fileReference(raw: string, origin = location.origin): FileReference | null {
  let value = raw.trim();
  if (/^(?:https?:)?\/\//i.test(value)) {
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin || url.username || url.password || url.search) return null;
      value = url.pathname + url.hash;
    } catch { return null; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/:\d+(?::\d+)?$/.test(value)) return null;
  try { value = decodeURIComponent(value); } catch { return null; }
  const suffix = /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+)?)$/.exec(value);
  const target = suffix ? value.slice(0, suffix.index) : value;
  // Authored links can use spaces/extensionless names; plain prose remains
  // conservative in the shared mention scanner.
  if (!filePathOf(target) && !/^(?:\.?\.?\/|~\/)/.test(target)) return null;
  if (/[\x00-\x1f\x7f]/.test(target)) return null;
  const line = Number(suffix?.[1] ?? suffix?.[2]);
  return { path: target, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) };
}
