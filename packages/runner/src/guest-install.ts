/**
 * Guest client installation on the guest's own Windows PC (2026-11-12; console since 2026-11-13).
 *
 * The installer extracts a self-contained app directory (Node and this Runner
 * bundle) and runs `standalone.js guest-install --installer <its own exe>`
 * with the bundled Node. The device's `guest.json` is not inside the NSIS
 * data: it is a trailer appended to the exe, so a cached base installer
 * becomes a new device's installer in a second (`guest-pack.ts`). This step:
 *
 * 0. Reads that trailer, keeps it as `app/guest.json`, and marks which
 *    agents' shortcuts the installer should create (`app/agents/<agent>`).
 * 1. Redeems the single-use enrollment baked into the package for this
 *    device's own Runner credential. A reinstall reuses a credential that still
 *    works, so a dead or expired installer can always upgrade in place.
 * 2. Installs an execution-only Runner whose scan home is the client's own
 *    directory, as task `OctopusGuest`, beside any ordinary Runner. It lets
 *    the owner help on this PC remotely.
 *
 * The desktop shortcuts open `guest console`, a window onto the agent that
 * runs on the owner's host (`guest-sessions.ts`). Neither the agents nor any
 * model credential are installed here. Nothing here can widen what the device
 * may do: the server-side guest profile decides that.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installManagedBundle,
  readInstalledConfig,
  RUNNER_GUEST_PROVIDERS,
  runnerInstallPaths,
  writeInstalledConfig,
  writeRunnerToken,
  type RunnerGuestProvider,
  type RunnerInstallConfig,
} from "./install-config.js";
import { installRunnerService, stopRunnerService, uninstallRunnerService } from "./service-manager.js";
import { addWorkspace, ensureDefaultWorkspace } from "./workspaces.js";

export const GUEST_PACKAGE_SCHEMA = "octopus-guest-package/v2";
export const GUEST_SERVICE_NAME = "OctopusGuest";

/** The baked, non-secret-but-single-use description of one guest installer. */
export interface GuestPackage {
  schema: typeof GUEST_PACKAGE_SCHEMA;
  owner: string;
  device: string;
  dashboard_url: string;
  runner_url: string;
  /** Single-use `re_` code; dead after the first successful install. */
  enrollment: string;
  expires_at: string;
  model_host: string;
  providers: RunnerGuestProvider[];
  created_at: string;
  versions: Record<string, string>;
}

/**
 * The trailer after a base installer: [guest.json][u32 LE length][magic].
 * NSIS checks only its own data, so the bytes after it are free.
 */
export const GUEST_TRAILER_MAGIC = Buffer.from("OCTOPUS-GUEST-V2", "ascii");
const MAX_TRAILER_BYTES = 64 * 1024;

export function guestTrailer(pkg: GuestPackage): Buffer {
  const json = Buffer.from(JSON.stringify(pkg), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length, 0);
  return Buffer.concat([json, length, GUEST_TRAILER_MAGIC]);
}

