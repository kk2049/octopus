/**
 * lark-cli — the official Feishu/Lark CLI (`@larksuite/cli`) — as a second
 * executor behind the Feishu gateway, next to lark-mcp.
 *
 * By the time a call reaches this file the gateway has already decided who is
 * asking and as whom: the operation is on the owner's user-OAuth Object, the
 * token came from the server-side resolver, and a write was approved for its
 * exact arguments. This file runs a binary that can reach every OpenAPI
 * endpoint and read and write local files, without that binary becoming a way
 * around any of those decisions:
 *
 *  · identity — the child gets the app id and the user's access token, never
 *    the app secret or a tenant token. lark-cli then pins itself to strict
 *    mode "user"; `--as bot` has no credential to use.
 *  · read vs write — the CLI annotates every command read / write /
 *    high-risk-write and enforces a `policy.yml` ceiling itself, before any
 *    request. `lark_cli_read` runs under `max_risk: read`, so a write named
 *    there is refused by the CLI's own classification rather than by a second
 *    copy of it here; the few commands it labels read that do write are denied
 *    by name. The CLI fails OPEN on a policy file it cannot load, so
 *    `available()` proves the exact file, environment and wrapper refuse a
 *    write under the read ceiling before any operation is offered.
 *  · files — the CLI accepts paths under its cwd, /tmp and ~/files only. The
 *    child starts in its own user+mount namespace, where /tmp is a fresh,
 *    size-capped tmpfs holding only the caller's input files and is also its
 *    cwd. As root of that namespace its home is /root, which the CLI's
 *    denylist refuses, so ~/files is gone too. A shared /tmp was the one place
 *    a path could reach a server file (a read with --dry-run echoes it back).
 *  · programs — the CLI runs git, npx, npm and clipboard tools only for
 *    commands outside `LARK_CLI_DOMAINS` or by PATH lookup; the child has no
 *    PATH.
 *  · resources — reads need no approval, so each call is bounded without one:
 *    the tmpfs caps what it can write, an address-space limit caps its memory,
 *    `timeout` inside the namespace caps its life even if this process dies,
 *    and only a few run at once.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync, promises as fs, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IndeterminateOutcome } from "@claude-bot/capability-kernel";
import { createLogger } from "../logger.js";

const log = createLogger("feishu-lark-cli");

/** The backend tool name the gateway catalog dispatches to this executor. */
export const LARK_CLI_TOOL = "octopus_lark_cli";

/**
 * The commands an agent may name first: every business domain of the pinned
 * CLI plus the raw `api`, `schema` and `skills`. Deliberately absent:
 * credential and configuration management (auth, config, profile), the binary
 * itself (update, doctor), long-running consumers (event), self-management of
 * the bound Feishu app (application), and the Miaoda `apps` domain: its local
 * development commands run git and npx in the working directory, and its
 * `+file-upload` checks paths against a short denylist only, which as
 * namespace root would admit any server file.
 */
export const LARK_CLI_DOMAINS: readonly string[] = [
  "api", "approval", "attendance", "base", "calendar", "contact", "docs", "drive", "im", "mail",
  "markdown", "mindnotes", "minutes", "note", "okr", "schema", "sheets", "skills", "slides", "task",
  "vc", "whiteboard", "wiki",
];

export type LarkCliMode = "read" | "write";

export interface LarkCliInputFile {
  /** Relative to the call's working directory. */
  path: string;
  bytes: Buffer;
}

export interface LarkCliRequest {
  mode: LarkCliMode;
  argv: string[];
  stdin?: string;
  files: LarkCliInputFile[];
  /** Pages of the PDF the command writes to return as images (1-based, ascending). */
  pdfPages?: number[];
}

export interface LarkCliOutputFile {
  path: string;
  bytes: number;
  sha256: string;
  media_type?: string;
  /** PNG, JPEG or WEBP bytes; the MCP surface turns these into image blocks. */
  base64?: string;
  /** UTF-8 text files (XML, JSON, Markdown, CSV…). */
  text?: string;
  /** Why the content is not returned; the file is still listed. */
  omitted?: string;
}

