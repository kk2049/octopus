import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { duplexPair, type Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuestSessionHost, guestSessionSpec, type GuestRecord } from "./guest-sessions.js";
import { controlFrame, dataFrame, FrameDecoder, type TerminalFrame } from "./guest-terminal.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "guest-sessions-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const record: GuestRecord = { device: "friend-pc", secret: "s".repeat(64), providers: ["anthropic"], created_at: "2026-11-13T00:00:00Z" };

describe("guest session spec", () => {
  it("runs the owner's Claude with the owner's login but none of the owner's settings, behind the guard", () => {
    const home = "/guests/guests/friend-pc";
    const spec = guestSessionSpec({
      agent: "claude", record, home, port: 47830, tools: { dir: "/guests/tools", plugin: "/guests/tools/docs-plugin", skills: ["pptx"] },
      executable: "/opt/claude/bin/claude", loginDir: "/home/owner/.claude", node: "/usr/bin/node",
      launchPrefix: ["memguard", "--rss-gib", "8", "--"], cols: 100, rows: 30,
      extraEnv: { PIP_INDEX_URL: "https://mirror/simple/", HOME: "/home/owner" },
    });
    expect(spec.env).toMatchObject({
      HOME: home, TMPDIR: `${home}/tmp`, XDG_RUNTIME_DIR: `${home}/run`, PIP_INDEX_URL: "https://mirror/simple/",
      CLAUDE_CONFIG_DIR: "/home/owner/.claude", ENABLE_CLAUDEAI_MCP_SERVERS: "false", DISABLE_AUTOUPDATER: "1",
      OCTOPUS_GUEST_HOME: home, CLAUDE_CODE_TMPDIR: `${home}/tmp`, CLAUDE_CODE_DISABLE_ARTIFACT: "1",
      DISABLE_LOGIN_COMMAND: "1", DISABLE_LOGOUT_COMMAND: "1",
    });
    // Claude's own files for this workspace stay readable: large tool results are read back from there.
    expect(JSON.parse(spec.env.OCTOPUS_GUEST_ALLOWED!)).toEqual(["/guests/tools", "/home/owner/.claude/projects/-guests-guests-friend-pc-workspace"]);
    expect(JSON.parse(spec.env.OCTOPUS_GUEST_PROTECTED!)).toEqual(["/home", "/root", "/srv/research", "/srv/research-archive"]);
    // No model proxy and no placeholder login: Claude talks to Anthropic with the owner's own login.
    expect(Object.keys(spec.env).filter((key) => /ANTHROPIC|OAUTH_TOKEN/.test(key))).toEqual([]);
    expect(spec.files.map((file) => file.path)).toEqual([".octopus/pc.json", ".octopus/pc-mcp.json", ".octopus/claude-settings.json"]);
    const settings = JSON.parse(spec.files.find((file) => file.path === ".octopus/claude-settings.json")!.text);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: GUARD, timeout: 15 }] }]);
    expect(spec.links).toEqual([]);
    expect(settings).toMatchObject({ plansDirectory: ".plans", autoMemoryDirectory: `${home}/memory` });
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["ListAgents", "SendMessage", "SendToProject", "RemoteTrigger"]));
    const argv = spec.argv;
    // Its own tmux server, which the guard ends on a violation.
    expect(argv.slice(0, 12)).toEqual(["tmux", "-S", `${home}/.octopus/tmux-claude.sock`, "-f", "/guests/tools/tmux.conf",
      "new-session", "-A", "-s", "claude", "-c", `${home}/workspace`, "--"]);
    expect(spec.env.OCTOPUS_GUEST_TMUX).toBe(`${home}/.octopus/tmux-claude.sock`);
    expect(argv.slice(12, 17)).toEqual(["memguard", "--rss-gib", "8", "--", "/opt/claude/bin/claude"]);
    const claude = argv.slice(16);
    expect(claude.slice(1, 3)).toEqual(["--setting-sources", ""]);
    expect(claude).toContain("--strict-mcp-config");
    expect(claude[claude.indexOf("--plugin-dir") + 1]).toBe("/guests/tools/docs-plugin");
    expect(claude[claude.indexOf("--append-system-prompt") + 1]).toContain(`Work only inside ${home}`);
    expect(claude[claude.indexOf("--append-system-prompt") + 1]).toContain("shared tools in /guests/tools");
  });

  it("runs Codex with the guests' own Codex home, the same guard and prompt, and none of the owner's Codex setup", () => {
    const home = "/guests/guests/friend-pc";
    const spec = guestSessionSpec({
      agent: "codex", record, home, port: 47830, tools: { dir: "/guests/tools", plugin: "/guests/tools/docs-plugin", skills: ["pptx", "xlsx"] },
      executable: "/opt/codex/bin/codex.js", loginDir: "/guests/codex-home", node: "/usr/bin/node",
      launchPrefix: [], cols: 100, rows: 30,
    });
    expect(spec.env).toMatchObject({ HOME: home, TMPDIR: `${home}/tmp`, CODEX_HOME: "/guests/codex-home", OCTOPUS_GUEST_HOME: home });
    expect(Object.keys(spec.env).filter((key) => /^CLAUDE|ANTHROPIC|OPENAI/.test(key))).toEqual([]);
    // Codex reads its built-in skills and the images it generates from its home.
    expect(JSON.parse(spec.env.OCTOPUS_GUEST_ALLOWED!)).toEqual(["/guests/tools", "/guests/codex-home/skills", "/guests/codex-home/generated_images"]);
    expect(spec.files.map((file) => file.path)).toEqual([".octopus/pc.json"]);
    // The shared document skills appear where Codex looks for a user's own skills.
    expect(spec.links).toEqual([
      { path: ".agents/skills/pptx", target: "/guests/tools/docs-plugin/skills/pptx" },
      { path: ".agents/skills/xlsx", target: "/guests/tools/docs-plugin/skills/xlsx" },
    ]);
    // Not the Claude session's tmux server: a session's command gets its server's environment, not its own.
    expect(spec.argv.slice(0, 12)).toEqual(["tmux", "-S", `${home}/.octopus/tmux-codex.sock`, "-f", "/guests/tools/tmux.conf",
      "new-session", "-A", "-s", "codex", "-c", `${home}/workspace`, "--"]);
    expect(spec.env.OCTOPUS_GUEST_TMUX).toBe(`${home}/.octopus/tmux-codex.sock`);
    const codex = spec.argv.slice(12);
    expect(codex[0]).toBe("/opt/codex/bin/codex.js");
    expect(codex).toEqual(expect.arrayContaining(["--no-daemon", "--dangerously-bypass-hook-trust"]));
    expect(codex.slice(codex.indexOf("--sandbox"), codex.indexOf("--sandbox") + 4)).toEqual(["--sandbox", "danger-full-access", "--ask-for-approval", "on-request"]);
    const disabled = codex.flatMap((arg, index) => arg === "--disable" ? [codex[index + 1]] : []);
    expect(disabled).toEqual(["plugins", "remote_plugin", "apps"]);
    const overrides = codex.flatMap((arg, index) => arg === "-c" ? [codex[index + 1]!] : []);
    expect(overrides).toEqual(expect.arrayContaining(["check_for_update_on_startup=false", 'service_tier="default"',
      'mcp_servers.pc.command="/usr/bin/node"', 'mcp_servers.pc.args=["/guests/tools/bin/pc-mcp.mjs"]',
      `hooks.PreToolUse=[{ matcher = "*", hooks = [{ type = "command", command = ${JSON.stringify(GUARD)}, timeout = 15 }] }]`]));
    const instructions = overrides.find((value) => value.startsWith("developer_instructions="))!;
    const prompt = JSON.parse(instructions.slice("developer_instructions=".length)) as string;
    expect(prompt).toContain(`Work only inside ${home}`);
    expect(prompt).toContain("/guests/codex-home/skills and /guests/codex-home/generated_images may be read too");
    // A guard that cannot run at all (here: no such file) still blocks, with a reason Codex accepts.
    const fallback = spawnSync("sh", ["-c", GUARD], { input: "{}", encoding: "utf8" });
    expect(fallback.status).toBe(2);
    expect(fallback.stderr).toContain("Octopus guard could not run");
  });
});

