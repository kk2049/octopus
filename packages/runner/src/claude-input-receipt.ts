/**
 * Claude Code's own record of an input it accepted, read back as the receipt
 * for a prompt the Runner typed into its terminal.
 *
 * A keystroke write has no reply channel, but Claude writes every input it
 * takes into the session transcript: a prompt submitted while it is idle as a
 * human-origin `user` record; one typed during a turn first as a
 * `queue-operation` enqueue and, once a turn reads it, as a human-origin
 * `queued_command` attachment. Reading only what was appended after the write
 * and matching the prompt turns "bytes reached the pty" into "Claude queued it"
 * or "Claude took it".
 *
 * Matching ignores whitespace (Claude turns pasted tabs into spaces) and the
 * `<pasted_content>` wrapper it puts around long pastes. Nothing here can cause
 * a write; failing to find a record leaves the receipt as uncertain as before.
 */
import { promises as fs } from "node:fs";
import { promptMatchKey } from "@claude-bot/agent-sessions-contract";

export type ClaudeInputPhase = "local_queued" | "input_observed";

/** One check never reads more than this; the rest is read by the next check. */
const MAX_READ_BYTES = 16 * 1024 * 1024;
const RANK: Record<ClaudeInputPhase, number> = { local_queued: 1, input_observed: 2 };

export class ClaudeInputReceipt {
  private carry = Buffer.alloc(0);
  private found: ClaudeInputPhase | null = null;

  private constructor(private readonly file: string, private readonly expected: string, private offset: number) {}

  /** Marks the transcript's end BEFORE the write. Null when there is no transcript to read. */
  static async open(file: string, prompt: string): Promise<ClaudeInputReceipt | null> {
    const expected = normalizeClaudeInput(prompt);
    if (!expected) return null;
    try {
      return new ClaudeInputReceipt(file, expected, (await fs.stat(file)).size);
    } catch {
      return null;
    }
  }

  /** The strongest evidence Claude has appended since `open`, reading only new bytes. */
  async check(): Promise<ClaudeInputPhase | null> {
    if (this.found === "input_observed") return this.found;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.file, "r");
      const { size } = await handle.stat();
      if (size < this.offset) {
        // Rewritten from the start: nothing appended after the write survives.
        this.offset = size;
        this.carry = Buffer.alloc(0);
        return this.found;
      }
      const length = Math.min(size - this.offset, MAX_READ_BYTES);
      if (length === 0) return this.found;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, this.offset);
      this.offset += bytesRead;
      // Split on the newline BYTE so a character cut by the read boundary waits
      // for its other half instead of decoding as two replacement characters.
      const bytes = Buffer.concat([this.carry, chunk.subarray(0, bytesRead)]);
      const end = bytes.lastIndexOf(0x0a);
      this.carry = end < 0 ? bytes : bytes.subarray(end + 1);
      if (this.carry.length > MAX_READ_BYTES) this.carry = Buffer.alloc(0);
      if (end >= 0) {
        for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) this.consider(line);
      }
    } catch {
      // An unreadable transcript is absent evidence, never a failed write.
    } finally {
      await handle?.close().catch(() => {});
    }
    return this.found;
  }

  private consider(line: string): void {
    // Most appended lines are tool traffic; parse only the three record kinds.
    if (!line.includes('"queue-operation"') && !line.includes('"queued_command"') && !line.includes('"type":"user"')) return;
    let row: unknown;
    try { row = JSON.parse(line); } catch { return; }
    const phase = claudeInputPhase(row, this.expected);
    if (phase && (!this.found || RANK[phase] > RANK[this.found])) this.found = phase;
  }
}

/** What one transcript record proves about `expected` (already normalized). */
export function claudeInputPhase(row: unknown, expected: string): ClaudeInputPhase | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (record.type === "queue-operation") {
    return record.operation === "enqueue" && normalizeClaudeInput(textOf(record.content)) === expected ? "local_queued" : null;
  }
  if (record.type === "attachment") {
    const attachment = record.attachment as Record<string, unknown> | undefined;
    return attachment?.type === "queued_command" && human(attachment.origin)
      && normalizeClaudeInput(textOf(attachment.prompt)) === expected ? "input_observed" : null;
  }
  if (record.type === "user" && record.isMeta !== true && human(record.origin)) {
    const message = record.message as Record<string, unknown> | undefined;
    return normalizeClaudeInput(textOf(message?.content)) === expected ? "input_observed" : null;
  }
  return null;
}

/** Whitespace-insensitive, without the wrapper Claude puts around long pastes. */
export function normalizeClaudeInput(text: string): string {
  return promptMatchKey(text);
}

/** Older transcripts carry no origin; a stamped one must say a human typed it. */
function human(origin: unknown): boolean {
  return origin === undefined || (Boolean(origin) && typeof origin === "object" && (origin as { kind?: unknown }).kind === "human");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text"
    && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "").join(" ");
}

/**
 * Whether Claude recorded the end of tool call `toolUseId` after `offset`:
 * its tool_result, written when the call is answered, cancelled with Esc or
 * interrupted. A transcript that shrank or grew past one read cannot prove the
 * call still open, so it counts as ended.
 */
export async function claudeToolCallEnded(file: string, offset: number, toolUseId: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    if (size < offset || size - offset > MAX_READ_BYTES) return true;
    const chunk = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    return chunk.subarray(0, bytesRead).toString("utf8").split("\n").some((line) => {
      if (!line.includes(toolUseId) || !line.includes('"tool_result"')) return false;
      try {
        const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
        return Array.isArray(content) && content.some((block) => block && typeof block === "object"
          && (block as { type?: unknown }).type === "tool_result"
          && (block as { tool_use_id?: unknown }).tool_use_id === toolUseId);
      } catch {
        return false;
      }
    });
  } catch {
    return true;
  } finally {
    await handle?.close().catch(() => {});
  }
}
