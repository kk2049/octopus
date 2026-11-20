/**
 * Run a child process with `execFile`'s completion semantics but without its
 * `maxBuffer` cliff.
 *
 * `execFile` kills the child once either stream passes `maxBuffer` and reports
 * that as a failed command, so a huge diff or a chatty test run turned into a
 * false "git failed" or a red gate step. Here the child always runs to its own
 * exit; each stream is kept whole or as a bounded tail chosen by the caller,
 * and the error object has `execFile`'s shape (`code` = exit status, `killed`,
 * `signal`), so callers keep their exit-code handling unchanged.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:buffer";

/** `execFile`'s error shape: `code` is the exit status (or a spawn errno string). */
export type ChildError = Error & { code?: number | string | null; killed?: boolean; signal?: NodeJS.Signals | null };

/** One stream: every byte, or only the newest `tailBytes` with the total counted. */
export class OutputBuffer {
  private chunks: Buffer[] = [];
  private held = 0;
  /** Bytes the stream produced in all. */
  total = 0;

  constructor(private readonly tailBytes = Number.POSITIVE_INFINITY) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.held += chunk.length;
    while (this.held > this.tailBytes && this.chunks.length) {
      const first = this.chunks[0]!;
      const excess = this.held - this.tailBytes;
      if (first.length <= excess) {
        this.chunks.shift();
        this.held -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.held -= excess;
      }
    }
  }

  /** Bytes produced but not held (0 for a whole buffer). */
  get dropped(): number {
    return this.total - this.held;
  }

  /** The held bytes. */
  bytes(): Buffer {
    return Buffer.concat(this.chunks, this.held);
  }

  /** The held bytes as UTF-8. Throws when they exceed what one JS string can hold. */
  text(): string {
    if (this.held > constants.MAX_STRING_LENGTH) {
      throw new Error(`输出 ${this.held} 字节超过一个 JavaScript 字符串的上限（${constants.MAX_STRING_LENGTH}）`);
    }
    return Buffer.concat(this.chunks, this.held).toString("utf8");
  }
}

export interface ChildRun {
  error: ChildError | null;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
}

export interface ChildOptions {
  cwd: string;
  /** Kill after this long, like `execFile`'s `timeout` (0 or absent = never). */
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
  env?: NodeJS.ProcessEnv;
  /** Keep only this many newest bytes of each stream; absent = keep everything. */
  tailBytes?: number;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** The live child, for callers that cancel it themselves. */
  onSpawn?: (child: ChildProcess) => void;
}

export function runChild(bin: string, args: readonly string[], opts: ChildOptions): Promise<ChildRun> {
  return new Promise((resolve) => {
    const stdout = new OutputBuffer(opts.tailBytes);
    const stderr = new OutputBuffer(opts.tailBytes);
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    } catch (error) {
      resolve({ error: error as ChildError, stdout, stderr });
      return;
    }
    let killedByTimeout = false;
    let settled = false;
    let spawnError: ChildError | null = null;
    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
        killedByTimeout = true;
        try { child.kill(opts.killSignal ?? "SIGTERM"); } catch { /* already gone */ }
      }, opts.timeoutMs)
      : null;
    const finish = (error: ChildError | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ error, stdout, stderr });
    };
    child.stdin?.on("error", () => { /* a child that exits early closes its stdin */ });
    child.stdin?.end(opts.input);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: ChildError) => {
      spawnError = error;
      // A child that never started emits no `close` worth waiting for.
      if (child.pid === undefined) finish(error);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (spawnError) { finish(spawnError); return; }
      if (code === 0 && signal === null) { finish(null); return; }
      let detail = "";
      try { detail = stderr.text().slice(-2_000); } catch { /* too large to quote */ }
      const error = new Error(`Command failed: ${[bin, ...args].join(" ")}\n${detail}`) as ChildError;
      error.code = code;
      error.killed = killedByTimeout || child.killed;
      error.signal = signal;
      finish(error);
    });
    opts.onSpawn?.(child);
  });
}

/**
 * The gate-log tail of one step: the newest `chars` characters of stdout, a
 * newline, then stderr — what `execFile` callers built from whole strings —
 * marked when output before it was not kept.
 */
export function stepLogTail(run: ChildRun, chars: number): string {
  const combined = `${run.stdout.text()}\n${run.stderr.text()}`;
  const tail = combined.slice(-chars);
  const omitted = run.stdout.dropped + run.stderr.dropped > 0 || combined.length > chars;
  return omitted ? `…（更早的输出未保留，共 ${run.stdout.total + run.stderr.total} 字节）\n${tail}` : tail;
}

/** Bytes each stream must keep so that `stepLogTail(run, chars)` sees `chars` whole characters. */
export function tailBytesFor(chars: number): number {
  // A UTF-16 unit takes at most 3 UTF-8 bytes (4 bytes = 2 units); the extra
  // unit absorbs a character cut at the window's front.
  return (chars + 1) * 3;
}
