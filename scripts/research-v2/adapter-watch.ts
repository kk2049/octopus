import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterPublishInput, AdapterRegisterInput, AdapterRow } from "../../packages/bot/src/research-canvas/projections.js";

export interface AdapterSnapshot {
  node: string;
  version: number;
  status: "registered" | "live" | "paused" | "removed";
}
export interface AdapterTransport {
  register(input: AdapterRegisterInput & { request: string }): Promise<{ node: string; version: number }>;
  /** Read ref_describe.resource; use resource.version independently from graph label versions. */
  read(input: { node: string }): Promise<AdapterSnapshot>;
  publish(input: { request: string; node: string; version: number; data: AdapterPublishInput }): Promise<{ node: string; version: number }>;
  control(input: { request: string; node: string; version: number; state: "paused" | "registered" | "removed" }): Promise<{ node: string; version: number }>;
}
export interface AdapterModule {
  register: Omit<AdapterRegisterInput, "source" | "entry"> & { schema: AdapterRegisterInput["schema"] };
  project(input: { text: string; sourcePath: string; sourceRevision: string }): AdapterRow[] | Promise<AdapterRow[]>;
}
export interface AdapterWatcherOptions {
  workspaceRoot: string;
  sourcePath: string;
  modulePath: string;
  transport: AdapterTransport;
  debounceMs?: number;
  /** Read only while a changed source is waiting for an external resume. */
  pausedPollMs?: number;
  requestId?: () => string;
  onError?(error: Error): void;
}
export interface AdapterWatcher {
  node: string;
  readonly error: Error | null;
  close(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}
const MAX_BYTES = 16 * 1024 * 1024;
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function safeFile(path: string, root: string): Promise<string> {
  const [canonical, canonicalRoot] = await Promise.all([real(path), real(root)]);
  if (!within(canonical, canonicalRoot)) throw new Error("适配器文件必须位于已授权 workspace");
  const info = await stat(canonical);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error("适配器来源文件无效或过大");
  return canonical;
}
async function real(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(resolve(path));
}
const request = () => `adapter_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
const versionConflict = (error: unknown) => error instanceof Error && error.message === "适配器版本已变化";
export async function startAdapterWatcher(options: AdapterWatcherOptions): Promise<AdapterWatcher> {
  const root = await real(options.workspaceRoot);
  const source = await safeFile(options.sourcePath, root);
  const modulePath = await safeFile(options.modulePath, root);
  const load = async (): Promise<AdapterModule> => {
    await safeFile(modulePath, root);
    const module = await import(`${pathToFileURL(modulePath).href}?reload=${Date.now()}`) as Partial<AdapterModule>;
    if (!module.register || typeof module.project !== "function") throw new Error("适配器模块必须导出 register 与 project");
    return module as AdapterModule;
  };
  const adapter = await load();
  const registered = await options.transport.register({ ...adapter.register, source, entry: modulePath, request: (options.requestId ?? request)() });
  const node = registered.node;
  let closed = false;
  let lastError: Error | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pausedTimer: ReturnType<typeof setTimeout> | undefined;
  let fsWatcher: FSWatcher | undefined;
  let tail: Promise<void> = Promise.resolve();
  const stop = () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(pausedTimer);
    fsWatcher?.close();
  };
  const report = (error: unknown) => {
    lastError = error instanceof Error ? error : new Error(String(error));
    if (options.onError) options.onError(lastError);
    else process.emitWarning(lastError);
  };
  // The returned promise always retains the failure for the caller/report.
  // Only the queue tail settles it so one failed operation cannot poison later work.
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const read = async () => {
    const state = await options.transport.read({ node });
    if (state.node !== node || !Number.isSafeInteger(state.version) || state.version < 1 ||
        !["registered", "live", "paused", "removed"].includes(state.status))
      throw new Error("适配器状态回执无效");
    if (state.status === "removed") stop();
    return state;
  };
  const waitForResume = () => {
    if (closed || pausedTimer) return;
    pausedTimer = setTimeout(() => {
      pausedTimer = undefined;
      void serial(publish).then(undefined, report);
    }, Math.max(20, options.pausedPollMs ?? 2_000));
  };
  const publish = async () => {
    if (closed) return;
    clearTimeout(pausedTimer);
    pausedTimer = undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await read();
      if (closed) return;
      if (state.status === "paused") { waitForResume(); return; }
      const current = await load();
      const bytes = await readFile(await safeFile(source, root));
      if (bytes.length > MAX_BYTES) throw new Error("适配器来源文件过大");
      const sourceRevision = createHash("sha256").update(bytes).digest("hex");
      const rows = await current.project({ text: bytes.toString("utf8"), sourcePath: source, sourceRevision });
      if (closed) return;
      try {
        await options.transport.publish({ request: (options.requestId ?? request)(), node, version: state.version, data: { sourceRevision, rows } });
        lastError = null;
        return;
      } catch (error) {
        // Retry only an explicit server CAS refusal, never an uncertain network result.
        if (attempt || !versionConflict(error)) throw error;
      }
    }
  };
  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void serial(publish).then(undefined, report), options.debounceMs ?? 250);
  };
  // Watching the directory also follows an editor's atomic replace of the source.
  fsWatcher = watch(dirname(source), { persistent: false }, (_event, filename) => {
    if (!filename || filename.toString() === basename(source)) schedule();
  });
  fsWatcher.on("error", (error) => { stop(); report(error); });
  try { await serial(publish); } catch (error) { stop(); throw error; }
  const control = async (state: "paused" | "registered") => {
    if (closed) throw new Error("适配器监听已关闭");
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await read();
      if (closed) throw new Error("适配器已移除");
      if (current.status === state || state === "registered" && current.status === "live") break;
      try {
        await options.transport.control({ request: (options.requestId ?? request)(), node, version: current.version, state });
        break;
      } catch (error) {
        if (attempt || !versionConflict(error)) throw error;
      }
    }
    lastError = null;
    if (state === "registered") await publish();
  };
  const changeState = (state: "paused" | "registered") => serial(() => control(state)).catch((error: unknown) => {
    report(error);
    throw error;
  });
  return {
    get node() { return node; },
    get error() { return lastError; },
    async close() { stop(); await tail; },
    pause: () => changeState("paused"),
    resume: () => changeState("registered"),
  };
}
