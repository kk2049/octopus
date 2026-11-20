import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "theme-deepseek.css"), "utf8");

describe("DeepSeek dashboard chat geometry", () => {
  it("styles the shared chat without narrowing it to a centered column", () => {
    const inset = CSS.match(/--av-chat-inset:\s*([^;]+);/)?.[1].trim();
    expect(inset).toBe("16px");
    expect(inset).not.toMatch(/748|calc/);
  });
});
