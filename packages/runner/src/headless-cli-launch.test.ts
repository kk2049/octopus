import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHeadlessCapture, spawnHeadlessCli } from "./headless-cli-launch.js";

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("detached headless CLI ownership", () => {
  it("gives Runner no provider output pipe while a detached drainer captures startup evidence", async () => {
    const home = mkdtempSync(join(tmpdir(), "headless-cli-"));
    dirs.push(home);
    const finished = join(home, "provider-finished");
    const launched = await spawnHeadlessCli(home, home, "op_headless_test", {
      bin: "sh",
      args: [
        "-c",
        "printf '%s\\n' \"$1\"; sleep 0.1; printf 'late output\\n'; : > \"$2\"",
        "provider-cli",
        "literal $() `ticks`",
        finished,
      ],
    });
    const exited = new Promise<void>((resolve) => launched.child.once("exit", () => resolve()));

    expect(launched.child.stdout).toBeNull();
    expect(launched.child.stderr).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await readHeadlessCapture(launched.outputFile)).toContain("literal $() `ticks`");
    // Simulate Runner dropping all startup evidence while the provider keeps
    // working. The detached drainer must keep consuming later output.
    await launched.cleanup();
    await exited;
    expect(existsSync(finished)).toBe(true);
    expect(await readHeadlessCapture(launched.outputFile)).toBe("");
  });

  it("captures output without an external awk dependency", async () => {
    const home = mkdtempSync(join(tmpdir(), "headless-cli-builtins-"));
    dirs.push(home);
    const bin = join(home, "bin");
    mkdirSync(bin);
    symlinkSync("/bin/bash", join(bin, "bash"));
    const originalPath = process.env.PATH;
    const launched = await (async () => {
      process.env.PATH = bin;
      try {
        return await spawnHeadlessCli(home, home, "op_headless_builtins", {
          bin: "/bin/sh",
          args: ["-c", "printf 'captured without awk\\n'"],
        });
      } finally {
        process.env.PATH = originalPath;
      }
    })();
    await new Promise<void>((resolve) => launched.child.once("exit", () => resolve()));

    expect(await readHeadlessCapture(launched.outputFile)).toBe("captured without awk");
    await launched.cleanup();
  });
});
