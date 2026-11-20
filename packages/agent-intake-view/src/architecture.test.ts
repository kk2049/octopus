import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
const SRC = [path.resolve(process.cwd(), "packages/agent-intake-view/src"), path.resolve(process.cwd(), "src")].find(existsSync)!;
function sources(): string[] { const out: string[] = []; const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (statSync(full).isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full); } }; walk(SRC); return out; }
function importsOf(source: string): string[] { return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]!); }
function code(source: string): string { return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1"); }
describe("agent-intake-view dependency boundary", () => {
  const files = sources();
  it("finds module sources", () => expect(files.length).toBeGreaterThan(3));
  it("imports only narrow untrusted entries", () => { const allowed = [/^react(-dom)?(\/.*)?$/, /^@claude-bot\/agent-view-react\/(ui|workspace)$/, /^@claude-bot\/agent-module-contract$/, /^@claude-bot\/agent-data-view(\/port)?$/, /^\.{1,2}\//]; for (const file of files) for (const specifier of importsOf(readFileSync(file, "utf8"))) { if (specifier.endsWith(".css")) continue; expect(allowed.some((pattern) => pattern.test(specifier)), `${path.relative(SRC, file)} imports ${specifier}`).toBe(true); } });
  it("uses configured actions and no network channel", () => { for (const file of files) { const source = code(readFileSync(file, "utf8")); expect(source).not.toMatch(/\bsubmit\(\s*["'`]/); expect(source).not.toMatch(/\b(fetch\(|XMLHttpRequest|new WebSocket|EventSource|postMessage|import\()/); } });
});
