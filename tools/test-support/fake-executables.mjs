// Hermetic fake executables for tests.
//
// A fake `claude`/`codex` written under a noexec /tmp cannot run, and a PATH
// that still ends with the real one then silently starts the real CLI: real
// subscription calls and false failures (review B18). Fakes made here live in
// a directory proven to execute, and the environment they come with reaches no
// real agent CLI: PATH is the fake bin, this test runner's own `node`, and the
// system directories after checking that none of them holds a real agent CLI;
// HOME is an empty private directory. Anything that cannot be proven fails
// loudly instead of falling through.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const AGENT_CLIS = ["claude", "codex", "omp"];
const SYSTEM_PATH = ["/usr/bin", "/bin"];
const FALLBACK = () => path.join(homedir(), ".cache", "octopus-test-tmp");

function canExecute(dir) {
  let probe;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    probe = mkdtempSync(path.join(dir, "exec-probe-"));
    const script = path.join(probe, "probe");
    writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    return spawnSync(script, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

/** A temporary base directory whose files can be executed, or a loud failure. */
export function execTempDir() {
  const proven = process.env.OCTOPUS_TEST_EXEC_TMPDIR;
  if (proven && proven === tmpdir()) return proven;
  for (const candidate of [tmpdir(), FALLBACK()]) {
    if (canExecute(candidate)) {
      process.env.OCTOPUS_TEST_EXEC_TMPDIR = candidate;
      return candidate;
    }
  }
  throw new Error(`No exec-capable temporary directory: ${tmpdir()} and ${FALLBACK()} cannot run scripts `
    + "(noexec mount?). Set TMPDIR to a directory on an exec-capable filesystem; tests must not fall through to real CLIs.");
}

/**
 * Point TMPDIR (inherited by child processes) at an exec-capable directory.
 * Used by the Node test project's setup file.
 */
export function ensureExecTmpdir() {
  const dir = execTempDir();
  if (tmpdir() !== dir) {
    process.env.TMPDIR = dir;
    process.env.OCTOPUS_TEST_EXEC_TMPDIR = dir;
  }
  return dir;
}

/**
 * Write executables into a fresh exec-capable directory and return an
 * environment in which only these fakes (never a real agent CLI) are found.
 */
export function fakeExecutables(files = {}, options = {}) {
  const dir = mkdtempSync(path.join(execTempDir(), options.prefix ?? "fake-cli-"));
  const bin = path.join(dir, "bin"), runtime = path.join(dir, "runtime");
  const home = options.home ?? path.join(dir, "home");
  for (const target of [bin, runtime, home]) mkdirSync(target, { recursive: true, mode: 0o700 });
  // `#!/usr/bin/env node` fakes run on this test runner's Node, not whichever
  // directory happens to share a real CLI with it.
  symlinkSync(process.execPath, path.join(runtime, "node"));
  const system = options.systemPath ?? SYSTEM_PATH;
  for (const directory of system) {
    for (const name of AGENT_CLIS) {
      if (existsSync(path.join(directory, name))) {
        throw new Error(`A real ${name} at ${path.join(directory, name)} would be reachable from a test PATH; `
          + "pass a systemPath without it.");
      }
    }
  }
  const write = (name, body) => {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid fake executable name: ${name}`);
    const file = path.join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
    return file;
  };
  for (const [name, body] of Object.entries(files)) write(name, body);
  const searchPath = [bin, ...(options.extraPath ?? []), runtime, ...system].join(path.delimiter);
  const env = { ...process.env, PATH: searchPath, HOME: home };
  let restore = null;
  return {
    dir, bin, home, path: searchPath, env, write,
    /** Pin process.env PATH/HOME for code under test that spawns by name. */
    apply() {
      if (!restore) {
        const prior = { PATH: process.env.PATH, HOME: process.env.HOME };
        process.env.PATH = searchPath; process.env.HOME = home;
        restore = () => {
          for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
          }
          restore = null;
        };
      }
      return restore;
    },
    cleanup() {
      restore?.();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
