import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { duplexPair, PassThrough, type Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pcPath, runGuestConsole, windowsTerminalRelaunch } from "./guest-console.js";
import { controlFrame, dataFrame, FrameDecoder, type TerminalFrame } from "./guest-terminal.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "guest-console-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** The host's end of one tunnel, as the test drives it. */
class HostEnd {
  readonly frames: TerminalFrame[] = [];
  private readonly decoder = new FrameDecoder();
  private waiters: Array<() => void> = [];
  constructor(readonly stream: Duplex) {
    stream.on("data", (chunk: Buffer) => {
      this.frames.push(...this.decoder.push(chunk));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }
  async next(match: (frame: TerminalFrame) => boolean): Promise<TerminalFrame> {
    for (;;) {
      const found = this.frames.find(match);
      if (found) {
        this.frames.splice(this.frames.indexOf(found), 1);
        return found;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
  control(t: string): Promise<{ message: Record<string, unknown>; attachment: Buffer }> {
    return this.next((frame) => frame.kind === "control" && frame.message.t === t) as Promise<{ message: Record<string, unknown>; attachment: Buffer }>;
  }
}

function fakeOutput() {
  const emitter = new EventEmitter() as EventEmitter & { columns: number; rows: number; text: string; write(chunk: string | Buffer): boolean };
  emitter.columns = 100;
  emitter.rows = 25;
  emitter.text = "";
  emitter.write = (chunk) => { emitter.text += chunk.toString(); return true; };
  return emitter;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

describe("guest console", () => {
  it("relays the terminal, answers PC calls, and reconnects after the agent exits", async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const hosts: HostEnd[] = [];
    let connects = 0;
    const done = runGuestConsole({
      gatewayUrl: "wss://gateway.invalid", token: () => "rt_guest", agent: "codex", home: dir,
      input, output: output as never, sleep: async () => {},
      shell: async (command) => ({ exit_code: 0, stdout: `ran ${command}`, stderr: "", timed_out: false }),
      connect: async (_url, token) => {
        connects++;
        expect(token).toBe("rt_guest");
        if (connects > 1) throw Object.assign(new Error("invalid token"), { refusal: "unauthorized" });
        const [mine, theirs] = duplexPair();
        hosts.push(new HostEnd(theirs));
        return mine;
      },
    });
    await until(() => hosts.length === 1);
    const host = hosts[0]!;
    expect((await host.control("hello")).message).toMatchObject({ v: 1, agent: "codex", cols: 100, rows: 25 });

    host.stream.write(dataFrame(Buffer.from("SCREEN")));
    await until(() => output.text.includes("SCREEN"));
    input.write("ls\r");
    expect((await host.next((frame) => frame.kind === "data")) as { bytes: Buffer }).toMatchObject({ bytes: Buffer.from("ls\r") });
    output.columns = 80;
    output.emit("resize");
    expect((await host.control("resize")).message).toMatchObject({ cols: 80, rows: 25 });

    host.stream.write(controlFrame({ t: "call", id: 1, op: "powershell", args: { command: "Get-Date", timeout_ms: 5000 } }));
    expect((await host.control("result")).message).toMatchObject({ id: 1, ok: true, value: { exit_code: 0, stdout: "ran Get-Date" } });

    host.stream.write(controlFrame({ t: "call", id: 2, op: "write_file", args: { path: "Desktop/新建 文稿.pptx" } }, Buffer.from("deck")));
    const written = await host.control("result");
    expect(written.message).toMatchObject({ id: 2, ok: true, value: { path: path.join(dir, "Desktop", "新建 文稿.pptx") } });
    expect(readFileSync(path.join(dir, "Desktop", "新建 文稿.pptx"), "utf8")).toBe("deck");
    host.stream.write(controlFrame({ t: "call", id: 3, op: "write_file", args: { path: "Desktop/新建 文稿.pptx" } }, Buffer.from("other")));
    expect((await host.control("result")).message).toMatchObject({ id: 3, ok: false, error: expect.stringMatching(/overwrite/) });

    writeFileSync(path.join(dir, "note.txt"), "from the PC");
    host.stream.write(controlFrame({ t: "call", id: 4, op: "read_file", args: { path: "~/note.txt" } }));
    const read = await host.control("result");
    expect(read.message).toMatchObject({ id: 4, ok: true, value: { path: path.join(dir, "note.txt") } });
    expect(read.attachment.toString()).toBe("from the PC");
    host.stream.write(controlFrame({ t: "call", id: 5, op: "read_file", args: { path: "missing.txt" } }));
    expect((await host.control("result")).message).toMatchObject({ id: 5, ok: false });

    // The agent exits: say so, wait for Enter, then dial again.
    host.stream.end(controlFrame({ t: "exit", text: "" }));
    await until(() => output.text.includes("Codex 已退出"));
    expect(connects).toBe(1);
    input.write("\r");
    // The second dial finds the device revoked: final, after one more Enter.
    await until(() => output.text.includes("登记已失效"));
    input.write("\r");
    expect(await done).toBe(1);
  });

  it("reopens itself in Windows Terminal once, and only on Windows outside it", () => {
    const argv = ["C:\\g\\standalone.js", "guest", "console", "--agent", "codex", "--home", "C:\\g\\home"];
    const env = { LOCALAPPDATA: "C:\\Users\\f\\AppData\\Local" };
    expect(windowsTerminalRelaunch(argv, "codex", env, "win32", "C:\\g\\node.exe")).toEqual({
      file: "C:\\Users\\f\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
      args: ["-w", "new", "new-tab", "--title", "Codex（Octopus）", "--suppressApplicationTitle", "C:\\g\\node.exe", ...argv, "--in-terminal"],
    });
    expect(windowsTerminalRelaunch([...argv, "--in-terminal"], "codex", env, "win32")).toBeUndefined();
    expect(windowsTerminalRelaunch(argv, "codex", { ...env, WT_SESSION: "x" }, "win32")).toBeUndefined();
    expect(windowsTerminalRelaunch(argv, "codex", env, "linux")).toBeUndefined();
  });

  it("resolves PC paths against the user's home", () => {
    const home = path.resolve("/home/friend");
    expect(pcPath("Desktop/a.pptx", home)).toBe(path.join(home, "Desktop", "a.pptx"));
    expect(pcPath("~/b.txt", home)).toBe(path.join(home, "b.txt"));
    expect(pcPath("/etc/hosts", home)).toBe(path.resolve("/etc/hosts"));
    expect(() => pcPath("  ", home)).toThrow();
  });
});
