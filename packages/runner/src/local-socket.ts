import { promises as fs } from "node:fs";
import net from "node:net";

/** Reclaim only a confirmed stale Unix socket; never remove a live or foreign path. */
export async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(socketPath);
    if (!stat.isSocket()) throw new Error(`refusing to replace non-socket local bridge path: ${socketPath}`);
    await new Promise<void>((resolve, reject) => {
      const probe = net.createConnection(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        reject(new Error(`another Runner is already serving ${socketPath}`));
      });
      const timer = setTimeout(() => probe.destroy(new Error("local socket probe timed out")), 1_000);
      probe.once("close", () => clearTimeout(timer));
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
        else reject(error);
      });
    });
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
