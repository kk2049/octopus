import { agentCommand, isExecutableProvider } from "./agent-executables.js";
/**
 * Detached provider CLI ownership for machines without tmux.
 *
 * A plain `detached: true` child with stdout/stderr pipes is not independent:
 * replacing Runner closes the read ends and a later provider write may die on
 * EPIPE.  This tiny detached bash owns and drains both pipes instead.  Runner
 * reads only bounded, private startup captures and may unlink them as soon as
 * it has enough evidence; the drainer keeps its already-open file descriptors
 * and the provider keeps running.
 */

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const CAPTURE_BYTES = 256 * 1024;

const WRAPPER = `
capture() {
  local target=$1
  local written=0
  local line chunk remaining
  # Keep one descriptor open for the lifetime of the drainer. Runner may
  # unlink the name later; writes continue through this fd and never recreate
  # a path with ambient umask permissions.
  exec 3>>"$target"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if (( written >= ${CAPTURE_BYTES} )); then
      continue
    fi
    chunk="\${line}"$'\\n'
    remaining=$((${CAPTURE_BYTES} - written))
    if (( \${#chunk} > remaining )); then
      printf '%s' "\${chunk:0:remaining}" >&3
      written=${CAPTURE_BYTES}
    else
      printf '%s' "$chunk" >&3
      written=$((written + \${#chunk}))
    fi
  done
  exec 3>&-
}
export LC_ALL=C
output=$1
errors=$2
exit_file=$3
shift 3
"$@" > >(capture "$output") 2> >(capture "$errors")
status=$?
wait
printf '%s\\n' "$status" > "$exit_file"
exit "$status"
`.trim();

export interface HeadlessCliProcess {
  child: ChildProcess;
  outputFile: string;
  errorFile: string;
  exitFile: string;
  cleanup(): Promise<void>;
}

export async function spawnHeadlessCli(
  home: string,
  cwd: string,
  requestId: string,
  command: { bin: string; args: string[] },
  env?: NodeJS.ProcessEnv,
): Promise<HeadlessCliProcess> {
  if (isExecutableProvider(command.bin)) {
    const selected = agentCommand(command.bin, command.args, env);
    command = selected;
    env = selected.env;
  }
  const directory = path.join(path.resolve(home), ".octopus-runner", "launch-captures");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await cleanupOldCaptures(directory);
  const { outputFile, errorFile, exitFile } = headlessCapturePaths(home, requestId);
  const cleanup = async (): Promise<void> => {
    await Promise.all([
      fs.unlink(outputFile).catch(() => {}),
      fs.unlink(errorFile).catch(() => {}),
      fs.unlink(exitFile).catch(() => {}),
    ]);
  };
  try {
    await Promise.all([createCapture(outputFile), createCapture(errorFile), createCapture(exitFile)]);
    const child = spawn(
      "bash",
      ["-c", WRAPPER, "octopus-headless-cli", outputFile, errorFile, exitFile, command.bin, ...command.args],
      { cwd, detached: true, stdio: "ignore", ...(env ? { env } : {}) },
    );
    return { child, outputFile, errorFile, exitFile, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function headlessCapturePaths(home: string, requestId: string) {
  const directory = path.join(path.resolve(home), ".octopus-runner", "launch-captures");
  const key = createHash("sha256").update(requestId).digest("hex");
  return { outputFile: path.join(directory, `${key}.stdout`), errorFile: path.join(directory, `${key}.stderr`),
    exitFile: path.join(directory, `${key}.exit`) };
}

/** Read a bounded capture while its detached drainer may still be appending. */
export async function readHeadlessCapture(file: string): Promise<string> {
  try {
    const value = await fs.readFile(file);
    return value.subarray(Math.max(0, value.length - CAPTURE_BYTES)).toString("utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
}

async function createCapture(file: string): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  await handle.close();
}

async function cleanupOldCaptures(directory: string): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(async (entry) => {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.(?:stdout|stderr|exit)$/.test(entry.name)) return;
    const file = path.join(directory, entry.name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.unlink(file).catch(() => {});
  }));
}
