import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = [
  path.resolve(process.cwd(), "packages/agent-schedule-view/src"),
  path.resolve(process.cwd(), "src"),
].find((candidate) => existsSync(candidate))!;

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

describe("agent-schedule-view dependency boundary", () => {
  const files = sources();

  it("finds the reusable module sources", () => expect(files.length).toBeGreaterThan(3));

  it("imports no trusted runtime or transport", () => {
    const allowed = [
      /^react(-dom)?(\/.*)?$/,
      /^@claude-bot\/agent-view-react\/(ui|workspace)$/,
      /^@claude-bot\/agent-module-contract$/,
      /^@claude-bot\/agent-data-view(\/port)?$/,
      /^\.{1,2}\//,
    ];
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        if (specifier.endsWith(".css")) continue;
        expect(allowed.some((pattern) => pattern.test(specifier)), `${path.relative(SRC, file)} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("uses only configured actions and opens no side channel", () => {
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      expect(source, path.relative(SRC, file)).not.toMatch(/\bsubmit\(\s*["'`]/);
      expect(source, path.relative(SRC, file)).not.toMatch(/\b(fetch\(|XMLHttpRequest|new WebSocket|EventSource|postMessage|import\()/);
    }
  });

  it("keeps release manifests free of React and styles", () => {
    for (const specifier of importsOf(readFileSync(path.join(SRC, "manifests.ts"), "utf8"))) {
      expect(specifier).not.toMatch(/^react|agent-view-react|\.css$/);
      expect(specifier).not.toBe("@claude-bot/agent-data-view");
    }
  });
});
