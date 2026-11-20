const RETRY_DELAY_MS = 10;
const sleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/**
 * SQLite may return BUSY immediately while a concurrent connection changes a
 * persistent database setting, even when the connection has a busy handler.
 * Keep that narrow startup race inside the caller's existing timeout budget.
 */
export function retrySqliteBusy<T>(operation: () => T, timeoutMs: number): T {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      Atomics.wait(sleepCell, 0, 0, Math.min(RETRY_DELAY_MS, remaining));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}
