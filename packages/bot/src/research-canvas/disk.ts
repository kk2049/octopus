import { statfsSync } from "node:fs";

/**
 * Free space a write must leave on its volume. Uploads and checkpoints have no
 * total size; what they must not do is fill the disk under the Head's SQLite
 * and logs (or under a workspace), which would stop everything else too.
 */
export const DISK_RESERVE_BYTES = 1024 ** 3;

/** Per-window disk guard: refuses this write, never truncates what was already stored. */
export function hasFreeSpace(path: string, bytes: number): boolean {
  const info = statfsSync(path, { bigint: true });
  return info.bavail * info.bsize >= BigInt(bytes) + BigInt(DISK_RESERVE_BYTES);
}

export function ensureFreeSpace(path: string, bytes: number): void {
  if (!hasFreeSpace(path, bytes))
    throw new Error("服务器磁盘剩余空间不足（需保留 1 GiB），本块未写入；已接收的部分保留，释放空间后可续传");
}
