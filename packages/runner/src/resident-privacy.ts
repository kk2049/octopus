import { constants, promises as fs } from "node:fs";
import path from "node:path";

/** CLI/MCP stdout is a protocol; only the resident process has a null log sink. */
export function isResidentInvocation(args: readonly string[]): boolean {
  return args.length === 0 || args[0] === "daemon" || (args[0] === "run" && args[1] === "--foreground");
}

/** Also covers old/custom supervisors which still redirect the daemon to a file. */
export function silenceResidentOutput(): void {
  const discard: typeof process.stdout.write = (_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof done === "function") queueMicrotask(() => done());
    return true;
  };
  process.stdout.write = discard;
  process.stderr.write = discard;
}

export interface LegacyLogCleanup {
  cleared: string[];
  failed: string[];
  bytes: number;
}

/** Fixed Runner-owned files only: never scan histories, workspaces or shared journals. */
export async function clearLegacyRunnerLogs(home: string): Promise<LegacyLogCleanup> {
  const result: LegacyLogCleanup = { cleared: [], failed: [], bytes: 0 };
  const directory = path.join(home, ".octopus", "runner", "logs");
  try {
    // Refuse symlinked parents as well as symlink/hardlink files.
    if (await fs.realpath(directory) !== path.join(await fs.realpath(home), ".octopus", "runner", "logs")) {
      result.failed.push(directory);
      return result;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.failed.push(directory);
    return result;
  }
  for (const name of ["runner.out.log", "runner.err.log", "stdout.log", "stderr.log"]) {
    const file = path.join(directory, name);
    let handle: fs.FileHandle | undefined;
    try {
      const before = await fs.lstat(file);
      if (!before.isFile() || before.nlink !== 1) { result.failed.push(file); continue; }
      handle = await fs.open(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) {
        result.failed.push(file); continue;
      }
      await handle.truncate(0);
      await handle.sync();
      result.bytes += opened.size;
      result.cleared.push(file);
      // Leave the empty inode in place: an old supervisor may still hold it open.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.failed.push(file);
    } finally { await handle?.close(); }
  }
  return result;
}
