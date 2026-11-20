#!/usr/bin/env node
import path from "node:path";

import { buildCodeIndex } from "./builder.js";

interface BuildArguments {
  root: string;
  repoSha: string;
  outDir: string;
}

function parseBuildArguments(args: string[]): BuildArguments {
  if (args[0] !== "build") throw new Error("usage: code-index build --root <checkout> --repo-sha <40hex> --out <directory>");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (!["--root", "--repo-sha", "--out"].includes(flag)) throw new Error(`unknown code-index option ${flag}`);
    values.set(flag, value);
  }
  const root = path.resolve(values.get("--root") ?? process.cwd());
  const repoSha = values.get("--repo-sha");
  if (!repoSha) throw new Error("--repo-sha is required");
  return { root, repoSha, outDir: path.resolve(values.get("--out") ?? path.join(root, ".generated/code-index")) };
}

const abort = new AbortController();
process.once("SIGINT", () => abort.abort(new Error("code-index build interrupted")));
process.once("SIGTERM", () => abort.abort(new Error("code-index build terminated")));

try {
  const options = parseBuildArguments(process.argv.slice(2));
  const manifest = await buildCodeIndex({ root: options.root, sha: options.repoSha, outDir: options.outDir, signal: abort.signal });
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
