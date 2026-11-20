import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { executablePath, trustedExecutablePath, readTrustGrant } from "./agent-executable-policy.js";

vi.mock("node:fs", () => ({ realpathSync: vi.fn(), statSync: vi.fn() }));
const entries = new Map<string, Stats>();
function entry(file: string, mode: number, uid = 501, gid = 80, directory = true) {
  entries.set(file, { mode, uid, gid, isDirectory: () => directory, isFile: () => !directory } as Stats);
}
function brew(prefix: string) {
  const file = `${prefix}/bin/codex`;
  for (let dir = path.dirname(file);; dir = path.dirname(dir)) {
    entry(dir, dir === prefix || dir.startsWith(prefix + "/") ? 0o775 : 0o755,
      dir === prefix || dir.startsWith(prefix + "/") ? 501 : 0);
    if (dir === "/") break;
  }
  entry(file, 0o755, 501, 80, false);
  return file;
}
beforeEach(() => {
  entries.clear();
  vi.spyOn(process, "getuid").mockReturnValue(501);
  vi.mocked(realpathSync).mockImplementation((file) => String(file));
  vi.mocked(statSync).mockImplementation((file) => {
    const found = entries.get(String(file));
    if (!found) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return found;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Homebrew directory compatibility without weakening private storage", () => {
  it.each([
    ["claude", "/opt/homebrew/Caskroom/claude-code/2.1.236/claude", 20],
    ["codex", "/opt/homebrew/Caskroom/codex/0.153.4/bin/codex", 80],
  ])("accepts ticket #543's actual %s Caskroom layout including both 0775 ancestors", (provider, target, fileGroup) => {
    brew("/opt/homebrew");
    const file = `/opt/homebrew/bin/${provider}`;
    entry(file, 0o755, 501, Number(fileGroup), false);
    for (let dir = path.dirname(String(target)); dir !== "/opt/homebrew"; dir = path.dirname(dir)) entry(dir, dir === "/opt/homebrew/Caskroom" ? 0o775 : 0o755);
    entry("/opt/homebrew", 0o755);
    entry(String(target), 0o755, 501, Number(fileGroup), false);
    vi.mocked(realpathSync).mockImplementation((value) => String(value) === file ? String(target) : String(value));
    expect(executablePath(file, "entry", { platform: "darwin" })).toBe(target);
    expect(() => trustedExecutablePath(file)).toThrow("unsafe_permissions");
  });
  it.each(["/opt/homebrew", "/usr/local"])("accepts current-user admin-group directories in %s", (prefix) => {
    const file = brew(prefix);
    expect(executablePath(file, "entry", { platform: "darwin" })).toBe(file);
    expect(() => trustedExecutablePath(file)).toThrow("unsafe_permissions");
  });
  it.each([
    ["/opt/homebrew/bin", 0o777, 501, 80, true],
    ["/opt/homebrew/bin", 0o775, 501, 20, true],
    ["/opt/homebrew/bin", 0o775, 502, 80, true],
    ["/opt", 0o775, 0, 80, true],
    ["/opt/homebrew/bin/codex", 0o775, 501, 80, false],
  ] as const)("rejects unsafe component %s mode=%s uid=%s gid=%s", (component, mode, uid, gid, directory) => {
    const file = brew("/opt/homebrew"); entry(component, mode, uid, gid, directory);
    expect(() => executablePath(file, "entry", { platform: "darwin" })).toThrow("unsafe_permissions");
    try { executablePath(file, "entry", { platform: "darwin" }); }
    catch (error) { expect(error).toMatchObject({ detail: { path: component, uid, gid, mode: mode.toString(8).padStart(4, "0") } }); }
  });
  it("does not apply the admin exception to Linux or a similarly named prefix", () => {
    const file = brew("/opt/homebrew");
    expect(() => executablePath(file, "entry", { platform: "linux" })).toThrow("unsafe_permissions");
    const lookalike = brew("/opt/homebrew-untrusted");
    expect(() => executablePath(lookalike, "entry", { platform: "darwin" })).toThrow("unsafe_permissions");
  });
  it("checks the real target and interpreter paths, including outside-prefix parents", () => {
    const file = brew("/opt/homebrew");
    const target = "/shared/codex";
    entry("/shared", 0o775); entry(target, 0o755, 501, 80, false);
    vi.mocked(realpathSync).mockImplementation((value) => String(value) === file ? target : String(value));
    expect(() => executablePath(file, "entry", { platform: "darwin" })).toThrow("unsafe_permissions");
    expect(() => executablePath(target, "interpreter", { platform: "darwin" })).toThrow("unsafe_permissions");
  });
  it("local trust records exact path/owner/group/write bits, never a global bypass", () => {
    const file = brew("/shared");
    const capture: NonNullable<Parameters<typeof executablePath>[2]["capture"]> = [];
    expect(executablePath(file, "entry", { platform: "linux", capture })).toBe(file);
    const trust = readTrustGrant({ version: 1, paths: capture });
    expect(executablePath(file, "entry", { platform: "linux", trust })).toBe(file);
    entry("/shared/bin", 0o775, 502);
    expect(() => executablePath(file, "entry", { platform: "linux", trust })).toThrow("unsafe_permissions");
    entry("/shared/bin", 0o777);
    expect(() => executablePath(file, "entry", { platform: "linux", capture: [] })).toThrow("unsafe_permissions");
  });
});
