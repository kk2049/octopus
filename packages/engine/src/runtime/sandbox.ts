/**
 * The trusted side of the app runtime boundary.
 *
 * v3 used to `import()` hot-plugged projection/action modules straight into
 * the Host process. That is fine for a probe written by one person and
 * indefensible the moment an agent can author or edit those files: the module
 * shares the Host's heap, its environment, its file descriptors and its
 * imports, so `ctx.capabilities` would be a suggestion rather than a boundary.
 *
 * So app code runs in a Hardened JavaScript Compartment (see
 * `sandbox-child.mjs`, which is where the security argument lives), inside a
 * child process that provides:
 *
 *   · a place for `lockdown()` to happen — it hardens every intrinsic in its
 *     realm and is irreversible, which is not something to do to a process that
 *     also runs better-sqlite3, the Feishu SDK and the bot's own scheduler;
 *   · containment for the compute a Compartment cannot bound — a leftover
 *     microtask loop wedges this process, not the Host;
 *   · somewhere unhelpful for a Compartment escape to land: scrubbed
 *     environment, no handles, no Store, no adapters, no capability kernel, and
 *     the Node permission model still on.
 *
 * Fail-closed: if the sandbox cannot start, the app does not run. There is
 * deliberately no "fall back to in-process" path — that would be a bypass
 * switched on by a bad day.
 *
 * ── Why one process can serve several security contexts ──────────────────
 *
 * The previous version gave every handler invocation a process of its own,
 * because the fd-3 channel could not be authenticated: app code shared a realm
 * with the protocol writer, so any secret we handed the child was readable by
 * the code we were hiding it from (a nonce in argv comes back out of
 * `process.report`). Killing the process was the only way to end code we no
 * longer wanted speaking.
 *
 * Under SES app code cannot reach fd 3 at all — writing to it needs `node:fs`
 * or `process`, and a Compartment has neither. Frames are written only by the
 * child's supervisor, so the `forId` on a capability request is a fact recorded
 * by trusted code rather than a claim made by the caller. Attribution is safe
 * again, and a shared long-lived process costs ~0.4ms per call instead of
 * ~35ms.
 *
 * What that trades away is availability, not authority: a leftover loop from
 * one app burns CPU that another app's call needs. The per-call timeout kills
 * and respawns the child, and it recycles after `maxCalls`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The child is a runtime asset, not part of the bundle: running from source
 * it sits next to this file, and from `dist/` it is two levels up in `src/`.
 * Missing entirely is a hard error — there is no in-process fallback, because
 * "the sandbox was unavailable so we ran the app code here" is exactly the
 * bypass this module exists to prevent.
 */
function resolveChild(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "sandbox-child.mjs"),
    path.join(here, "..", "src", "runtime", "sandbox-child.mjs"),
    path.join(here, "..", "..", "src", "runtime", "sandbox-child.mjs"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`app sandbox runtime missing: looked in ${candidates.join(", ")}`);
}

let childPath: string | null = null;
function childEntry(): string {
  if (!childPath) childPath = resolveChild();
  return childPath;
}

/**
 * Read grants for the permission model: the child's own entry, the app it
 * serves, and the `node_modules` trees `ses` resolves through. Narrow rather
 * than "the whole repo", and computed rather than configured — a path list an
 * operator has to maintain is a path list that goes stale.
 */
