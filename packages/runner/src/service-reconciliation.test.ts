import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileRunnerService, runnerServiceFiles } from "./service-manager.js";

const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(), execute: vi.fn() }));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  existsSync: (file: string) => state.files.has(file),
  readFileSync: (file: string, encoding?: string) => encoding ? state.files.get(file)!.toString(encoding as BufferEncoding) : state.files.get(file),
  writeFileSync: (file: string, value: string | Buffer) => { state.files.set(file, Buffer.from(value)); },
  renameSync: (from: string, to: string) => { state.files.set(to, state.files.get(from)!); state.files.delete(from); },
  rmSync: (file: string) => { state.files.delete(file); },
  mkdirSync: vi.fn(), chmodSync: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: state.execute }),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const linuxHome = "/home/alice";
let legacyUnit: Buffer;

function operation() {
  let resolve!: (value: { stdout: string; stderr: string }) => void;
  let reject!: (reason: Error) => void;
  const child = new EventEmitter();
  const promise = Object.assign(new Promise<{ stdout: string; stderr: string }>((yes, no) => {
    resolve = yes; reject = no;
  }), { child });
  state.execute.mockReturnValueOnce(promise);
  return { resolve: () => resolve({ stdout: "", stderr: "" }), reject, close: () => child.emit("close") };
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...platform, value });
}

beforeEach(() => {
  setPlatform("linux");
  state.files.clear(); state.execute.mockReset();
  // A unit an earlier bundle migrated to null sinks, plus a local customisation.
  const files = runnerServiceFiles(linuxHome);
  legacyUnit = Buffer.from(files.definition.replace("[Service]\n", "[Service]\nStandardOutput=null\nStandardError=null\nEnvironment=KEEP=1\n"));
  state.files.set(files.definitionPath, legacyUnit);
});
afterEach(() => { Object.defineProperty(process, "platform", platform); });

describe("Linux service reconciliation", () => {
  it("restores the journal by removing only the null sinks an earlier bundle added", async () => {
    const files = runnerServiceFiles(linuxHome);
    const child = operation();
    const migration = reconcileRunnerService(linuxHome);
    child.resolve(); child.close();
    await expect(migration).resolves.toBe(true);
    const migrated = state.files.get(files.definitionPath)!.toString("utf8");
    expect(migrated).not.toContain("StandardOutput");
    expect(migrated).not.toContain("StandardError");
    expect(migrated).toContain("Environment=KEEP=1");
    expect(state.execute).toHaveBeenCalledWith("systemctl", ["--user", "daemon-reload"], expect.anything());
  });

  it("lets the event loop run while the reload is slow, with a bounded child", async () => {
    const child = operation();
    let settled = false;
    const migration = reconcileRunnerService(linuxHome).finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(state.execute).toHaveBeenCalledWith("systemctl", ["--user", "daemon-reload"], expect.objectContaining({
      timeout: 15_000, killSignal: "SIGKILL",
    }));
    child.resolve(); child.close();
    await expect(migration).resolves.toBe(true);
    await expect(reconcileRunnerService(linuxHome)).resolves.toBe(false);
    expect(state.execute).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "abort"])("waits for child close on %s before restoring the file and releasing the owner", async (reason) => {
    const child = operation();
    const abort = new AbortController();
    let settled = false;
    const migration = reconcileRunnerService(linuxHome, abort.signal).catch((error: Error) => error).finally(() => { settled = true; });
    const file = runnerServiceFiles(linuxHome).definitionPath;
    const error = new Error(reason);
    if (reason === "abort") abort.abort();
    child.reject(error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(state.files.get(file)).not.toEqual(legacyUnit);
    expect(state.execute.mock.calls[0]?.[2].signal).toBe(abort.signal);
    child.close();
    await expect(migration).resolves.toBe(error);
    expect(state.files.get(file)).toEqual(legacyUnit);
    const retry = operation();
    const next = reconcileRunnerService(linuxHome);
    retry.resolve(); retry.close();
    await expect(next).resolves.toBe(true);
  });

  it("does not modify the installed unit if shutdown already started", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(reconcileRunnerService(linuxHome, abort.signal)).rejects.toThrow();
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.files.get(runnerServiceFiles(linuxHome).definitionPath)).toEqual(legacyUnit);
  });
});

describe("Windows scheduled task", () => {
  it("is never rewritten or re-registered by the daemon, whatever wrapper is installed", async () => {
    setPlatform("win32");
    const home = "C:\\Users\\fixture";
    const definitionPath = runnerServiceFiles(home).definitionPath;
    const installed = Buffer.from("# Octopus managed task format 2\r\nold installed task\r\n");
    state.files.set(definitionPath, installed);
    await expect(reconcileRunnerService(home)).resolves.toBe(false);
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.files.get(definitionPath)).toEqual(installed);
  });
});
