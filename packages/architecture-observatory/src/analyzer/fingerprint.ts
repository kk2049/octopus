import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ArchitectureAtlas, AtlasConfig } from "../shared/model.js";
import { discoverWorkspacePackages } from "./paths.js";
import { discoverSourceFiles } from "./typescript.js";

function gitValue(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export function inputFingerprint(
  root: string,
  configPath: string,
  config: AtlasConfig,
  waiverPath = "architecture/waivers.json",
): string {
  const hash = crypto.createHash("sha256");
  const sourceRoots = config.analysis?.sourceRoots ?? ["packages", "plugins", "scripts", "ctl"];
  const sources = discoverSourceFiles(root, sourceRoots, config.analysis?.exclude ?? []);
  const manifests = discoverWorkspacePackages(root).map((pkg) => path.join(root, pkg.path, "package.json"));
  const structural = [
    path.resolve(root, configPath),
    path.resolve(root, waiverPath),
    path.join(root, "package.json"),
    path.join(root, "pnpm-lock.yaml"),
    path.join(root, "tsconfig.json"),
    ...manifests,
  ];
  hash.update(gitValue(root, ["rev-parse", "HEAD"]));
  hash.update("\0");
  hash.update(gitValue(root, ["branch", "--show-current"]));
  for (const file of [...new Set([...sources, ...structural])].sort()) {
    if (!fs.existsSync(file)) continue;
    hash.update("\0");
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

export function reusableAtlas(out: string, fingerprint: string): ArchitectureAtlas | undefined {
  if (!fs.existsSync(out)) return undefined;
  try {
    const atlas = JSON.parse(fs.readFileSync(out, "utf8")) as ArchitectureAtlas;
    return atlas.meta.inputFingerprint === fingerprint ? atlas : undefined;
  } catch {
    return undefined;
  }
}
