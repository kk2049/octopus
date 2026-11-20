import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { removeStaleSocket } from "./local-socket.js";

/** An OS-owned singleton per scan home; contains no credential or RPC surface. */
export async function claimRunnerInstance(scanHome: string): Promise<{ close(): Promise<void> }> {
  const windows = process.platform === "win32";
  const home = path.resolve(scanHome);
  const socketPath = windows
    ? `\\\\.\\pipe\\octopus-runner-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 32)}`
    : path.join(home, ".octopus", "runner", "resident.sock");
  if (!windows) {
    await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(socketPath);
  }
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(new Error(`another Runner may own this scan home: ${error.message}`));
    server.once("error", failed);
    server.listen(socketPath, () => { server.off("error", failed); resolve(); });
  });
  if (!windows) await fs.chmod(socketPath, 0o600);
  server.unref();
  let closing: Promise<void> | undefined;
  return { close() {
    closing ??= new Promise<void>((resolve) => server.close(() => resolve()));
    return closing;
  } };
}
