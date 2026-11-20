/** Exact, bounded provider identity from this operation's own private capture. */
export function sessionIdFromCodexEvent(line: string): string | null {
  if (!line || line.length > 256 * 1024) return null;
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = String(value.type ?? "");
  if (!["thread.started", "thread_started", "session.started", "session_started"].includes(type)) return null;
  const payload = object(value.payload);
  const thread = object(value.thread);
  const candidates = [value.thread_id, value.session_id, payload.thread_id, payload.session_id, thread.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{5,199}$/.test(candidate)) return candidate;
  }
  return null;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