function readGrants(child: string, appDir: string): string[] {
  const grants = [child, appDir, `${appDir}/*`];
  let dir = path.dirname(child);
  for (let i = 0; i < 8; i++) {
    const mods = path.join(dir, "node_modules");
    if (fs.existsSync(mods)) grants.push(mods, `${mods}/*`);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return grants;
}

/** A capability request coming back out of untrusted code. */
export type SandboxCapabilityBroker = (
  slot: string,
  operation: string,
  args: unknown,
) => Promise<unknown>;

export interface SandboxOptions {
  /** Only directory the child may read. */
  appDir: string;
  /** What this sandbox serves, for diagnostics. */
  contextKey: string;
  /** Per-call ceiling; a wedged handler must not wedge the Host. */
  timeoutMs?: number;
  /** Ceiling on one message in either direction. */
  maxMessageBytes?: number;
  /** Recycle the child after this many calls, reaping whatever apps left running. */
  maxCalls?: number;
  /** Refuse to queue more than this many calls at once. */
  maxConcurrent?: number;
  onStderr?: (line: string) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  /** The authority this invocation may spend, if any. */
  broker?: SandboxCapabilityBroker;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Lower than the old 2000 on purpose. Handler calls share this process now, so
 * anything an app left running — a microtask loop, an unresolved promise — is
 * still here after its call returned. Recycling is the only thing that reaps it.
 */
const DEFAULT_MAX_CALLS = 500;
const DEFAULT_MAX_CONCURRENT = 16;

interface ChildOptions {
  appDir: string;
  timeoutMs: number;
  maxMessageBytes: number;
  onStderr?: (line: string) => void;
}

/**
 * One process. Owns its framing and its pending replies; each pending
 * invocation carries its own broker, and a capability frame is matched to one
 * by the `forId` the child's supervisor stamped on it.
 */
class SandboxChild {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = "";
  private dead = false;
  private exited: Promise<void> = Promise.resolve();

  constructor(private opts: ChildOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const appDir = path.resolve(this.opts.appDir);
      const child_ = childEntry();
      const args = [
        // `--permission` is the stable spelling in Node 24 and is also
        // accepted by our Node 22 compatibility floor. The former
        // `--experimental-permission` spelling was removed in Node 24.
        "--permission",
        ...readGrants(child_, appDir).map((p) => `--allow-fs-read=${p}`),
        "--no-warnings",
        child_,
        appDir,
      ];
      const child = spawn(process.execPath, args, {
        cwd: appDir,
        // Scrubbed: an escaped Compartment that reads process.env finds nothing
        // worth stealing. execArgv is NOT inherited — a loader flag would drag
        // in a worker thread the permission model refuses anyway.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV ?? "production" },
        // fd 3 is the whole protocol, both directions. stdin is `ignore`;
        // stdout/stderr are ordinary diagnostics, so a stray console.log cannot
        // corrupt a frame.
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.exited = new Promise<void>((done) => child.once("exit", () => done()));
      let settled = false;
      const fail = (msg: string): void => {
        if (settled) return;
        settled = true;
        reject(new Error(`app sandbox failed to start: ${msg}`));
      };
      const bootTimer = setTimeout(() => fail("no ready frame within 10s"), 10_000);
      const proto = child.stdio[3] as NodeJS.ReadableStream | null;
      proto?.setEncoding?.("utf8");
      proto?.on("data", (chunk: string) => {
        if (!settled && chunk.includes('"ready"')) {
          settled = true;
          clearTimeout(bootTimer);
          resolve();
        }
        this.onData(chunk);
      });
      /**
       * An unhandled `'error'` event on a stream THROWS in Node, which takes the
       * whole Host process down. These pipes had `data` handlers and no error
       * handler, and a read in flight when a killed child is reaped surfaces
       * `ECONNRESET`. The child's fate is reported by `exit`/`error` on the
       * ChildProcess below, so a pipe error carries no information we act on —
       * the correct handling is to have one at all.
       */
      const ignorePipeError = (): void => {};
      proto?.on("error", ignorePipeError);
      for (const stream of [child.stdout, child.stderr, child.stdin]) {
        stream?.on("error", ignorePipeError);
      }
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          for (const line of String(chunk).split("\n")) {
            if (line.trim()) this.opts.onStderr?.(line);
          }
        });
      }
      child.on("exit", (code, signal) => {
        clearTimeout(bootTimer);
        const why = `app sandbox exited (code ${code ?? "null"}${signal ? `, ${signal}` : ""})`;
        fail(why);
        this.dead = true;
        this.rejectAll(why);
      });
      child.on("error", (err) => fail(err.message));
    });
  }

  get alive(): boolean {
    return Boolean(this.child) && !this.dead;
  }

  private rejectAll(why: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
      this.pending.delete(id);
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.opts.maxMessageBytes) {
      this.buf = "";
      void this.dispose();
      this.rejectAll("sandbox produced an oversized message");
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (msg.op === "ready") continue;
      if (msg.op === "cap") {
        void this.onCapability(msg);
        continue;
      }
      const p = this.pending.get(Number(msg.id));
      if (!p) continue;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else {
        const error = new Error(String(msg.error ?? "sandbox error"));
        // The child's classification survives the hop: "app_rejected" marks
        // text the app's own function threw (safe to show its own View),
        // everything else is machinery whose message must stay inside.
        if (typeof msg.code === "string") (error as Error & { code?: string }).code = msg.code;
        p.reject(error);
      }
    }
  }

  /**
   * Untrusted code asked for a capability, through the facade the child's
   * supervisor built for one invocation and stamped with its id.
   *
   * The frame is attributable because app code cannot write frames: fd 3 needs
   * `node:fs` or `process`, and a Compartment has neither. An id whose call has
   * already finished — a leftover continuation racing the reply — finds no
   * pending entry and is denied here as well as at the facade.
   */
  private async onCapability(msg: Record<string, unknown>): Promise<void> {
    const reply = (result: unknown): void => {
      this.write({ op: "cap_reply", capId: msg.capId, result });
    };
    const broker = this.pending.get(Number(msg.forId))?.broker;
    if (!broker) {
      reply({ status: "denied", reason: "this runtime was not given any capabilities" });
      return;
    }
    try {
      reply(await broker(String(msg.slot ?? ""), String(msg.operation ?? ""), msg.args));
    } catch (err) {
      reply({ status: "denied", reason: String((err as Error)?.message ?? err) });
    }
  }

  private write(msg: unknown): void {
    const proto = this.child?.stdio[3] as NodeJS.WritableStream | undefined;
    proto?.write(JSON.stringify(msg) + "\n");
  }

  async request(msg: Record<string, unknown>, broker?: SandboxCapabilityBroker): Promise<unknown> {
    if (this.dead) throw new Error("app sandbox is not running");
    const id = this.nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.dispose();
        reject(new Error(`app code exceeded ${this.opts.timeoutMs}ms and was killed`));
      }, this.opts.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, broker });
      this.write({ ...msg, id });
    });
  }

  /** SIGKILL and WAIT for the corpse: a reaped process cannot write again. */
  async dispose(): Promise<void> {
    const child = this.child;
    this.dead = true;
    this.child = null;
    if (!child) return;
    child.kill("SIGKILL");
    this.rejectAll("app sandbox stopped");
    await this.exited;
  }
}

