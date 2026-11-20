import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runnerServiceFiles } from "./service-manager.js";

// Real Windows Task Scheduler acceptance. Uses a uniquely named temporary
// task and fake daemon; it never touches an installed OctopusRunner task.
describe.skipIf(process.platform !== "win32")("Windows resident task lifecycle", () => {
  it("runs hidden, migrates without changing identity, restarts crashes, and obeys stop", () => {
    const definition = runnerServiceFiles("C:\\Users\\octopus-test-placeholder", "win32").definition;
    const harness = readFileSync(new URL("./fixtures/windows-residency.ps1", import.meta.url), "utf8")
      .replace("__SERVICE_DEFINITION_BASE64__", Buffer.from(definition).toString("base64"));
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(harness, "utf16le").toString("base64")], { encoding: "utf8", timeout: 80_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`).toBe(0);
    expect(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!)).toMatchObject({
      Installed: true, Migrated: true, Hidden: true, CrashRecovered: true,
      Starts: 4, LegacyProcessRemoved: true, RemoteRestartRecovered: true, ExplicitStopRemovedChildren: true, RunLevel: "Limited",
    });
  }, 85_000);
});
