import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = [
  path.resolve(process.cwd(), "packages/chat-ui-commons"),
  path.resolve(process.cwd()),
].find((candidate) => candidate.endsWith("chat-ui-commons") && existsSync(path.join(candidate, "package.json")))!;
const SRC = path.join(ROOT, "src");

function implementationSources(): Array<{ name: string; source: string }> {
  return readdirSync(SRC)
    .filter((name) => /\.(?:ts|tsx|css)$/.test(name) && !/\.test\./.test(name))
    .map((name) => ({ name, source: readFileSync(path.join(SRC, name), "utf8") }));
}

describe("chat-ui-commons boundary", () => {
  it("has only the neutral contract, React, viewport measurement and the DOM-free diagram renderer as runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@claude-bot/agent-sessions-contract",
      "@tanstack/react-virtual",
      "beautiful-mermaid",
      "react",
    ]);
  });

  it("cannot reach either release lane, a channel, identity, network, or raw HTML", () => {
    const forbiddenImports = /@claude-bot\/(?:agent-.*-view|agent-view-react|bot|dashboard-web|session-plus-view|web-trust)/;
    const forbiddenSurface = /\b(?:MessagePort|MessageChannel|XMLHttpRequest|WebSocket|EventSource|fetch|postMessage|useIdentity|useOwner|useCapability|instanceHandle|csrf|dangerouslySetInnerHTML)\b/;
    for (const { name, source } of implementationSources()) {
      for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)) {
        expect(match[1], `${name} imports ${match[1]}`).not.toMatch(forbiddenImports);
      }
      expect(source, `${name} exposes a forbidden runtime surface`).not.toMatch(forbiddenSurface);
    }
  });

  it("keeps the sessions contract type-only and Markdown host-injected", () => {
    const transcript = readFileSync(path.join(SRC, "transcript.ts"), "utf8");
    const group = readFileSync(path.join(SRC, "TranscriptGroup.tsx"), "utf8");
    expect(transcript).toMatch(/import type \{ Activity, RichBlock, RichMessage \} from "@claude-bot\/agent-sessions-contract"/);
    expect(group).toMatch(/renderAssistant\?\(text: string\): ReactNode/);
    expect(group).toMatch(/renderAssistant = renderPlainTextAssistant/);
    expect(group).toMatch(/function renderPlainTextAssistant\(text: string\): string\s*\{\s*return text;/);
    expect(group).not.toMatch(/react-markdown|rehype-raw/);
  });

  it("contains presentation only and makes structural CSS an explicit Host choice", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const transcript = readFileSync(path.join(SRC, "transcript.ts"), "utf8");
    const components = readFileSync(path.join(SRC, "transcript-ui.ts"), "utf8");

    expect(transcript).not.toMatch(/\b(?:FRONTIER_LOOKBACK|clientFrontier|hasOpenTool)\b/);
    expect(components).not.toMatch(/(?:^|\n)\s*import\s+["'][^"']+\.css["']/);
    expect(manifest.exports).toHaveProperty("./transcript-ui.css", "./src/transcript-ui.css");
  });
});