const GUARD = '/usr/bin/node /guests/tools/bin/guard.mjs || { echo "Octopus guard could not run, so this call was blocked." >&2; exit 2; }';

/** Stands in for the launcher: reports the spec and echoes terminal frames. */
const FAKE_LAUNCHER = `
let buf = Buffer.alloc(0);
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 5) {
    const kind = buf[0], size = buf.readUInt32BE(1);
    if (buf.length < 5 + size) break;
    const payload = buf.subarray(5, 5 + size);
    buf = buf.subarray(5 + size);
    if (kind === 3) { const spec = JSON.parse(payload); process.stdout.write("SPEC " + spec.argv[8] + " " + spec.env.HOME + " " + (spec.env.CLAUDE_CONFIG_DIR || spec.env.CODEX_HOME) + "\\n"); }
    else if (kind === 1) {
      process.stdout.write("ECHO " + payload);
      if (String(payload).includes("quit")) process.exit(0);
    }
    else if (kind === 2) process.stdout.write("SIZE " + payload + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

class ConsoleEnd {
  readonly frames: TerminalFrame[] = [];
  screen = "";
  private readonly decoder = new FrameDecoder();
  private waiters: Array<() => void> = [];
  constructor(readonly stream: Duplex) {
    stream.on("data", (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.kind === "data") this.screen += frame.bytes.toString();
        else this.frames.push(frame);
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
  }
  async control(t: string): Promise<{ message: Record<string, unknown>; attachment: Buffer }> {
    for (;;) {
      const index = this.frames.findIndex((frame) => frame.kind === "control" && frame.message.t === t);
      if (index >= 0) return this.frames.splice(index, 1)[0] as { message: Record<string, unknown>; attachment: Buffer };
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
  async sees(text: string): Promise<void> {
    while (!this.screen.includes(text)) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe.skipIf(!hasOpenssl)("guest session host", () => {
  it("relays the guest's terminal, its PC calls, and why the guard ended a session", async () => {
    const root = path.join(dir, "root");
    const state = path.join(dir, "state");
    const owner = path.join(dir, "owner-claude");
    mkdirSync(path.join(owner, "skills", "synced", "org", "pptx"), { recursive: true });
    writeFileSync(path.join(owner, "skills", "synced", "org", "pptx", "SKILL.md"), "---\nname: pptx\n---\n");
    const launched: Array<readonly string[]> = [];
    const port = await freePort();
    let codexHome: string | undefined;
    const host = new GuestSessionHost({
      config: () => ({ root, port }), stateDir: state,
      logins: () => ({ anthropic: { config_dir: owner }, ...(codexHome ? { openai: { codex_home: codexHome } } : {}) }),
      node: "/usr/bin/node", claude: () => "/opt/claude/bin/claude", codex: () => "/opt/codex/bin/codex.js",
      spawnLauncher: (argv) => { launched.push(argv); return spawn(process.execPath, ["-e", FAKE_LAUNCHER], { stdio: ["pipe", "pipe", "pipe"] }); },
    });
    await host.start();
    try {
      const [mine, theirs] = duplexPair();
      host.attach(theirs, { device: "friend-pc", providers: ["anthropic"] });
      const console = new ConsoleEnd(mine);
      mine.write(controlFrame({ t: "hello", v: 1, agent: "claude", cols: 100, rows: 30 }));
      const home = path.join(root, "guests", "friend-pc");
      await console.sees(`SPEC claude ${home} ${owner}`);
      expect(host.advertisement()).toMatchObject({ model_egress: { providers: ["anthropic"] } });
      expect(launched).toEqual([["/usr/bin/python3", "-I", path.join(root, "tools", "bin", "guest-launcher.py")]]);
      for (const file of ["bin/guest-launcher.py", "bin/guard.mjs", "bin/pc-mcp.mjs", "tmux.conf", "ca.pem", "docs-plugin/skills/pptx/SKILL.md", "docs-plugin/.claude-plugin/plugin.json"]) {
        expect(existsSync(path.join(root, "tools", file)), file).toBe(true);
      }
      // First-run screens are skipped for this workspace, in the guests' own state file.
      const claudeState = JSON.parse(readFileSync(path.join(owner, ".claude.json"), "utf8"));
      expect(claudeState.hasCompletedOnboarding).toBe(true);
      expect(claudeState.projects[path.join(home, "workspace")].hasTrustDialogAccepted).toBe(true);
      const recordsFile = path.join(state, "guest-sessions.json");
      expect(statSync(recordsFile).mode & 0o777).toBe(0o600);
      const secret = (JSON.parse(readFileSync(recordsFile, "utf8")) as { guests: GuestRecord[] }).guests[0]!.secret;

      mine.write(dataFrame(Buffer.from("hi\r")));
      await console.sees("ECHO hi\r");
      mine.write(controlFrame({ t: "resize", cols: 80, rows: 20 }));
      await console.sees('SIZE {"cols":80,"rows":20}');

      const ca = readFileSync(path.join(state, "guest-sessions-tls", "ca.pem"));
      const request = (pathname: string, bearer: string, body: string): Promise<{ status: number; body: Buffer }> =>
        new Promise((resolve, reject) => {
          const req = https.request({ host: "127.0.0.1", port, method: "POST", path: pathname, ca, headers: { authorization: `Bearer ${bearer}` } }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          });
          req.on("error", reject);
          req.end(body);
        });
      expect((await request("/octopus/pc/run_powershell", "wrong", "{}")).status).toBe(401);
      // No model routes any more: only the PC relay listens here.
      expect((await request("/anthropic/v1/messages", secret, "{}")).status).toBe(404);
      const shell = request("/octopus/pc/run_powershell", secret, JSON.stringify({ command: "Get-Date", timeout_seconds: 5 }));
      const call = await console.control("call");
      expect(call.message).toMatchObject({ op: "powershell", args: { command: "Get-Date", timeout_ms: 5000 } });
      mine.write(controlFrame({ t: "result", id: call.message.id, ok: true, value: { exit_code: 0, stdout: "today" } }));
      expect(JSON.parse((await shell).body.toString())).toMatchObject({ stdout: "today" });

      // The guard ended the agent: the console hears why.
      mkdirSync(path.join(home, ".octopus"), { recursive: true });
      writeFileSync(path.join(home, ".octopus", "terminated.json"), JSON.stringify({ reason: "touches /home/ubuntu/.ssh" }));
      mine.write(dataFrame(Buffer.from("quit")));
      expect(String((await console.control("exit")).message.text)).toContain("touches /home/ubuntu/.ssh");

      // Codex runs only once this host names a Codex home for guests, and only for devices allowed to use it.
      const codexConsole = async (providers: Array<"anthropic" | "openai">): Promise<ConsoleEnd> => {
        const [end, hostEnd] = duplexPair();
        host.attach(hostEnd, { device: "friend-pc", providers });
        end.write(controlFrame({ t: "hello", v: 1, agent: "codex", cols: 80, rows: 24 }));
        return new ConsoleEnd(end);
      };
      expect(String((await (await codexConsole(["anthropic", "openai"])).control("exit")).message.text)).toContain("没有提供 Codex");
      codexHome = path.join(dir, "guest-codex-home");
      expect(String((await (await codexConsole(["anthropic"])).control("exit")).message.text)).toContain("未获准使用 Codex");
      await (await codexConsole(["anthropic", "openai"])).sees(`SPEC codex ${home} ${codexHome}`);
      expect(host.advertisement()).toMatchObject({ model_egress: { providers: ["anthropic", "openai"] } });
    } finally {
      host.close();
    }
  });
});
