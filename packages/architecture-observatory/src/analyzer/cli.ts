#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeRepository } from "./analyze.js";
import { loadConfig } from "./config.js";
import { inputFingerprint, reusableAtlas } from "./fingerprint.js";
import type { ArchitectureAtlas } from "../shared/model.js";
import { loadWaivers } from "./waivers.js";

interface CliOptions {
  root: string;
  config: string;
  out: string;
  check: boolean;
  reuse: boolean;
}

export function hasBlockingCheckResult(atlas: Pick<ArchitectureAtlas, "constraints" | "findings">): boolean {
  return atlas.constraints.some((constraint) => constraint.status === "fail" || constraint.status === "unknown")
    || atlas.findings.some((finding) => finding.signal === "tooling"
      && (finding.severity === "critical" || finding.severity === "high"));
}

export function waivedCheckLines(atlas: Pick<ArchitectureAtlas, "constraints">): string[] {
  return atlas.constraints.flatMap((constraint) => constraint.waivedViolations.map((item) =>
    `- ${constraint.id} [${item.witness}] owner=${item.waiver.owner} expires=${item.waiver.expires_at}: ${item.waiver.reason}`,
  ));
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  let check = false;
  let reuse = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--reuse") {
      reuse = true;
      continue;
    }
    if (!["--root", "--config", "--out"].includes(arg)) throw new Error(`unknown argument ${arg}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} needs a value`);
    values.set(arg, value);
    index += 1;
  }
  const root = path.resolve(process.cwd(), values.get("--root") ?? ".");
  return {
    root,
    config: values.get("--config") ?? "architecture/atlas.json",
    out: path.resolve(process.cwd(), values.get("--out") ?? ".architecture/atlas.json"),
    check,
    reuse,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.root, options.config);
  const waiverFile = loadWaivers(options.root);
  process.stdout.write("Architecture atlas: fingerprinting inputs…\n");
  const fingerprint = inputFingerprint(options.root, options.config, config);
  const cached = options.reuse ? reusableAtlas(options.out, fingerprint) : undefined;
  if (cached) {
    process.stdout.write(`Architecture atlas: reused ${options.out} (${fingerprint.slice(0, 12)})\n`);
    if (options.check && hasBlockingCheckResult(cached)) process.exitCode = 1;
    return;
  }
  process.stdout.write("Architecture atlas: resolving TypeScript symbols and dependency graph…\n");
  const atlas = await analyzeRepository(options.root, config, fingerprint, waiverFile.waivers);
  process.stdout.write(
    `Architecture atlas facts: ${atlas.files.length} files, ${atlas.symbols.length} symbols, `
    + `${atlas.calls.length} calls, ${atlas.annotations.length} annotations\n`,
  );
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(atlas, null, 2)}\n`, "utf8");
  const failed = atlas.constraints.filter((constraint) => constraint.status === "fail");
  const unknown = atlas.constraints.filter((constraint) => constraint.status === "unknown");
  const waived = atlas.constraints.filter((constraint) => constraint.status === "waived");
  const review = atlas.constraints.filter((constraint) => constraint.status === "review");
  process.stdout.write(
    `Architecture atlas: ${atlas.modules.length} modules, ${atlas.dependencies.length} cross-module dependencies, `
    + `${atlas.flows.length} flows, ${failed.length} failing constraints, ${unknown.length} unknown, ${waived.length} waived, ${review.length} review claims\n`
    + `Wrote ${options.out}\n`,
  );
  const waiverLines = waivedCheckLines(atlas);
  if (waiverLines.length > 0) {
    process.stdout.write(`Architecture atlas: active waived witnesses\n${waiverLines.join("\n")}\n`);
  }
  if (options.check && hasBlockingCheckResult(atlas)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${String((error as Error).stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
