/**
 * Pack a guest client installer on the guest-session host (2026-11-12; console since 2026-11-13).
 *
 *   octopus-runner guest pack --device <name> [--providers anthropic,openai]
 *
 * The output is one Windows .exe (NSIS, per-user, no admin) that carries its
 * own Node, this Runner bundle, and a `guest.json` naming the server and a
 * single-use enrollment for a new guest device under this host's owner. Its
 * shortcuts open `guest console` windows onto agents that run on this host;
 * no agent and no model credential is installed on the guest's PC.
 *
 * Only `guest.json` differs between devices, so it is not compressed into the
 * NSIS data: it is a trailer appended to a cached base installer (built once
 * per Node, Runner bundle and owner, which takes the LZMA time). A new device
 * or a new enrollment costs one server request and one file copy.
 *
 * Node comes from npmmirror (reachable from mainland China), checked against
 * its SHASUMS256. The Runner bundle is the server's active one, checked
 * against its published sha256. Downloads are cached under ~/.cache/octopus-guest.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync, copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { readInstalledConfig, runnerInstallPaths, type RunnerGuestProvider } from "./install-config.js";
import { GUEST_PACKAGE_SCHEMA, GUEST_SERVICE_NAME, guestTrailer, type GuestPackage } from "./guest-install.js";

const NODE_MIRROR = "https://cdn.npmmirror.com/binaries/node";
export const GUEST_NODE_VERSION = "22.23.5";

export interface GuestPackOptions {
  device: string;
  providers: RunnerGuestProvider[];
  ttlDays?: number;
  out?: string;
  cacheDir?: string;
  nodeVersion?: string;
  /** Test a local Runner bundle instead of the server's active one (pre-deploy checks only). */
  runnerBundle?: string;
  log?: (line: string) => void;
}

export interface GuestPackResult {
  file: string;
  bytes: number;
  sha256: string;
  device: string;
  owner: string;
  expires_at: string;
  versions: Record<string, string>;
}

export async function packGuest(home: string, options: GuestPackOptions): Promise<GuestPackResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const config = readInstalledConfig(home);
  const token = readFileSync(runnerInstallPaths(home).token, "utf8").trim();
  const egress = config.model_egress;
  const missing = options.providers.filter((provider) => provider === "anthropic" ? !egress?.anthropic : !egress?.openai);
  if (missing.length) {
    throw new Error(`本机还没有开启 ${missing.join("、")} 模型出口；先运行 octopus-runner guest host 配置登录目录`);
  }
  if (!config.guest_sessions) throw new Error("本机还没有开启访客会话；先运行 octopus-runner guest host --sessions-root <目录>");
  if (spawnSync("makensis", ["-VERSION"], { encoding: "utf8" }).status !== 0) {
    throw new Error("打包需要 NSIS：sudo apt-get install -y nsis");
  }
  const cache = options.cacheDir ?? path.join(os.homedir(), ".cache", "octopus-guest");
  const versions: Record<string, string> = { node: options.nodeVersion ?? GUEST_NODE_VERSION };

  // Everything that can fail without side effects happens before the
  // enrollment is minted, so a broken download never wastes a device name.
  log(`准备 Windows 组件：${Object.entries(versions).map(([key, value]) => `${key} ${value}`).join("，")}`);
  const nodeExe = await nodeForWindows(cache, versions.node);
  const bundle = options.runnerBundle
    ? { file: path.resolve(options.runnerBundle), sha: await sha256File(path.resolve(options.runnerBundle)) }
    : await activeRunnerBundle(config.dashboard_url, cache);
  versions.runner = bundle.sha.slice(0, 12);

  log("向 Octopus 申请访客设备……");
  const response = await fetch(`${config.dashboard_url}/api/runner-guest-enrollment`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ device: options.device, providers: options.providers, ...(options.ttlDays ? { ttl_days: options.ttlDays } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  const issued = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof issued.enrollment_code !== "string") {
    throw new Error(`服务器拒绝签发访客设备（HTTP ${response.status}）：${String(issued.error ?? "未知错误")}`);
  }

  const pkg: GuestPackage = {
    schema: GUEST_PACKAGE_SCHEMA,
    owner: String(issued.username),
    device: String(issued.device),
    dashboard_url: String(issued.dashboard_url ?? config.dashboard_url),
    runner_url: String(issued.runner_url ?? config.runner_url),
    enrollment: issued.enrollment_code,
    expires_at: String(issued.expires_at),
    model_host: String(issued.model_host),
    providers: options.providers,
    created_at: new Date().toISOString(),
    versions,
  };

  const base = baseInstaller(cache, { nodeExe, bundle, nodeVersion: versions.node, owner: pkg.owner, log });
  const out = path.resolve(options.out ?? path.join(os.homedir(), "lht", "temp", "octopus-guest", pkg.device, `OctopusGuest-${pkg.device}-Setup.exe`));
  mkdirSync(path.dirname(out), { recursive: true });
  const partial = `${out}.partial`;
  copyFileSync(base, partial);
  appendFileSync(partial, guestTrailer(pkg));
  renameSync(partial, out);
  const sha256 = await sha256File(out);
  return {
    file: out, bytes: statSync(out).size, sha256,
    device: pkg.device, owner: pkg.owner, expires_at: pkg.expires_at, versions,
  };
}

