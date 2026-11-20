import path from "node:path";
import fs from "node:fs/promises";
import { resolveSessionPath, parseSessionText, type SessionScanRoot, type Source } from "@claude-bot/plugin-sessions/scan";
import { resolveWorkspace } from "./workspaces.js";
import { accessOwnerFiles, type AccessOwnerFilesResult } from "./workspace-files.js";

/** Called only by access_owner_files. Split placement is bound by the server. */
export async function resolveOwnerFileLink(home: string, scan: SessionScanRoot, args: Record<string, unknown>): Promise<AccessOwnerFilesResult> {
  const href = args.path;
  if (typeof href !== "string" || !href || href.length > 400 || /[\u0000\r\n\\]/.test(href)
    || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) throw new Error("无效文件链接");
  let cwd: string;
  if (typeof args.workspace_id === "string") {
    cwd = (await resolveWorkspace(home, args.workspace_id)).path;
  } else {
    const sessionCwd = await sessionMetadataCwd(scan, args);
    if (path.isAbsolute(href)) cwd = "/";
    else if (sessionCwd) cwd = sessionCwd;
    else return { status: "refused", code: "not_found" };
  }
  const absolute = href.startsWith("~/") ? path.resolve(home, href.slice(2)) : path.resolve(cwd, href);
  return accessOwnerFiles({ mode: "stat", absolute_path: absolute });
}

/** The absolute cwd a session's own metadata records, read from a bounded prefix of its transcript. */
export async function sessionMetadataCwd(scan: SessionScanRoot, args: Record<string, unknown>): Promise<string | null> {
  if (!["codex", "claude", "omp"].includes(String(args.source)) || typeof args.id !== "string" || !args.id) {
    throw new Error("文件链接缺少会话来源");
  }
  const session = await resolveSessionPath(scan, args.source as Source, args.id, undefined);
  // Only metadata is needed; a file click must not materialize a transcript.
  const file = await fs.open(session.path, "r");
  let prefix: string;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    prefix = bytesRead === buffer.length ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
  } finally { await file.close(); }
  const { meta } = parseSessionText(session.source, prefix);
  return typeof meta.cwd === "string" && path.isAbsolute(meta.cwd) ? meta.cwd : null;
}
