import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENGINE_SRC = fileURLToPath(new URL("../../engine/src/", import.meta.url));
const SERVICE_FILE = fileURLToPath(new URL("./service.ts", import.meta.url));
const ENGINE_PACKAGE = fileURLToPath(new URL("../../engine/package.json", import.meta.url));

describe("App Runtime dependency boundary", () => {
  it("reaches the sandbox without loading the engine host barrel", () => {
    const service = readFileSync(SERVICE_FILE, "utf8");
    expect(service).toContain('from "@claude-bot/engine/sandbox"');
    expect(service).not.toMatch(/from ["']@claude-bot\/engine["']/);

    const manifest = JSON.parse(readFileSync(ENGINE_PACKAGE, "utf8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
    };
    expect(manifest.exports?.["./sandbox"]).toEqual({
      types: "./src/sandbox.ts",
      default: "./src/sandbox.ts",
    });

    const narrow = localImportClosure(path.join(ENGINE_SRC, "sandbox.ts"));
    const barrel = localImportClosure(path.join(ENGINE_SRC, "index.ts"));
    expect(relativeFiles(narrow)).toEqual(["runtime/sandbox.ts", "sandbox.ts"]);
    expect(relativeFiles(barrel)).toEqual(expect.arrayContaining([
      "agent/openai.ts",
      "cards/feishu.ts",
      "host/server.ts",
      "index.ts",
      "runtime/sandbox.ts",
    ]));
    expect(barrel.size).toBeGreaterThan(narrow.size);
  });
});

function localImportClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...source.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g),
      ...source.matchAll(/import\s+["'](\.[^"']+)["']/g),
    ].map((match) => match[1]!);
    for (const specifier of specifiers) {
      const resolved = resolveTypescriptImport(file, specifier);
      if (resolved) visit(resolved);
    }
  };
  visit(entry);
  return seen;
}

function resolveTypescriptImport(importer: string, specifier: string): string | null {
  const absolute = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    absolute.replace(/\.js$/, ".ts"),
    `${absolute}.ts`,
    path.join(absolute, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function relativeFiles(files: ReadonlySet<string>): string[] {
  return [...files].map((file) => path.relative(ENGINE_SRC, file)).sort();
}