/** Bases kept in the cache; older ones are removed when a new one is built. */
const KEEP_BASES = 3;

/**
 * The device-independent installer for one Node, Runner bundle and owner.
 * Built with makensis once (the LZMA pass over Node is the slow part), then
 * reused for every device until one of them changes.
 */
function baseInstaller(cache: string, input: {
  nodeExe: string; bundle: { file: string; sha: string }; nodeVersion: string; owner: string; log: (line: string) => void;
}): string {
  const dir = path.join(cache, "base");
  const key = createHash("sha256")
    .update(JSON.stringify([input.nodeVersion, input.bundle.sha, nsisScript({ owner: input.owner }, "OUT"), readmeText({ owner: input.owner })]))
    .digest("hex").slice(0, 16);
  const file = path.join(dir, `OctopusGuest-base-${key}.exe`);
  if (existsSync(file)) {
    input.log("复用已缓存的安装包底包");
    return file;
  }
  const work = path.join(cache, "build", `base-${key}-${process.pid}`);
  const app = path.join(work, "app");
  try {
    mkdirSync(app, { recursive: true });
    mkdirSync(dir, { recursive: true });
    place(input.nodeExe, path.join(app, "node", "node.exe"));
    place(input.bundle.file, path.join(app, "runner", "standalone.js"));
    writeFileSync(path.join(app, "README.txt"), "\ufeff" + readmeText({ owner: input.owner }));
    const partial = `${file}.${process.pid}.partial`;
    writeFileSync(path.join(work, "installer.nsi"), nsisScript({ owner: input.owner }, partial));
    input.log("生成安装包底包（Runner 或 Node 更新后的第一次，约半分钟）……");
    const built = spawnSync("makensis", ["-V2", "-INPUTCHARSET", "UTF8", path.join(work, "installer.nsi")], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...makensisTempEnvironment(cache) },
    });
    if (built.status !== 0) {
      rmSync(partial, { force: true });
      throw new Error(`makensis 失败（${built.signal ?? `exit ${built.status}`}）：${(built.stderr || built.stdout || "").slice(-2000)}`);
    }
    renameSync(partial, file);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const bases = readdirSync(dir).filter((name) => /^OctopusGuest-base-[0-9a-f]{16}\.exe$/.test(name))
    .map((name) => path.join(dir, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const old of bases.slice(KEEP_BASES)) rmSync(old, { force: true });
  return file;
}

