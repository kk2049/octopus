import { sessionInputStage } from "./session-input-perf.js";
import { readSessionInputMetadata } from "./session-metadata.js";
import { interruptNativeDevelopment, resolveNativeDevelopmentWorkspace } from "./development-session.js";
import type { SessionObservationIndex } from "./session-observation.js";
import { withAgentOperation } from "./agent-executables.js";
/**
 * Machine operations — the "this laptop as a working endpoint" half of the
 * Runner, as opposed to the session-investigation half.
 *
 * Trust model (doc/design-machines-and-memory.md §2): these run on the
 * user's OWN machine, as the user's own OS account, because that user
 * installed this Runner with their own device token. There is deliberately
 * no path jail here — the boundary is the OS account, exactly as it would be
 * if they opened a terminal. What the bot side guarantees is that only THAT
 * user's sessions can address THIS device (loopback capability tokens are
 * minted per username).
 *
 * What we do enforce is blast-radius hygiene on each CALL, never on the total
 * a caller asks for: a command timeout, and bounded windows for what one
 * answer carries. A command's output beyond its inline head+tail window spills
 * to a device file the caller pages with `read_file`; files are read in
 * offset windows, written in appended chunks, and directories listed in
 * cursor pages. So a runaway command or a huge file cannot wedge the runner or
 * flood the gateway, and nothing a user legitimately asks for is unreachable.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { MACHINE_LIMITS } from "./limits.js";
import {
  resolveSessionPath,
  deriveIdFromPath,
  ENUMERATED_SOURCES,
  type Source,
  type SessionScanRoot,
} from "@claude-bot/plugin-sessions/scan";
import type { AgentRuntimeRegistry } from "./agent-runtime.js";
import type { AgentInteractionBroker } from "./agent-interactions.js";
import type { AgentControlPlane } from "./agent-control-plane.js";
import type { SessionInputReceipt } from "./gateway-protocol.js";
import {
  type CodexExecRelayCoordinator,
  type CodexRemoteEnvironment,
} from "./codex-exec-relay.js";
import { LaunchJournal } from "./launch-journal.js";
import { ScopedMcpProxy } from "./scoped-mcp-proxy.js";
import { CodexManagedSession } from "./codex-app-server.js";
import { agentEffort, agentModel, agentPermissionProfile } from "./agent-permissions.js";
import { markInputHandoff } from "./input-handoff.js";
import type { CodexAccountRouter } from "./codex-account-routing.js";
import { resolveWorkspace, type WorkspaceRecord } from "./workspaces.js";

// One canonical set, shared with the bot's capability registry (limits.ts).
export const EXEC_DEFAULT_TIMEOUT_MS = MACHINE_LIMITS.execDefaultTimeoutMs;
export const EXEC_MAX_TIMEOUT_MS = MACHINE_LIMITS.execTimeoutMaxMs;
export const EXEC_MAX_OUTPUT = MACHINE_LIMITS.execMaxOutputBytes;
export const FILE_MAX_BYTES = MACHINE_LIMITS.readFileMaxBytes;
export const WRITE_MAX_BYTES = MACHINE_LIMITS.writeFileMaxBytes;
export const LIST_MAX_ENTRIES = MACHINE_LIMITS.listMaxEntries;
/**
 * Spilled command output is a hand-off to the caller's next `read_file`, not
 * an archive: kept a day, and at most this many files. A file younger than the
 * longest possible exec may still be written to and is never pruned.
 */
export const EXEC_SPILL_TTL_MS = 24 * 60 * 60_000;
export const EXEC_SPILL_KEEP_FILES = 64;
/**
 * Disk safety, not a cap on what the caller sees: a runaway stream (`yes`)
 * could otherwise write timeout × pipe throughput into the owner's home. Past
 * it the stream is still drained (the command is never blocked or killed) and
 * its tail still returned inline; only the bytes between stop being saved.
 */
export const EXEC_SPILL_MAX_BYTES = 1024 * 1024 * 1024;
const EXEC_SPILL_LIVE_MS = EXEC_MAX_TIMEOUT_MS + 60_000;
/** Budget of the explicit account-fallback fork; provider-native attachments own their lifecycle. */
export const APPEND_TIMEOUT_MS = MACHINE_LIMITS.appendTimeoutMs;
export const APPEND_MAX_PROMPT = MACHINE_LIMITS.appendMaxPromptBytes;
export const APPEND_RESULT_CAP = 4_000;

