import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = [
  path.resolve(process.cwd(), "packages/agent-text-view/src"),
  path.resolve(process.cwd(), "src"),
].find((candidate) => existsSync(candidate))!;

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

describe("agent-text-view dependency boundary", () => {
  const files = sources();

  it("finds the reusable surface sources", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("is presentation-only and statically bundled", () => {
    const allowed = [
      /^react(-dom)?(\/.*)?$/,
      /^@claude-bot\/agent-view-react\/ui$/,
      /^@codemirror\/(?:commands|lang-[a-z-]+|language|legacy-modes\/mode\/[a-z-]+|search|state|view)$/,
      /^\.{1,2}\//,
    ];
    for (const file of files) {
      const relative = path.relative(SRC, file);
      const source = code(readFileSync(file, "utf8"));
      for (const specifier of importsOf(source)) {
        if (specifier.endsWith(".css")) continue;
        expect(allowed.some((pattern) => pattern.test(specifier)), `${relative} imports ${specifier}`).toBe(true);
      }
      for (const pattern of [
        /^node:/m,
        /@claude-bot\/(bot|runner|engine)/,
        /dashboard-web|web-trust|capability-kernel/,
        /\bfetch\(/,
        /XMLHttpRequest|new WebSocket|EventSource|postMessage/,
        /\bimport\(/,
        /new (?:Shared)?Worker/,
      ]) {
        expect(pattern.test(source), `${relative} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("keeps CodeMirror in the surface and its bounded language registry", () => {
    for (const file of files) {
      const relative = path.relative(SRC, file).split(path.sep).join("/");
      const uses = importsOf(readFileSync(file, "utf8")).filter((specifier) => specifier.startsWith("@codemirror/"));
      if (relative === "components/CodeMirrorTextSurface.tsx") expect(uses).toHaveLength(5);
      else if (relative === "languages.ts") expect(uses).toHaveLength(23);
      else expect(uses, `${relative} imports ${uses.join(", ")}`).toEqual([]);
    }
  });

  it("does not invent resource identity or path fields", () => {
    const forbidden = [
      /\bownerName\b/,
      /\busername\b/,
      /\bcredential\b/,
      /\bdeviceId\b/,
      /\bworkspaceId\b/,
      /\brelativePath\b/,
      /\bcanonicalPath\b/,
      /\bcontextId\b/,
      /\bgrant\b/,
    ];
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
  });
});