async function nodeForWindows(cache: string, version: string): Promise<string> {
  const target = path.join(cache, "payload", `node-${version}`, "node.exe");
  if (existsSync(target)) return target;
  const name = `node-v${version}-win-x64.zip`;
  const sums = await (await fetchOk(`${NODE_MIRROR}/v${version}/SHASUMS256.txt`)).text();
  const expected = sums.split("\n").find((line) => line.trim().endsWith(` ${name}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`SHASUMS256 里没有 ${name}`);
  const zip = await download(`${NODE_MIRROR}/v${version}/${name}`, path.join(cache, "downloads", name), { sha256: expected });
  mkdirSync(path.dirname(target), { recursive: true });
  const extracted = spawnSync("unzip", ["-p", zip, `node-v${version}-win-x64/node.exe`], { maxBuffer: 512 * 1024 * 1024 });
  if (extracted.status !== 0 || !extracted.stdout?.length) throw new Error("解压 node.exe 失败（需要 unzip）");
  writeFileSync(`${target}.tmp`, extracted.stdout);
  renameSync(`${target}.tmp`, target);
  return target;
}

async function activeRunnerBundle(dashboardUrl: string, cache: string): Promise<{ file: string; sha: string }> {
  const sha = (await (await fetchOk(`${dashboardUrl}/install/runner.sha256`)).text()).trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("服务器没有返回有效的 Runner bundle 摘要");
  const file = path.join(cache, "payload", "runner", `${sha}.js`);
  if (existsSync(file) && await sha256File(file) === sha) return { file, sha };
  return { file: await download(`${dashboardUrl}/install/runner.js`, file, { sha256: sha }), sha };
}

async function download(url: string, file: string, expect: { sha256?: string; sha512?: string }): Promise<string> {
  const check = async (candidate: string): Promise<boolean> => {
    if (expect.sha256) return await sha256File(candidate) === expect.sha256;
    return await hashFile(candidate, "sha512") === expect.sha512;
  };
  if (existsSync(file) && await check(file)) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  const response = await fetchOk(url, 30 * 60_000);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
  if (!await check(partial)) {
    rmSync(partial, { force: true });
    throw new Error(`${path.basename(file)} 校验失败`);
  }
  renameSync(partial, file);
  return file;
}

async function fetchOk(url: string, timeoutMs = 60_000): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw new Error(`下载失败 ${url}: HTTP ${response.status}`);
  return response;
}

function sha256File(file: string): Promise<string> {
  return hashFile(file, "sha256");
}

async function hashFile(file: string, algorithm: "sha256" | "sha512"): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * makensis keeps the whole compressed data block in tmpfile(), which glibc
 * always places in /tmp; a small /tmp (a 1 GiB tmpfs here) makes it die with
 * SIGBUS on a ~250 MB installer. A tiny preload shim moves that file (and
 * makensis' own /tmp/ mkstemp templates) to a directory beside the cache.
 * Without a compiler, require enough /tmp instead of crashing midway.
 */
const NSIS_TMP_SHIM = `#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static const char *dir(void) { const char *d = getenv("NSIS_TMPDIR"); return d && *d ? d : NULL; }
FILE *tmpfile(void) {
  const char *d = dir();
  if (!d) { FILE *(*real)(void) = (FILE *(*)(void))dlsym(RTLD_NEXT, "tmpfile"); return real(); }
  char path[4096];
  snprintf(path, sizeof path, "%s/nsis-XXXXXX", d);
  int fd = mkstemp(path);
  if (fd < 0) return NULL;
  unlink(path);
  return fdopen(fd, "w+b");
}
FILE *tmpfile64(void) { return tmpfile(); }
int mkstemp(char *template) {
  int (*real)(char *) = (int (*)(char *))dlsym(RTLD_NEXT, "mkstemp");
  const char *d = dir();
  if (d && strncmp(template, "/tmp/", 5) == 0) {
    char path[4096];
    snprintf(path, sizeof path, "%s/%s", d, template + 5);
    if (strlen(path) < sizeof path - 1) { int fd = real(path); if (fd >= 0) strcpy(template, path); return fd; }
  }
  return real(template);
}
`;

function makensisTempEnvironment(cache: string): Record<string, string> {
  if (process.platform !== "linux") return {};
  const tools = path.join(cache, "tools");
  const tmp = path.join(cache, "tmp");
  mkdirSync(tools, { recursive: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(NSIS_TMP_SHIM).digest("hex").slice(0, 12);
  const shim = path.join(tools, `nsis-tmp-shim-${digest}.so`);
  if (!existsSync(shim)) {
    const source = path.join(tools, `nsis-tmp-shim-${digest}.c`);
    writeFileSync(source, NSIS_TMP_SHIM);
    const compiled = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", `${shim}.tmp`, source, "-ldl"], { encoding: "utf8" });
    if (compiled.status === 0) renameSync(`${shim}.tmp`, shim);
  }
  if (existsSync(shim)) return { LD_PRELOAD: shim, NSIS_TMPDIR: tmp };
  const free = spawnSync("df", ["--output=avail", "-B1", "/tmp"], { encoding: "utf8" }).stdout.trim().split("\n").at(-1);
  if (Number(free) < 2 * 1024 ** 3) {
    throw new Error("makensis 需要 /tmp 至少 2 GiB 空闲，或安装 C 编译器（cc）以便把它的临时文件移到缓存目录");
  }
  return {};
}

/** Hard-link from the cache when possible; the build directory is temporary. */
function place(source: string, target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  try { linkSync(source, target); } catch { copyFileSync(source, target); }
}

function nsisString(value: string): string {
  // NSIS: "$" and quotes are escaped with $; keep values to plain text.
  return value.replace(/\$/g, "$$$$").replace(/"/g, '$\\"');
}

/**
 * The base installer's script. Nothing device-specific: `guest-install` reads
 * the device's package from the exe's own trailer and marks which agents'
 * shortcuts to create (`app/agents/<agent>`).
 */
export function nsisScript(base: { owner: string }, outFile: string): string {
  const node = '"$INSTDIR\\app\\node\\node.exe"';
  // The Runner home's managed bundle, which the background service keeps
  // updated, so console fixes reach the guest without a reinstall.
  const launch = (agent: string) => `'"$INSTDIR\\home\\.octopus\\runner\\standalone.js" guest console --agent ${agent} --home "$INSTDIR\\home"'`;
  const icon = '"$SYSDIR\\cmd.exe" 0';
  const owner = nsisString(base.owner);
  return `Unicode true
ManifestDPIAware true
!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "Octopus 访客客户端"
Caption "Octopus 访客客户端"
OutFile "${nsisString(outFile)}"
InstallDir "$LOCALAPPDATA\\OctopusGuest"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
ShowInstDetails show
ShowUninstDetails show
BrandingText "Octopus"

!define MUI_WELCOMEPAGE_TITLE "安装 Octopus 访客客户端"
!define MUI_WELCOMEPAGE_TEXT "这个安装包是 ${owner} 为你准备的。$\\r$\\n$\\r$\\n安装后桌面上会出现「Claude（Octopus）」或「Codex（Octopus）」。双击打开的窗口里，是在 ${owner} 的服务器上运行的智能体，不需要你登录。它在服务器上的独立工作区里干活；窗口开着的时候，它也能在这台电脑上执行命令、收发文件，关掉窗口就碰不到这台电脑。$\\r$\\n$\\r$\\n同时会安装一个后台服务，让 ${owner} 在需要时远程协助操作这台电脑。卸载即可撤销。$\\r$\\n$\\r$\\n不需要管理员权限，也不需要另外安装任何软件。"
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "双击桌面上的图标开始使用。关掉窗口后，智能体在服务器上继续工作，再次双击就能回到原来的会话。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  DetailPrint "停止旧版本（如果有）……"
  nsExec::ExecToLog 'schtasks /End /TN "${GUEST_SERVICE_NAME}"'
  Pop $0
  Sleep 1500
  SetOutPath "$INSTDIR\\app"
  File /r "app\\*.*"
  DetailPrint "正在配置这台电脑……"
  nsExec::ExecToLog '"$INSTDIR\\app\\node\\node.exe" "$INSTDIR\\app\\runner\\standalone.js" guest-install --installer "$EXEPATH" --app "$INSTDIR\\app"'
  Pop $0
  \${If} $0 != 0
    MessageBox MB_ICONSTOP "配置没有完成（错误码 $0）。请把安装窗口里的信息截图发给 ${owner}。" /SD IDOK
    SetErrorLevel 2
    Abort
  \${EndIf}
  CreateDirectory "$SMPROGRAMS\\Octopus"
${["claude", "codex"].map((agent) => {
    const name = agent === "claude" ? "Claude（Octopus）.lnk" : "Codex（Octopus）.lnk";
    return `  \${If} \${FileExists} "$INSTDIR\\app\\agents\\${agent}"
    CreateShortCut "$DESKTOP\\${name}" ${node} ${launch(agent)} ${icon}
    CreateShortCut "$SMPROGRAMS\\Octopus\\${name}" ${node} ${launch(agent)} ${icon}
  \${Else}
    Delete "$DESKTOP\\${name}"
  \${EndIf}
`;
  }).join("")}  CreateShortCut "$SMPROGRAMS\\Octopus\\卸载 Octopus 访客客户端.lnk" "$INSTDIR\\uninstall.exe"
  WriteUninstaller "$INSTDIR\\uninstall.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OctopusGuest" "DisplayName" "Octopus 访客客户端"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OctopusGuest" "UninstallString" '"$INSTDIR\\uninstall.exe"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OctopusGuest" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OctopusGuest" "Publisher" "Octopus"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OctopusGuest" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OctopusGuest" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog '"$INSTDIR\\app\\node\\node.exe" "$INSTDIR\\app\\runner\\standalone.js" guest-uninstall --app "$INSTDIR\\app"'
  Pop $0
  Delete "$DESKTOP\\Claude（Octopus）.lnk"
  Delete "$DESKTOP\\Codex（Octopus）.lnk"
  RMDir /r "$SMPROGRAMS\\Octopus"
  ; The stopped task's host process can hold its exe for a moment.
  Sleep 2000
  RMDir /r "$INSTDIR"
  IfFileExists "$INSTDIR\\*.*" 0 +3
    Sleep 5000
    RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OctopusGuest"
SectionEnd
`;
}

function readmeText(base: { owner: string }): string {
  return [
    "Octopus 访客客户端",
    "",
    `由 ${base.owner} 的 Octopus 提供。这台电脑的设备名和可用的智能体见 guest.json。`,
    "",
    "使用：双击桌面图标。窗口里是在所有者的服务器上运行的智能体（模型用所有者的账号）。",
    "它在服务器上的独立工作区里干活；窗口开着时也能在这台电脑上执行命令、收发文件，关掉窗口就碰不到这台电脑。",
    "关掉窗口后智能体继续工作，再次双击回到原来的会话。",
    "后台服务 OctopusGuest 让所有者在需要时远程协助操作这台电脑。",
    "卸载：开始菜单 → Octopus → 卸载，或在“设置 → 应用”里卸载。",
    "",
  ].join("\r\n");
}
