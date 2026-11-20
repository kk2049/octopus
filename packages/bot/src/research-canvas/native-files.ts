import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { ResourceBinding } from "@claude-bot/research-canvas-contract";
import { workspaceTextWindows } from "@claude-bot/workspace-files-contract";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { workspaceRelativePathProblem } from "@claude-bot/runner/workspace-files";
import type { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import { GrantWorkspaceFilesAuthority } from "../workspace-files/authority.js";
import { RunnerWorkspaceFilesBackend } from "../workspace-files/runner-backend.js";
import type { PermissionService } from "../permissions/service.js";
import { IntentGrantResolver } from "../session-resource/intent-resolver.js";
import { RESEARCH_CANVAS_CONTRACT, RESEARCH_FILE_OPERATIONS } from "./contract.js";
import type { ResearchContext } from "./graph.js";
import { integer, text } from "./validation.js";

export function boundFilePath(binding: ResourceBinding, value: string): string {
  const raw = text(value, "文件路径", 2000);
  const root = String(binding.config.directory ?? "").replace(/\/$/, "");
  let path = raw.replace(/^file:\/\//, "").replace(/:\d+(?::\d+)?$/, "");
  if (path.startsWith("/")) {
    if (!root || !path.startsWith(`${root}/`)) throw new Error("此文件不在 Agent 绑定的项目工作区内");
    path = path.slice(root.length + 1);
  }
  if (workspaceRelativePathProblem(path) || !path) throw new Error("文件路径无效");
  return path;
}

/** Fixed, explicitly shared workspace bindings; every call still crosses the existing Gate. */
export class ResearchNativeFiles {
  private readonly grants: IntentGrantResolver;
  constructor(
    private readonly capabilities: WorkspaceFilesCapabilities | undefined,
    permissions: PermissionService,
    private readonly allowed: (context: ResearchContext, binding: ResourceBinding, operation?: string) => boolean,
  ) {
    this.grants = new IntentGrantResolver(permissions, Date.now,
      new Map([[RESEARCH_CANVAS_CONTRACT.app, RESEARCH_CANVAS_CONTRACT.publisher]]));
  }
  private check(context: ResearchContext, binding: ResourceBinding, write: boolean): void {
    if (!this.allowed(context, binding, write ? "edit_graph" : "read_project")) throw new Error("项目文件授权已变化");
    const effective = this.grants.effective(RESEARCH_CANVAS_CONTRACT, binding.owner);
    for (const op of write ? ["download_workspace_file", "replace_workspace_text"] : ["download_workspace_file"])
      if (!effective.operations.includes(op) || !effective.autoAllow.includes(op))
        throw new Error(write ? "资源归属人尚未授权项目成员编辑工作区文件" : "资源归属人尚未授权项目工作区文件读取");
  }
  private access(context: ResearchContext, binding: ResourceBinding, path: string, write: boolean) {
    this.check(context, binding, write);
    const effective = this.grants.effective(RESEARCH_CANVAS_CONTRACT, binding.owner);
    const rights = RESEARCH_FILE_OPERATIONS.filter(op =>
      effective.operations.includes(op) && effective.autoAllow.includes(op) &&
      (write || op !== "replace_workspace_text"));
    const grant = this.capabilities?.open({
      username: binding.owner, device: String(binding.config.device),
      purpose: `科研项目 ${context.project} · ${path}`, kind: "app-instance",
      rights, autoAllow: rights,
      metadata: { app: "research-v2", project: context.project, trigger: context.actor.owner, node: binding.node },
    });
    if (!grant) throw new Error("工作区文件模块不可用");
    return {
      grant,
      backend: new RunnerWorkspaceFilesBackend(new GrantWorkspaceFilesAuthority({
        grant, devices: () => [{ device: String(binding.config.device), label: String(binding.config.device) }],
      })),
      workspace: {
        device: String(binding.config.device), deviceLabel: String(binding.config.device),
        workspaceId: String(binding.config.workspace), workspaceLabel: String(binding.config.label),
      },
    };
  }
  async read(context: ResearchContext, binding: ResourceBinding, params: Record<string, string>) {
    const path = boundFilePath(binding, params.path);
    const { grant, backend, workspace } = this.access(context, binding, path, false);
    try {
      const answer = await backend.downloadBinary(workspace, path, integer(params.cursor ?? "0", 0, MACHINE_LIMITS.workspaceFileMaxOffset), 24000);
      this.check(context, binding, false);
      if (!answer.ok) throw new Error(answer.message);
      const part = answer.value;
      if (params.version && params.version !== part.digest) throw new Error("文件已变化，请重新打开，未拼接不同版本");
      const name = posix.basename(path), extension = posix.extname(name).toLowerCase();
      const mime = ({
        ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".gif": "image/gif", ".mp3": "audio/mpeg", ".wav": "audio/wav",
        ".m4a": "audio/mp4", ".mp4": "video/mp4", ".json": "application/json", ".csv": "text/csv",
        ".md": "text/markdown", ".txt": "text/plain", ".yaml": "text/yaml", ".yml": "text/yaml",
      } as Record<string, string>)[extension] ?? "application/octet-stream";
      return { file: { id: part.digest, name, mime, bytes: part.sizeBytes, sha256: part.digest, version: binding.version },
        data: part.data, next: part.eof ? null : part.offset + part.bytes };
    } finally { grant.destroy(); }
  }
  /**
   * The public save has no graph baseline. Keep the Runner's atomic replacement precondition.
   *
   * A text of any size: one window is the ordinary one-call replace; more
   * windows are one staged upload on the device (workspace-files'
   * begin/append/commit, 2026-10-20) whose commit runs the same CAS and atomic
   * rename. The device call is the bounded window, not the file.
   */
  async write(context: ResearchContext, binding: ResourceBinding, params: Record<string, string>) {
    const path = boundFilePath(binding, params.path);
    const value = text(params.text, "文件正文", Number.MAX_SAFE_INTEGER, "");
    const { grant, backend, workspace } = this.access(context, binding, path, true);
    try {
      const windows = workspaceTextWindows(value);
      let answer: Awaited<ReturnType<typeof backend.replaceText>>;
      if (windows.length === 1) answer = await backend.replaceText(workspace, path, params.digest, value);
      else {
        const uploadId = randomBytes(16).toString("hex");
        const begun = await backend.stageText(workspace, path, { stage: "begin", uploadId, expectedDigest: params.digest });
        if (!begun.ok) throw new Error(begun.message);
        const size = await appendWindows(backend, workspace, path, uploadId, 0, windows);
        answer = await backend.commitStagedText(workspace, path, uploadId, params.digest, size);
      }
      this.check(context, binding, true);
      if (!answer.ok) throw new Error(answer.message);
      return { status: "saved", path, ...answer.value };
    } finally { grant.destroy(); }
  }
  /**
   * One non-final step of a caller's staged save, for a text larger than one
   * action call. The device stages under an id derived from the caller's token
   * AND this project, actor and file, so a token means nothing to anyone else.
   * Nothing touches the file before `commit`; the device sweeps an abandoned upload.
   */
  async stage(context: ResearchContext, binding: ResourceBinding, params: {
    path: string; token: string; step: "begin" | "append"; digest?: string; offset?: number; text?: string;
  }): Promise<{ status: "staged"; upload: string; size: number }> {
    const path = boundFilePath(binding, params.path);
    const uploadId = deviceUploadId(context, binding, path, params.token);
    const { grant, backend, workspace } = this.access(context, binding, path, true);
    try {
      let size: number;
      if (params.step === "begin") {
        const begun = await backend.stageText(workspace, path, { stage: "begin", uploadId, expectedDigest: String(params.digest ?? "") });
        if (!begun.ok) throw new Error(begun.message);
        size = begun.value.sizeBytes;
      } else {
        // One action call may carry more than one device window.
        size = await appendWindows(backend, workspace, path, uploadId, params.offset ?? 0, workspaceTextWindows(params.text ?? ""));
      }
      this.check(context, binding, true);
      return { status: "staged", upload: params.token, size };
    } finally { grant.destroy(); }
  }
  /** Commit a staged save: the device's compare-and-swap against `digest`, then the atomic rename. */
  async commit(context: ResearchContext, binding: ResourceBinding, params: { path: string; token: string; digest: string; size: number }) {
    const path = boundFilePath(binding, params.path);
    const { grant, backend, workspace } = this.access(context, binding, path, true);
    try {
      const answer = await backend.commitStagedText(workspace, path, deviceUploadId(context, binding, path, params.token), params.digest, params.size);
      this.check(context, binding, true);
      if (!answer.ok) throw new Error(answer.message);
      return { status: "saved", path, ...answer.value };
    } finally { grant.destroy(); }
  }
}

/** A caller's upload token, minted by the plane: 128 random bits. */
export const UPLOAD_TOKEN = /^[0-9a-f]{32}$/;
export function uploadToken(): string { return randomBytes(16).toString("hex"); }

function deviceUploadId(context: ResearchContext, binding: ResourceBinding, path: string, token: string): string {
  if (!UPLOAD_TOKEN.test(token)) throw new Error("分段保存的 upload 无效");
  return createHash("sha256").update(JSON.stringify([
    "research-file-upload", context.project, context.actor.kind, context.actor.owner, context.actor.agent ?? "",
    binding.node, path, token,
  ])).digest("hex").slice(0, 32);
}

/** Append windows in order from `offset`, holding each answer to the bytes sent. */
async function appendWindows(
  backend: RunnerWorkspaceFilesBackend,
  workspace: Parameters<RunnerWorkspaceFilesBackend["replaceText"]>[0],
  path: string,
  uploadId: string,
  offset: number,
  windows: readonly string[],
): Promise<number> {
  let at = offset;
  for (const window of windows) {
    const appended = await backend.stageText(workspace, path, { stage: "append", uploadId, offset: at, text: window });
    if (!appended.ok) throw new Error(appended.message);
    at += Buffer.byteLength(window, "utf8");
    if (appended.value.sizeBytes !== at) throw new Error("分段保存的回执与提交的内容不一致，文件没有被改动；请重新保存");
  }
  return at;
}
