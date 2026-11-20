import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(process.cwd(), "packages/agent-file-preview/src");
const files = readdirSync(SRC).filter((name) => /\.(ts|tsx)$/.test(name) && !name.includes(".test.") && !name.endsWith(".d.ts"));
const importsOf = (source: string) => [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]);

describe("agent-file-preview boundary", () => {
  it("depends only on browser presentation and pure resource contracts", () => {
    const allowed = [/^react$/, /^pdfjs-dist(?:\/.*)?$/, /^@claude-bot\/agent-view-react\/ui$/, /^@claude-bot\/(agent-module-contract|workspace-files-contract|agent-sessions-contract)$/, /^\.\//];
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(path.join(SRC, file), "utf8"))) {
        expect(allowed.some((pattern) => pattern.test(specifier)), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("opens no network or host channel", () => {
    for (const file of files) {
      const source = readFileSync(path.join(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
      expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|new WebSocket|EventSource|postMessage|import\(/);
      expect(source).not.toMatch(/@claude-bot\/(bot|runner|engine|capability-kernel)|dashboard-web|["']node:/);
    }
  });

  it("isolates PDF parsing in a version-matched module worker and disables optional resource fetches", () => {
    const source = readFileSync(path.join(SRC, "pdf-document.ts"), "utf8");
    expect(source).toContain('new Worker(new URL("./pdf-worker.ts", import.meta.url)');
    expect(source).toContain("PDFWorker.create({ port })");
    expect(source).not.toContain("globalThis.pdfjsWorker");
    expect(source).toContain("port.terminate()");
    expect(readFileSync(path.join(SRC, "pdf-worker.ts"), "utf8")).toContain("pdfjs-dist/legacy/build/pdf.worker.mjs");
    expect(source).toContain("useWorkerFetch: false");
    expect(source).toContain("useWasm: false");
  });

  it("keeps PDF.js text-layer font geometry wired to the CSS viewport", () => {
    const source = readFileSync(path.join(SRC, "PdfPreview.tsx"), "utf8");
    const styles = readFileSync(path.join(SRC, "styles.css"), "utf8");
    expect(source).toContain('layer.style.setProperty("--scale-factor", `${cssViewport.scale}`)');
    expect(source).toContain('layer.style.setProperty("--user-unit", `${cssViewport.userUnit}`)');
    expect(styles).toContain("--total-scale-factor: calc(var(--scale-factor) * var(--user-unit))");
    expect(styles).toContain("font-size: calc(var(--text-scale-factor) * var(--font-height))");
    expect(styles).toContain("rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))");
  });
});
