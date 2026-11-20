#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluateCrashSemantics,
  evaluateDshSeam,
  evaluateTcbExtraction,
  evaluateUiParity,
  runSelfHostedAcceptance,
  type DshSeamBaseline,
  type SelfHostedAcceptanceDriver,
  type UiParityEvidence,
} from "./gates.js";
import { evaluateUsageWindow, readUsageFiles } from "./usage.js";

const [command = "static", ...args] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../../..");

async function main(): Promise<void> {
  switch (command) {
    case "static": {
      output([evaluateCrashSemantics(), await evaluateTcbExtraction(root)]);
      return;
    }
    case "g1": {
      const baselineFile = path.resolve(args[0] ?? path.join(root, "architecture/convergence-gates.json"));
      const baseline = JSON.parse(await readFile(baselineFile, "utf8")) as { g1: DshSeamBaseline };
      output(await evaluateDshSeam(baseline.g1));
      return;
    }
    case "g2": {
      if (!args[0]) throw new Error("g2 needs a driver module whose default export implements SelfHostedAcceptanceDriver");
      const module = await import(pathToFileURL(path.resolve(args[0])).href) as { default?: SelfHostedAcceptanceDriver };
      if (!module.default) throw new Error("g2 driver has no default export");
      output(await runSelfHostedAcceptance(module.default));
      return;
    }
    case "g4": {
      if (!args[0]) throw new Error("g4 needs a JSON evidence file");
      const evidence = JSON.parse(await readFile(path.resolve(args[0]), "utf8")) as UiParityEvidence;
      output(evaluateUiParity(evidence));
      return;
    }
    case "g0": {
      if (args.length < 4) throw new Error("g0 needs <start-iso> <end-iso> <minimum-hours> <usage.jsonl...>");
      const [start, end, hours, ...files] = args;
      const events = await readUsageFiles(files.map((file) => path.resolve(file)));
      output(evaluateUsageWindow(events, new Date(start!), new Date(end!), Number(hours) * 3_600_000));
      return;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const rows = Array.isArray(value) ? value : [value];
  if (rows.some((row) => row && typeof row === "object" && "status" in row && row.status !== "pass")) {
    process.exitCode = 2;
  }
}

await main();
