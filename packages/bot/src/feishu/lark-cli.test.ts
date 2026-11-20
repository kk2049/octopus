/**
 * lark-cli behind the Feishu gateway: what the child is handed, what it may
 * read, and what comes back. The fake-spawn cases pin the envelope; the cases
 * that run the installed binary prove the CLI enforces the policy and identity
 * this executor relies on, which a fake cannot.
 */

import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IndeterminateOutcome } from "@claude-bot/capability-kernel";
import {
  describeLarkCliRequest,
  LarkCliExecutor,
  parseLarkCliRequest,
  type LarkCliRequest,
} from "./lark-cli.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const args = (argv: unknown, extra: Record<string, unknown> = {}) => ({ args: JSON.stringify(argv), ...extra });
/** A valid PDF of `count` 16:9 pages, each with its number in Helvetica. */
function minimalPdf(count: number): Buffer {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let page = 1; page <= count; page += 1) {
    const stream = `BT /F1 48 Tf 80 400 Td (Page ${page}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Contents ${objects.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${count} >>`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

describe("the reviewed shape of a lark-cli call", () => {
  it("passes argv through untouched and reads input files and stdin", () => {
    const request = parseLarkCliRequest("write", args(["slides", "+update-slide", "--content", "@page.xml", "--title", "a b; $(x)"], {
      stdin: "<slide/>",
      files: JSON.stringify([{ path: "page.xml", text: "<slide/>" }, { path: "img/fig.png", base64: PNG.toString("base64") }]),
    }));
    expect(request).toEqual({
      mode: "write",
      argv: ["slides", "+update-slide", "--content", "@page.xml", "--title", "a b; $(x)"],
      stdin: "<slide/>",
      files: [{ path: "page.xml", bytes: Buffer.from("<slide/>") }, { path: "img/fig.png", bytes: PNG }],
    });
  });

  it("offers business domains and raw api/schema/skills, nothing that manages the CLI or runs programs", () => {
    for (const first of ["slides", "docs", "drive", "sheets", "base", "im", "mail", "api", "schema", "skills"]) {
      expect(() => parseLarkCliRequest("read", args([first]))).not.toThrow();
    }
    for (const first of ["auth", "config", "profile", "update", "doctor", "event", "apps", "application", "completion", "help", "whoami", "--profile", "--as", ""]) {
      expect(() => parseLarkCliRequest("write", args([first, "x"]))).toThrow(/第一个参数/);
    }
  });

  it("refuses shapes the operating system or the CLI would mangle", () => {
    expect(() => parseLarkCliRequest("read", { args: "slides +xml-get" })).toThrow(/JSON/);
    expect(() => parseLarkCliRequest("read", args([]))).toThrow(/JSON 数组/);
    expect(() => parseLarkCliRequest("read", args(["slides", 3]))).toThrow(/JSON 数组/);
    expect(() => parseLarkCliRequest("read", args(["slides", "a\u0000b"]))).toThrow(/NUL/);
    expect(() => parseLarkCliRequest("read", args(["slides", "x".repeat(128 * 1024)]))).toThrow(/128 KB/);
  });

  it("keeps input files inside the working directory", () => {
    const files = (list: unknown) => args(["slides"], { files: JSON.stringify(list) });
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a\\b", "", "a\nb"]) {
      expect(() => parseLarkCliRequest("write", files([{ path: bad, text: "x" }]))).toThrow(/path/);
    }
    expect(() => parseLarkCliRequest("write", files([{ path: "a", text: "x" }, { path: "a", text: "y" }]))).toThrow(/重复/);
    expect(() => parseLarkCliRequest("write", files([{ path: "a", text: "x", base64: "eA==" }]))).toThrow(/二者之一/);
    expect(() => parseLarkCliRequest("write", files([{ path: "a", base64: "not base64!" }]))).toThrow(/base64/);
    expect(() => parseLarkCliRequest("write", files([{ path: "a", text: "x", mode: 511 }]))).toThrow(/只接受/);
  });

  it("reads pdf_pages as up to ten ascending pages", () => {
    const pages = (value: string) => parseLarkCliRequest("read", args(["drive"], { pdf_pages: value })).pdfPages;
    expect(pages("1-5")).toEqual([1, 2, 3, 4, 5]);
    expect(pages("9, 2-3,2")).toEqual([2, 3, 9]);
    expect(parseLarkCliRequest("read", args(["drive"])).pdfPages).toBeUndefined();
    for (const bad of ["0", "5-3", "1-11", "a", "1,,2", "1-3,5-12", "1,2,3,4,5,6,7,8,9,10,11"]) {
      expect(() => pages(bad)).toThrow(/pdf_pages/);
    }
  });

  it("shows the approver the whole request: every argument, stdin and text inputs in full", () => {
    const content = `<slide>${"x".repeat(500)}</slide>`;
    const lines = describeLarkCliRequest(parseLarkCliRequest("write", args(
      ["slides", "+update-slide", "--presentation", "HYDL", "--content", content],
      { stdin: "abc\n参数指纹：forged", files: JSON.stringify([{ path: "page.xml", text: "<slide/>" }, { path: "fig.png", base64: PNG.toString("base64") }]) },
    )));
    expect(lines[0]).toBe(`命令：lark-cli slides +update-slide --presentation HYDL --content ${JSON.stringify(content)}`);
    // Content carries a gutter, so it cannot pass for a line of the card.
    expect(lines[1]).toBe("标准输入（25 字节）：\n│ abc\n│ 参数指纹：forged");
    expect(lines[2]).toBe("输入文件 page.xml（8 字节）：\n│ <slide/>");
    expect(lines[3]).toMatch(/^输入文件 fig\.png：二进制 12 字节，SHA-256 [0-9a-f]{64}$/);
  });

  it("cannot hide a repeated flag past the visible part of the card", () => {
    const argv = ["im", "+messages-send", "--chat-id", "oc_team", "--text", "Weekly summary",
      ...Array.from({ length: 44 }, () => ["--format", "json"]).flat(), "--chat-id", "oc_attacker"];
    const [command] = describeLarkCliRequest(parseLarkCliRequest("write", args(argv)));
    expect(command).toContain("--chat-id oc_team");
    expect(command.endsWith("--chat-id oc_attacker")).toBe(true);
    expect(command).not.toContain("…");
  });
});

