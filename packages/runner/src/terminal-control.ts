/**
 * Conservative control of an Agent that already owns a tmux pane.
 *
 * A TTY match is evidence, not a licence to spray key presses.  We only expose
 * an input attachment when exactly one live pane owns the exact tty of the
 * hook-observed process. Read-only discovery refuses copy mode. An explicit
 * write may leave copy mode, but only after proving the unique pane and then
 * re-proving its tty, identity and mode before any text is sent. Text is pasted
 * via a private tmux buffer (stdin, never a shell command) and Enter is sent as
 * a separate key after the paste succeeds.
 */

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";

export interface TmuxPaneAttachment {
  paneId: string;
  ttyPath: string;
}

export interface TerminalControlOptions {
  run?: (bin: string, args: string[], input?: string) => Promise<{ stdout: string }>;
  readlink?: (path: string) => Promise<string>;
  wait?: (ms: number) => Promise<void>;
}

export interface TerminalAppendOptions {
  /**
   * The prompt glyphs of the TUI's composer, e.g. `❯` for Claude Code. When
   * given, text is pasted only while the pane shows that composer focused and
   * empty; anything else (a picker, panel or dialog, or a half-typed draft)
   * refuses before a single byte is written. See `composerState`.
   */
  composerGlyphs?: readonly string[];
  /**
   * Optional provider evidence that the pasted prompt crossed the submit
   * boundary. When present, a pane redraw alone is not a receipt: full-screen
   * TUIs also redraw while leaving the prompt parked in their composer.
   */
  confirmSubmitted?: () => Promise<boolean>;
  /** How long `confirmSubmitted` may take to find its evidence; defaults to the pane-redraw window. */
  confirmTimeoutMs?: number;
}

interface TmuxPaneObservation {
  paneId: string;
  dead: string | undefined;
  inMode: string | undefined;
}

const PASTE_SETTLE_MS = 200;
/**
 * Keep the existing grace period for large pastes and terminals that do not
 * advertise bracketed paste. Timing alone cannot delimit a paste: a busy TUI
 * may read the text and Enter together even after this delay.
 */
const LARGE_PASTE_SETTLE_MS = 5_000;
const LARGE_PASTE_CHARS = 1_000;
const CONFIRM_TIMEOUT_MS = 2_500;
const CONFIRM_POLL_MS = 100;
/**
 * A stop key is one keystroke, so the pane reacts in a frame or two. Waiting
 * as long as a paste+submit would only delay an honest "could not confirm".
 */
const INTERRUPT_CONFIRM_TIMEOUT_MS = 1_200;

export class TerminalSubmissionUnconfirmedError extends Error {
  readonly code = "tmux_submission_unconfirmed";
}

/** Nothing was written: the composer was not there to receive a paste. */
export class TerminalComposerNotReadyError extends Error {
  readonly code = "terminal_composer_busy";
  readonly inputNotSent = true as const;
}

/**
 * What the pane shows where a paste would land.
 *
 * - `empty`: the terminal cursor is visible, its row starts with a composer
 *   glyph, the cursor sits right after that glyph and nothing but blanks or
 *   dimmed placeholder text follows it.
 * - `draft`: the composer holds text the person typed and did not send.
 *   Pasting would append to it and Enter would submit both.
 * - `elsewhere`: the cursor is hidden or not on a composer row: a picker,
 *   panel, menu, permission dialog or another input mode has the keyboard, and
 *   pasted text could select, delete or change settings there.
 */
export type ComposerState = "empty" | "draft" | "elsewhere";

export class TerminalControl {
  private snapshot?: { at: number; rows: string[] };
  private snapshotFlight?: Promise<string[]>;
  private snapshotGeneration = 0;
  private readonly run: NonNullable<TerminalControlOptions["run"]>;
  private readonly readlink: NonNullable<TerminalControlOptions["readlink"]>;
  private readonly wait: NonNullable<TerminalControlOptions["wait"]>;

