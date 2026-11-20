import { readFileSync } from "node:fs";
import path from "node:path";
import { RunnerBundleRegistry } from "./bundle-registry.js";

interface CliOptions {
  dataDir: string;
  actor: string;
  positional: string[];
}

function parseOptions(args: string[]): CliOptions {
  const positional: string[] = [];
  let dataDir = process.env.DATA_DIR ?? "/data";
  let actor = process.env.USER ? `cli:${process.env.USER}` : "cli:operator";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      continue;
    } else if (arg === "--data-dir") {
      dataDir = args[++index] ?? "";
    } else if (arg === "--actor") {
      actor = args[++index] ?? "";
    } else {
      positional.push(arg);
    }
  }
  if (!dataDir) throw new Error("--data-dir requires a path");
  return { dataDir: path.resolve(dataDir), actor, positional };
}

function usage(): never {
  throw new Error(
    "usage: runner-bundle <status|activate|rollback> [bundle.js] [--data-dir DIR] [--actor LABEL]",
  );
}

export function runRunnerBundleCli(args: string[]): void {
  const options = parseOptions(args);
  const [command, candidate, ...extra] = options.positional;
  if (extra.length > 0 || !command) usage();
  const registry = new RunnerBundleRegistry(path.join(options.dataDir, "runner-bundles"));

  let result;
  if (command === "status" && !candidate) {
    result = registry.health();
  } else if (command === "activate" && candidate) {
    const callerDir = process.env.INIT_CWD ?? process.cwd();
    result = registry.activate(readFileSync(path.resolve(callerDir, candidate)), options.actor);
  } else if (command === "rollback" && !candidate) {
    result = registry.rollback(options.actor);
  } else {
    usage();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

try {
  runRunnerBundleCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
