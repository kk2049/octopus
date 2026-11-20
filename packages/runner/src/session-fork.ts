/**
 * Branching a conversation at a completed turn, the way each CLI branches its
 * own: the copy's context is exactly the source's up to that turn, and the
 * source is not touched.
 *
 *  - Claude: the Agent SDK's `forkSession` copies the transcript up to one
 *    message into a new session file with fresh ids. Nothing runs.
 *  - Codex: app-server `thread/fork` with `lastTurnId` writes a new rollout
 *    holding the turns through that one; the client exits right after.
 *
 * The anchor names the turn: Claude's last `end_turn` assistant record, or
 * Codex's last `task_complete`. A snapshot reads it when it is taken and a
 * later fork uses it again, so a branch starts from that moment even after the
 * source has moved on. A turn still running is never an anchor: cutting inside
 * it would leave a tool call without its result.
 */
import { promises as fs } from "node:fs";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { resolveSessionPath, type SessionScanRoot } from "@claude-bot/plugin-sessions/scan";
import { CodexManagedSession } from "./codex-app-server.js";
import { sessionMetadataCwd } from "./owner-file-link.js";

export type ForkSource = "claude" | "codex";

const ANCHOR = /^[A-Za-z0-9-]{8,80}$/;
/**
 * The newest completed turn sits near the end; read backwards in chunks this
 * size until it is found. Memory holds one chunk plus the one record that
 * spans chunk boundaries, never the log.
 */
const TAIL_CHUNK_BYTES = 1024 * 1024;

/**
 * The log read_session shows for an id, as the session index found it: by the
 * id the file's own records carry. File names can mislead — Codex continues a
 * thread in a file named `<thread>_<another id>` — so a snapshot or fork must
 * read the same file the card read, not the one its name points to.
 */
export interface IndexedLog { path: string; scan: SessionScanRoot }

export interface TurnAnchor {
  anchor: string;
  /** The anchor record's own timestamp: everything the session wrote after it belongs to later turns. */
  at?: string;
}

/** The last completed turn of one transcript, or null when no turn has finished yet. */
export async function latestTurnAnchor(file: string, source: ForkSource): Promise<TurnAnchor | null> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    let end = size;
    // Pieces, in file order, of the line whose start lies in an earlier chunk.
    let carry: Buffer[] = [];
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      const cut = start === 0 ? -1 : chunk.indexOf(0x0a);
      if (start > 0 && cut < 0) {
        carry.unshift(chunk);
        end = start;
        continue;
      }
      const lines = Buffer.concat([chunk.subarray(cut + 1), ...carry]).toString("utf8").split("\n");
      carry = start === 0 ? [] : [chunk.subarray(0, cut)];
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const anchor = anchorOf(lines[index], source);
        if (anchor) return anchor;
      }
      end = start;
    }
    return null;
  } finally {
    await handle.close();
  }
}

function anchorOf(line: string, source: ForkSource): TurnAnchor | null {
  if (!line.includes(source === "claude" ? '"end_turn"' : '"task_complete"')) return null;
  let row: Record<string, unknown>;
  try { row = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  let anchor: unknown;
  if (source === "claude") {
    const message = row.message as Record<string, unknown> | undefined;
    if (row.type === "assistant" && row.isSidechain !== true && message?.stop_reason === "end_turn") anchor = row.uuid;
  } else {
    const payload = row.payload as Record<string, unknown> | undefined;
    if (row.type === "event_msg" && payload?.type === "task_complete") anchor = payload.turn_id;
  }
  if (typeof anchor !== "string" || !ANCHOR.test(anchor)) return null;
  const at = typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : undefined;
  return { anchor, ...(at ? { at } : {}) };
}

function sourceOf(value: unknown): ForkSource {
  if (value === "claude" || value === "codex") return value;
  throw new Error("只能分叉 Claude Code 或 Codex 会话");
}

/** `session_anchor`: the session's last completed turn, read-only. */
export async function sessionAnchor(scan: SessionScanRoot, args: Record<string, unknown>, located?: IndexedLog): Promise<TurnAnchor | { anchor: null }> {
  const source = sourceOf(args.source);
  const resolved = await resolveSessionPath(located?.scan ?? scan, source, String(args.id ?? ""), located?.path);
  return await latestTurnAnchor(resolved.path, source) ?? { anchor: null };
}

/**
 * `fork_session`: a new session holding the source's conversation through
 * `anchor` (or through its last completed turn). It runs nothing; the first
 * message reaches it like any message to an idle session.
 */
export async function forkSessionAt(scan: SessionScanRoot, args: Record<string, unknown>, located?: IndexedLog): Promise<{ session_id: string; anchor: string }> {
  const source = sourceOf(args.source);
  const id = String(args.id ?? "");
  const resolved = await resolveSessionPath(located?.scan ?? scan, source, id, located?.path);
  const requested = typeof args.anchor === "string" && args.anchor ? args.anchor : null;
  if (requested !== null && !ANCHOR.test(requested)) throw new Error("分叉位置无效");
  const anchor = requested ?? (await latestTurnAnchor(resolved.path, source))?.anchor;
  if (!anchor) throw new Error("这个会话还没有完成的一轮对话，没有可以分叉的位置");
  const title = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (source === "claude") {
    const forked = await forkSession(id, { upToMessageId: anchor, ...(title ? { title } : {}) });
    return { session_id: forked.sessionId, anchor };
  }
  const cwd = await sessionMetadataCwd(scan, { source, id });
  if (!cwd) throw new Error("读不到这个 Codex 会话的工作目录，无法分叉");
  const sessionId = await CodexManagedSession.forkThrough(
    { sessionId: id, path: resolved.path, lastTurnId: anchor, ...(title ? { name: title } : {}) },
    { cwd, timeoutMs: 60_000, ...(resolved.codexHome ? { codexHome: resolved.codexHome } : {}) },
  );
  return { session_id: sessionId, anchor };
}