export interface LarkCliResult {
  exit_code: number;
  /** The CLI's JSON envelope when stdout parses, otherwise its text. */
  stdout?: unknown;
  stderr?: unknown;
  stdout_omitted?: string;
  stderr_omitted?: string;
  files?: LarkCliOutputFile[];
  /** What to do here, when the CLI's own hint names a command Octopus does not offer. */
  octopus_hint?: string;
  /** The rendering `pdf_pages` asked for: which PDF, how many pages it has, which were rendered. */
  pdf_pages?: { source: string; pages: number; rendered: number[] } | { error: string };
}

/** Linux refuses a single argv string of 32 pages or more (MAX_ARG_STRLEN). */
const ARG_MAX_BYTES = 128 * 1024 - 1;
const MAX_ARGS = 256;
const MAX_INPUT_FILES = 32;
const DEFAULT_TIMEOUT_MS = 120_000;
/** The Bot host has a few GiB of memory to spare; each call may hold one address-space ceiling of it. */
const DEFAULT_MAX_CONCURRENT = 2;
/** Everything one call can write, inputs included. Returned content is far smaller. */
const TMPFS_BYTES = 64 * 1024 * 1024;
/**
 * The Go runtime reserves over 1 GiB of address space it does not touch: on the
 * production host 1280 MiB failed 3 of 20 TLS handshakes with "out of memory"
 * while 1536 and 2048 MiB passed 20 of 20. At 2 GiB an unbounded `--jq` still
 * dies by itself at about 550 MiB resident; `oom_score_adj` makes the CLI, not
 * the Bot, the kernel's first choice if memory runs out anyway.
 */
const ADDRESS_SPACE_KIB = 2 * 1024 * 1024;
/** What the CLI prints; past these it is reported by size, not returned. */
const STDOUT_MAX_BYTES = 2 * 1024 * 1024;
const STDERR_MAX_BYTES = 256 * 1024;
/**
 * The returned result, measured as the JSON it becomes. The kernel refuses an
 * adapter result over 8 MiB AFTER the call ran, which for a write would report
 * a completed write as failed; staying under it is what keeps that impossible.
 */
const RESULT_BUDGET_BYTES = 6 * 1024 * 1024;
const FILES_LISTED_MAX = 64;
/** Rendered PDF pages: as many as `slides +screenshot` returns per call, at a legible width. */
const PDF_PAGES_MAX = 10;
const PDF_PAGE_WIDTH = 1280;
const PDF_RENDER_TIMEOUT_MS = 60_000;
const PDF_PAGES_DIR = ".pdf-pages";
const PDF_RENDERER = fileURLToPath(new URL("./pdf-pages.mjs", import.meta.url));
/** The wrapper's own exit code for "the CLI never started"; lark-cli exits 0–10. */
const SETUP_FAILED = 125;

/**
 * `mail +watch` keeps a mailbox subscription open until it is stopped cleanly,
 * which a call deadline never does; `base +record-share-link-create` is
 * labelled read but creates a share link.
 */
const POLICY: Readonly<Record<LarkCliMode, string>> = {
  read: "rules:\n  - name: octopus-read\n    max_risk: read\n    identities: [user]\n"
    + "    deny:\n      - mail/+watch\n      - base/+record-share-link-create\n",
  write: "rules:\n  - name: octopus-write\n    max_risk: high-risk-write\n    identities: [user]\n"
    + "    deny:\n      - mail/+watch\n",
};

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");