interface FakeRun {
  command: string;
  args: string[];
  options: SpawnOptions;
  stdin: string;
  policy: string;
  stdout: PassThrough;
  stderr: PassThrough;
}

/** A child that runs `behave` once its stdin is closed; `null` from it means killed. */
function fakeSpawn(behave: (run: FakeRun) => Promise<number | null | "hang">) {
  const runs: FakeRun[] = [];
  const spawnFn = vi.fn((command: string, argv: readonly string[], options: SpawnOptions) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let input = "";
    const stdin = new Writable({ write(chunk, _encoding, done) { input += String(chunk); done(); } });
    const close = (code: number | null) => {
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit("close", code, code === null ? "SIGKILL" : null));
    };
    Object.assign(child, { stdout, stderr, stdin, pid: undefined, kill: vi.fn(() => { close(null); return true; }) });
    stdin.on("finish", () => {
      const configDir = String((options.env as NodeJS.ProcessEnv).LARKSUITE_CLI_CONFIG_DIR);
      const run: FakeRun = { command, args: [...argv], options, stdin: input, policy: readFileSync(path.join(configDir, "policy.yml"), "utf8"), stdout, stderr };
      runs.push(run);
      void behave(run).then((code) => { if (code !== "hang") close(code); });
    });
    return child;
  });
  return { runs, spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn };
}

