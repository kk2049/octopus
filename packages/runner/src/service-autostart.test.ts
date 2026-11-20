import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runnerAutostartStatus } from "./service-autostart.js";
import { runnerServiceFiles, RUNNER_SERVICE_LABEL } from "./service-manager.js";
import { WINDOWS_RESIDENT_HOST_NAME } from "./windows-resident-host.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
describe("OS autostart diagnosis", () => {
  it.each(["yes", "no"])("distinguishes Linux boot from login using actual linger=%s", (linger) => {
    const status = runnerAutostartStatus("/home/test", "linux", (command, args) => ({
      status: 0, stdout: command === "loginctl" ? linger : args.includes("is-enabled") ? "enabled\n" : "on-failure\n",
    }));
    expect(status).toMatchObject({ enabled: true, restart: true, trigger: linger === "yes" ? "boot" : "login" });
  });
  it("does not claim autostart or restart when the system manager cannot confirm them", () => {
    expect(runnerAutostartStatus("/home/test", "linux", () => ({ status: 1, stdout: "" })))
      .toMatchObject({ enabled: false, restart: false, trigger: "login" });
  });
  it("checks macOS launchd enablement as well as RunAtLoad and KeepAlive", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "runner-launchd-test-")); homes.push(home);
    const files = runnerServiceFiles(home, "darwin");
    mkdirSync(path.dirname(files.definitionPath), { recursive: true });
    writeFileSync(files.definitionPath, files.definition);
    expect(runnerAutostartStatus(home, "darwin", () => ({ status: 0, stdout: "{}" })))
      .toMatchObject({ enabled: true, restart: true, trigger: "login" });
    expect(runnerAutostartStatus(home, "darwin", () => ({ status: 0, stdout: '"' + RUNNER_SERVICE_LABEL + '" => true' })))
      .toMatchObject({ enabled: false, restart: true, trigger: "login" });
  });
  it("checks Windows login trigger and GUI action instead of accepting WindowStyle Hidden", () => {
    const query = (host: string) => () => ({ status: 0, stdout: JSON.stringify({ enabled: true, restart: 999, host }) });
    expect(runnerAutostartStatus("C:\\Users\\test", "win32", query(WINDOWS_RESIDENT_HOST_NAME)))
      .toMatchObject({ enabled: true, restart: true, trigger: "login" });
    expect(runnerAutostartStatus("C:\\Users\\test", "win32", query("powershell.exe")))
      .toMatchObject({ enabled: true, restart: false });
  });
});