/**
 * The app runtime for one (app, scope): projection, export enumeration and
 * handler invocations, all in one long-lived child. Isolation between calls is
 * the child's business (one Compartment per invocation, revocable facades);
 * this class owns process lifetime, timeouts and back-pressure.
 */
export class AppSandbox {
  private current: SandboxChild | null = null;
  private starting: Promise<SandboxChild> | null = null;
  private stopped = false;
  private calls = 0;
  private inFlight = 0;

  constructor(private opts: SandboxOptions) {}

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async ensureChild(): Promise<SandboxChild> {
    if (this.current?.alive) return this.current;
    if (this.starting) return await this.starting;
    this.starting = (async () => {
      const c = new SandboxChild({
        appDir: this.opts.appDir,
        timeoutMs: this.timeoutMs,
        maxMessageBytes: this.opts.maxMessageBytes ?? DEFAULT_MAX_BYTES,
        onStderr: this.opts.onStderr,
      });
      await c.start();
      this.current = c;
      return c;
    })().finally(() => {
      this.starting = null;
    });
    return await this.starting;
  }

  /**
   * One call into the app runtime.
   *
   * Calls are NOT serialized: concurrency between invocations is safe by
   * construction inside the child, and the engine already serializes dispatch
   * per (app, scope). Recycling waits for quiet — killing the child while
   * someone else's call is in flight would fail a call for hygiene's sake.
   */
  private async call(msg: Record<string, unknown>, broker?: SandboxCapabilityBroker): Promise<unknown> {
    if (this.stopped) throw new Error("app sandbox stopped");
    if (this.inFlight >= (this.opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)) {
      throw new Error("app sandbox is saturated");
    }
    this.inFlight++;
    try {
      if (this.calls >= (this.opts.maxCalls ?? DEFAULT_MAX_CALLS) && this.inFlight === 1) {
        this.calls = 0;
        const old = this.current;
        this.current = null;
        await old?.dispose();
      }
      this.calls++;
      const child = await this.ensureChild();
      return await child.request({ ...msg, nowMs: Date.now() }, broker);
    } finally {
      this.inFlight--;
    }
  }

  /** mtime doubles as the module version — same warm-reload rule as before. */
  private versionOf(file: string): number {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }

  async project(
    file: string,
    events: readonly unknown[],
    context?: Readonly<Record<string, unknown>>,
    snapshot?: unknown,
  ): Promise<unknown> {
    return await this.call({
      op: "project",
      file,
      version: this.versionOf(file),
      events,
      context: context ?? {},
      ...(snapshot === undefined ? {} : { snapshot }),
    });
  }

  async exports(file: string): Promise<string[]> {
    return (await this.call({ op: "exports", file, version: this.versionOf(file) })) as string[];
  }

  /**
   * Run one action handler.
   *
   * The broker is registered against this invocation's id and dropped when the
   * call settles, and the child revokes the matching facade before answering —
   * so nothing the app leaves running (a microtask, an unresolved promise) can
   * still spend this authority afterwards, and it has no shared scope through
   * which to reach a sibling's.
   */
  async runHandler(
    file: string,
    action: string,
    ctx: Record<string, unknown>,
    params: Record<string, unknown>,
    broker?: SandboxCapabilityBroker,
  ): Promise<unknown> {
    return await this.call(
      { op: "handler", file, version: this.versionOf(file), action, ctx, params },
      broker,
    );
  }

  /** Stop everything this sandbox owns and wait for the process to go. */
  async dispose(): Promise<void> {
    this.stopped = true;
    const child = this.current;
    this.current = null;
    await child?.dispose();
  }

  /** Fire-and-forget teardown for call sites that cannot await. */
  stop(): void {
    void this.dispose();
  }
}
