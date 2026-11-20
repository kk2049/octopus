import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const APP_REGISTRY_DIR = fileURLToPath(new URL(".", import.meta.url));
const APP_CORE_DIR = path.resolve(APP_REGISTRY_DIR, "../app-core");
const SESSION_PLUS_ROOT_IMPORT = /(?:from\s+|import\s*\()\s*["'](?:\.\.\/)+session-plus\//;
const COMPOSITION_ROOT_IMPORT = /(?:from\s+|import\s*\()\s*["'](?:\.\.\/)+(?:session-plus|app-registry)\//;

function typescriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...typescriptFiles(absolute));
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

describe("App registry dependency direction", () => {
  it("does not import the Session Plus composition root", () => {
    const offenders = typescriptFiles(APP_REGISTRY_DIR)
      .filter((file) => SESSION_PLUS_ROOT_IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(APP_REGISTRY_DIR, file))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("keeps the shared core below both composition roots", () => {
    const offenders = typescriptFiles(APP_CORE_DIR)
      .filter((file) => COMPOSITION_ROOT_IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(APP_CORE_DIR, file))
      .sort();

    expect(offenders).toEqual([]);
  });
});