  constructor(options: TerminalControlOptions = {}) {
    this.run = options.run ?? run;
    this.readlink = options.readlink ?? fs.readlink;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async attachmentForPid(pid: number, fresh = false): Promise<TmuxPaneAttachment | null> {
    return this.resolveAttachmentForPid(pid, false, fresh);
  }

  /**
   * Resolve a pane for one user-requested write, returning it in the live tail
   * view when it was parked in tmux copy/history mode.
   */
  async writableAttachmentForPid(pid: number): Promise<TmuxPaneAttachment | null> {
    return this.resolveAttachmentForPid(pid, true, true);
  }

  private async resolveAttachmentForPid(
    pid: number,
    exitCopyMode: boolean,
    fresh = false,
  ): Promise<TmuxPaneAttachment | null> {
    if (!Number.isInteger(pid) || pid <= 1 || process.platform === "win32") return null;
    const ttyPath = await this.ttyForPid(pid);
    if (!ttyPath) return null;
    if (!/^\/dev\/(?:pts\/\d+|tty\d+)$/.test(ttyPath)) return null;

    const observations = await this.paneObservations(ttyPath, fresh);
    const paneId = exactLivePaneId(observations);
    if (!paneId) return null;
    const modes = new Set(observations.map((row) => row.inMode));
    if (modes.size !== 1) return null;
    if (modes.has("0")) {
      // The list and /proc reads are separate snapshots. A write path closes
      // that TTY-rebind window before returning the attachment.
      if (exitCopyMode && await this.ttyForPid(pid) !== ttyPath) return null;
      return { paneId, ttyPath };
    }
    // tmux currently reports pane_in_mode as 0/1. Do not interpret a missing
    // or future value as permission to change terminal state.
    if (!exitCopyMode || !modes.has("1")) return null;

    try {
      // `copy-mode -q` cancels copy/history mode and returns the pane to its
      // live tail without forwarding Escape or any other key to the TUI.
      await this.run("tmux", ["copy-mode", "-q", "-t", paneId]);
    } catch {
      return null;
    }

    // Exiting copy mode is an await boundary and may race a process exit,
    // fd/TTY replacement or tmux pane rebind. Re-prove every identity fact.
    if (await this.ttyForPid(pid) !== ttyPath) return null;
    const refreshed = await this.paneObservations(ttyPath, true);
    if (exactLivePaneId(refreshed) !== paneId || refreshed.some((row) => row.inMode !== "0")) return null;
    return { paneId, ttyPath };
  }

  private async ttyForPid(pid: number): Promise<string | null> {
    try {
      return await this.readlink(`/proc/${pid}/fd/0`);
    } catch {
      return null;
    }
  }

  /** Shared read-only snapshot, including panes whose user is in copy mode. */
  async observedTtys(): Promise<ReadonlySet<string>> {
    return new Set((await this.paneRows()).flatMap((line) => {
      const [, tty, dead] = line.trim().split("\t");
      return tty && dead === "0" ? [tty] : [];
    }));
  }

  private async paneRows(fresh = false): Promise<string[]> {
    if (!fresh && this.snapshot && Date.now() - this.snapshot.at < 2_000) return this.snapshot.rows;
    if (!fresh && this.snapshotFlight) return this.snapshotFlight;
    const generation = ++this.snapshotGeneration;
    if (fresh) this.snapshot = undefined;
    const flight = this.run("tmux", ["list-panes", "-a", "-F",
      "#{pane_id}\t#{pane_tty}\t#{pane_dead}\t#{pane_in_mode}"])
      .then(({ stdout }) => {
        const rows = stdout.split("\n");
        if (generation === this.snapshotGeneration) this.snapshot = { at: Date.now(), rows };
        return rows;
      }).catch(() => []).finally(() => {
        if (this.snapshotFlight === flight) this.snapshotFlight = undefined;
      });
    this.snapshotFlight = flight;
    return flight;
  }

  private async paneObservations(ttyPath: string, fresh = false): Promise<TmuxPaneObservation[]> {
    try {
      return (await this.paneRows(fresh)).flatMap((line) => {
        const [paneId, paneTty, dead, inMode] = line.trim().split("\t");
        return paneId && paneTty === ttyPath
          ? [{ paneId, dead, inMode }]
          : [];
      });
    } catch {
      return [];
    }
  }

  async append(
    attachment: TmuxPaneAttachment,
    prompt: string,
    options: TerminalAppendOptions = {},
  ): Promise<void> {
    const text = prompt.trim();
    if (!text) throw new Error("发送到 CLI 的 prompt 不能为空");
    if (options.composerGlyphs) {
      const state = await this.composerState(attachment.paneId, options.composerGlyphs);
      if (state === "draft") {
        throw new TerminalComposerNotReadyError(
          "CLI 输入框里有还没发出的文字（可能是在终端里打了一半，或上一条没有提交成功），这次没有发送，以免两段话拼在一起。请先到终端里发出或清空它，再重试。",
        );
      }
      if (state === "elsewhere") {
        throw new TerminalComposerNotReadyError(
          "CLI 现在显示的不是输入框（可能打开了选择框、面板或确认对话框），这次没有发送，以免按键落到别的地方。请先到终端里关掉它，再重试。",
        );
      }
    }
    const buffer = `octopus-${process.pid}-${randomBytes(6).toString("hex")}`;
    await this.run("tmux", ["load-buffer", "-b", buffer, "-"], text);
    try {
      // -p encloses the text in bracketed-paste markers when the TUI requests
      // them, so the subsequent Enter is outside the paste even if both arrive
      // in one read. -r preserves embedded LF instead of turning each into CR.
      await this.run("tmux", ["paste-buffer", "-p", "-r", "-b", buffer, "-t", attachment.paneId, "-d"]);
      // Let the TUI process the paste, snapshot the exact pane, then send one
      // separate submit key. Never compensate for an unknown result by sending
      // another Enter or replaying the text.
      await this.wait(pasteSettleMs(text));
      const beforeSubmit = await this.capture(attachment.paneId);
      await this.run("tmux", ["send-keys", "-t", attachment.paneId, "C-m"]);

      // A successful tmux command proves only that bytes reached the pty. The
      // TUI must visibly react before this non-idempotent write is reported as
      // accepted. Failure is deliberately indeterminate: never replay a prompt
      // that might actually have crossed the submit boundary.
      const attempts = Math.ceil((options.confirmSubmitted && options.confirmTimeoutMs ? options.confirmTimeoutMs : CONFIRM_TIMEOUT_MS) / CONFIRM_POLL_MS);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await this.wait(CONFIRM_POLL_MS);
        if (options.confirmSubmitted) {
          // Confirmation is best-effort evidence after bytes were sent. A
          // failed hook/file check therefore means "unknown", not a safe
          // prompt replay and not a second Enter.
          if (await options.confirmSubmitted().catch(() => false)) return;
        } else if (await this.capture(attachment.paneId) !== beforeSubmit) {
          return;
        }
      }
      throw new TerminalSubmissionUnconfirmedError(
        "等待 tmux 响应超时，无法确认 prompt 是否已提交；不会自动重发。请到本机 CLI 核对并继续操作，或在确认本轮没有执行后选择“交给 Octopus 托管”。",
      );
    } finally {
      // `paste-buffer -d` normally removed it. This is a best-effort cleanup
      // for older tmux versions and failed pastes.
      await this.run("tmux", ["delete-buffer", "-b", buffer]).catch(() => {});
    }
  }

