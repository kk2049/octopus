import path from "node:path";
import type { SessionScanRoot } from "@claude-bot/plugin-sessions/scan";
import { sessionMetadataCwd } from "./owner-file-link.js";
import { placeInWorkspaces, type WorkspacePlacement } from "./workspaces.js";

/**
 * Where a path an agent wrote sits among this device's registered workspaces.
 *
 * Only the device knows its home directory and the workspaces' real roots, so
 * the device answers; the Head is told an opaque workspace id and the path
 * inside it, never the absolute path, and authorizes by workspace as before.
 * `~/` is this account's home and a relative path is taken from the session's
 * own cwd (read from its transcript metadata only when needed).
 */
export async function placeSessionPath(home: string, scan: SessionScanRoot, args: Record<string, unknown>): Promise<WorkspacePlacement> {
  const mention = typeof args.path === "string" ? args.path.trim() : "";
  if (!mention || mention.length > 1024 || /[\u0000\r\n\\]/.test(mention) || /^[a-z][a-z0-9+.-]*:/i.test(mention)) {
    throw new Error("无效文件路径");
  }
  let absolute: string;
  if (mention === "~" || mention.startsWith("~/")) absolute = path.resolve(home, mention.slice(2));
  else if (path.isAbsolute(mention)) absolute = path.resolve(mention);
  else {
    const cwd = await sessionMetadataCwd(scan, args);
    if (!cwd) return { placement: null, reason: "no_cwd" };
    absolute = path.resolve(cwd, mention);
  }
  return placeInWorkspaces(home, absolute);
}
