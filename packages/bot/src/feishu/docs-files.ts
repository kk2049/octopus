/**
 * Workspace files behind a Feishu Docs card.
 *
 * A reader clicks a path the agent mentioned. That path is only a NAME in the
 * owner's device namespace; authority is a workspace grant. This module asks
 * the owner's Runner to turn the name into (registered workspace, relative
 * path) — only the device knows its home and the workspaces' real roots — and
 * reads through the owner's Workspace Files root with read-only rights. An
 * older Runner is mapped from what it reports instead (each session's place in
 * its workspace, and any absolute cwd). The Runner confines every read to the
 * workspace's real path, so a wrong mapping can only fail to open, never open
 * something outside.
 */
import path from "node:path";
import type { Operation } from "@claude-bot/capability-kernel";
import { WORKSPACE_FILES_LIMITS, readWorkspaceListCursor, workspaceListCursor } from "@claude-bot/workspace-files-contract";
import type { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import { GrantWorkspaceFilesAuthority } from "../workspace-files/authority.js";
import { RunnerWorkspaceFilesBackend } from "../workspace-files/runner-backend.js";
import { readWorkspaceDirectorySnapshot } from "../workspace-files/directory-index.js";
import type { WorkspaceBinding } from "../workspace-files/types.js";
import { DocsAddonError } from "./docs-addon-auth.js";

const CHUNK = 256 * 1024;
const LAYOUT_MS = 30_000;
const READ_RIGHTS: readonly Operation[] = ["list_session_workspaces", "list_workspace_entries", "read_workspace_binary"];

export interface SessionRef { owner: string; device: string; cliKind: string; sessionId: string }

/** One registered workspace on one device, with its absolute root when the owner's sessions reveal it. */
export interface WorkspaceRoot { workspaceId: string; label: string; display?: string; root?: string }

export interface Layout {
  roots: WorkspaceRoot[];
  /** Each session's directory inside its workspace, keyed `cliKind\0sessionId`. */
  sessions: Map<string, { workspaceId: string; relativePath: string; cwd?: string }>;
  /** Absolute cwd of every known session, including ones outside any workspace. */
  cwds: ReadonlyMap<string, string>;
  home?: string;
}

export interface FileTarget { workspace: WorkspaceRoot; relativePath: string }

/**
 * A file's bytes arrive as `chunks`, pulled one Runner window at a time while
 * the consumer reads, so a file of any size passes through in one window of
 * memory. Iterating throws if the file changes or the device goes away midway;
 * nothing partial is ever presented as the whole file.
 */
export type DocsFile = { kind: "file"; workspace: WorkspaceRoot; path: string; name: string; size: number; modifiedAt: string; chunks: AsyncIterable<Buffer> };
export type DocsFileContent =
  | DocsFile
  | {
    kind: "dir"; workspace: WorkspaceRoot; path: string;
    entries: Array<{ name: string; path: string; dir: boolean; size?: number; modifiedAt?: string }>;
    truncated: boolean;
    /** Present when more entries follow: pass it back as `after` for the next page. */
    next?: string;
  };

const key = (cliKind: string, sessionId: string) => `${cliKind}\u0000${sessionId}`;

/**
 * Pure: where a mention points, given what the Runner reported. Absolute and
 * `~/` mentions land in the deepest workspace whose root contains them; a
 * relative mention is taken against the session's cwd, or, when no root is
 * known, joined onto the session's own place in its workspace.
 */
export function locate(layout: Layout, session: Pick<SessionRef, "cliKind" | "sessionId">, mention: string): FileTarget | null {
  const own = layout.sessions.get(key(session.cliKind, session.sessionId));
  const cwd = own?.cwd ?? layout.cwds.get(key(session.cliKind, session.sessionId));
  const clean = mention.replace(/\/+$/, "") || mention;
  let absolute: string | undefined;
  if (clean.startsWith("/")) absolute = path.posix.normalize(clean);
  else if (clean === "~" || clean.startsWith("~/")) absolute = layout.home ? path.posix.join(layout.home, clean.slice(2)) : undefined;
  else if (cwd && path.posix.isAbsolute(cwd)) absolute = path.posix.join(cwd, clean);
  if (absolute) {
    let best: WorkspaceRoot | undefined;
    for (const root of layout.roots) {
      if (!root.root || !(absolute === root.root || absolute.startsWith(`${root.root}/`))) continue;
      if (!best || root.root.length > best.root!.length) best = root;
    }
    if (best) return { workspace: best, relativePath: absolute === best.root ? "" : absolute.slice(best.root!.length + 1) };
  }
  if (own && !clean.startsWith("/") && !clean.startsWith("~")) {
    const joined = path.posix.normalize(path.posix.join(own.relativePath || ".", clean));
    const workspace = layout.roots.find((root) => root.workspaceId === own.workspaceId);
    if (workspace && joined !== ".." && !joined.startsWith("../")) return { workspace, relativePath: joined === "." ? "" : joined };
  }
  return null;
}

/** Pure: a workspace root is the session cwd minus the session's path inside the workspace. */
export function deriveLayout(snapshot: NonNullable<ReturnType<typeof readWorkspaceDirectorySnapshot>>, cwds: ReadonlyMap<string, string>): Layout {
  const roots = new Map<string, WorkspaceRoot>();
  for (const root of snapshot.roots) if (!roots.has(root.workspaceId)) roots.set(root.workspaceId, { workspaceId: root.workspaceId, label: root.label, ...(root.display ? { display: root.display } : {}) });
  const sessions: Layout["sessions"] = new Map();
  for (const row of snapshot.sessionDirectories) {
    const cwd = cwds.get(key(row.source, row.id));
    const normalized = cwd && path.posix.isAbsolute(cwd) ? path.posix.normalize(cwd).replace(/\/+$/, "") || "/" : undefined;
    sessions.set(key(row.source, row.id), { workspaceId: row.workspaceId, relativePath: row.relativePath, ...(normalized ? { cwd: normalized } : {}) });
    const root = roots.get(row.workspaceId);
    if (!root || root.root || !normalized) continue;
    const suffix = row.relativePath ? `/${row.relativePath}` : "";
    if (!suffix) root.root = normalized;
    else if (normalized.endsWith(suffix) && normalized.length > suffix.length) root.root = normalized.slice(0, -suffix.length);
  }
  const list = [...roots.values()];
  return { roots: list, sessions, cwds, home: list.find((root) => root.display === "~")?.root };
}

export class DocsWorkspaceFiles {
  private readonly layouts = new Map<string, { at: number; value: Promise<Layout> }>();

  constructor(
    private readonly capabilities: WorkspaceFilesCapabilities,
    /** Absolute cwd of each of the owner's sessions on a device, keyed `cliKind\0sessionId`. */
    private readonly cwds: (owner: string, device: string) => Promise<ReadonlyMap<string, string>>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read-only rights on the owner's Workspace Files root, pooled per owner and device. */
  private authority(owner: string, device: string): GrantWorkspaceFilesAuthority {
    const grant = this.capabilities.open({
      username: owner, device, purpose: "飞书文档卡片 · 工作区文件只读", kind: "job",
      rights: READ_RIGHTS, autoAllow: READ_RIGHTS, pool: `feishu-docs-files:${device}`,
      metadata: { surface: "feishu-docs" },
    });
    if (!grant) throw new DocsAddonError(503, "所有者的设备当前不可用，暂时无法读取文件");
    return new GrantWorkspaceFilesAuthority({ grant, devices: () => [{ device, label: device }] });
  }

  /** The device's workspaces and where the owner's sessions sit in them; cached briefly. */
  layout(owner: string, device: string): Promise<Layout> {
    const id = `${owner}\u0000${device}`;
    const cached = this.layouts.get(id);
    if (cached && this.now() - cached.at < LAYOUT_MS) return cached.value;
    const value = (async () => {
      const outcome = await this.authority(owner, device).call(device, "list_session_workspaces", { device });
      const snapshot = outcome.status === "succeeded" ? readWorkspaceDirectorySnapshot(outcome.result, device) : null;
      if (!snapshot) throw new DocsAddonError(503, "所有者的设备当前不可用，暂时无法读取文件");
      return deriveLayout(snapshot, await this.cwds(owner, device).catch(() => new Map<string, string>()));
    })();
    this.layouts.set(id, { at: this.now(), value });
    value.catch(() => { if (this.layouts.get(id)?.value === value) this.layouts.delete(id); });
    return value;
  }

  /**
   * The workspace a mention points into. The device answers this itself — it
   * knows its home and the workspaces' real roots, which it does not report —
   * and a device that predates the question falls back to what it reports.
   */
  async resolve(session: SessionRef, mention: string): Promise<FileTarget> {
    const placed = await this.place(session, mention);
    if (placed && "reason" in placed) {
      throw new DocsAddonError(404, placed.reason === "not_found" ? "文件不存在，或已被移动" : "这个路径不在所有者登记的任何工作区里");
    }
    if (placed) {
      for (const fresh of [false, true]) {
        if (fresh) this.layouts.delete(`${session.owner}\u0000${session.device}`);
        const workspace = (await this.layout(session.owner, session.device)).roots.find((root) => root.workspaceId === placed.workspaceId);
        if (workspace) return { workspace, relativePath: placed.relativePath };
      }
      throw new DocsAddonError(404, "这个路径所在的工作区已不在所有者的设备上");
    }
    const target = locate(await this.layout(session.owner, session.device), session, mention);
    if (!target) throw new DocsAddonError(404, "这个路径不在所有者登记的任何工作区里");
    return target;
  }

  /** The device's placement of one mention; null when it cannot answer (an older Runner, or machine operations off). */
  private async place(session: SessionRef, mention: string): Promise<{ workspaceId: string; relativePath: string } | { reason: string } | null> {
    const outcome = await this.authority(session.owner, session.device).call(session.device, "list_session_workspaces",
      { device: session.device, path: mention, source: session.cliKind, id: session.sessionId });
    const result = outcome.status === "succeeded" && outcome.result && typeof outcome.result === "object" ? outcome.result as Record<string, unknown> : null;
    // An older Runner ignores `path` and answers with its listing instead.
    if (!result || !("placement" in result)) return null;
    const placement = result.placement as Record<string, unknown> | null;
    if (placement && typeof placement.workspace_id === "string" && typeof placement.relative_path === "string") {
      return { workspaceId: placement.workspace_id, relativePath: placement.relative_path };
    }
    const reason = typeof result.reason === "string" ? result.reason : "outside";
    return reason === "not_found" || reason === "outside" ? { reason } : null;
  }

  /** The workspace that holds a session's working directory, if the Runner reports one. */
  async sessionWorkspace(session: SessionRef): Promise<{ workspace: WorkspaceRoot; relativePath: string; cwd?: string } | null> {
    const layout = await this.layout(session.owner, session.device);
    const own = layout.sessions.get(key(session.cliKind, session.sessionId));
    const workspace = own && layout.roots.find((root) => root.workspaceId === own.workspaceId);
    return own && workspace ? { workspace, relativePath: own.relativePath, ...(own.cwd ? { cwd: own.cwd } : {}) } : null;
  }

  /**
   * A file's bytes, or one page of a directory's entries when the target is a
   * directory (or `asDirectory`). `after` continues a listing: the previous
   * page's `next`, a keyset position in the device's listing order, so a
   * directory of any length is reached page by page.
   */
  async read(owner: string, device: string, target: FileTarget, asDirectory = false, after?: string): Promise<DocsFileContent> {
    if (after !== undefined && !readWorkspaceListCursor(after)) throw new DocsAddonError(400, "目录分页位置无效");
    const backend = new RunnerWorkspaceFilesBackend(this.authority(owner, device));
    const binding: WorkspaceBinding = { device, deviceLabel: device, workspaceId: target.workspace.workspaceId, workspaceLabel: target.workspace.label };
    if (!asDirectory && after === undefined && target.relativePath) {
      const first = await backend.readBinary(binding, target.relativePath, 0, CHUNK);
      if (first.ok) {
        const relativePath = target.relativePath;
        const head = first.value;
        async function* chunks(): AsyncGenerator<Buffer> {
          let window = head;
          for (;;) {
            yield Buffer.from(window.data, "base64");
            if (window.eof) return;
            if (window.bytes <= 0) throw new DocsAddonError(502, "设备返回的文件内容不完整");
            const next = await backend.readBinary(binding, relativePath, window.offset + window.bytes, CHUNK);
            if (!next.ok) throw refusal(next.code, next.message);
            // Every window states the whole-file version it came from.
            if (next.value.sizeBytes !== head.sizeBytes || next.value.digest !== head.digest) {
              throw new DocsAddonError(409, "文件在读取过程中被改动了，请重新打开");
            }
            window = next.value;
          }
        }
        return { kind: "file", workspace: target.workspace, path: relativePath, name: path.posix.basename(relativePath),
          size: head.sizeBytes, modifiedAt: head.modifiedAt, chunks: chunks() };
      }
      if (first.code !== "not_a_file" && first.code !== "not_a_directory") throw refusal(first.code, first.message);
    }
    const listing = await backend.listEntries(binding, target.relativePath, WORKSPACE_FILES_LIMITS.maxEntries, after);
    // On a listing, `too_large` is an older Runner that cannot page; say so.
    if (!listing.ok && listing.code === "too_large") throw new DocsAddonError(413, listing.message);
    if (!listing.ok) throw refusal(listing.code, listing.message);
    // The cursor is the device's own last row, before this page is filtered
    // and re-sorted for display.
    const last = listing.value.entries.at(-1);
    const next = listing.value.truncated && last ? workspaceListCursor({ kind: last.kind, label: last.name }) : undefined;
    const entries = listing.value.entries
      .filter((entry) => entry.kind !== "other" && entry.relativePath !== undefined)
      .map((entry) => ({ name: entry.name, path: entry.relativePath!, dir: entry.kind === "directory",
        ...(entry.sizeBytes !== undefined ? { size: entry.sizeBytes } : {}), ...(entry.modifiedAt ? { modifiedAt: entry.modifiedAt } : {}) }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { kind: "dir", workspace: target.workspace, path: target.relativePath, entries, truncated: listing.value.truncated,
      ...(next ? { next } : {}) };
  }
}

/** For a consumer that needs the whole file at once; refuses past `maxBytes` before holding more. */
export async function collectDocsFile(file: DocsFile, maxBytes: number, tooLarge: string): Promise<Buffer> {
  if (file.size > maxBytes) throw new DocsAddonError(413, tooLarge);
  const parts: Buffer[] = [];
  for await (const part of file.chunks) parts.push(part);
  return Buffer.concat(parts);
}

function refusal(code: string, message: string): DocsAddonError {
  if (code === "not_found") return new DocsAddonError(404, "文件不存在，或已被移动");
  if (code === "outside_workspace") return new DocsAddonError(403, "这个路径指向工作区之外，不能打开");
  if (code === "too_large") return new DocsAddonError(413, "所有者设备上的 Runner 版本较旧，仍对大文件设有读取上限；升级后即可打开");
  if (code === "approval_required" || code === "denied") return new DocsAddonError(403, "所有者的 Octopus 授权暂不允许读取这个工作区");
  if (code === "unavailable") return new DocsAddonError(503, "所有者的设备当前不在线，暂时无法读取文件");
  return new DocsAddonError(502, message.slice(0, 200) || "读取文件失败");
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  ".md": "text/markdown", ".markdown": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json", ".jsonl": "application/x-ndjson",
  ".html": "text/plain", ".htm": "text/plain", ".xml": "text/plain",
};
const TEXT_EXT = /\.(txt|log|out|err|ya?ml|toml|ini|cfg|conf|env|ipynb|py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|c|h|cc|cpp|hpp|cu|java|kt|rb|php|sh|bash|zsh|sql|tex|bib|r|jl|m|scala|swift|lua|css|scss|less|vue|svelte|diff|patch|proto|gitignore|lock|mk|cmake)$/i;

/**
 * The media type a card renders a file as. HTML/XML/SVG-as-text are served as
 * plain text or as an image respectively; nothing is ever served as active
 * content to the card's frame.
 */
export function mimeOf(name: string): string {
  const ext = path.posix.extname(name).toLowerCase();
  return MIME[ext] ?? (TEXT_EXT.test(name) ? "text/plain" : "application/octet-stream");
}