  /**
   * Ask the TUI in this pane to stop its current turn — and nothing else.
   *
   * `Escape` is the stop key BOTH supported TUIs already publish to their own
   * users: it ends the running generation or tool loop and leaves the session,
   * the process and the pane exactly where they were, so the person can type
   * the next thing (or `--resume` it later) as if they had pressed it
   * themselves. That is the whole reason a key is used here instead of a
   * signal: `C-c`/SIGINT is the TUI's QUIT path, and SIGKILL on a pane's
   * process would leave a live tmux window around a dead program.
   *
   * One key, once. A pane that does not visibly react is reported as
   * unconfirmed rather than pressed again: a second Escape in a TUI that
   * already stopped is the keystroke that clears the composer draft.
   */
  async interrupt(attachment: TmuxPaneAttachment): Promise<{ confirmed: boolean }> {
    const before = await this.capture(attachment.paneId);
    await this.run("tmux", ["send-keys", "-t", attachment.paneId, "Escape"]);
    const attempts = Math.ceil(INTERRUPT_CONFIRM_TIMEOUT_MS / CONFIRM_POLL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await this.wait(CONFIRM_POLL_MS);
      if (await this.capture(attachment.paneId) !== before) return { confirmed: true };
    }
    return { confirmed: false };
  }

  private async capture(paneId: string): Promise<string> {
    const { stdout } = await this.run("tmux", ["capture-pane", "-p", "-t", paneId]);
    return stdout;
  }