export interface ExecResult {
  ok: boolean;
  /** Exit status; the spawn error code (e.g. `ENOENT`) when the shell never started. */
  exit_code: number | string | null;
  signal: string | null;
  /** The whole stream, or its head and tail around an explicit omission marker. */
  stdout: string;
  stderr: string;
  /** True when either inline text is not the whole stream. */
  truncated: boolean;
  timed_out: boolean;
  cwd: string;
  duration_ms: number;
  /** Bytes the command wrote to each stream. */
  stdout_bytes: number;
  stderr_bytes: number;
  /** The complete stream on this device, present only when it outgrew the inline window. */
  stdout_path?: string;
  stderr_path?: string;
  /** Present when that spill file holds only the stream's first `EXEC_SPILL_MAX_BYTES`. */
  stdout_spill_truncated?: true;
  stderr_spill_truncated?: true;
}

/** Where `exec` spills output that outgrows its inline window. */
export function execSpillDir(home: string): string {
  return path.join(home, ".octopus", "runner", "exec-output");
}

/**
 * Execute inside a device-resolved registered workspace without returning its
 * canonical path. A spill path is still returned: it names the Runner's own
 * output file, outside the workspace, so this caller can page it with its next
 * command. That command already runs as this OS account, so the path widens
 * nothing; it is not the workspace identity the omitted `cwd` would reveal.
 */
export async function machineExecWorkspace(home: string, args: Record<string, unknown>): Promise<unknown> {
  const workspaceId = String(args.workspace_id ?? "").trim();
  let workspace: WorkspaceRecord;
  try {
    workspace = await resolveWorkspace(home, workspaceId);
  } catch {
    return { ok: false, code: "workspace_not_found", error: "工作区不存在、未登记或当前不可访问" };
  }
  const result = await machineExec({ ...args, cwd: workspace.path }, execSpillDir(home));
  const { cwd: _canonicalPath, ...publicResult } = result;
  return { ...publicResult, workspace_id: workspaceId };
}

/**
 * `RUNNER_EXEC_NICE=<1..19>` runs every `exec` at that CPU nice level and at
 * idle IO priority (when `ionice` exists). Set by the CI container, where an
 * agent's build must never outrank the Runner process that carries it or the
 * machine's sshd; unset on laptops, where the owner's commands are the point.
 */
export function execNiceLevel(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.RUNNER_EXEC_NICE?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 19 ? n : 0;
}

function singleQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** The command line `exec` actually runs: the caller's command, re-niced when configured. */
export function execCommandLine(command: string, env: Readonly<Record<string, string | undefined>>): string {
  const nice = execNiceLevel(env);
  if (nice === 0) return command;
  // `ionice` is Linux-only; fall through to plain `nice` elsewhere.
  return `if command -v ionice >/dev/null 2>&1; then exec nice -n ${nice} ionice -c 3 bash -c ${singleQuote(command)};`
    + ` else exec nice -n ${nice} bash -c ${singleQuote(command)}; fi`;
}

/**
 * Trusted local shell selection. Git Bash gives native Windows Runners the
 * same command language as existing Linux/macOS devices without requiring
 * WSL. The onboarding installer pins its discovered absolute path here;
 * other installations retain the historical platform default.
 */
export function runnerExecShell(
  env: Readonly<Record<string, string | undefined>>,
  platform = process.platform,
): string {
  const configured = env.RUNNER_EXEC_SHELL?.trim();
  if (configured) return configured;
  if (platform === "win32") return env.ComSpec?.trim() || "cmd.exe";
  return "/bin/bash";
}

