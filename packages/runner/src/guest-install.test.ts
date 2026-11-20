import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guestLayout, guestTrailer, readGuestPackage, readGuestTrailer, unpackGuestTrailer, type GuestPackage } from "./guest-install.js";
import { nsisScript } from "./guest-pack.js";
import { readGuestConfig, readGuestSessionsConfig, readModelEgressConfig } from "./install-config.js";
import { runnerServiceFiles } from "./service-manager.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "guest-install-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function pkg(overrides: Partial<GuestPackage> = {}): GuestPackage {
  return {
    schema: "octopus-guest-package/v2",
    owner: "alice",
    device: "friend-pc",
    dashboard_url: "https://octopus.example:444",
    runner_url: "wss://octopus.example:444/octopus-runner/v1",
    enrollment: `re_${"a".repeat(48)}`,
    expires_at: "2026-11-19T00:00:00.000Z",
    model_host: "host",
    providers: ["anthropic", "openai"],
    created_at: "2026-11-12T00:00:00.000Z",
    versions: { node: "22.23.5" },
    ...overrides,
  };
}

describe("guest package", () => {
  it("round-trips a package and refuses anything that is not a single-use enrollment", () => {
    const file = path.join(dir, "guest.json");
    writeFileSync(file, JSON.stringify(pkg()));
    expect(readGuestPackage(file)).toMatchObject({ device: "friend-pc", providers: ["anthropic", "openai"] });
    writeFileSync(file, JSON.stringify(pkg({ providers: ["anthropic"] })));
    expect(readGuestPackage(file).providers).toEqual(["anthropic"]);
    writeFileSync(file, JSON.stringify({ ...pkg(), enrollment: "rt_real_token" }));
    expect(() => readGuestPackage(file)).toThrow();
    // An installer from the model-on-the-PC design must not half-install.
    writeFileSync(file, JSON.stringify({ ...pkg(), schema: "octopus-guest-package/v1" }));
    expect(() => readGuestPackage(file)).toThrow(/guest.json/);
  });

  it("rides as a trailer after the installer and unpacks into the app directory", () => {
    const exe = path.join(dir, "setup.exe");
    // Stand-in for the NSIS data; its last bytes may look like anything.
    writeFileSync(exe, Buffer.concat([Buffer.from("MZ installer bytes OCTOPUS-GUEST"), guestTrailer(pkg({ providers: ["openai"] }))]));
    expect(JSON.parse(readGuestTrailer(exe))).toMatchObject({ device: "friend-pc", providers: ["openai"] });
    const app = path.join(dir, "app");
    writeFileSync(path.join(dir, "stale"), "");
    const packageFile = unpackGuestTrailer(exe, app);
    expect(readGuestPackage(packageFile)).toMatchObject({ device: "friend-pc", enrollment: `re_${"a".repeat(48)}` });
    expect(existsSync(path.join(app, "agents", "codex"))).toBe(true);
    expect(existsSync(path.join(app, "agents", "claude"))).toBe(false);
    // A reinstall with other agents replaces the markers.
    writeFileSync(exe, Buffer.concat([readFileSync(exe).subarray(0, 32), guestTrailer(pkg({ providers: ["anthropic"] }))]));
    unpackGuestTrailer(exe, app);
    expect(existsSync(path.join(app, "agents", "claude"))).toBe(true);
    expect(existsSync(path.join(app, "agents", "codex"))).toBe(false);
    // An installer without a trailer is refused with a message for the guest.
    writeFileSync(exe, "MZ only");
    expect(() => readGuestTrailer(exe)).toThrow(/重新生成/);
  });

  it("keeps the install to the app and the Runner home", () => {
    expect(guestLayout(path.join(dir, "app"))).toEqual({ root: dir, app: path.join(dir, "app"), home: path.join(dir, "home") });
  });
});

describe("guest installer artifacts", () => {
  it("builds one device-independent base that installs from its own trailer", () => {
    const base = nsisScript({ owner: "alice" }, "/out/base.exe");
    expect(base).toContain("RequestExecutionLevel user");
    expect(base).toContain('InstallDir "$LOCALAPPDATA\\OctopusGuest"');
    expect(base).toContain('guest-install --installer "$EXEPATH" --app "$INSTDIR\\app"');
    expect(base).toContain('schtasks /End /TN "OctopusGuest"');
    // Shortcuts follow the agents the device's package grants.
    expect(base).toContain('${If} ${FileExists} "$INSTDIR\\app\\agents\\claude"');
    expect(base).toContain('${If} ${FileExists} "$INSTDIR\\app\\agents\\codex"');
    expect(base).toContain('CreateShortCut "$DESKTOP\\Claude（Octopus）.lnk" "$INSTDIR\\app\\node\\node.exe" \'"$INSTDIR\\home\\.octopus\\runner\\standalone.js" guest console --agent claude --home "$INSTDIR\\home"\'');
    // No device and no enrollment in the base; no agent or model credential at all.
    expect(base).not.toContain("friend-pc");
    expect(base).not.toMatch(/re_[0-9a-f]{8}|claude\.exe|codex\.exe|launch\.ps1/);
    expect(nsisScript({ owner: 'evil"$name' }, "/o.exe")).toContain('evil$\\"$$name');
  });

  it("names the Windows task and scan home of a guest install", () => {
    const home = "C:\\Users\\friend\\AppData\\Local\\OctopusGuest\\home";
    const guest = runnerServiceFiles(home, "win32", "C:\\app\\node\\node.exe", "OctopusGuest").definition;
    expect(guest).toContain("$TaskName = 'OctopusGuest'");
    expect(guest).toContain(`$env:RUNNER_SCAN_HOME = '${home}'`);
    expect(runnerServiceFiles("C:\\Users\\a", "win32", "C:\\node.exe").definition).toContain("$TaskName = 'OctopusRunner'");
  });

  it("validates guest, egress and guest-session configuration", () => {
    expect(readGuestConfig({ providers: ["anthropic", "openai"] })).toEqual({ providers: ["anthropic", "openai"] });
    // Ports from the earlier design are ignored, not fatal.
    expect(readGuestConfig({ local_port: 47821, providers: ["openai"] })).toEqual({ providers: ["openai"] });
    expect(() => readGuestConfig({ providers: ["gemini"] })).toThrow();
    expect(() => readGuestConfig({ providers: [] })).toThrow();
    expect(readModelEgressConfig({ anthropic: { config_dir: "/home/u/.claude" } })).toEqual({ anthropic: { config_dir: "/home/u/.claude" } });
    expect(() => readModelEgressConfig({ openai: { codex_home: "relative" } })).toThrow();
    expect(() => readModelEgressConfig({})).toThrow();
    expect(readGuestSessionsConfig({ root: "/srv/guests/", port: 47830, launch_prefix: ["memguard", "--rss-gib", "8", "--"], env: { PIP_INDEX_URL: "https://mirror/simple/" } }))
      .toEqual({ root: "/srv/guests", port: 47830, launch_prefix: ["memguard", "--rss-gib", "8", "--"], env: { PIP_INDEX_URL: "https://mirror/simple/" } });
    expect(() => readGuestSessionsConfig({ root: "relative", port: 47830 })).toThrow();
    expect(() => readGuestSessionsConfig({ root: "/srv/guests", port: 80 })).toThrow();
    expect(() => readGuestSessionsConfig({ root: "/srv/guests", port: 47830, launch_prefix: "memguard" })).toThrow();
    expect(() => readGuestSessionsConfig({ root: "/srv/guests", port: 47830, env: { "lower": "x" } })).toThrow();
  });
});