  /** Read where a paste would land; see `ComposerState`. Read-only. */
  async composerState(paneId: string, glyphs: readonly string[]): Promise<ComposerState> {
    const { stdout: cursor } = await this.run("tmux", ["display-message", "-p", "-t", paneId,
      "#{cursor_flag} #{cursor_x} #{cursor_y}"]);
    const [flag, x, y] = cursor.trim().split(/\s+/).map(Number);
    if (flag !== 1 || !Number.isInteger(x) || !Number.isInteger(y) || x! < 0 || y! < 0) return "elsewhere";
    const { stdout: screen } = await this.run("tmux", ["capture-pane", "-p", "-e", "-t", paneId]);
    return composerRowState(screen.split("\n")[y!] ?? "", x!, glyphs);
  }
}

/**
 * Classify one captured row (with SGR escapes) against the cursor column.
 * Exported for tests; `TerminalControl.composerState` is the only caller.
 */
export function composerRowState(row: string, cursorX: number, glyphs: readonly string[]): ComposerState {
  const cells = styledCells(row);
  // An older composer sits inside a box: `│ > `. Its border and indentation
  // are allowed before the glyph, and the closing border after the input.
  let at = 0;
  while (at < cells.length && (cells[at]!.char === "│" || isBlank(cells[at]!.char))) at += 1;
  const glyph = cells[at];
  if (!glyph || !glyphs.includes(glyph.char)) return "elsewhere";
  const inputStart = at + 1;
  if (!cells[inputStart] || !isBlank(cells[inputStart]!.char)) return "elsewhere";
  // Columns, not code points: a wide character before the cursor would shift it.
  let column = 0;
  for (let index = 0; index <= inputStart; index += 1) column += cellWidth(cells[index]!.char);
  if (cursorX !== column) return cursorX > column ? "draft" : "elsewhere";
  const rest = cells.slice(inputStart + 1);
  while (rest.length && (rest[rest.length - 1]!.char === "│" || isBlank(rest[rest.length - 1]!.char))) rest.pop();
  return rest.every((cell) => cell.dim || isBlank(cell.char)) ? "empty" : "draft";
}

interface StyledCell { char: string; dim: boolean }

/** Visible characters with their dim (SGR 2) state; other escapes are dropped. */
function styledCells(row: string): StyledCell[] {
  const cells: StyledCell[] = [];
  let dim = false;
  for (let index = 0; index < row.length;) {
    if (row[index] === "\u001b") {
      if (row[index + 1] === "[") {
        let end = index + 2;
        while (end < row.length && !/[@-~]/.test(row[end]!)) end += 1;
        if (row[end] === "m") dim = sgrDim(row.slice(index + 2, end), dim);
        index = end + 1;
      } else if (row[index + 1] === "]") {
        // OSC (e.g. a hyperlink): ends at BEL or ST.
        let end = index + 2;
        while (end < row.length && row[end] !== "\u0007" && !(row[end] === "\u001b" && row[end + 1] === "\\")) end += 1;
        index = row[end] === "\u0007" ? end + 1 : end + 2;
      } else {
        index += 2;
      }
      continue;
    }
    const char = String.fromCodePoint(row.codePointAt(index)!);
    cells.push({ char, dim });
    index += char.length;
  }
  return cells;
}