/** The guest package appended to an installer, as JSON text. */
export function readGuestTrailer(installer: string): string {
  const fd = openSync(installer, "r");
  try {
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(4 + GUEST_TRAILER_MAGIC.length);
    if (size < tail.length || readSync(fd, tail, 0, tail.length, size - tail.length) !== tail.length
      || !tail.subarray(4).equals(GUEST_TRAILER_MAGIC)) {
      throw new Error("安装包里没有这台电脑的配置；请联系发给你安装包的人重新生成");
    }
    const length = tail.readUInt32LE(0);
    if (length > MAX_TRAILER_BYTES || length > size - tail.length) throw new Error("安装包里的配置无效");
    const json = Buffer.alloc(length);
    readSync(fd, json, 0, length, size - tail.length - length);
    return json.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function readGuestPackage(file: string): GuestPackage {
  return parseGuestPackage(readFileSync(file, "utf8"));
}

export function parseGuestPackage(json: string): GuestPackage {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  const text = (key: string): string => typeof raw[key] === "string" ? raw[key] as string : "";
  if (raw.schema !== GUEST_PACKAGE_SCHEMA || !text("device") || !/^https?:\/\//.test(text("dashboard_url"))
    || !/^wss?:\/\//.test(text("runner_url")) || !/^re_[0-9a-f]{48}$/.test(text("enrollment"))
    || !providers.length
    || providers.some((provider) => !(RUNNER_GUEST_PROVIDERS as readonly unknown[]).includes(provider))) {
    throw new Error("安装包里的 guest.json 无效");
  }
  return {
    schema: GUEST_PACKAGE_SCHEMA,
    owner: text("owner"),
    device: text("device"),
    dashboard_url: text("dashboard_url").replace(/\/$/, ""),
    runner_url: text("runner_url"),
    enrollment: text("enrollment"),
    expires_at: text("expires_at"),
    model_host: text("model_host"),
    providers: [...new Set(providers as RunnerGuestProvider[])],
    created_at: text("created_at"),
    versions: raw.versions && typeof raw.versions === "object" ? raw.versions as Record<string, string> : {},
  };
}

/**
 * Layout under the install directory chosen by the installer:
 * `app/` (read-only payload) and `home/` (Runner scan home).
 */
export function guestLayout(appDir: string) {
  const root = path.dirname(path.resolve(appDir));
  return { root, app: path.resolve(appDir), home: path.join(root, "home") };
}

export interface GuestInstallDeps {
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Tests skip the OS service. */
  installService?: (scanHome: string) => void;
  now?: () => Date;
}

/** Install from the installer's own trailer. */
export async function installGuestFromInstaller(installer: string, appDir: string, deps: GuestInstallDeps = {}): Promise<{ device: string; online: boolean }> {
  return await installGuest(unpackGuestTrailer(installer, appDir), deps);
}

/**
 * Keep the trailer as `app/guest.json` and mark the agents whose shortcuts
 * the installer creates (`app/agents/claude`, `app/agents/codex`).
 */
export function unpackGuestTrailer(installer: string, appDir: string): string {
  const pkg = parseGuestPackage(readGuestTrailer(installer));
  const packageFile = path.join(appDir, "guest.json");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + "\n");
  const agents = path.join(appDir, "agents");
  rmSync(agents, { recursive: true, force: true });
  mkdirSync(agents, { recursive: true });
  for (const provider of pkg.providers) writeFileSync(path.join(agents, provider === "anthropic" ? "claude" : "codex"), "");
  return packageFile;
}

export async function installGuest(packageFile: string, deps: GuestInstallDeps = {}): Promise<{ device: string; online: boolean }> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const http = deps.fetch ?? fetch;
  const pkg = readGuestPackage(packageFile);
  const layout = guestLayout(path.dirname(packageFile));
  mkdirSync(layout.home, { recursive: true });

  // 1. Credential: keep a working one, otherwise spend the enrollment.
  const paths = runnerInstallPaths(layout.home);
  let token = existsSync(paths.token) ? readFileSync(paths.token, "utf8").trim() : "";
  let reused = false;
  if (token && existsSync(paths.config)) {
    try {
      const current = readInstalledConfig(layout.home);
      reused = current.device === pkg.device && await tokenWorks(http, pkg.dashboard_url, token, pkg.device);
      if (current.device !== pkg.device) {
        // An installer for another device name replaces this one: retire the
        // old device instead of leaving it registered and unreachable.
        await http(`${current.dashboard_url}/api/runner-self-revoke`, {
          method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
      }
    } catch { reused = false; }
  }
  if (!reused) {
    log("正在登记这台电脑……");
    token = await redeem(http, pkg);
  } else {
    log("沿用已登记的这台电脑");
  }

  // 2. Runner: execution-only, its own scan home and task.
  const gitBash = findGitBash();
  const config: RunnerInstallConfig = {
    version: 1,
    dashboard_url: pkg.dashboard_url,
    runner_url: pkg.runner_url,
    device: pkg.device,
    scan_home: layout.home,
    // Unused by an execution-only Runner, but part of every config.
    codex_home: path.join(layout.home, ".codex"),
    execution_only: true,
    ...(gitBash ? { execution_shell: gitBash } : {}),
    installed_at: (deps.now?.() ?? new Date()).toISOString(),
    service_name: GUEST_SERVICE_NAME,
    guest: { providers: pkg.providers },
  };
  // Stop a previous instance first so the bundle file is not in use.
  try { stopRunnerService(layout.home); } catch { /* first install */ }
  writeInstalledConfig(config);
  writeRunnerToken(layout.home, token);
  await ensureDefaultWorkspace(layout.home);
  // The owner's helpers (with the guest's consent, by installing) can browse
  // the user's own folders; registration is idempotent.
  await addWorkspace(layout.home, os.homedir(), "用户目录").catch((error) => {
    log(`未能登记用户目录（不影响使用）：${error instanceof Error ? error.message : String(error)}`);
  });
  installManagedBundle(layout.home, process.argv[1]);
  (deps.installService ?? installRunnerService)(layout.home);

  log("正在等待连接 Octopus……");
  const online = await waitOnline(http, pkg.dashboard_url, token, pkg.device);
  log(online ? `已连接：${pkg.device}` : "后台服务已启动，但暂时还没连上 Octopus；稍后会自动重试。");
  return { device: pkg.device, online };
}

/** Called by the uninstaller: stop the task and revoke this device's credential. */
export async function uninstallGuest(appDir: string, deps: Pick<GuestInstallDeps, "fetch" | "log"> = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const http = deps.fetch ?? fetch;
  const layout = guestLayout(appDir);
  try { uninstallRunnerService(layout.home); } catch (error) {
    log(`停止后台服务失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const paths = runnerInstallPaths(layout.home);
  if (!existsSync(paths.token) || !existsSync(paths.config)) return;
  const token = readFileSync(paths.token, "utf8").trim();
  const config = readInstalledConfig(layout.home);
  const response = await http(`${config.dashboard_url}/api/runner-self-revoke`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  log(response?.ok ? "已在服务器上注销这台电脑" : "服务器暂时无法注销这台电脑；请联系管理员在 Dashboard 删除它");
}

async function redeem(http: typeof fetch, pkg: GuestPackage): Promise<string> {
  let response: Response;
  try {
    response = await http(`${pkg.dashboard_url}/api/runner-enrollment/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pkg.enrollment }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`连不上 Octopus 服务器（${pkg.dashboard_url}）：${error instanceof Error ? error.message : String(error)}。请检查网络后重新运行安装包。`);
  }
  if (response.status === 404) {
    throw new Error("这个安装包已经用过或已过期。请联系发给你安装包的人重新生成一个。");
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof body.token !== "string") {
    throw new Error(`登记失败（HTTP ${response.status}）：${String(body.error ?? "未知错误")}`);
  }
  if (body.device !== pkg.device) throw new Error("服务器返回的设备名与安装包不一致");
  return body.token;
}

async function tokenWorks(http: typeof fetch, dashboardUrl: string, token: string, device: string): Promise<boolean> {
  try {
    const response = await http(`${dashboardUrl}/api/runner-self-status`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.device === device;
  } catch {
    return false;
  }
}

async function waitOnline(http: typeof fetch, dashboardUrl: string, token: string, device: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await http(`${dashboardUrl}/api/runner-self-status`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.ok && body.device === device && body.online === true) return true;
    } catch { /* keep waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

/** Git for Windows' bash, when the guest happens to have it; cmd.exe otherwise. */
function findGitBash(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate));
}