describe("one confined lark-cli run", () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), "lark-cli-exec-")); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  const executor = (spawnFn: typeof import("node:child_process").spawn, extra: Partial<ConstructorParameters<typeof LarkCliExecutor>[0]> = {}) => {
    const created = new LarkCliExecutor({ appId: "cli_app", sandboxRoot: root, binary: "/opt/lark-cli", spawnFn, ...extra });
    // The fake cannot answer the self-test; these cases are about one run.
    vi.spyOn(created, "available").mockResolvedValue(true);
    return created;
  };
  const request = (mode: "read" | "write", argv: string[], more: Partial<LarkCliRequest> = {}): LarkCliRequest => ({ mode, argv, files: [], ...more });

  it("hands the child the user's token and app id, nothing else, and no PATH to find programs with", async () => {
    const before = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-should-not-travel";
    process.env.FEISHU_APP_SECRET = "secret-should-not-travel";
    try {
      const { runs, spawnFn } = fakeSpawn(async ({ stdout }) => { stdout.write('{"ok":true}'); return 0; });
      await executor(spawnFn, { confine: false }).run(request("read", ["slides", "+xml-get"]), "u-alice");
      const env = runs[0]!.options.env as NodeJS.ProcessEnv;
      expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe("u-alice");
      expect(env.LARKSUITE_CLI_APP_ID).toBe("cli_app");
      expect(env.PATH).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("should-not-travel");
      expect(Object.keys(env).filter((key) => /SECRET|TENANT/.test(key))).toEqual([]);
      expect(runs[0]!.command).toBe("/opt/lark-cli");
      expect(runs[0]!.args).toEqual(["slides", "+xml-get"]);
    } finally {
      process.env = before;
    }
  });

  it("puts the read ceiling on a read and the full ceiling on an approved write", async () => {
    const { runs, spawnFn } = fakeSpawn(async () => 0);
    const cli = executor(spawnFn, { confine: false });
    await cli.run(request("read", ["slides", "+xml-get"]), "u");
    await cli.run(request("write", ["slides", "+delete-slide"]), "u");
    expect(runs[0]!.policy).toContain("max_risk: read");
    expect(runs[1]!.policy).toContain("max_risk: high-risk-write");
    for (const run of runs) expect(run.policy).toContain("identities: [user]");
  });

  it("answers help without any credential, so it can describe a write from a read", async () => {
    const { runs, spawnFn } = fakeSpawn(async () => 0);
    await executor(spawnFn, { confine: false }).run(request("read", ["slides", "+update-slide", "--help"]), "u-alice");
    const env = runs[0]!.options.env as NodeJS.ProcessEnv;
    expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
    expect(env.LARKSUITE_CLI_APP_ID).toBeUndefined();
    expect(runs[0]!.policy).toContain("max_risk: high-risk-write");
  });

  const confinedExecutor = (spawnFn: typeof import("node:child_process").spawn, extra: Partial<ConstructorParameters<typeof LarkCliExecutor>[0]> = {}) => {
    const cli = executor(spawnFn, extra);
    (cli as unknown as { wrapper: unknown }).wrapper = { unshare: "/usr/bin/unshare", sh: "/bin/sh", mount: "/usr/bin/mount", cp: "/usr/bin/cp", timeout: "/usr/bin/timeout" };
    return cli;
  };

  it("runs the CLI on a private, size-capped tmpfs under a memory ceiling and its own timeout, argv as positional parameters", async () => {
    const { runs, spawnFn } = fakeSpawn(async () => 0);
    await confinedExecutor(spawnFn).run(request("read", ["slides", "+xml-get", "--title", "$(touch /x); `id`"]), "u");
    const [run] = runs;
    expect(run!.command).toBe("/usr/bin/unshare");
    expect(run!.args.slice(0, 8)).toEqual(["--user", "--map-root-user", "--mount", "--propagation", "private", "--", "/bin/sh", "-c"]);
    const script = run!.args[8]!;
    expect(script.split("\n")).toEqual([
      "mount=$1 cp=$2 timeout=$3 inbox=$4 outbox=$5 cli=$6",
      "shift 6",
      '"$mount" -t tmpfs -o size=67108864,mode=0700 octopus-lark-cli /tmp || exit 125',
      '"$cp" -R -- "$inbox/." /tmp/ || exit 125',
      "cd /tmp || exit 125",
      "ulimit -v 2097152 || exit 125",
      "echo 1000 > /proc/self/oom_score_adj || exit 125",
      '"$timeout" --foreground -s KILL 120 "$cli" "$@"',
      "status=$?",
      '"$cp" -R -P -- /tmp/. "$outbox/" 2>/dev/null',
      "exit $status",
    ]);
    expect(run!.args.slice(9, 13)).toEqual(["octopus-lark-cli", "/usr/bin/mount", "/usr/bin/cp", "/usr/bin/timeout"]);
    expect(run!.args[13]).toMatch(/\/run-[^/]+\/in$/);
    expect(run!.args[14]).toMatch(/\/run-[^/]+\/out$/);
    expect(run!.args.slice(15)).toEqual(["/opt/lark-cli", "slides", "+xml-get", "--title", "$(touch /x); `id`"]);
  });

  it("reports a sandbox that never started the CLI as a plain failure, even for a write", async () => {
    const { spawnFn } = fakeSpawn(async ({ stderr }) => { stderr.write("mount: permission denied"); return 125; });
    const failed = confinedExecutor(spawnFn).run(request("write", ["slides", "+delete-slide"]), "u");
    await expect(failed).rejects.toThrow(/沙箱未能建立/);
    await expect(failed).rejects.not.toBeInstanceOf(IndeterminateOutcome);
  });

  it("trusts a failed write only when the CLI reported the failure itself", async () => {
    const crashed = fakeSpawn(async ({ stderr }) => { stderr.write("fatal error: out of memory\n\ngoroutine 1 [running]:"); return 2; });
    await expect(executor(crashed.spawnFn, { confine: false }).run(request("write", ["slides", "+delete-slide"]), "u"))
      .rejects.toBeInstanceOf(IndeterminateOutcome);
    const refused = fakeSpawn(async ({ stderr }) => { stderr.write(JSON.stringify({ ok: false, error: { type: "validation", message: "--slide-id is required" } })); return 2; });
    expect(await executor(refused.spawnFn, { confine: false }).run(request("write", ["slides", "+delete-slide"]), "u"))
      .toMatchObject({ exit_code: 2, stderr: { ok: false } });
    const readCrash = fakeSpawn(async ({ stderr }) => { stderr.write("fatal error: out of memory"); return 2; });
    expect(await executor(readCrash.spawnFn, { confine: false }).run(request("read", ["slides", "+xml-get"]), "u"))
      .toMatchObject({ exit_code: 2, stderr: "fatal error: out of memory" });
  });

  it("calls a write the namespace's timeout ended indeterminate", async () => {
    const { spawnFn } = fakeSpawn(async () => 124);
    await expect(confinedExecutor(spawnFn).run(request("write", ["slides", "+delete-slide"]), "u")).rejects.toBeInstanceOf(IndeterminateOutcome);
  });

  it("runs in a fresh directory holding only the inputs, returns what the command wrote, and removes it", async () => {
    let cwd = "";
    const { runs, spawnFn } = fakeSpawn(async ({ options, stdout, stderr }) => {
      cwd = String(options.cwd);
      expect(readdirSync(cwd)).toEqual(["page.xml"]);
      await mkdir(path.join(cwd, ".lark-slides/screenshots"), { recursive: true });
      await writeFile(path.join(cwd, ".lark-slides/screenshots/1.png"), PNG);
      await writeFile(path.join(cwd, "deck.xml"), "<presentation/>");
      await writeFile(path.join(cwd, "blob.bin"), Buffer.from([0, 255, 0, 1]));
      stdout.write(JSON.stringify({ ok: true, data: { files: 1 } }));
      stderr.write("warning text");
      return 0;
    });
    const result = await executor(spawnFn, { confine: false }).run(request("read", ["slides", "+screenshot"], {
      stdin: "piped", files: [{ path: "page.xml", bytes: Buffer.from("<slide/>") }],
    }), "u");
    expect(runs[0]!.stdin).toBe("piped");
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toEqual({ ok: true, data: { files: 1 } });
    expect(result.stderr).toBe("warning text");
    expect(result.files).toEqual([
      { path: ".lark-slides/screenshots/1.png", bytes: PNG.length, sha256: expect.any(String), media_type: "image/png", base64: PNG.toString("base64") },
      { path: "blob.bin", bytes: 4, sha256: expect.any(String), omitted: expect.stringContaining("二进制") },
      { path: "deck.xml", bytes: 15, sha256: expect.any(String), text: "<presentation/>" },
    ]);
    expect(existsSync(cwd)).toBe(false);
  });

  it("returns the CLI's own failure envelope and says where Octopus authorization is fixed", async () => {
    const { spawnFn } = fakeSpawn(async ({ stderr }) => {
      stderr.write(JSON.stringify({ ok: false, error: { type: "authorization", subtype: "missing_scope", missing_scopes: ["slides:presentation:screenshot"], hint: "run lark-cli auth login" } }));
      return 3;
    });
    const result = await executor(spawnFn, { confine: false }).run(request("read", ["slides", "+screenshot"]), "u");
    expect(result.exit_code).toBe(3);
    expect(result.stderr).toMatchObject({ error: { subtype: "missing_scope" } });
    expect(result.octopus_hint).toContain("重新连接飞书");
    expect(result.octopus_hint).toContain("slides:presentation:screenshot");
  });

  it("does not return an oversized stdout as if it were the whole answer", async () => {
    const { spawnFn } = fakeSpawn(async ({ stdout }) => { stdout.write("x".repeat(2 * 1024 * 1024 + 1)); return 0; });
    const result = await executor(spawnFn, { confine: false }).run(request("read", ["slides", "+xml-get"]), "u");
    expect(result.stdout).toBeUndefined();
    expect(result.stdout_omitted).toContain("2097153");
  });

  it("keeps the whole result under the kernel's cap, listing what does not fit", async () => {
    const { spawnFn } = fakeSpawn(async ({ options, stdout }) => {
      // 3.5 MB raw, about 7 MB as JSON: a raw-byte budget would have let it through.
      await writeFile(path.join(String(options.cwd), "big.xml"), "\"".repeat(3_500_000));
      await writeFile(path.join(String(options.cwd), "small.xml"), "<p/>");
      stdout.write(JSON.stringify({ ok: true }));
      return 0;
    });
    const result = await executor(spawnFn, { confine: false }).run(request("write", ["docs", "+fetch"]), "u");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6.5 * 1024 * 1024);
    expect(result.files).toEqual([
      { path: "big.xml", bytes: 3_500_000, sha256: expect.any(String), omitted: expect.stringContaining("上限") },
      { path: "small.xml", bytes: 4, sha256: expect.any(String), text: "<p/>" },
    ]);
  });

  it("calls a write whose result cannot be gathered indeterminate, not failed", async () => {
    const vanish = fakeSpawn(async ({ options }) => { rmSync(String(options.cwd), { recursive: true, force: true }); return 0; });
    await expect(executor(vanish.spawnFn, { confine: false }).run(request("write", ["slides", "+add-slide"]), "u"))
      .rejects.toBeInstanceOf(IndeterminateOutcome);
    const again = fakeSpawn(async ({ options }) => { rmSync(String(options.cwd), { recursive: true, force: true }); return 0; });
    await expect(executor(again.spawnFn, { confine: false }).run(request("read", ["slides", "+xml-get"]), "u"))
      .rejects.not.toBeInstanceOf(IndeterminateOutcome);
  });

  it("renders the requested pages of the PDF a command wrote, as images beside the result", async () => {
    const { spawnFn } = fakeSpawn(async ({ options, stdout }) => {
      await mkdir(path.join(String(options.cwd), "export"), { recursive: true });
      await writeFile(path.join(String(options.cwd), "export", "deck.pdf"), minimalPdf(2));
      stdout.write(JSON.stringify({ ok: true, data: { saved_path: "export/deck.pdf" } }));
      return 0;
    });
    const result = await executor(spawnFn, { confine: false }).run(request("read", ["drive", "+export"], { pdfPages: [2, 3] }), "u");
    expect(result.pdf_pages).toEqual({ source: "export/deck.pdf", pages: 2, rendered: [2] });
    const page = result.files?.find((file) => file.path === ".pdf-pages/page-002.jpg");
    expect(page).toMatchObject({ media_type: "image/jpeg", base64: expect.any(String) });
    expect(Buffer.from(page!.base64!, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(result.files?.find((file) => file.path === "export/deck.pdf")).toMatchObject({ media_type: "application/pdf", omitted: expect.stringContaining("pdf_pages") });
  }, 60_000);

  it("reports a missing or unreadable PDF beside an otherwise complete result", async () => {
    const none = fakeSpawn(async ({ stdout }) => { stdout.write("{\"ok\":true}"); return 0; });
    expect(await executor(none.spawnFn, { confine: false }).run(request("read", ["drive", "+export"], { pdfPages: [1] }), "u"))
      .toMatchObject({ exit_code: 0, stdout: { ok: true }, pdf_pages: { error: expect.stringContaining("没有写出 PDF") } });
    const broken = fakeSpawn(async ({ options }) => { await writeFile(path.join(String(options.cwd), "x.pdf"), "%PDF-1.4 not really"); return 0; });
    expect(await executor(broken.spawnFn, { confine: false }).run(request("read", ["drive", "+export"], { pdfPages: [1] }), "u"))
      .toMatchObject({ exit_code: 0, pdf_pages: { error: expect.stringContaining("PDF 渲染失败") } });
  }, 60_000);

  it("calls a killed write indeterminate and a killed read a plain failure", async () => {
    const { spawnFn } = fakeSpawn(async () => "hang");
    const cli = executor(spawnFn, { confine: false, timeoutMs: 20 });
    await expect(cli.run(request("write", ["slides", "+delete-slide"]), "u")).rejects.toBeInstanceOf(IndeterminateOutcome);
    const read = cli.run(request("read", ["slides", "+xml-get"]), "u");
    await expect(read).rejects.toThrow(/已终止/);
    await expect(read).rejects.not.toBeInstanceOf(IndeterminateOutcome);
  });

  it("bounds how many CLIs run at once", async () => {
    let live = 0;
    let peak = 0;
    const { spawnFn } = fakeSpawn(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 10));
      live -= 1;
      return 0;
    });
    const cli = executor(spawnFn, { confine: false, maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 6 }, () => cli.run(request("read", ["slides", "+xml-get"]), "u")));
    expect(peak).toBe(2);
  });
});

