import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { composerRowState, runTerminalCommand, TerminalComposerNotReadyError, TerminalControl } from "./terminal-control.js";

function fakeChild(
  onEnd: (child: EventEmitter, stdin: PassThrough, endArgs: readonly unknown[]) => void,
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const originalEnd = stdin.end.bind(stdin);
  stdin.end = ((...args: Parameters<typeof stdin.end>) => {
    onEnd(child, stdin, args);
    return originalEnd(...args);
  }) as typeof stdin.end;
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

describe("TerminalControl", () => {
  it("shares one pane snapshot across different pids and fresh writes bypass it", async () => {
    const run = vi.fn(async () => ({ stdout: "%1\t/dev/pts/8\t0\t0\n%2\t/dev/pts/9\t0\t0\n" }));
    const control = new TerminalControl({ run, readlink: async (file) => file.includes("/123/") ? "/dev/pts/8" : "/dev/pts/9" });
    const [a, b] = await Promise.all([control.attachmentForPid(123), control.attachmentForPid(124)]);
    expect(a?.paneId).toBe("%1"); expect(b?.paneId).toBe("%2"); expect(run).toHaveBeenCalledOnce();
    await control.writableAttachmentForPid(123); expect(run).toHaveBeenCalledTimes(2);
  });

  it("includes copy-mode panes in observation without making them writable", async () => {
    const control = new TerminalControl({ run: async () => ({ stdout: "%1\t/dev/pts/8\t0\t1\n" }), readlink: async () => "/dev/pts/8" });
    expect(await control.observedTtys()).toEqual(new Set(["/dev/pts/8"]));
    expect(await control.attachmentForPid(123)).toBeNull();
  });
  it("binds only one exact, live, non-copy-mode tmux pane", async () => {
    const run = vi.fn(async () => ({ stdout: "%1\t/dev/pts/8\t0\t0\n%2\t/dev/pts/9\t0\t0\n" }));
    const control = new TerminalControl({ run, readlink: async () => "/dev/pts/8" });
    await expect(control.attachmentForPid(123)).resolves.toEqual({ paneId: "%1", ttyPath: "/dev/pts/8" });
  });

  it("refuses ambiguous panes and copy mode", async () => {
    const duplicate = new TerminalControl({
      readlink: async () => "/dev/pts/8",
      run: async () => ({ stdout: "%1\t/dev/pts/8\t0\t0\n%2\t/dev/pts/8\t0\t0\n" }),
    });
    await expect(duplicate.attachmentForPid(123)).resolves.toBeNull();
    const copyMode = new TerminalControl({
      readlink: async () => "/dev/pts/8",
      run: async () => ({ stdout: "%1\t/dev/pts/8\t0\t1\n" }),
    });
    await expect(copyMode.attachmentForPid(123)).resolves.toBeNull();
  });

  it("exits copy mode only for an explicit write, then re-proves the pane and tty", async () => {
    let paneLists = 0;
    const calls: string[][] = [];
    const control = new TerminalControl({
      readlink: async () => "/dev/pts/8",
      run: async (_bin, args) => {
        calls.push(args);
        if (args[0] !== "list-panes") return { stdout: "" };
        paneLists += 1;
        return { stdout: `%7\t/dev/pts/8\t0\t${paneLists < 3 ? "1" : "0"}\n` };
      },
    });

    // Projection/status reads remain non-mutating even while the user is
    // browsing history in this exact pane.
    await expect(control.attachmentForPid(123)).resolves.toBeNull();
    expect(calls.some((args) => args[0] === "copy-mode")).toBe(false);

    await expect(control.writableAttachmentForPid(123)).resolves.toEqual({
      paneId: "%7",
      ttyPath: "/dev/pts/8",
    });
    expect(calls.filter((args) => args[0] === "copy-mode")).toEqual([
      ["copy-mode", "-q", "-t", "%7"],
    ]);
    expect(paneLists).toBe(3);
  });

  it("never changes copy mode when the tty does not identify one unique live pane", async () => {
    const calls: string[][] = [];
    const control = new TerminalControl({
      readlink: async () => "/dev/pts/8",
      run: async (_bin, args) => {
        calls.push(args);
        return { stdout: "%1\t/dev/pts/8\t0\t1\n%2\t/dev/pts/8\t0\t1\n" };
      },
    });

    await expect(control.writableAttachmentForPid(123)).resolves.toBeNull();
    expect(calls.some((args) => args[0] === "copy-mode")).toBe(false);
  });

  it("refuses a write when the tty or pane changes while leaving copy mode", async () => {
    let ttyReads = 0;
    const ttyChanged = new TerminalControl({
      readlink: async () => ttyReads++ === 0 ? "/dev/pts/8" : "/dev/pts/9",
      run: async (_bin, args) => ({
        stdout: args[0] === "list-panes" ? "%7\t/dev/pts/8\t0\t1\n" : "",
      }),
    });
    await expect(ttyChanged.writableAttachmentForPid(123)).resolves.toBeNull();

    let paneLists = 0;
    const paneChanged = new TerminalControl({
      readlink: async () => "/dev/pts/8",
      run: async (_bin, args) => {
        if (args[0] !== "list-panes") return { stdout: "" };
        paneLists += 1;
        return { stdout: paneLists === 1
          ? "%7\t/dev/pts/8\t0\t1\n"
          : "%8\t/dev/pts/8\t0\t0\n" };
      },
    });
    await expect(paneChanged.writableAttachmentForPid(123)).resolves.toBeNull();
  });

  it("collapses grouped-session aliases of the same pane id", async () => {
    const control = new TerminalControl({
      readlink: async () => "/dev/pts/8",
      run: async () => ({
        stdout: "%37\t/dev/pts/8\t0\t0\n%37\t/dev/pts/8\t0\t0\n%37\t/dev/pts/8\t0\t0\n",
      }),
    });
    await expect(control.attachmentForPid(123)).resolves.toEqual({ paneId: "%37", ttyPath: "/dev/pts/8" });
  });

  it("refuses a grouped alias when any observation says the pane is unsafe", async () => {
    const control = new TerminalControl({
      readlink: async () => "/dev/pts/8",
      run: async () => ({ stdout: "%37\t/dev/pts/8\t0\t0\n%37\t/dev/pts/8\t0\t1\n" }),
    });
    await expect(control.attachmentForPid(123)).resolves.toBeNull();
  });

  it("pastes through stdin and presses Enter without a shell", async () => {
    const calls: Array<{ bin: string; args: string[]; input?: string }> = [];
    const waits: number[] = [];
    let captures = 0;
    const control = new TerminalControl({
      run: async (bin, args, input) => {
        calls.push({ bin, args, ...(input === undefined ? {} : { input }) });
        return { stdout: args[0] === "capture-pane" ? (captures++ === 0 ? "prompt" : "working") : "" };
      },
      wait: async (ms) => { waits.push(ms); },
    });
    await control.append({ paneId: "%7", ttyPath: "/dev/pts/8" }, "继续，保留 $() 和 `ticks`");
    expect(calls[0]).toMatchObject({ bin: "tmux", args: ["load-buffer", "-b", expect.any(String), "-"], input: "继续，保留 $() 和 `ticks`" });
    expect(calls[1]?.args).toEqual(["paste-buffer", "-p", "-r", "-b", calls[0]?.args[2], "-t", "%7", "-d"]);
    expect(calls[2]?.args).toEqual(["capture-pane", "-p", "-t", "%7"]);
    expect(calls[3]?.args).toEqual(["send-keys", "-t", "%7", "C-m"]);
    expect(calls[4]?.args).toEqual(["capture-pane", "-p", "-t", "%7"]);
    expect(waits).toEqual([200, 100]);
  });

  it("keeps the grace period for a multiline paste before Enter", async () => {
    const waits: number[] = [];
    let captures = 0;
    const control = new TerminalControl({
      run: async (_bin, args) => ({
        stdout: args[0] === "capture-pane" ? `pane-${captures++}` : "",
      }),
      wait: async (ms) => { waits.push(ms); },
    });

    await control.append(
      { paneId: "%7", ttyPath: "/dev/pts/8" },
      "第一行\n第二行",
    );
    expect(waits).toEqual([5_000, 100]);
  });

  it("reports an indeterminate submission when the pane never reacts", async () => {
    const calls: string[][] = [];
    const waits: number[] = [];
    const control = new TerminalControl({
      run: async (_bin, args) => {
        calls.push(args);
        return { stdout: args[0] === "capture-pane" ? "unchanged prompt" : "" };
      },
      wait: async (ms) => { waits.push(ms); },
    });

    await expect(control.append(
      { paneId: "%7", ttyPath: "/dev/pts/8" },
      "继续",
    )).rejects.toMatchObject({ code: "tmux_submission_unconfirmed" });
    expect(calls.filter((args) => args[0] === "send-keys")).toEqual([
      ["send-keys", "-t", "%7", "C-m"],
    ]);
    expect(waits).toEqual([200, ...Array.from({ length: 25 }, () => 100)]);
  });

  it("does not treat a composer redraw as a receipt when provider confirmation is available", async () => {
    let captures = 0;
    const confirmSubmitted = vi.fn(async () => false);
    const control = new TerminalControl({
      run: async (_bin, args) => ({
        stdout: args[0] === "capture-pane" ? `redraw-${captures++}` : "",
      }),
      wait: async () => {},
    });

    await expect(control.append(
      { paneId: "%7", ttyPath: "/dev/pts/8" },
      "留在输入框里的文字",
      { confirmSubmitted },
    )).rejects.toMatchObject({ code: "tmux_submission_unconfirmed" });
    expect(confirmSubmitted).toHaveBeenCalledTimes(25);
  });

  it("accepts provider confirmation even when the pane snapshot is unchanged", async () => {
    let checks = 0;
    const control = new TerminalControl({
      run: async (_bin, args) => ({
        stdout: args[0] === "capture-pane" ? "unchanged" : "",
      }),
      wait: async () => {},
    });

    await expect(control.append(
      { paneId: "%7", ttyPath: "/dev/pts/8" },
      "确实提交的文字",
      { confirmSubmitted: async () => ++checks === 2 },
    )).resolves.toBeUndefined();
    expect(checks).toBe(2);
  });

  it("stops a turn with one Escape and no signal, buffer or Enter", async () => {
    const calls: string[][] = [];
    let captures = 0;
    const control = new TerminalControl({
      run: async (_bin, args) => {
        calls.push(args);
        return { stdout: args[0] === "capture-pane" ? (captures++ === 0 ? "working…" : "stopped") : "" };
      },
      wait: async () => {},
    });

    await expect(control.interrupt({ paneId: "%7", ttyPath: "/dev/pts/8" }))
      .resolves.toEqual({ confirmed: true });
    expect(calls).toEqual([
      ["capture-pane", "-p", "-t", "%7"],
      ["send-keys", "-t", "%7", "Escape"],
      ["capture-pane", "-p", "-t", "%7"],
    ]);
    // The keys that would quit the TUI, submit something, or kill the pane.
    for (const forbidden of ["C-c", "C-d", "C-m", "kill-pane", "kill-session", "load-buffer"]) {
      expect(calls.flat()).not.toContain(forbidden);
    }
  });

  it("reports an unconfirmed stop instead of pressing Escape twice", async () => {
    const calls: string[][] = [];
    const waits: number[] = [];
    const control = new TerminalControl({
      run: async (_bin, args) => {
        calls.push(args);
        return { stdout: args[0] === "capture-pane" ? "unchanged" : "" };
      },
      wait: async (ms) => { waits.push(ms); },
    });

    await expect(control.interrupt({ paneId: "%7", ttyPath: "/dev/pts/8" }))
      .resolves.toEqual({ confirmed: false });
    // A second Escape is the keystroke that clears an idle composer draft.
    expect(calls.filter((args) => args[0] === "send-keys")).toEqual([
      ["send-keys", "-t", "%7", "Escape"],
    ]);
    expect(waits).toEqual(Array.from({ length: 12 }, () => 100));
  });
});

// Rows exactly as `tmux capture-pane -p -e` returned them from Claude Code
// 2.1.322 (2026-11-12): the empty composer, its dimmed placeholder, a typed
// draft, and the `/model` picker's selection row.
const CLAUDE = ["\u276f", ">"];
const EMPTY = "\u001b[39m\u276f\u00a0";
const PLACEHOLDER = "\u001b[39m\u276f\u00a0\u001b[2mTry \"refactor <filepath>\"\u001b[0m";
const DRAFT = "\u001b[39m\u276f\u00a0abc";
const PICKER = "    \u001b[38;5;153m\u276f\u001b[39m \u001b[38;5;246m5.  \u001b[38;5;114mHaiku 5.5\u001b[39m";

describe("composerRowState", () => {
  it("accepts an empty composer, with or without its dimmed placeholder", () => {
    expect(composerRowState(EMPTY, 2, CLAUDE)).toBe("empty");
    expect(composerRowState(PLACEHOLDER, 2, CLAUDE)).toBe("empty");
  });

  it("calls typed text a draft wherever the cursor is", () => {
    expect(composerRowState(DRAFT, 5, CLAUDE)).toBe("draft");
    // Home/Ctrl+A puts the cursor where an empty composer has it.
    expect(composerRowState(DRAFT, 2, CLAUDE)).toBe("draft");
  });

  it("does not take a colour index for the dim attribute", () => {
    // 38;5;2 is a palette colour, not SGR 2: this text is a real draft.
    expect(composerRowState("\u276f\u00a0\u001b[38;5;2mgreen draft\u001b[0m", 2, CLAUDE)).toBe("draft");
    expect(composerRowState("\u276f\u00a0\u001b[2;38;5;246mplaceholder\u001b[22m", 2, CLAUDE)).toBe("empty");
  });

  it("refuses rows that are not the composer", () => {
    expect(composerRowState(PICKER, 3, CLAUDE)).toBe("elsewhere");
    expect(composerRowState("\u001b[38;5;211m!\u00a0\u001b[39m", 2, CLAUDE)).toBe("elsewhere");
    expect(composerRowState("  Enter to set as default \u00b7 Esc to cancel", 2, CLAUDE)).toBe("elsewhere");
    expect(composerRowState("", 0, CLAUDE)).toBe("elsewhere");
  });

  it("understands the older boxed composer", () => {
    expect(composerRowState("\u2502 > \u001b[2mTry something\u001b[22m                \u2502", 4, CLAUDE)).toBe("empty");
    expect(composerRowState("\u2502 > hello                \u2502", 9, CLAUDE)).toBe("draft");
  });
});

describe("TerminalControl composer precondition", () => {
  function pane(cursor: string, row: string) {
    const calls: string[][] = [];
    const control = new TerminalControl({
      run: async (_bin, args) => {
        calls.push(args);
        if (args[0] === "display-message") return { stdout: `${cursor}\n` };
        if (args[0] === "capture-pane" && args.includes("-e")) return { stdout: `top\n${row}\nstatus\n` };
        return { stdout: args[0] === "capture-pane" ? String(calls.length) : "" };
      },
      wait: async () => {},
    });
    return { control, calls };
  }

  it.each([
    { label: "a typed draft", cursor: "1 5 1", row: DRAFT, wording: /还没发出的文字/ },
    { label: "a picker that hid the cursor", cursor: "0 3 1", row: PICKER, wording: /不是输入框/ },
    { label: "a cursor on another row", cursor: "1 2 2", row: EMPTY, wording: /不是输入框/ },
  ])("writes nothing into $label", async ({ cursor, row, wording }) => {
    const { control, calls } = pane(cursor, row);
    const sent = control.append({ paneId: "%7", ttyPath: "/dev/pts/8" }, "继续", { composerGlyphs: CLAUDE });
    await expect(sent).rejects.toBeInstanceOf(TerminalComposerNotReadyError);
    await expect(sent).rejects.toMatchObject({ code: "terminal_composer_busy", inputNotSent: true, message: expect.stringMatching(wording) });
    expect(calls.map((args) => args[0])).not.toContain("load-buffer");
    expect(calls.map((args) => args[0])).not.toContain("send-keys");
  });

  it("pastes into the empty composer it just checked", async () => {
    const { control, calls } = pane("1 2 1", PLACEHOLDER);
    await control.append({ paneId: "%7", ttyPath: "/dev/pts/8" }, "继续", { composerGlyphs: CLAUDE });
    expect(calls.map((args) => args[0])).toEqual([
      "display-message", "capture-pane", "load-buffer", "paste-buffer", "capture-pane", "send-keys", "capture-pane", "delete-buffer",
    ]);
  });
});

describe("runTerminalCommand", () => {
  it("contains a stdin EPIPE for a read-only command and preserves its zero exit", async () => {
    let endArgumentCount = -1;
    const child = fakeChild((process, stdin, endArgs) => {
      endArgumentCount = endArgs.length;
      stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      process.emit("close", 0, null);
    });

    await expect(runTerminalCommand("tmux", ["list-panes"], "", () => child))
      .resolves.toEqual({ stdout: "" });
    expect(endArgumentCount).toBe(0);
  });

  it("keeps the stdin error listener alive after process close", async () => {
    let lateErrorWasHandled = false;
    const child = fakeChild((process, stdin) => {
      process.emit("close", 0, null);
      lateErrorWasHandled = stdin.emit(
        "error",
        Object.assign(new Error("late write EPIPE"), { code: "EPIPE" }),
      );
    });

    await expect(runTerminalCommand("tmux", ["list-panes"], "", () => child))
      .resolves.toEqual({ stdout: "" });
    expect(lateErrorWasHandled).toBe(true);
  });

  it("waits for close so stdout arriving after exit is retained", async () => {
    const child = fakeChild((process) => {
      process.emit("exit", 0, null);
      (child.stdout as PassThrough).write("late stdout");
      process.emit("close", 0, null);
    });

    await expect(runTerminalCommand("tmux", ["list-panes"], "", () => child))
      .resolves.toEqual({ stdout: "late stdout" });
  });

  it("succeeds after non-empty stdin finishes and the command closes at zero", async () => {
    const child = fakeChild((process, stdin) => {
      stdin.emit("finish");
      process.emit("close", 0, null);
    });

    await expect(runTerminalCommand("tmux", ["load-buffer"], "prompt", () => child))
      .resolves.toEqual({ stdout: "" });
  });

  it("contains a stdin EPIPE and fails honestly when non-empty input was not delivered", async () => {
    const secret = "raw prompt that must never cross the error boundary";
    const child = fakeChild((process, stdin) => {
      // Reproduce the production order exactly and deterministically: `exit`
      // happens first, the pipe reports EPIPE, then stdio reaches `close`.
      process.emit("exit", 0, null);
      stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      process.emit("close", 0, null);
    });

    const failure = await runTerminalCommand("tmux", ["load-buffer"], secret, () => child)
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("tmux exited before stdin was delivered");
    expect((failure as Error).message).not.toContain(secret);
    expect((failure as Error).message).not.toContain("EPIPE");
  });

  it("keeps a non-zero command exit authoritative over a stdin delivery error", async () => {
    const child = fakeChild((process, stdin) => {
      (child.stderr as PassThrough).write("sensitive command stderr");
      stdin.emit("error", Object.assign(new Error("sensitive raw write EPIPE"), { code: "EPIPE" }));
      process.emit("close", 2, null);
    });

    const failure = await runTerminalCommand("tmux", ["list-panes"], "private", () => child)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("tmux exited (2)");
  });
});
