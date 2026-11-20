import { defineConfig } from "tsup";

export default defineConfig({
  // The built MCP server runs under plain Node. Bundle the workspace contract
  // so its runtime vocabulary cannot escape back to TypeScript source files.
  noExternal: ["@claude-bot/agent-sessions-contract"],
});
