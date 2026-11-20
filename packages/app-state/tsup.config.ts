import { defineConfig } from "tsup";

// The production State entry must run with plain Node: this workspace package
// exports TypeScript sources, so include its small IPC server in the artifact.
export default defineConfig({ noExternal: ["@claude-bot/child-rpc"] });