/** Apply one SGR parameter list to the dim state, skipping colour arguments. */
function sgrDim(parameters: string, dim: boolean): boolean {
  const codes = parameters === "" ? [0] : parameters.split(/[;:]/).map((code) => Number(code || 0));
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 38 || code === 48 || code === 58) {
      index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 1;
    } else if (code === 0 || code === 22) {
      dim = false;
    } else if (code === 2) {
      dim = true;
    }
  }
  return dim;
}

function isBlank(char: string): boolean {
  return char === " " || char === "\u00a0" || char === "\t";
}

/** Terminal column width: East Asian wide and fullwidth characters take two. */
function cellWidth(char: string): number {
  const code = char.codePointAt(0)!;
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x20000 && code <= 0x3fffd)
    ? 2 : 1;
}

function pasteSettleMs(text: string): number {
  return text.includes("\n") || text.length >= LARGE_PASTE_CHARS
    ? LARGE_PASTE_SETTLE_MS
    : PASTE_SETTLE_MS;
}

/**
 * `tmux list-panes -a` prints one row per grouped-session alias. Collapse only
 * identical stable pane ids and fail closed on a dead/conflicting observation.
 */
function exactLivePaneId(observations: TmuxPaneObservation[]): string | null {
  const paneIds = new Set(observations.map((row) => row.paneId));
  if (paneIds.size !== 1 || observations.some((row) => row.dead !== "0")) return null;
  return [...paneIds][0] ?? null;
}

type SpawnCommand = (
  bin: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

/** @internal Exported only so the child-process boundary can be tested deterministically. */
export async function runTerminalCommand(
  bin: string,
  args: string[],
  input = "",
  spawnCommand: SpawnCommand = spawn,
): Promise<{ stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawnCommand(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let spawnFailed = false;
    let stdinFinished = false;
    let stdinFailed = false;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-256 * 1024); });
    // Always drain stderr, but never carry raw command output (which may echo
    // stdin) across this trust boundary in an error message.
    child.stderr.resume();
    // Node guarantees `close` after either `exit` or a spawn-time `error`.
    // Record the phase here, then settle once at `close` after stdio events
    // have had their chance to establish whether input was delivered.
    child.once("error", () => { spawnFailed = true; });
    child.stdin.once("finish", () => { stdinFinished = true; });
    // A short-lived command can close fd 0 before `end(input)` flushes. Without
    // this listener Node treats EPIPE as an uncaught EventEmitter error and
    // terminates the entire Runner. Keep listening until the stream is gone so
    // even an error arriving after process settlement stays contained here.
    child.stdin.on("error", () => { stdinFailed = true; });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (spawnFailed) {
        reject(new Error(`${bin} could not start`));
      } else if (code !== 0) {
        reject(new Error(`${bin} exited (${String(code ?? signal ?? "unknown")})`));
      } else if (input.length > 0 && (!stdinFinished || stdinFailed)) {
        reject(new Error(`${bin} exited before stdin was delivered`));
      } else {
        resolve({ stdout });
      }
    });
    try {
      // Read-only commands have no payload to deliver. Do not turn their close
      // into a zero-byte write that can race a short-lived child and raise EPIPE.
      if (input.length > 0) child.stdin.end(input);
      else child.stdin.end();
    } catch {
      // Preserve the command's eventual exit status as the primary outcome.
      // A zero exit will still fail below when non-empty stdin was not sent.
      stdinFailed = true;
    }
  });
}

const run = runTerminalCommand;
