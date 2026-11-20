import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execTempDir, fakeExecutables } from "./fake-executables.mjs";

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function withEnv(patch) {
  const prior = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, patch);
  delete process.env.OCTOPUS_TEST_EXEC_TMPDIR;
  cleanup.push(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

describe("hermetic fake executables", () => {
  it("runs only the fakes: no real agent CLI is reachable from the pinned PATH or HOME", () => {
    const fake = fakeExecutables({ claude: "#!/bin/sh\necho fake-claude \"$@\"\n", codex: "#!/usr/bin/env node\nconsole.log('fake-codex ' + process.version)\n" });
    cleanup.push(() => fake.cleanup());
    expect(spawnSync("claude", ["-p", "x"], { env: fake.env, encoding: "utf8" }).stdout).toBe("fake-claude -p x\n");
    expect(spawnSync("codex", [], { env: fake.env, encoding: "utf8" }).stdout).toBe(`fake-codex ${process.version}\n`);
    for (const directory of fake.path.split(path.delimiter).filter((entry) => entry !== fake.bin)) {
      for (const name of ["claude", "codex", "omp"]) expect(existsSync(path.join(directory, name)), `${directory}/${name}`).toBe(false);
    }
    expect(fake.env.HOME).toBe(fake.home);
    // An absent fake is "not found", never a fallback to the operator's install.
    expect(spawnSync("omp", ["--version"], { env: fake.env }).error).toMatchObject({ code: "ENOENT" });
  });

  it("pins and restores process.env for code that spawns by name", () => {
    const before = { PATH: process.env.PATH, HOME: process.env.HOME };
    const fake = fakeExecutables({ codex: "#!/bin/sh\necho pinned\n" });
    cleanup.push(() => fake.cleanup());
    const restore = fake.apply();
    expect(execFileSync("codex", { encoding: "utf8" })).toBe("pinned\n");
    expect(process.env.HOME).toBe(fake.home);
    restore();
    expect({ PATH: process.env.PATH, HOME: process.env.HOME }).toEqual(before);
  });

  it("refuses a system directory that holds a real agent CLI", () => {
    const system = mkdtempSync(path.join(tmpdir(), "fake-system-"));
    cleanup.push(() => rmSync(system, { recursive: true, force: true }));
    writeFileSync(path.join(system, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    expect(() => fakeExecutables({}, { systemPath: [system] })).toThrow(/real codex/);
  });

  it("moves off an unusable TMPDIR and fails loudly when nothing can execute", () => {
    const fallbackHome = mkdtempSync(path.join(execTempDir(), "fake-home-"));
    cleanup.push(() => rmSync(fallbackHome, { recursive: true, force: true }));
    // A path below a regular file can never hold an executable fixture.
    const unusable = path.join(fallbackHome, "regular-file");
    writeFileSync(unusable, "");
    withEnv({ TMPDIR: path.join(unusable, "tmp"), HOME: fallbackHome });
    const chosen = execTempDir();
    expect(chosen).toBe(path.join(fallbackHome, ".cache", "octopus-test-tmp"));
    const script = path.join(mkdtempSync(path.join(chosen, "probe-")), "run");
    writeFileSync(script, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    expect(execFileSync(script, { encoding: "utf8" })).toBe("ok\n");
    withEnv({ HOME: path.join(unusable, "home") });
    expect(() => execTempDir()).toThrow(/No exec-capable temporary directory/);
  });
});
