#!/usr/bin/env node
import { Console } from "node:console";
import { runWorkspaceMcp } from "../packages/bot/src/research-canvas/workspace-mcp.js";
// Plugin console output is diagnostic; stdout belongs to MCP framing.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
if (process.argv.length !== 3) throw new Error("Usage: tsx ctl/research-workspace-mcp.ts /absolute/private/config.json");
void runWorkspaceMcp(process.argv[2]).catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