/** Run a shell command on this machine as the runner's own OS user. */
export async function machineExec(
  args: Record<string, unknown>,
  spillDir = execSpillDir(os.homedir()),
  spillMaxBytes = EXEC_SPILL_MAX_BYTES,
): Promise<ExecResult> {
  const command = String(args.command ?? "").trim();
  if (!command) throw new Error("exec requires `command`");
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : os.homedir();
  const timeout = Math.min(
    EXEC_MAX_TIMEOUT_MS,
    Math.max(1_000, Number(args.timeout_ms ?? EXEC_DEFAULT_TIMEOUT_MS) || EXEC_DEFAULT_TIMEOUT_MS),
  );

  const started = Date.now();
  // The configured shell runs `-c <command>` under the same option
  // normalisation `exec` used (cmd.exe quoting included). Unlike `exec`,
  // output volume never kills the command: `maxBuffer` used to SIGKILL a
  // verbose build midway. Output now streams into bounded windows instead.
  const child = spawn(execCommandLine(command, process.env), {
    cwd,
    shell: runnerExecShell(process.env),
    windowsHide: true,
  });
  let exited = false;
  let timedOut = false;
  const status = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: NodeJS.ErrnoException }>(
    (resolve) => {
      child.on("exit", (code, signal) => {
        exited = true;
        resolve({ code, signal });
      });
      // A shell that never started emits `error` and no `exit`.
      child.on("error", (error) => resolve({ code: null, signal: null, error }));
    },
  );
  const timer = setTimeout(() => {
    // As `exec` did: a process still running is killed and reported timed
    // out, and the pipes are closed either way, so a background grandchild
    // that inherited them cannot hold this call open.
    timedOut = !exited;
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (!exited) child.kill("SIGKILL");
  }, timeout);
  const spill = execSpill(spillDir, started);
  const [result, stdout, stderr] = await Promise.all([
    status,
    captureStream(child.stdout!, () => spill("stdout"), spillMaxBytes),
    captureStream(child.stderr!, () => spill("stderr"), spillMaxBytes),
  ]);
  clearTimeout(timer);
  return {
    ok: !result.error && !timedOut && result.code === 0 && result.signal === null,
    exit_code: result.error ? (result.error.code ?? null) : result.code,
    signal: result.signal ?? null,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    timed_out: timedOut,
    cwd,
    duration_ms: Date.now() - started,
    stdout_bytes: stdout.bytes,
    stderr_bytes: stderr.bytes,
    ...(stdout.path ? { stdout_path: stdout.path } : {}),
    ...(stderr.path ? { stderr_path: stderr.path } : {}),
    ...(stdout.spillTruncated ? { stdout_spill_truncated: true as const } : {}),
    ...(stderr.spillTruncated ? { stderr_spill_truncated: true as const } : {}),
  };
}

interface CapturedStream {
  text: string;
  bytes: number;
  truncated: boolean;
  path?: string;
  spillTruncated?: true;
}

interface SpillFile {
  path: string;
  file: FileHandle;
}

/**
 * Drain one output stream without ever stopping the command for its volume.
 *
 * While the stream fits `window` it is kept whole. Past it, only the first and
 * last half-windows stay in memory and every byte, from the first, goes to a
 * spill file. Each file write is awaited before the next chunk is pulled, so a
 * slow disk applies backpressure through the pipe rather than growing a
 * backlog here. A failed spill is reported in the marker, never as a path.
 * A spill that reaches `spillMax` stops growing; the stream is still drained
 * and its tail kept, and the marker and result say the file is a prefix.
 */
async function captureStream(
  stream: Readable,
  openSpill: () => Promise<SpillFile>,
  spillMax: number,
  window = EXEC_MAX_OUTPUT,
): Promise<CapturedStream> {
  const half = Math.floor(window / 2);
  let whole: Buffer[] = [];
  let bytes = 0;
  let head: Buffer | undefined;
  const tail: Buffer[] = [];
  let tailBytes = 0;
  let spill: SpillFile | undefined;
  let spillError = "";
  let spilled = 0;
  let spillCapped = false;
  const keepTail = (chunk: Buffer) => {
    tail.push(chunk);
    tailBytes += chunk.length;
    while (tail.length > 1 && tailBytes - tail[0].length >= half) tailBytes -= tail.shift()!.length;
  };
  const dropSpill = async (error: unknown) => {
    spillError = error instanceof Error ? error.message : String(error);
    const dropped = spill;
    spill = undefined;
    await dropped?.file.close().catch(() => undefined);
    if (dropped) await fs.rm(dropped.path, { force: true }).catch(() => undefined);
  };
  const persist = async (chunk: Buffer) => {
    if (!spill || spillCapped) return;
    const room = spillMax - spilled;
    if (chunk.length >= room) spillCapped = true;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    try {
      await spill.file.appendFile(part);
      spilled += part.length;
    } catch (error) {
      await dropSpill(error);
    }
  };
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (head) {
        keepTail(chunk);
        await persist(chunk);
        continue;
      }
      whole.push(chunk);
      if (bytes <= window) continue;
      const all = Buffer.concat(whole);
      whole = [];
      head = all.subarray(0, half);
      keepTail(all.subarray(half));
      try {
        spill = await openSpill();
      } catch (error) {
        spillError = error instanceof Error ? error.message : String(error);
      }
      await persist(all);
    }
  } catch {
    // Destroyed at the timeout; what arrived is still reported, and spilled.
  }
  if (spill) {
    try {
      await spill.file.close();
    } catch (error) {
      await dropSpill(error);
    }
  }
  if (!head) return { text: Buffer.concat(whole).toString("utf8"), bytes, truncated: false };
  const first = head.subarray(0, utf8Prefix(head));
  const tailAll = Buffer.concat(tail);
  const tailWindow = tailAll.subarray(Math.max(0, tailAll.length - half));
  const last = tailWindow.subarray(utf8Start(tailWindow));
  const omitted = bytes - first.length - last.length;
  const capped = Boolean(spill) && spillCapped && spilled < bytes;
  const where = !spill
    ? `完整输出未能保存：${spillError || "未知错误"}`
    : capped
      ? `仅前 ${spilled} 字节保存在 ${spill.path}（落盘达到每流上限，其后未保存）`
      : `完整输出见 ${spill.path}`;
  return {
    text: `${first.toString("utf8")}\n…[省略中间 ${omitted} 字节；${where}]…\n${last.toString("utf8")}`,
    bytes,
    truncated: true,
    ...(spill ? { path: spill.path } : {}),
    ...(capped ? { spillTruncated: true as const } : {}),
  };
}

