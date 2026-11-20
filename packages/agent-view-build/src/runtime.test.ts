import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { runtimeEntrySource } from "./runtime.js";

describe("shared runtime CommonJS exports", () => {
  it.each([
    ["react", "useMemo"], ["react/jsx-runtime", "jsx"], ["react/jsx-dev-runtime", "jsxDEV"],
    ["react-dom", "createPortal"], ["react-dom/client", "createRoot"],
  ])("exposes %s named exports to an independently loaded ESM consumer", async (specifier, name) => {
    const root = mkdtempSync(join(tmpdir(), "app-runtime-cjs-"));
    try {
      const entry = join(root, "entry.js");
      const cjs = join(root, "runtime.cjs");
      writeFileSync(cjs, `module.exports = { ${name}: function exportedOperation() { return 42; } };`);
      writeFileSync(entry, runtimeEntrySource(specifier));
      const result = await build({ configFile: false, root, logLevel: "silent",
        plugins: [{ name: "fixture-commonjs", resolveId(id) { if (id === specifier) return cjs; } }],
        build: { write: false, minify: false, lib: { entry, formats: ["es"] }, commonjsOptions: { include: [/runtime\.cjs$/] } },
      });
      const bundle = Array.isArray(result) ? result[0] : result;
      if (!("output" in bundle)) throw new Error("expected build output");
      const chunk = bundle.output.find((item) => item.type === "chunk" && item.isEntry);
      if (!chunk || chunk.type !== "chunk") throw new Error("missing runtime entry");
      expect(chunk.exports).toContain(name);
      const loaded = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
      expect(loaded[name]()).toBe(42);
      expect(loaded[name]).toBe(loaded.default[name]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
