import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runTerminalCommand, TerminalComposerNotReadyError, TerminalControl } from "./terminal-control.js";

const hasTmux = process.platform !== "win32"
  && spawnSync("tmux", ["-V"], { timeout: 2_000 }).status === 0;

// Exercise the actual tmux/pty boundary. A command-argument mock cannot detect
// newline conversion or prove that the submit key follows the paste end marker.
describe.skipIf(!hasTmux)("TerminalControl through a real tmux pane", () => {
  it.each([
    { label: "short Unicode text", bracketed: true, prompt: "继续，保留 $() 和 `ticks`" },
    { label: "multiline text", bracketed: true, prompt: "第一行\n\n第二行\r\n第三行" },
    { label: "large text", bracketed: true, prompt: "长消息🙂".repeat(1_000) },
    { label: "a terminal without bracketed paste", bracketed: false, prompt: "continue" },
  ])("delivers $label and exactly one separate Enter", async ({ bracketed, prompt }) => {
    const root = await mkdtemp(join(tmpdir(), "terminal-paste-"));
    const socket = join(root, "tmux.sock");
    const received = join(root, "received");
    const reader = join(root, "reader.mjs");
    const run: typeof runTerminalCommand = (bin, args, input) => runTerminalCommand(
      bin, ["-S", socket, "-f", "/dev/null", ...args], input,
    );
    try {
      await writeFile(received, "");
      await writeFile(reader, `
        import { appendFileSync } from "node:fs";
        process.stdin.setRawMode(true);
        process.stdin.on("data", (chunk) => appendFileSync(process.argv[2], chunk));
        process.stdin.pause();
        process.stdout.write(process.argv[3] === "true" ? "\\x1b[?2004hREADY" : "READY");
        // A busy TUI can read paste and Enter together. Explicit framing must
        // still distinguish their meanings without relying on read timing.
        setTimeout(() => process.stdin.resume(), 500);
      `);
      const created = await run("tmux", [
        "new-session", "-d", "-P", "-F", "#{pane_id}\t#{pane_tty}",
        process.execPath, reader, received, String(bracketed),
      ]);
      const [paneId, ttyPath] = created.stdout.trim().split("\t");
      expect(paneId).toMatch(/^%\d+$/);
      expect(ttyPath).toBeTruthy();
      // Seeing READY in tmux proves it consumed the mode-setting sequence too.
      await vi.waitFor(async () => {
        const screen = await run("tmux", ["capture-pane", "-p", "-t", paneId!]);
        expect(screen.stdout).toContain("READY");
      }, { timeout: 5_000, interval: 25 });

      const control = new TerminalControl({ run });
      await control.append({ paneId: paneId!, ttyPath: ttyPath! }, prompt, {
        confirmSubmitted: async () => (await readFile(received, "utf8")).endsWith("\r"),
      });

      const expected = bracketed ? `\x1b[200~${prompt}\x1b[201~\r` : `${prompt}\r`;
      expect(await readFile(received, "utf8")).toBe(expected);
      const buffers = await run("tmux", ["list-buffers"]);
      expect(buffers.stdout).toBe("");
    } finally {
      // This private socket cannot address a user's existing tmux server.
      await run("tmux", ["kill-server"]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { screen: "empty", label: "an empty composer with its dimmed placeholder", sends: true },
    { screen: "draft", label: "a composer holding a typed draft", sends: false },
    { screen: "picker", label: "a picker that hides the cursor", sends: false },
  ])("reads the real pane before pasting into $label", async ({ screen, sends }) => {
    const root = await mkdtemp(join(tmpdir(), "terminal-composer-"));
    const socket = join(root, "tmux.sock");
    const received = join(root, "received");
    const tui = join(root, "tui.mjs");
    const run: typeof runTerminalCommand = (bin, args, input) => runTerminalCommand(
      bin, ["-S", socket, "-f", "/dev/null", ...args], input,
    );
    try {
      await writeFile(received, "");
      // Draws what Claude Code draws (2.1.322): rules around a `❯` composer,
      // the cursor right after the glyph, a dimmed placeholder or a draft; a
      // picker hides the cursor instead.
      await writeFile(tui, `
        import { appendFileSync } from "node:fs";
        process.stdin.setRawMode(true);
        process.stdin.on("data", (chunk) => appendFileSync(process.argv[2], chunk));
        const out = (text) => process.stdout.write(text);
        out("\\x1b[?2004h\\x1b[2J\\x1b[H\\u2500\\u2500\\u2500\\u2500\\r\\n");
        if (process.argv[3] === "picker") {
          out("  Select model\\r\\n    \\u276f 5. Haiku\\x1b[?25l");
        } else {
          out(process.argv[3] === "draft" ? "\\u276f\\u00a0abc" : "\\u276f\\u00a0\\x1b[2mTry something\\x1b[0m");
          out("\\r\\n\\u2500\\u2500\\u2500\\u2500");
          out(process.argv[3] === "draft" ? "\\x1b[2;6H" : "\\x1b[2;3H");
          out("\\x1b[?25h");
        }
      `);
      const created = await run("tmux", [
        "new-session", "-d", "-P", "-F", "#{pane_id}\t#{pane_tty}",
        process.execPath, tui, received, screen,
      ]);
      const [paneId, ttyPath] = created.stdout.trim().split("\t");
      await vi.waitFor(async () => {
        const shown = await run("tmux", ["capture-pane", "-p", "-t", paneId!]);
        expect(shown.stdout).toContain(screen === "picker" ? "Haiku" : "\u2500\u2500\u2500\u2500\n\u276f");
      }, { timeout: 5_000, interval: 25 });

      const control = new TerminalControl({ run });
      const sent = control.append({ paneId: paneId!, ttyPath: ttyPath! }, "continue", {
        composerGlyphs: ["\u276f"],
        confirmSubmitted: async () => (await readFile(received, "utf8")).endsWith("\r"),
      });
      if (sends) {
        await sent;
        expect(await readFile(received, "utf8")).toBe("\x1b[200~continue\x1b[201~\r");
      } else {
        await expect(sent).rejects.toBeInstanceOf(TerminalComposerNotReadyError);
        expect(await readFile(received, "utf8")).toBe("");
      }
    } finally {
      await run("tmux", ["kill-server"]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
});