/** Length of the longest prefix of `bytes` that does not end inside a UTF-8 sequence. */
function utf8Prefix(bytes: Buffer): number {
  let lead = bytes.length - 1;
  while (lead >= 0 && bytes.length - lead < 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
  if (lead < 0) return bytes.length;
  const byte = bytes[lead];
  const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return lead + need > bytes.length ? lead : bytes.length;
}

/** Offset of the first byte that is not the continuation of a sequence cut off before it. */
function utf8Start(bytes: Buffer): number {
  let start = 0;
  while (start < bytes.length && start < 3 && (bytes[start] & 0xc0) === 0x80) start++;
  return start;
}

/** One run's spill files. Pruning runs once, when the run first needs a file. */
function execSpill(dir: string, started: number): (stream: "stdout" | "stderr") => Promise<SpillFile> {
  const run = `${started}-${randomBytes(6).toString("hex")}`;
  let ready: Promise<void> | undefined;
  return async (stream) => {
    ready ??= (async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await pruneExecSpills(dir, Date.now());
    })();
    await ready;
    const file = path.join(dir, `${run}.${stream}.log`);
    return { path: file, file: await fs.open(file, "ax", 0o600) };
  };
}

/**
 * Retire spill files older than a day, or beyond the newest few, but never one
 * a run that may still be alive could be writing. Unrecognised names are left
 * alone.
 */
export async function pruneExecSpills(dir: string, now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const files = names
    .map((name) => ({ name, at: Number(/^(\d+)-[0-9a-f]+\.(?:stdout|stderr)\.log$/.exec(name)?.[1]) }))
    .filter((file) => Number.isSafeInteger(file.at))
    .sort((a, b) => b.at - a.at);
  await Promise.all(files
    .filter((file, rank) => now - file.at > EXEC_SPILL_LIVE_MS
      && (rank >= EXEC_SPILL_KEEP_FILES || now - file.at > EXEC_SPILL_TTL_MS))
    .map((file) => fs.rm(path.join(dir, file.name), { force: true }).catch(() => undefined)));
}

/**
 * Read one window of a file: up to `max_bytes` (at most the per-call window)
 * from byte `offset`. Following `next_offset` until `eof` reaches any file
 * size. A window that would end inside a UTF-8 character ends before it, so
 * the windows' `content` concatenates back to the exact text.
 */