function jsonValue(value: unknown, field: string): unknown {
  if (typeof value !== "string") throw new Error(`${field} 必须是 JSON 字符串`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} 不是有效的 JSON`);
  }
}

function inputPath(value: unknown, at: string): string {
  if (typeof value !== "string" || !value || value.length > 240) throw new Error(`${at}.path 必须是 1–240 字符的相对路径`);
  // eslint-disable-next-line no-control-regex
  if (value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${at}.path 必须是工作目录内的相对路径`);
  }
  const parts = value.split("/");
  if (parts.length > 8 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${at}.path 不能为空段、"." 或 ".."，且最多 8 层`);
  }
  return parts.join("/");
}

function inputFiles(value: unknown): LarkCliInputFile[] {
  if (value === undefined || value === null || value === "") return [];
  const list = jsonValue(value, "files");
  if (!Array.isArray(list) || list.length > MAX_INPUT_FILES) throw new Error(`files 必须是最多 ${MAX_INPUT_FILES} 项的 JSON 数组`);
  const seen = new Set<string>();
  return list.map((item: unknown, index) => {
    const at = `files[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${at} 必须是 {"path","text"} 或 {"path","base64"}`);
    const { path: name, text, base64, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length) throw new Error(`${at} 只接受 path、text、base64`);
    const relative = inputPath(name, at);
    if (seen.has(relative)) throw new Error(`${at}.path 重复：${relative}`);
    seen.add(relative);
    if ((text === undefined) === (base64 === undefined)) throw new Error(`${at} 需要 text 或 base64 二者之一`);
    if (text !== undefined) {
      if (typeof text !== "string") throw new Error(`${at}.text 必须是字符串`);
      return { path: relative, bytes: Buffer.from(text, "utf8") };
    }
    const encoded = typeof base64 === "string" ? base64.replace(/\s+/g, "") : "";
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`${at}.base64 不是有效的 base64`);
    return { path: relative, bytes: Buffer.from(encoded, "base64") };
  });
}

/**
 * The reviewed shape of one lark-cli call. Runs at the policy (so a malformed
 * call is refused before anyone is asked to approve it) and again in the
 * adapter; it decides nothing about read versus write.
 */
export function parseLarkCliRequest(mode: LarkCliMode, args: Readonly<Record<string, unknown>>): LarkCliRequest {
  const argv = jsonValue(args.args, "args");
  if (!Array.isArray(argv) || !argv.length || argv.length > MAX_ARGS || argv.some((value) => typeof value !== "string")) {
    throw new Error(`args 必须是 1–${MAX_ARGS} 个字符串组成的 JSON 数组，例如 ["slides","+xml-get","--presentation","<token>"]`);
  }
  for (const value of argv as string[]) {
    if (value.includes("\u0000")) throw new Error("args 不能包含 NUL 字符");
    if (Buffer.byteLength(value) > ARG_MAX_BYTES) throw new Error("单个参数超过 128 KB；长内容请放进 files 或 stdin，再用 @文件名 或 - 引用");
  }
  const first = (argv as string[])[0]!;
  if (!LARK_CLI_DOMAINS.includes(first)) {
    throw new Error(`第一个参数必须是业务域或 api / schema / skills（${LARK_CLI_DOMAINS.join("、")}）；"${first.slice(0, 40)}" 不在 Octopus 开放的 lark-cli 范围内`);
  }
  const stdin = args.stdin === undefined || args.stdin === null ? undefined : String(args.stdin);
  const pdfPages = pageList(args.pdf_pages);
  return {
    mode,
    argv: [...(argv as string[])],
    ...(stdin === undefined ? {} : { stdin }),
    files: inputFiles(args.files),
    ...(pdfPages ? { pdfPages } : {}),
  };
}

/** "1-5", "3", "1,4,7" or "2-3,9": at most `PDF_PAGES_MAX` pages, ascending. */
function pageList(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const pages = new Set<number>();
  for (const part of String(value).split(",")) {
    const range = /^\s*(\d{1,4})\s*(?:-\s*(\d{1,4})\s*)?$/.exec(part);
    const first = range ? Number(range[1]) : 0;
    const last = range?.[2] === undefined ? first : Number(range[2]);
    if (!range || first < 1 || last < first || last - first >= PDF_PAGES_MAX) {
      throw new Error(`pdf_pages 必须是页码或页码范围，例如 "1-5"、"3"、"1,4,7"`);
    }
    for (let page = first; page <= last; page += 1) pages.add(page);
  }
  if (pages.size > PDF_PAGES_MAX) throw new Error(`pdf_pages 一次最多 ${PDF_PAGES_MAX} 页`);
  return [...pages].sort((a, b) => a - b);
}

/** One argument, unambiguous on one line: as written when plain, else JSON-quoted. */
const shownArg = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value));
/** Content lines carry a gutter, so text inside an input cannot pass for a line of the card. */
const quoted = (text: string) => text.split("\n").map((line) => `│ ${line}`).join("\n");

/**
 * The approval card's view of a call: all of it. A flag given twice takes its
 * last value, so a card that cut the command short could show one target and
 * run another; inputs are shown as text, binary ones by full digest.
 */
export function describeLarkCliRequest(request: LarkCliRequest): string[] {
  return [
    `命令：lark-cli ${request.argv.map(shownArg).join(" ")}`,
    ...(request.stdin === undefined ? [] : [`标准输入（${Buffer.byteLength(request.stdin)} 字节）：\n${quoted(request.stdin)}`]),
    ...request.files.map((file) => {
      const text = utf8Text(file.bytes);
      return text === null
        ? `输入文件 ${shownArg(file.path)}：二进制 ${file.bytes.length} 字节，SHA-256 ${sha256(file.bytes)}`
        : `输入文件 ${shownArg(file.path)}（${file.bytes.length} 字节）：\n${quoted(text)}`;
    }),
    ...(request.pdfPages ? [`渲染 PDF 页：${request.pdfPages.join(",")}`] : []),
  ];
}

const isHelp = (argv: readonly string[]) => argv.includes("--help") || argv.includes("-h");

function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function utf8Text(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

function parsedOutput(bytes: Buffer): unknown {
  const text = utf8Text(bytes) ?? bytes.toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The CLI's own failure report: `{ "ok": false, "error": { … } }`. */
const isEnvelope = (value: unknown) => Boolean(value && typeof value === "object"
  && (value as { ok?: unknown }).ok === false && typeof (value as { error?: unknown }).error === "object");

/** Takes `value` out of the result budget if it fits. */
type Budget = (value: unknown) => boolean;

/**
 * The regular files the call left behind, minus inputs it did not change.
 * Symlinks and special files are never followed or read; content is returned
 * only while it fits the budget, otherwise the file is listed by size.
 */
async function collectOutputs(dir: string, inputs: ReadonlyMap<string, string>, fits: Budget): Promise<LarkCliOutputFile[]> {
  const found: string[] = [];
  const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= 512) return;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(absolute, entry.name), childRelative, depth + 1);
      else if (entry.isFile()) found.push(childRelative);
    }
  };
  await walk(dir, "", 0);
  const files: LarkCliOutputFile[] = [];
  for (const relative of found) {
    if (files.length >= FILES_LISTED_MAX) break;
    const handle = await fs.open(path.join(dir, relative), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      const bytes = await handle.readFile();
      const digest = sha256(bytes);
      if (inputs.get(relative) === digest) continue;
      const entry = { path: relative, bytes: bytes.length, sha256: digest };
      if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
        // Even an all-ASCII PDF is a document, not text a model should read.
        files.push({ ...entry, media_type: "application/pdf", omitted: "PDF 不随结果返回；要看页面，用 pdf_pages 把指定页渲染成图片" });
        continue;
      }
      const media = imageType(bytes);
      const text = media ? null : utf8Text(bytes);
      const full: LarkCliOutputFile | null = media
        ? { ...entry, media_type: media, base64: bytes.toString("base64") }
        : text !== null ? { ...entry, text } : null;
      if (full && fits(full)) files.push(full);
      else {
        files.push({
          ...entry,
          ...(media ? { media_type: media } : {}),
          omitted: full
            ? "超出单次返回上限；请缩小这次命令的输出（例如更少页数）"
            : "二进制文件不随结果返回（只返回 PNG/JPEG/WEBP 图片与文本文件）",
        });
      }
    } finally {
      await handle.close();
    }
  }
  return files;
}

/** The first regular file under `dir` (by path) that is a PDF, outside the rendered pages. */
async function firstPdf(dir: string): Promise<string | null> {
  const walk = async (absolute: string, relative: string, depth: number): Promise<string | null> => {
    if (depth > 8) return null;
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (childRelative === PDF_PAGES_DIR) continue;
        const found = await walk(path.join(absolute, entry.name), childRelative, depth + 1);
        if (found) return found;
      } else if (entry.isFile()) {
        const handle = await fs.open(path.join(absolute, entry.name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const head = Buffer.alloc(5);
          await handle.read(head, 0, 5, 0);
          if (head.toString("latin1") === "%PDF-") return childRelative;
        } finally {
          await handle.close();
        }
      }
    }
    return null;
  };
  return await walk(dir, "", 0);
}

/** Octopus's answer where the CLI's own hint says `lark-cli auth login`, which is not offered here. */
function octopusHint(envelope: unknown): string | undefined {
  const error = envelope && typeof envelope === "object" ? (envelope as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object") return undefined;
  const { type, subtype, missing_scopes: missing } = error as { type?: unknown; subtype?: unknown; missing_scopes?: unknown };
  if (type !== "authorization") return undefined;
  const scopes = Array.isArray(missing) ? missing.map(String).join("、") : "";
  if (subtype === "missing_scope") {
    return `这里的身份是 Octopus 代管的飞书授权，lark-cli auth login 不可用。缺少的 scope${scopes ? `（${scopes}）` : ""}需要在 Octopus 权限中心「重新连接飞书」补充；`
      + "若重新连接后仍缺少，说明它不在 Octopus 的申请清单或飞书应用尚未开通，请告诉 Octopus 管理员。";
  }
  return "这里的身份是 Octopus 代管的飞书授权，lark-cli 的 auth / config 命令不可用；授权问题请在 Octopus 权限中心处理，应用权限请联系飞书应用管理员。";
}

function firstExisting(candidates: readonly string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

interface Bounded {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: Buffer | null;
  stdoutBytes: number;
  stderr: Buffer | null;
  stderrBytes: number;
}

interface Wrapper {
  unshare: string;
  sh: string;
  mount: string;
  cp: string;
  timeout: string;
}

export interface LarkCliExecutorOptions {
  /** The same app the user's OAuth token was issued to. */
  appId: string;
  /** Parent of the per-call sandboxes. Never under /tmp, which the child replaces. */
  sandboxRoot: string;
  /** Defaults to the binary installed with `@larksuite/cli`. */
  binary?: string;
  /** Tests only: run the binary directly, without the namespace and its bounds. */
  confine?: boolean;
  timeoutMs?: number;
  maxConcurrent?: number;
  spawnFn?: typeof spawn;
}

export class LarkCliExecutor {
  private ready: Promise<boolean> | null = null;
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private wrapper: Wrapper | null = null;

  constructor(private readonly opts: LarkCliExecutorOptions) {}

  /** The installed binary and the version its package declares. */
  static installed(): { binary: string; version: string } {
    const manifest = createRequire(import.meta.url).resolve("@larksuite/cli/package.json");
    const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return { binary: path.join(path.dirname(manifest), "bin", "lark-cli"), version: String(version ?? "") };
  }

  /**
   * Whether calls can run here at all, decided once. Fails closed: a missing
   * binary, an unexpected version, a host without unprivileged namespaces or a
   * policy the CLI does not enforce each leave the operations unoffered.
   */
  available(): Promise<boolean> {
    this.ready ??= this.selfTest().catch((error: unknown) => {
      log.error({ err: error }, "lark-cli self-test failed; lark-cli operations are disabled");
      return false;
    });
    return this.ready;
  }

  async run(request: LarkCliRequest, token: string): Promise<LarkCliResult> {
    if (!(await this.available())) throw new Error("lark-cli 在这台服务器上不可用（启动自检未通过）");
    await this.acquire();
    try {
      return await this.execute(request, token);
    } finally {
      this.release();
    }
  }

  private get confined(): boolean {
    return this.opts.confine !== false;
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private binary(): string {
    return this.opts.binary ?? LarkCliExecutor.installed().binary;
  }

  /** Sandboxes a crashed process left behind; a live call is never older than its timeout. */
  private async sweep(): Promise<void> {
    const cutoff = Date.now() - 2 * this.timeoutMs;
    const entries = await fs.readdir(this.opts.sandboxRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
      const dir = path.join(this.opts.sandboxRoot, entry.name);
      if ((await fs.stat(dir)).mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private async selfTest(): Promise<boolean> {
    const binary = this.binary();
    await fs.access(binary, fs.constants.X_OK);
    await this.sweep();
    if (this.confined) {
      const tool = (name: string) => firstExisting([`/usr/bin/${name}`, `/bin/${name}`]);
      const wrapper = { unshare: tool("unshare"), sh: tool("sh"), mount: tool("mount"), cp: tool("cp"), timeout: tool("timeout") };
      const missing = Object.entries(wrapper).filter(([, found]) => !found).map(([name]) => name);
      if (missing.length) throw new Error(`lark-cli confinement needs ${missing.join(", ")}`);
      this.wrapper = wrapper as Wrapper;
    }
    const expected = this.opts.binary ? null : LarkCliExecutor.installed().version;
    const version = await this.execute({ mode: "read", argv: ["--version"], files: [] }, null);
    const reported = typeof version.stdout === "string" ? version.stdout.trim() : "";
    if (version.exit_code !== 0 || !reported.startsWith("lark-cli version ") || (expected && reported !== `lark-cli version ${expected}`)) {
      throw new Error(`lark-cli did not start as expected (exit ${version.exit_code}): ${reported.slice(0, 120)}`);
    }
    // The read ceiling is the only thing between an auto-allowed call and a
    // write, and the CLI ignores a policy it cannot load. Prove it here, with
    // the same files, environment and wrapper every call uses; --dry-run and a
    // fake token mean nothing could reach Feishu even if it were not refused.
    const probe = await this.execute({
      mode: "read",
      argv: ["slides", "+delete-slide", "--presentation", "octopus-self-test", "--slide-id", "octopus-self-test", "--dry-run"],
      files: [],
    }, "u-octopus-self-test");
    if (probe.exit_code === 0 || !JSON.stringify(probe).includes("write_not_allowed")) {
      throw new Error("lark-cli did not enforce the read-only policy ceiling");
    }
    log.info({ version: reported, confined: this.confined }, "lark-cli executor ready");
    return true;
  }

  private async acquire(): Promise<void> {
    if (this.running < (this.opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }

  /** `token: null` runs without any credential (help, version). */
  private async execute(request: LarkCliRequest, token: string | null): Promise<LarkCliResult> {
    await fs.mkdir(this.opts.sandboxRoot, { recursive: true, mode: 0o700 });
    const root = await fs.mkdtemp(path.join(this.opts.sandboxRoot, "run-"));
    try {
      const home = path.join(root, "home");
      const config = path.join(root, "config");
      const inbox = path.join(root, "in");
      const outbox = path.join(root, "out");
      for (const dir of [home, config, inbox, outbox]) await fs.mkdir(dir, { mode: 0o700 });
      // Help never needs an identity, and needs the whole command tree to
      // describe a write; without a credential nothing it could run reaches
      // Feishu, so the ceiling no longer guards anything there.
      const credential = token !== null && !isHelp(request.argv) ? token : null;
      await fs.writeFile(path.join(config, "policy.yml"), credential ? POLICY[request.mode] : POLICY.write, { mode: 0o600, flag: "wx" });
      // Confined, the wrapper copies the inputs onto the private tmpfs and the
      // outputs back to `outbox`; unconfined (tests), the CLI runs in `outbox`.
      const staging = this.confined ? inbox : outbox;
      const inputs = new Map<string, string>();
      for (const file of request.files) {
        const target = path.join(staging, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, file.bytes, { mode: 0o600, flag: "wx" });
        inputs.set(file.path, sha256(file.bytes));
      }
      const outcome = await this.spawnBounded(
        this.command(request.argv, inbox, outbox),
        this.confined ? root : outbox,
        this.childEnv(home, config, credential),
        request.stdin,
      );
      return await this.settle(request, outcome, outbox, inputs);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch((error: unknown) => {
        log.warn({ err: error }, "lark-cli sandbox cleanup failed");
      });
    }
  }

  /**
   * The result of a run that has happened. Past this point a write may have
   * taken effect, so anything that goes wrong is indeterminate for it, never
   * a failure that invites the same write again.
   */
  private async settle(request: LarkCliRequest, outcome: Bounded, outbox: string, inputs: ReadonlyMap<string, string>): Promise<LarkCliResult> {
    const code = outcome.code;
    if (this.confined && code !== null && code >= SETUP_FAILED && code <= 127) {
      // The wrapper or `timeout` could not start the CLI: nothing ran.
      const detail = outcome.stderr ? outcome.stderr.toString("utf8").slice(0, 300) : "";
      throw new Error(`lark-cli 沙箱未能建立，命令没有运行（exit ${code}）${detail ? `：${detail}` : ""}`);
    }
    try {
      if (outcome.timedOut || code === null || code >= 128 || (this.confined && code === 124)) {
        const reason = code === 124 || outcome.timedOut
          ? `lark-cli 超过 ${Math.round(this.timeoutMs / 1000)} 秒未结束，已终止`
          : `lark-cli 被信号终止（${outcome.signal ?? `exit ${code}`}）`;
        if (request.mode === "write") throw new IndeterminateOutcome(`${reason}；写入是否已生效未知。请先用读取命令核对，不要直接重试。`);
        throw new Error(reason);
      }
      const stdout = outcome.stdout ? parsedOutput(outcome.stdout) : undefined;
      const stderr = outcome.stderr ? parsedOutput(outcome.stderr) : undefined;
      // The CLI reports every failure it handles as a JSON envelope on stderr.
      // A non-zero exit without one (a runtime crash) may have come after a
      // request was sent, so for a write it says nothing about the outcome.
      if (request.mode === "write" && code !== 0 && !isEnvelope(stderr)) {
        throw new IndeterminateOutcome(`lark-cli 非正常结束（exit ${code}，没有错误信封）；写入是否已生效未知。请先用读取命令核对，不要直接重试。`);
      }
      let budget = RESULT_BUDGET_BYTES;
      const fits: Budget = (value) => {
        const size = jsonBytes(value);
        if (size > budget) return false;
        budget -= size;
        return true;
      };
      const result: LarkCliResult = { exit_code: code };
      const tooLarge = (stream: string, bytes: number) =>
        `${stream} ${bytes} 字节，超过单次返回上限，未返回；请缩小范围（如 --slide-number、--page-limit、--jq）或用 --output 写成文件`;
      if (!outcome.stdout) result.stdout_omitted = tooLarge("标准输出", outcome.stdoutBytes);
      else if (stdout !== undefined) {
        if (fits(stdout)) result.stdout = stdout;
        else result.stdout_omitted = tooLarge("标准输出", outcome.stdoutBytes);
      }
      if (!outcome.stderr) result.stderr_omitted = tooLarge("标准错误", outcome.stderrBytes);
      else if (stderr !== undefined) {
        if (fits(stderr)) result.stderr = stderr;
        else result.stderr_omitted = tooLarge("标准错误", outcome.stderrBytes);
      }
      if (request.pdfPages) {
        result.pdf_pages = await this.renderPdfPages(outbox, request.pdfPages)
          .catch((error: unknown) => ({ error: `PDF 渲染失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 300) }));
      }
      const files = await collectOutputs(outbox, inputs, fits);
      if (files.length) result.files = files;
      const hint = octopusHint(stderr) ?? octopusHint(stdout);
      if (hint) result.octopus_hint = hint;
      return result;
    } catch (error) {
      if (request.mode === "write" && !(error instanceof IndeterminateOutcome)) {
        throw new IndeterminateOutcome(`lark-cli 已运行，但结果无法整理（${error instanceof Error ? error.message : String(error)}）；写入是否已生效未知。请先用读取命令核对，不要直接重试。`);
      }
      throw error;
    }
  }

  /**
   * Renders pages of the PDF the command wrote (the first, by path) into
   * `outbox/.pdf-pages/`, where collection returns them as images. A failure
   * is reported beside the command's own result, which already happened.
   */
  private async renderPdfPages(outbox: string, pages: readonly number[]): Promise<NonNullable<LarkCliResult["pdf_pages"]>> {
    const pdf = await firstPdf(outbox);
    if (!pdf) {
      return {
        error: "命令没有写出 PDF。导出未完成（stdout.data.ready 为 false）时按 data.next_command 用 drive +task_result 查询，"
          + "完成后用返回的 data.file_token 执行 drive +export-download 并带上 pdf_pages；否则先用 drive +export --file-extension pdf 把文件写到工作目录",
      };
    }
    const target = path.join(outbox, PDF_PAGES_DIR);
    await fs.mkdir(target, { mode: 0o700 });
    const run = await this.spawnBounded(
      ["/bin/sh", ["-c", 'echo 1000 > /proc/self/oom_score_adj && exec "$0" "$@"',
        process.execPath, "--max-old-space-size=512", PDF_RENDERER, path.join(outbox, pdf), target, String(PDF_PAGE_WIDTH), pages.join(",")]],
      target,
      { LANG: "C.UTF-8" },
      undefined,
      // Our own program, never the CLI stand-in a test injects.
      { timeoutMs: PDF_RENDER_TIMEOUT_MS, run: spawn },
    );
    const report = run.code === 0 && run.stdout ? parsedOutput(run.stdout) : undefined;
    if (!report || typeof report !== "object") {
      const detail = run.timedOut ? "超时" : (run.stderr?.toString("utf8") ?? "").trim().split("\n")[0]?.slice(0, 200) ?? "";
      return { error: `PDF 渲染失败（${run.code ?? run.signal ?? "killed"}）${detail ? `：${detail}` : ""}` };
    }
    const { pages: total, rendered } = report as { pages?: unknown; rendered?: Array<{ page?: unknown }> };
    return { source: pdf, pages: Number(total), rendered: (rendered ?? []).map((entry) => Number(entry.page)) };
  }

  /**
   * The child's environment, built from nothing. No PATH: the CLI then cannot
   * find any program to run. The policy lives in an explicit config dir so its
   * location does not depend on how the CLI resolves a home directory.
   */
  private childEnv(home: string, config: string, token: string | null): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      TMPDIR: "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      TZ: process.env.TZ,
      HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy,
      NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy,
      SSL_CERT_FILE: process.env.SSL_CERT_FILE,
      SSL_CERT_DIR: process.env.SSL_CERT_DIR,
      LARKSUITE_CLI_CONFIG_DIR: config,
      LARKSUITE_CLI_BRAND: "feishu",
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      ...(token ? { LARKSUITE_CLI_APP_ID: this.opts.appId, LARKSUITE_CLI_USER_ACCESS_TOKEN: token } : {}),
    };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    return env;
  }

  /**
   * `unshare` execs `sh` in a new user+mount namespace. `sh` mounts the
   * size-capped tmpfs on /tmp, copies the inputs onto it, works there under
   * the address-space limit as the kernel's first OOM victim, runs the CLI
   * under `timeout`, and copies what is left back out. The script is constant: trusted paths and every CLI
   * argument arrive as positional parameters and are never interpreted.
   */
  private command(argv: readonly string[], inbox: string, outbox: string): [string, string[]] {
    const binary = this.binary();
    if (!this.confined) return [binary, [...argv]];
    const wrapper = this.wrapper;
    if (!wrapper) throw new Error("lark-cli confinement is not prepared");
    const script = [
      'mount=$1 cp=$2 timeout=$3 inbox=$4 outbox=$5 cli=$6',
      'shift 6',
      `"$mount" -t tmpfs -o size=${TMPFS_BYTES},mode=0700 octopus-lark-cli /tmp || exit ${SETUP_FAILED}`,
      `"$cp" -R -- "$inbox/." /tmp/ || exit ${SETUP_FAILED}`,
      `cd /tmp || exit ${SETUP_FAILED}`,
      `ulimit -v ${ADDRESS_SPACE_KIB} || exit ${SETUP_FAILED}`,
      `echo 1000 > /proc/self/oom_score_adj || exit ${SETUP_FAILED}`,
      `"$timeout" --foreground -s KILL ${Math.ceil(this.timeoutMs / 1000)} "$cli" "$@"`,
      'status=$?',
      '"$cp" -R -P -- /tmp/. "$outbox/" 2>/dev/null',
      'exit $status',
    ].join("\n");
    return [wrapper.unshare, [
      "--user", "--map-root-user", "--mount", "--propagation", "private", "--",
      wrapper.sh, "-c", script, "octopus-lark-cli",
      wrapper.mount, wrapper.cp, wrapper.timeout, inbox, outbox, binary, ...argv,
    ]];
  }

  private spawnBounded(
    [command, args]: [string, string[]],
    cwd: string,
    env: NodeJS.ProcessEnv,
    stdin: string | undefined,
    { timeoutMs, run = this.opts.spawnFn ?? spawn }: { timeoutMs?: number; run?: typeof spawn } = {},
  ): Promise<Bounded> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = run(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      } catch (error) {
        reject(error as Error);
        return;
      }
      const capture = (stream: NodeJS.ReadableStream | null, limit: number) => {
        const state = { chunks: [] as Buffer[], bytes: 0 };
        stream?.on("data", (chunk: Buffer) => {
          state.bytes += chunk.length;
          if (state.bytes <= limit) state.chunks.push(chunk);
          else state.chunks = [];
        });
        return state;
      };
      const out = capture(child.stdout, STDOUT_MAX_BYTES);
      const err = capture(child.stderr, STDERR_MAX_BYTES);
      let settled = false;
      let timedOut = false;
      // Confined, `timeout` inside the namespace ends the CLI first; this is
      // the backstop for the wrapper itself (and the only clock unconfined).
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (!child.pid) throw new Error("no process group");
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs ?? this.timeoutMs + (this.confined ? 15_000 : 0));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          signal,
          timedOut,
          stdout: out.bytes <= STDOUT_MAX_BYTES ? Buffer.concat(out.chunks) : null,
          stdoutBytes: out.bytes,
          stderr: err.bytes <= STDERR_MAX_BYTES ? Buffer.concat(err.chunks) : null,
          stderrBytes: err.bytes,
        });
      });
      // A command that never reads stdin closes the pipe first.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin ?? "");
    });
  }
}
