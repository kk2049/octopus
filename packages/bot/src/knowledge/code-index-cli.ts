#!/usr/bin/env node
import path from "node:path";

import { openCodeIndex, type CodeSymbolSelector } from "./code-index.js";

function argumentsByFlag(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error(`missing value for ${flag ?? "argument"}`);
    values.set(flag, value);
  }
  return values;
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

const values = argumentsByFlag(process.argv.slice(2));
const allowed = new Set(["--artifact", "--repo-sha", "--operation", "--query", "--path", "--qualified-name", "--line", "--character", "--direction", "--limit"]);
for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`unknown code-index query option ${flag}`);

const resolver = openCodeIndex(path.resolve(required(values, "--artifact")));
try {
  const repoSha = required(values, "--repo-sha");
  const operation = required(values, "--operation");
  const limitValue = values.get("--limit");
  const limit = limitValue ? Number(limitValue) : undefined;
  const selector = (): CodeSymbolSelector => ({
    path: values.get("--path"),
    qualifiedName: required(values, "--qualified-name"),
  });
  let result: unknown;
  switch (operation) {
    case "search":
      result = resolver.searchSymbols({ repoSha, query: required(values, "--query"), limit });
      break;
    case "definition":
      result = resolver.definitions({ repoSha, symbol: selector(), limit });
      break;
    case "references":
      result = resolver.references({ repoSha, symbol: selector(), limit });
      break;
    case "implementations":
      result = resolver.implementations({ repoSha, symbol: selector(), limit });
      break;
    case "tests":
      result = resolver.testsForSymbol({ repoSha, symbol: selector(), limit });
      break;
    case "calls": {
      const direction = values.get("--direction");
      if (direction !== undefined && direction !== "incoming" && direction !== "outgoing" && direction !== "both") {
        throw new Error("--direction must be incoming, outgoing, or both");
      }
      result = resolver.calls({ repoSha, symbol: selector(), direction, limit });
      break;
    }
    case "position":
      result = resolver.resolvePosition({
        repoSha,
        path: required(values, "--path"),
        line: Number(required(values, "--line")),
        character: Number(required(values, "--character")),
      });
      break;
    default:
      throw new Error(`unknown code-index operation ${operation}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  resolver.close();
}
