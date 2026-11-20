import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUEST_GUARD_MJS } from "./guest-guard-script.js";
import { GUEST_LAUNCHER_PY } from "./guest-launcher-script.js";
import { GUEST_PC_MCP_MJS } from "./guest-pc-mcp-script.js";
import { localTlsMaterial } from "./guest-sessions.js";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(path.join(tmpdir(), "guest-scripts-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const python = spawnSync("python3", ["--version"]).status === 0;

function frame(kind: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(kind, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

describe.skipIf(!python)("guest session launcher", () => {
  it("prepares the guest's files and runs the command on a terminal", async () => {
    const script = path.join(dir, "guest-launcher.py");
    writeFileSync(script, GUEST_LAUNCHER_PY);
    const home = path.join(dir, "home");
    mkdirSync(home);
    writeFileSync(path.join(home, "kept.json"), "mine");
    const spec = {
      home, cwd: home, dirs: ["tmp", "workspace"],
      files: [{ path: ".octopus/pc.json", text: "{}" }, { path: "kept.json", text: "replaced", create_only: true }],
      links: [{ path: "skill", target: "/usr" }],
      env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, nice: 5, cols: 91, rows: 17,
      argv: ["/bin/sh", "-c", "stty size; echo home=$HOME; cat"],
    };
    const child = spawn("python3", ["-I", script], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stdin.write(frame(3, Buffer.from(JSON.stringify(spec))));
    // Typed input reaches the command through its terminal.
    setTimeout(() => {
      child.stdin.write(frame(1, Buffer.from("typed-line\n")));
      child.stdin.write(frame(1, Buffer.from("\x04")));
    }, 300);
    expect(await new Promise<number | null>((resolve) => child.once("exit", resolve))).toBe(0);
    expect(output).toContain("17 91");
    expect(output).toContain("home=" + home);
    expect(output).toContain("typed-line");
    expect(readFileSync(path.join(home, ".octopus", "pc.json"), "utf8")).toBe("{}");
    expect(readFileSync(path.join(home, "kept.json"), "utf8")).toBe("mine");
    expect(existsSync(path.join(home, "workspace"))).toBe(true);
  });

  it("refuses to start without a spec", async () => {
    writeFileSync(path.join(dir, "guest-launcher.py"), GUEST_LAUNCHER_PY);
    const child = spawn("python3", ["-I", path.join(dir, "guest-launcher.py")], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(frame(1, Buffer.from("x")));
    expect(await new Promise((resolve) => child.once("exit", resolve))).toBe(125);
  });
});

describe("guest guard hook", () => {
  const guestHome = "/srv/research/research-b/octopus-guest/guests/dev";
  const env = {
    ...process.env,
    OCTOPUS_GUEST_HOME: guestHome,
    OCTOPUS_GUEST_ALLOWED: JSON.stringify(["/srv/research/research-b/octopus-guest/tools", "/home/ubuntu/.claude/projects/-srv-research-research-b-octopus-guest-guests-dev-workspace"]),
    OCTOPUS_GUEST_PROTECTED: JSON.stringify(["/home", "/root", "/srv/research", "/srv/research-archive"]),
  };
  const run = (event: Record<string, unknown>, home = guestHome, extraEnv: Record<string, string> = {}) => {
    const script = path.join(dir, "guard.mjs");
    writeFileSync(script, GUEST_GUARD_MJS);
    return spawnSync(process.execPath, [script], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: home + "/workspace", ...event }),
      encoding: "utf8", env: { ...env, OCTOPUS_GUEST_HOME: home, ...extraEnv },
    });
  };
  const blocked: Array<[string, Record<string, unknown>]> = [
    ["Bash", { command: "cat /home/ubuntu/.bashrc" }], ["Bash", { command: "ls ~ubuntu" }], ["Bash", { command: "cd /home && ls" }],
    ["Bash", { command: 'cat /ho""me/ubuntu/x' }], ["Bash", { command: "cat '/home'/ubuntu/x" }],
    ["Bash", { command: "cat ../../../../../../../home/ubuntu/x" }], ["Bash", { command: "cat $CLAUDE_CONFIG_DIR/.credentials.json" }],
    ["Bash", { command: "cat /proc/123/environ" }], ["Bash", { command: "tar czf x.tgz /root" }],
    ["Read", { file_path: "/home/ubuntu/lht/x" }], ["Read", { file_path: "/srv/research/research-b/LOCKS.md" }],
    ["Read", { file_path: "/home/ubuntu/.claude/projects/-home-ubuntu-lht-ops-octopus/memory/MEMORY.md" }], ["Read", { file_path: "/home/ubuntu/.claude/plans/x.md" }],
    ["Read", { file_path: guestHome + "/../other/x" }], ["Grep", { pattern: "x", path: "/home/ubuntu" }], ["Glob", { pattern: "/home/**/*.md" }],
    ["mcp__pc__send_file", { path: "/home/ubuntu/.ssh/id_rsa", pc_path: "C:\\x" }], ["Write", { file_path: "/srv/research-archive/x", content: "" }],
    // Codex: its patch tool names files in the patch's headers; images are viewed by path.
    ["apply_patch", { command: "*** Begin Patch\n*** Update File: /home/ubuntu/lht/x.py\n@@\n-a\n+b\n*** End Patch\n" }],
    ["apply_patch", { command: "*** Begin Patch\n*** Add File: ../../../../../../../root/x\n+y\n*** End Patch\n" }],
    ["apply_patch", { command: "*** Begin Patch\n*** Update File: a.txt\n*** Move to: /srv/research/x.txt\n*** End Patch\n" }],
    ["view_image", { path: "/root/a.png" }],
  ];
  const allowed: Array<[string, Record<string, unknown>]> = [
    ["Bash", { command: "echo hello > note.txt" }], ["Bash", { command: "ls ~ && cd ~/work" }], ["Bash", { command: "cat ./home/index.html" }],
    ["Bash", { command: "mkdir -p home && cp a.txt home/" }], ["Bash", { command: "ls /homebrew" }], ["Bash", { command: "curl https://example.com/home/page" }],
    ["Bash", { command: "df -h /srv" }], ["Bash", { command: "soffice --headless --convert-to pdf deck.pptx" }],
    ["Read", { file_path: guestHome + "/workspace/a.pptx" }],
    ["Read", { file_path: "/home/ubuntu/.claude/projects/-srv-research-research-b-octopus-guest-guests-dev-workspace/0b1c/tool-results/toolu_1.txt" }], ["Read", { file_path: "/srv/research/research-b/octopus-guest/tools/docs-plugin/skills/pptx/SKILL.md" }],
    ["Grep", { pattern: "/home/ubuntu", path: "." }], ["Write", { file_path: guestHome + "/workspace/doc.md", content: "see /home/ubuntu" }],
    ["mcp__pc__send_file", { path: "deck.pptx", pc_path: "C:\\Users\\home\\deck.pptx" }], ["mcp__pc__run_powershell", { command: "ls C:\\home" }],
    ["Bash", { command: "python3 -c \"import os; print(os.listdir('.'))\"" }],
    ["apply_patch", { command: "*** Begin Patch\n*** Add File: notes.md\n+see /home/ubuntu/lht and /root\n*** End Patch\n" }],
    ["apply_patch", { command: `*** Begin Patch\n*** Update File: ${guestHome}/workspace/a.py\n@@\n-x\n+y\n*** End Patch\n` }],
    ["view_image", { path: "chart.png" }],
  ];

  it("blocks calls that reach the owner's trees and lets the guest's own work through", async () => {
    const script = path.join(dir, "guard.mjs");
    writeFileSync(script, GUEST_GUARD_MJS);
    Object.assign(process.env, env);
    const { candidates, violation } = await import(script) as {
      candidates: (tool: string, input: Record<string, unknown>) => string[]; violation: (text: string, cwd: string) => string;
    };
    const verdict = (tool: string, input: Record<string, unknown>) =>
      candidates(tool, input).map((text) => violation(text, guestHome + "/workspace")).find(Boolean) ?? "";
    for (const [tool, input] of blocked) expect(verdict(tool, input), `${tool} ${JSON.stringify(input)}`).not.toBe("");
    for (const [tool, input] of allowed) expect(verdict(tool, input), `${tool} ${JSON.stringify(input)}`).toBe("");
  });

  it.skipIf(spawnSync("tmux", ["-V"]).status !== 0)("ends the agent's own tmux server and no other", async () => {
    const home = path.join(dir, "guest");
    mkdirSync(path.join(home, ".octopus"), { recursive: true });
    const socket = path.join(home, ".octopus", "tmux-claude.sock");
    // The same guest's other agent, and a server that is not the guest's at all.
    const others = [path.join(home, ".octopus", "tmux-codex.sock"), path.join(dir, "other.sock")];
    for (const sock of [socket, ...others]) expect(spawnSync("tmux", ["-S", sock, "-f", "/dev/null", "new-session", "-d", "-s", "claude", "sleep 60"]).status).toBe(0);
    const alive = (sock: string) => spawnSync("tmux", ["-S", sock, "has-session"]).status === 0;
    try {
      // Called from a window that is already gone: the agent's server still ends.
      expect(run({ tool_name: "Read", tool_input: { file_path: "/root/x" } }, home, { OCTOPUS_GUEST_TMUX: socket }).status).toBe(2);
      for (let i = 0; i < 50 && alive(socket); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(socket)).toBe(false);
      for (const sock of others) expect(alive(sock)).toBe(true);
    } finally {
      for (const sock of [socket, ...others]) spawnSync("tmux", ["-S", sock, "kill-server"]);
    }
  });

  it("answers a violation with exit 2, a reason for the agent, and a record for the host", () => {
    const home = path.join(dir, "guest");
    const result = run({ tool_name: "Read", tool_input: { file_path: "/home/ubuntu/.ssh/id_rsa" } }, home);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("touches /home/ubuntu/.ssh/id_rsa");
    expect(JSON.parse(readFileSync(path.join(home, ".octopus", "terminated.json"), "utf8"))).toMatchObject({ tool: "Read", reason: "touches /home/ubuntu/.ssh/id_rsa" });
    expect(readFileSync(path.join(home, ".octopus", "guard.log"), "utf8")).toContain("id_rsa");
    expect(run({ tool_name: "Bash", tool_input: { command: "ls" } }, home).status).toBe(0);
    expect(run({ tool_name: "Bash" }, home).status).toBe(0);
    // Fail closed: input the guard cannot read is blocked.
    expect(spawnSync(process.execPath, [path.join(dir, "guard.mjs")], { input: "not json", encoding: "utf8", env: { ...env, OCTOPUS_GUEST_HOME: home } }).status).toBe(2);
  });
});

const openssl = spawnSync("openssl", ["version"]).status === 0;

describe.skipIf(!openssl)("guest pc MCP server", () => {
  it("speaks MCP over stdio and turns tool calls into calls to the Runner", async () => {
    const tls = localTlsMaterial();
    const seen: Array<{ url: string; auth: string; body: Buffer }> = [];
    const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ url: req.url ?? "", auth: String(req.headers.authorization), body });
        if (req.url?.startsWith("/octopus/pc/run_powershell")) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ exit_code: 3, stdout: "out", stderr: "err", timed_out: false }));
        } else if (req.url?.startsWith("/octopus/pc/read_file")) {
          res.writeHead(200, { "x-octopus-pc-path": encodeURIComponent("C:\\Users\\f\\报告.docx") }).end(Buffer.from("docx-bytes"));
        } else {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pc_path: "C:\\Users\\f\\Desktop\\x.pptx", bytes: body.length }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const home = path.join(dir, "home");
    const workspace = path.join(home, "workspace");
    mkdirSync(path.join(home, ".octopus"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(path.join(dir, "ca.pem"), tls.ca);
    writeFileSync(path.join(home, ".octopus", "pc.json"), JSON.stringify({ endpoint: `https://127.0.0.1:${port}`, token: "guest-secret", ca_file: path.join(dir, "ca.pem") }));
    writeFileSync(path.join(dir, "pc-mcp.mjs"), GUEST_PC_MCP_MJS);
    writeFileSync(path.join(workspace, "deck.pptx"), "pptx-bytes");
    const child = spawn(process.execPath, [path.join(dir, "pc-mcp.mjs")], { cwd: workspace, env: { PATH: process.env.PATH, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    const replies = new Map<number, Record<string, any>>();
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        const message = JSON.parse(buffered.slice(0, newline)) as Record<string, any>;
        buffered = buffered.slice(newline + 1);
        replies.set(message.id, message);
      }
    });
    const ask = async (id: number, method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      for (let i = 0; i < 400 && !replies.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      return replies.get(id)!;
    };
    try {
      expect((await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })).result)
        .toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "octopus-pc" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      expect((await ask(2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["run_powershell", "fetch_file", "send_file"]);

      const shell = (await ask(3, "tools/call", { name: "run_powershell", arguments: { command: "dir", timeout_seconds: 9999 } })).result;
      expect(shell.isError).toBe(true);
      expect(shell.content[0].text).toBe("exit code: 3\n--- stdout ---\nout\n--- stderr ---\nerr");
      expect(JSON.parse(seen[0]!.body.toString())).toEqual({ command: "dir", timeout_seconds: 1800 });
      expect(seen[0]!.auth).toBe("Bearer guest-secret");

      const fetched = (await ask(4, "tools/call", { name: "fetch_file", arguments: { pc_path: "报告.docx" } })).result;
      expect(fetched.isError).toBeUndefined();
      expect(readFileSync(path.join(workspace, "报告.docx"), "utf8")).toBe("docx-bytes");
      const again = (await ask(5, "tools/call", { name: "fetch_file", arguments: { pc_path: "报告.docx" } })).result;
      expect(again.isError).toBe(true);
      expect(again.content[0].text).toContain("overwrite");

      const sent = (await ask(6, "tools/call", { name: "send_file", arguments: { path: "deck.pptx", pc_path: "Desktop/x.pptx", overwrite: true } })).result;
      expect(sent.content[0].text).toContain("C:\\Users\\f\\Desktop\\x.pptx");
      const upload = seen.at(-1)!;
      expect(upload.url).toBe("/octopus/pc/write_file?pc_path=Desktop%2Fx.pptx&overwrite=1");
      expect(upload.body.toString()).toBe("pptx-bytes");
      expect((await ask(7, "tools/call", { name: "send_file", arguments: { path: "missing", pc_path: "x" } })).result.isError).toBe(true);
      expect((await ask(8, "nope")).error.code).toBe(-32601);
    } finally {
      child.kill();
      server.close();
    }
  });
});