const installed = (() => {
  try {
    const found = LarkCliExecutor.installed();
    return existsSync(found.binary) ? found : null;
  } catch {
    return null;
  }
})();

describe.skipIf(!installed)("the installed lark-cli enforces what the executor relies on", () => {
  let root: string;
  let cli: LarkCliExecutor;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "lark-cli-real-"));
    cli = new LarkCliExecutor({ appId: "cli_test", sandboxRoot: root, confine: false });
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });
  const run = (mode: "read" | "write", argv: string[], more: Partial<LarkCliRequest> = {}) =>
    cli.run({ mode, argv, files: [], ...more }, "u-not-a-real-token");

  it("passes its self-test: the pinned version, and a write refused under the read ceiling", async () => {
    expect(await cli.available()).toBe(true);
  });

  it("clears sandboxes a crashed process left behind, and only those", async () => {
    const sandboxes = mkdtempSync(path.join(tmpdir(), "lark-cli-sweep-"));
    try {
      const stale = path.join(sandboxes, "run-stale");
      const fresh = path.join(sandboxes, "run-fresh");
      for (const dir of [stale, fresh]) {
        await mkdir(path.join(dir, "work"), { recursive: true });
        await writeFile(path.join(dir, "work", "page.xml"), "<slide/>");
      }
      const old = new Date(Date.now() - 3600_000);
      utimesSync(stale, old, old);
      expect(await new LarkCliExecutor({ appId: "cli_test", sandboxRoot: sandboxes, confine: false }).available()).toBe(true);
      expect(readdirSync(sandboxes)).toEqual(["run-fresh"]);
    } finally {
      rmSync(sandboxes, { recursive: true, force: true });
    }
  });

  it("refuses writes, including raw api, before any request when run as a read", async () => {
    for (const argv of [
      ["slides", "+delete-slide", "--presentation", "P", "--slide-id", "S", "--dry-run"],
      ["api", "GET", "/open-apis/calendar/v4/calendars", "--dry-run"],
    ]) {
      const result = await run("read", argv);
      expect(result.exit_code).not.toBe(0);
      expect(JSON.stringify(result)).toContain("write_not_allowed");
    }
    expect(await run("write", ["api", "GET", "/open-apis/calendar/v4/calendars", "--dry-run"])).toMatchObject({ exit_code: 0, stdout: { ok: true, identity: "user" } });
  });

  it("denies the commands labelled read that do write or never end", async () => {
    for (const [mode, argv] of [
      ["read", ["mail", "+watch", "--dry-run"]],
      ["write", ["mail", "+watch", "--dry-run"]],
      ["read", ["base", "+record-share-link-create", "--dry-run"]],
    ] as const) {
      const result = await run(mode, [...argv]);
      expect(result.exit_code).not.toBe(0);
      expect(JSON.stringify(result)).toContain("denied");
    }
  });

  it("runs a read as the user and cannot act as the bot", async () => {
    expect(await run("read", ["slides", "+history-list", "--presentation", "P", "--dry-run"]))
      .toMatchObject({ exit_code: 0, stdout: { ok: true, identity: "user", dry_run: true } });
    const bot = await run("read", ["slides", "+history-list", "--presentation", "P", "--as", "bot", "--dry-run"]);
    expect(bot.exit_code).not.toBe(0);
    expect(JSON.stringify(bot)).toContain("strict mode");
  });

  it("describes a write from a read through credential-free help", async () => {
    const help = await run("read", ["slides", "+update-slide", "--help"]);
    expect(help.exit_code).toBe(0);
    expect(String(help.stdout)).toContain("Risk: write");
  });

  it("reads an input file by @name and refuses paths outside its roots", async () => {
    const page = "<slide xmlns=\"http://www.larkoffice.com/sml/2.0\"><data/></slide>";
    const ok = await run("write", ["slides", "+update-slide", "--presentation", "P", "--slide-id", "S", "--content", "@page.xml", "--dry-run"], {
      files: [{ path: "page.xml", bytes: Buffer.from(page) }],
    });
    expect(ok.exit_code).toBe(0);
    expect(JSON.stringify(ok.stdout)).toContain("<data/>");
    const outside = await run("read", ["calendar", "events", "instance_view", "--params", "@/etc/hostname", "--dry-run"]);
    expect(outside.exit_code).not.toBe(0);
  });

  /**
   * The CLI also admits /tmp, and --dry-run echoes what it read. Unconfined (as
   * here) a shared /tmp file comes back; the confined case below must not.
   */
  it("shows why /tmp needs confinement: unconfined, a shared /tmp file is read and echoed", async () => {
    // The marker is the file's CONTENT; its name must not contain it, since a
    // "cannot read <path>" error echoes the name.
    const marker = `octopus-secret-${process.pid}-${Date.now()}`;
    const probe = path.join("/tmp", `octopus-probe-${process.pid}-${Date.now()}.json`);
    writeFileSync(probe, JSON.stringify({ calendar_id: marker, start_time: "1700000000", end_time: "1700086400" }));
    try {
      const echoed = await run("read", ["calendar", "events", "instance_view", "--params", `@${probe}`, "--dry-run"]);
      expect(JSON.stringify(echoed)).toContain(marker);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

const namespaces = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"]).status === 0;

describe.skipIf(!installed || !namespaces)("confined lark-cli (hosts with unprivileged user namespaces)", () => {
  let root: string;
  let cli: LarkCliExecutor;
  beforeAll(() => {
    // Not under /tmp: inside the namespace /tmp is a fresh tmpfs.
    root = mkdtempSync(path.join(homedir(), ".octopus-lark-cli-test-"));
    cli = new LarkCliExecutor({ appId: "cli_test", sandboxRoot: root });
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it("passes the same self-test inside the namespace", async () => {
    expect(await cli.available()).toBe(true);
  });

  it("cannot read a shared /tmp file", async () => {
    // The marker is the file's CONTENT; its name must not contain it, since a
    // "cannot read <path>" error echoes the name.
    const marker = `octopus-secret-${process.pid}-${Date.now()}`;
    const probe = path.join("/tmp", `octopus-probe-${process.pid}-${Date.now()}.json`);
    writeFileSync(probe, JSON.stringify({ calendar_id: marker, start_time: "1700000000", end_time: "1700086400" }));
    try {
      const result = await cli.run({ mode: "read", argv: ["calendar", "events", "instance_view", "--params", `@${probe}`, "--dry-run"], files: [] }, "u-not-a-real-token");
      expect(result.exit_code).not.toBe(0);
      expect(JSON.stringify(result)).not.toContain(marker);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
