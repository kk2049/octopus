import { describe, expect, it } from "vitest";
import { languageForFileName, languageKeyForFileName } from "./languages.js";

describe("workspace syntax language selection", () => {
  it.each([
    ["src/App.tsx", "tsx"],
    ["package.json", "json"],
    [".github/workflows/check.yml", "yaml"],
    ["Dockerfile", "dockerfile"],
    ["config/nginx.conf", "nginx"],
    [".env.production", "properties"],
    ["scripts/deploy.sh", "shell"],
    ["main.rs", "rust"],
    ["notes.md", "markdown"],
  ] as const)("maps %s to %s", (fileName, key) => {
    expect(languageKeyForFileName(fileName)).toBe(key);
    expect(languageForFileName(fileName)).not.toBeNull();
  });

  it("keeps unknown and extensionless files as plain text", () => {
    expect(languageKeyForFileName("LICENSE")).toBeNull();
    expect(languageForFileName("archive.unknown")).toBeNull();
  });
});
