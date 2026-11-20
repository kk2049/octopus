import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { scopeAppCss } from "../agent-view-build/src/scope-css";
import { APP_RUNTIME_IMPORTS, runtimeEntryName, runtimeEntrySource } from "../agent-view-build/src/runtime";
import { renderAgentViewThemeCss } from "../agent-view-build/src/theme-tokens";

const prefix = "octopus-runtime:";
const runtime: Plugin = {
  name: "octopus-shared-runtime",
  // Generated theme rules must enter Vite CSS processing before PostCSS
  // replaces document roots with the App surface, just like the SDK styles.
  enforce: "pre",
  resolveId(id) { if (id.startsWith(prefix)) return "\0" + id; },
  load(id) {
    if (!id.startsWith("\0" + prefix)) return;
    const specifier = id.slice(prefix.length + 1);
    return runtimeEntrySource(specifier);
  },
  transform(code, id) {
    if (!id.split("?", 1)[0].replaceAll("\\", "/").endsWith("/agent-view-react/src/styles-index.css")) return;
    return code.replace("/* @claude-bot/agent-view-build:theme-tokens */", `@layer agent-view-base { ${renderAgentViewThemeCss()} }`);
  },
};
export default defineConfig({
  base: "/ui/",
  plugins: [runtime, react()],
  css: { postcss: { plugins: [{
    postcssPlugin: "octopus-runtime-css-scope",
    Once(root) {
      const file = root.source?.input.file?.replaceAll("\\", "/") ?? "";
      if (file.includes("/agent-view-react/")) scopeAppCss(root);
    },
  }] } },
  resolve: { dedupe: ["react", "react-dom", "antd", "@ant-design/cssinjs"] },
  build: {
    target: "es2022", outDir: "dist", assetsDir: "a", manifest: true,
    emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200, modulePreload: false, cssCodeSplit: false,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: { app: "src/main.tsx", ...Object.fromEntries(APP_RUNTIME_IMPORTS.map((id, index) => [runtimeEntryName(index), prefix + id])) },
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/") && /\/(?:antd|@ant-design|@rc-component|rc-[^/]+)\//.test(id)) return "ui-vendor";
          if (id.includes("/node_modules/") && /\/(?:react|react-dom|scheduler)\//.test(id)) return "react";
        },
        entryFileNames: "a/[name]-[hash].js", chunkFileNames: "a/[name]-[hash].js", assetFileNames: "a/[name]-[hash][extname]",
      },
    },
  },
});