export async function machineReadFile(args: Record<string, unknown>): Promise<unknown> {
  const p = String(args.path ?? "").trim();
  if (!p) throw new Error("read_file requires `path`");
  const target = path.resolve(p);
  const st = await fs.stat(target);
  if (!st.isFile()) throw new Error("不是普通文件");
  const max = Math.max(1024, Math.min(FILE_MAX_BYTES, Number(args.max_bytes ?? FILE_MAX_BYTES) || FILE_MAX_BYTES));
  const offset = Number(args.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset 必须是非负整数");
  // One byte past the window says whether the file goes on.
  const window = Buffer.alloc(max + 1);
  let filled = 0;
  const handle = await fs.open(target, "r");
  try {
    while (filled < window.length) {
      const { bytesRead } = await handle.read(window, filled, window.length - filled, offset + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const eof = filled <= max;
  const length = eof ? filled : utf8Prefix(window.subarray(0, max));
  return {
    path: target,
    size: st.size,
    offset,
    bytes: length,
    next_offset: offset + length,
    eof,
    truncated: offset > 0 || !eof,
    content: window.subarray(0, length).toString("utf8"),
  };
}

/**
 * Write or append one chunk. Content larger than one call (the capability
 * kernel bounds a call's arguments) goes as a first chunk followed by
 * `append: true` chunks; `size` after each call lets the caller confirm the
 * file holds what it sent before sending the next. Not atomic: a reader can
 * observe the file between chunks, and an overwrite truncates before writing.
 * A caller that needs atomic replacement writes a sibling path and renames it.
 */
export async function machineWriteFile(args: Record<string, unknown>): Promise<unknown> {
  const p = String(args.path ?? "").trim();
  if (!p) throw new Error("write_file requires `path`");
  const content = String(args.content ?? "");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > WRITE_MAX_BYTES) {
    throw new Error(`内容过大 (${bytes} > ${WRITE_MAX_BYTES} 字节)；请分块写入：首块覆盖，其余各块 append=true`);
  }
  const target = path.resolve(p);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (args.append) await fs.appendFile(target, content, "utf8");
  else await fs.writeFile(target, content, "utf8");
  const { size } = await fs.stat(target);
  return { path: target, bytes, size, mode: args.append ? "append" : "write" };
}

/**
 * List one page of a directory in name order. `cursor` is the previous page's
 * `next_cursor` (its last name), so every entry is reachable, and an entry
 * added or removed between pages cannot shift the others into a skip or a
 * repeat.
 */
export async function machineListDir(args: Record<string, unknown>): Promise<unknown> {
  const p = String(args.path ?? "").trim() || os.homedir();
  const target = path.resolve(p);
  const limit = Math.max(1, Math.min(LIST_MAX_ENTRIES, Number(args.limit ?? 200) || 200));
  const cursor = typeof args.cursor === "string" ? args.cursor : "";
  const dirents = (await fs.readdir(target, { withFileTypes: true }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rest = cursor ? dirents.filter((d) => d.name > cursor) : dirents;
  const page = rest.slice(0, limit);
  const entries: Array<Record<string, unknown>> = [];
  for (const d of page) {
    const full = path.join(target, d.name);
    let size: number | undefined;
    let mtime: string | undefined;
    try {
      const st = await fs.stat(full);
      size = st.size;
      mtime = new Date(st.mtimeMs).toISOString();
    } catch {
      // broken symlink or permission denied — still list the name
    }
    entries.push({
      name: d.name,
      type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
      size,
      mtime,
    });
  }
  return {
    path: target,
    total: dirents.length,
    returned: entries.length,
    entries,
    // Echoed so a caller can tell this Runner honoured the cursor.
    ...(cursor ? { cursor } : {}),
    next_cursor: rest.length > page.length ? page[page.length - 1].name : null,
  };
}

/**
 * Append one prompt to an existing Claude Code / Codex / omp session on THIS
 * machine through the managed control plane: the native daemon or TUI that
 * owns it, or a provider-native attachment in the session's own cwd. There
 * is no headless CLI fallback. new_session_id reports the provider's answer.
 * Costs run on this machine's own CLI credentials.
 */
export async function machineAppendSession(
  home: string,
  args: Record<string, unknown>,
  runtime?: AgentRuntimeRegistry,
  interactions?: AgentInteractionBroker,
  controlPlane?: AgentControlPlane,
  codexExecRelay?: CodexExecRelayCoordinator,
  sessionScanRoot: SessionScanRoot = home,
  codexAccountRouter?: Pick<CodexAccountRouter, "selectForFallback">,
  gatewaySite?: string,
  onInput?: (input: SessionInputReceipt) => Promise<void>,
  developmentMcpUrl?: string,
  developmentId?: string,
  observation?: Pick<SessionObservationIndex, "resolve">,
): Promise<unknown> {
  return await withAgentOperation(async () => {
  const idArg = String(args.id ?? "").trim();
  const prompt = String(args.prompt ?? "").trim();
  if (!idArg) throw new Error("append_session requires `id`");
  const interrupt = args.interrupt === true;
  const steerOnly = args.steer_only === true;
  const releaseControl = args.release_control === true;
  const takeover = args.takeover === true;
  const accountFallback = args.account_fallback === true;
  if ([interrupt, releaseControl, takeover, accountFallback].filter(Boolean).length > 1) {
    throw new Error("停止、放锁、当前 CLI 接管与账号切换不能同时执行");
  }
  const configureContinuation = args.configure_continuation === true;
  if (configureContinuation && (interrupt || releaseControl || takeover || accountFallback || steerOnly || args.native_cli_only
    || args.prompt !== undefined || args.model !== undefined || args.effort !== undefined || args.permission_profile !== undefined)) {
    throw new Error("保存续接设置不能同时发送消息或执行会话控制");
  }
  const promptlessControl = interrupt || releaseControl || configureContinuation;
  if (steerOnly && (promptlessControl || takeover || accountFallback)) {
    throw new Error("运行中追加不能同时停止、接管、切换账号或释放控制");
  }
  if (steerOnly && !controlPlane) throw new Error("这个 Runner 没有托管会话控制面，未发送消息");
  if (!promptlessControl && !prompt) throw new Error("append_session requires `prompt`");
  if (!promptlessControl && Buffer.byteLength(prompt, "utf8") > APPEND_MAX_PROMPT) {
    throw new Error(`prompt 过长 (最多 ${APPEND_MAX_PROMPT} 字节)`);
  }
  const source = ENUMERATED_SOURCES.includes(String(args.source) as Source)
    ? (String(args.source) as Source)
    : undefined;

  // Reuse the same trusted, corpus-specific locator as transcript reads.
  // Enumerating every historical home here delays input before Codex even sees it.
  // Only the local observer can supply a path; args.path/codexHome stay ignored.
  const indexed = source ? await sessionInputStage("resolve_index", async () =>
    await observation?.resolve({ source, id: idArg })) : undefined;
  const resolved = await sessionInputStage(indexed ? "resolve_indexed_path" : "resolve_catalog", () =>
    resolveSessionPath(indexed?.scan ?? sessionScanRoot, source, idArg, indexed?.path));
  const meta = await sessionInputStage("transcript_metadata", () => readSessionInputMetadata(resolved.path, resolved.source));
  const sessionId = meta.id ?? deriveIdFromPath(resolved.source, resolved.path);
  if (indexed && sessionId !== idArg) throw new Error("indexed session identity changed; input was not sent");
  if (configureContinuation) {
    if (resolved.source !== "codex" || !controlPlane) throw new Error("仅支持 Codex 自动续接设置");
    return await controlPlane.saveContinuationSettings(resolved.source, sessionId,
      args.continuation_prompt === "" ? null : args.continuation_prompt, args.continuation_revision);
  }
  if (args.native_cli_only === true) {
    const codex = resolved.source === "codex";
    if (!controlPlane || (!codex && resolved.source !== "claude") || (codex && !resolved.codexHome) || sessionId !== idArg || !meta.cwd
      || takeover || releaseControl || accountFallback || steerOnly || args.model || args.effort || args.permission_profile
      || args._octopus_execution_mcp_url || args._octopus_development_id) throw new Error("native development input cannot launch, take over or reconfigure an agent");
    const cwd = await fs.realpath(meta.cwd);
    await resolveNativeDevelopmentWorkspace(home, args.native_workspace_id, args.native_relative_path);
    markInputHandoff();
    if (interrupt) {
      return codex ? await interruptNativeDevelopment(resolved.codexHome!, sessionId, resolved.path)
        : await controlPlane.interruptNativeCli("claude", sessionId);
    }
    return await controlPlane.continueSession({ nativeOnly: true, provider: resolved.source, sessionId, prompt, cwd, takeover: false,
      ...(codex ? { codexHome: resolved.codexHome } : {}), sessionPath: resolved.path, ...(onInput ? { onInput } : {}) });
  }
  if (promptlessControl && (
    (args.permission_profile !== undefined && args.permission_profile !== "")
    || (args.model !== undefined && args.model !== "")
    || (args.effort !== undefined && args.effort !== "")
  )) {
    throw new Error(interrupt
      ? "停止轮次不接受 Agent 权限档位、模型或 effort"
      : "放锁动作不接受 Agent 权限档位、模型或 effort");
  }
  if (interrupt) {
    if (!controlPlane) throw new Error("这个 Runner 不支持中断轮次");
    markInputHandoff();
    return await controlPlane.interruptSession(resolved.source, sessionId);
  }
  if (releaseControl) {
    if (!controlPlane) throw new Error("这个 Runner 不支持释放 Codex 后台占用");
    markInputHandoff();
    return await controlPlane.releaseSession(resolved.source, sessionId);
  }
  if (accountFallback && resolved.source !== "codex") {
    throw new Error("只有 Codex 会话支持账号切换续跑");
  }
  const requestedPermissionProfile = args.permission_profile !== undefined
    ? agentPermissionProfile(resolved.source, args.permission_profile)
    : undefined;
  const model = agentModel(args.model, "append_session");
  const effort = agentEffort(resolved.source, args.effort, "append_session");
  const permissionProfile = requestedPermissionProfile ?? agentPermissionProfile(resolved.source, undefined);
  let cwd = home;
  if (meta.cwd) {
    try {
      if ((await fs.stat(meta.cwd)).isDirectory()) cwd = meta.cwd;
    } catch {
      /* session cwd no longer exists — run from the scan home */
    }
  }
  const placement = await new LaunchJournal(home).sessionPlacement(sessionId);
  const remoteMcpEndpoint = String(args._octopus_execution_mcp_url ?? "").trim();
  const remoteMcpToken = String(args._octopus_execution_mcp_token ?? "").trim();
  const executionDevice = String(args.execution_device ?? "").trim();
  const executionWorkspaceId = String(args.workspace_id ?? "").trim();
  const executionOperationId = String(args._octopus_execution_operation_id ?? "").trim();
  const executionExpiresAt = Number(args._octopus_execution_expires_at);
  if (Boolean(remoteMcpEndpoint) !== Boolean(remoteMcpToken)) {
    throw new Error("split session 续跑的 MCP endpoint 与凭证必须同时存在");
  }
  if (placement) {
    if (
      !remoteMcpEndpoint
      || !executionOperationId
      || !Number.isFinite(executionExpiresAt)
      || executionExpiresAt <= Date.now()
    ) {
      throw new Error("split session 的执行凭证已失效；请新建会话以选择新的执行放置");
    }
    if (
      placement.source !== resolved.source
      || placement.execution_device !== executionDevice
      || placement.workspace_id !== executionWorkspaceId
    ) {
      throw new Error("split session 的执行放置与原始启动记录不一致");
    }
  } else if (remoteMcpEndpoint || executionDevice || executionWorkspaceId || executionOperationId) {
    throw new Error("本机会话不能附加 split execution 凭证");
  }
  if (accountFallback) {
    if (placement) throw new Error("跨机器 Codex 会话暂不支持账号切换续跑");
    if (!resolved.codexHome) throw new Error("无法确认当前 Codex 会话所属账号");
    if (!codexAccountRouter) throw new Error("这个 Runner 没有配置 Codex 备用账号");
    if (!interactions) throw new Error("这个 Runner 不支持 Codex 托管会话");
    await runtime?.assertAppendable("codex", sessionId, false);
    const selected = await codexAccountRouter.selectForFallback(resolved.codexHome);
    markInputHandoff();
    const fallback = await CodexManagedSession.forkFromPath(sessionId, resolved.path, {
      cwd,
      interactions,
      timeoutMs: APPEND_TIMEOUT_MS,
      permissionProfile,
      codexHome: selected.codexHome,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
    let finishFallback: (() => void | Promise<void>) | undefined;
    const fallbackStarted = Date.now();
    try {
      finishFallback = await runtime?.beginHeadless("codex", fallback.sessionId);
      const dispatched = await fallback.dispatch(prompt);
      const completed = await dispatched.completion;
      let resultText = completed.resultText;
      if (resultText && resultText.length > APPEND_RESULT_CAP) {
        resultText = "…" + resultText.slice(-APPEND_RESULT_CAP);
      }
      return {
        ok: completed.ok,
        agent: "codex",
        session_id: sessionId,
        new_session_id: fallback.sessionId,
        account_label: selected.label,
        result_text: resultText,
        exit_code: completed.ok ? 0 : null,
        timed_out: completed.error?.includes("timed out") === true,
        stderr_tail: completed.stderr?.slice(-4_000),
        error: completed.error,
        transport: "app-server-fork",
        cwd,
        duration_ms: Date.now() - fallbackStarted,
      };
    } finally {
      await fallback.close();
      await finishFallback?.();
    }
  }

  // Every input goes through the managed control plane; there is no second channel to fall back to.
  if (!controlPlane) throw new Error("这个 Runner 没有托管 Agent 控制面，未发送消息");
  if (developmentMcpUrl && resolved.source === "omp" && !placement && !steerOnly) {
    await fs.writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
      octopus_devpipe: { url: developmentMcpUrl },
    } }), { encoding: "utf8", mode: 0o600 });
  }
  let mcpProxy: ScopedMcpProxy | null = null;
  let codexEnvironment: CodexRemoteEnvironment | null = null;
  let remoteMcpUrl = "";
  // Live input keeps the existing controller and execution relay. Credentials
  // and placement were still validated above; it must not rebuild tool state.
  if (placement && !steerOnly) {
    try {
      mcpProxy = new ScopedMcpProxy(
        new URL(remoteMcpEndpoint),
        remoteMcpToken,
        { revokeOnClose: false },
      );
      remoteMcpUrl = await mcpProxy.start();
      if (resolved.source === "omp") {
        await fs.writeFile(
          path.join(cwd, ".mcp.json"),
          JSON.stringify({ mcpServers: { octopus_execution: { url: remoteMcpUrl },
            ...(developmentMcpUrl ? { octopus_devpipe: { url: developmentMcpUrl } } : {}) } }, null, 2),
          { encoding: "utf8", mode: 0o600 },
        );
      }
      if (resolved.source === "codex") {
        if (!codexExecRelay) throw new Error("Codex split session 续跑需要 exec-server relay");
        codexEnvironment = await codexExecRelay.open({
          executionDevice,
          workspaceId: executionWorkspaceId,
          executionToken: remoteMcpToken,
          operationId: executionOperationId,
        });
      }
    } catch (error) {
      await mcpProxy?.close().catch(() => {});
      await codexEnvironment?.close().catch(() => {});
      const value = error instanceof Error ? error : new Error(String(error));
      (value as Error & { safeFallback?: boolean }).safeFallback = false;
      throw value;
    }
  }

  // Everything above only validated or prepared. Durable operations reach
  // the provider only through the control plane; refusals inside the plane
  // carry their own not-sent proof.
  markInputHandoff();
  const started = Date.now();
  try {
    return await controlPlane.continueSession({
      ...(onInput ? { onInput } : {}),
      ...(steerOnly ? { steerOnly: true } : {}),
      provider: resolved.source,
      sessionId,
      prompt,
      cwd,
      takeover,
      // Already jailed inside this device's scan root by resolveSessionPath.
      // omp resumes by opening the exact file; the other two ignore it.
      sessionPath: resolved.path,
      ...(requestedPermissionProfile ? { permissionProfile: requestedPermissionProfile } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      // Resolve the existing thread's account from its trusted rollout, including
      // split homes. Labels are display metadata; dropping this selects the default host.
      ...(resolved.source === "codex" && resolved.codexHome
        ? { codexHome: resolved.codexHome }
        : {}),
      ...(placement
        ? {
            recoveryPlacement: {
              ...(gatewaySite ? { gatewaySite } : {}),
              executionDevice: placement.execution_device,
              workspaceId: placement.workspace_id,
              ...(developmentId ? { developmentId } : {}),
            },
          }
        : {}),
      ...(remoteMcpUrl ? { remoteMcpUrl } : {}),
      ...(developmentMcpUrl ? { developmentMcpUrl } : {}),
      ...(codexEnvironment
        ? {
            codexEnvironment: {
              environmentId: codexEnvironment.environmentId,
              endpoint: codexEnvironment.endpoint,
            },
          }
        : {}),
    });
  } catch (error) {
    // Managed setup failed before the provider owned the prompt, so the input
    // was definitively not sent. A legacy `claude -p` / `codex exec resume`
    // retry would contend for the same thread writer (the 2026-09-27 "already
    // has an active writer" failure ended on that ladder) and could not honor
    // model, effort, placement or browser interactions. Report it once.
    if ((error as Error & { safeFallback?: boolean }).safeFallback !== true) throw error;
    return {
      ok: false,
      agent: resolved.source,
      session_id: sessionId,
      code: "failed",
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - started,
    };
  } finally {
    await Promise.allSettled([
      mcpProxy?.close() ?? Promise.resolve(),
      codexEnvironment?.close() ?? Promise.resolve(),
    ]);
  }
  });
}

/** Orientation for the agent: which box is this, and where does it start. */
export async function machineHostInfo(): Promise<unknown> {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    home: os.homedir(),
    cwd: process.cwd(),
    user: os.userInfo().username,
    uptime_s: Math.round(os.uptime()),
    total_mem_mb: Math.round(os.totalmem() / 1024 / 1024),
  };
}
