/**
 * The guest agent's `pc` MCP server (stdio), run by the system Node inside
 * the guest sandbox. It needs no packages: MCP over stdio is newline-framed
 * JSON-RPC, and the three tools are HTTPS calls to the owner's Runner, which
 * relays them over the guest's own console connection. Files on the sandbox
 * side are read and written here, so the sandbox, not the Runner, decides
 * which workspace paths are reachable.
 *
 * Kept free of template literals: it is embedded as a String.raw constant.
 */
export const GUEST_PC_MCP_MJS = String.raw`// Octopus guest "pc" tools (written by the Octopus Runner; do not edit).
import https from "node:https";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// Written by the Runner at each session start: where the Runner listens, this guest's secret, and the CA it uses.
const LINK = (() => {
  try { return JSON.parse(readFileSync(path.join(os.homedir(), ".octopus", "pc.json"), "utf8")); } catch { return {}; }
})();
const ENDPOINT = String(LINK.endpoint || "");
const TOKEN = String(LINK.token || "");
const CA = (() => { try { return readFileSync(String(LINK.ca_file)); } catch { return undefined; } })();
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 1800;

const INSTRUCTIONS = "These tools act on the user's own Windows PC, where they are sitting. "
  + "Everything else you do (shell, files, scripts) runs in a sandboxed Linux workspace on a server that the user cannot see. "
  + "Bring the user's files in with fetch_file and hand results over with send_file; "
  + "their Desktop may live under OneDrive, so ask PowerShell for [Environment]::GetFolderPath('Desktop').";

const TOOLS = [
  {
    name: "run_powershell",
    description: "Run a PowerShell command on the user's Windows PC (Windows PowerShell 5.1, in the user's own desktop session, starting in their home folder). "
      + "Use it to look at or change things on that PC, or to open a delivered file for the user with Start-Process. "
      + "There is no interactive input; output comes back as UTF-8 text and long output is truncated.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "PowerShell script to run." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: "Stop it after this long (default 120)." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    annotations: { title: "Run PowerShell on the user's PC", destructiveHint: true, openWorldHint: true },
  },
  {
    name: "fetch_file",
    description: "Copy one file (up to 64 MiB) from the user's PC into this workspace, for example a document they mention or drag into the window.",
    inputSchema: {
      type: "object",
      properties: {
        pc_path: { type: "string", description: "File on the PC: an absolute Windows path, or one relative to the user's home folder." },
        path: { type: "string", description: "Where to save it here (default: its file name in the current directory)." },
        overwrite: { type: "boolean", description: "Replace an existing file here (default false)." },
      },
      required: ["pc_path"],
      additionalProperties: false,
    },
    annotations: { title: "Copy a file from the user's PC", readOnlyHint: true },
  },
  {
    name: "send_file",
    description: "Copy one file (up to 64 MiB) from this workspace to the user's PC, for example a finished deck to their Desktop. "
      + "Missing folders are created; an existing file is replaced only with overwrite: true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File in this workspace." },
        pc_path: { type: "string", description: "Destination on the PC: an absolute Windows path, or one relative to the user's home folder." },
        overwrite: { type: "boolean", description: "Replace an existing file on the PC (default false)." },
      },
      required: ["path", "pc_path"],
      additionalProperties: false,
    },
    annotations: { title: "Copy a file to the user's PC", destructiveHint: true },
  },
];

function request(op, options) {
  return new Promise((resolve, reject) => {
    const url = new URL("/octopus/pc/" + op, ENDPOINT);
    for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, String(value));
    const body = options.body !== undefined ? options.body : Buffer.from(JSON.stringify(options.json || {}));
    const req = https.request(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + TOKEN,
        "content-type": options.body !== undefined ? "application/octet-stream" : "application/json",
        "content-length": body.length,
      },
      timeout: options.timeoutMs,
      ...(CA ? { ca: CA } : {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_FILE_BYTES + 1024 * 1024) { req.destroy(new Error("response too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out waiting for the PC")));
    req.on("error", reject);
    req.end(body);
  });
}

function failure(response) {
  try {
    const value = JSON.parse(response.body.toString("utf8"));
    if (value && typeof value.error === "string") return value.error;
  } catch { /* not JSON */ }
  return "HTTP " + response.status;
}

function text(value, isError) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function runPowershell(args) {
  if (typeof args.command !== "string" || !args.command.trim()) return text("command is required", true);
  const seconds = Math.min(Math.max(Math.floor(Number(args.timeout_seconds) || 120), 1), MAX_TIMEOUT_SECONDS);
  const response = await request("run_powershell", {
    json: { command: args.command, timeout_seconds: seconds }, timeoutMs: (seconds + 60) * 1000,
  });
  if (response.status !== 200) return text(failure(response), true);
  const result = JSON.parse(response.body.toString("utf8"));
  const parts = [(result.timed_out ? "timed out after " + seconds + "s; " : "") + "exit code: " + result.exit_code];
  if (result.stdout) parts.push("--- stdout ---\n" + result.stdout);
  if (result.stderr) parts.push("--- stderr ---\n" + result.stderr);
  return text(parts.join("\n"), result.exit_code !== 0 || Boolean(result.timed_out));
}

async function fetchFile(args) {
  if (typeof args.pc_path !== "string" || !args.pc_path.trim()) return text("pc_path is required", true);
  const response = await request("read_file", { json: { pc_path: args.pc_path }, timeoutMs: 15 * 60 * 1000 });
  if (response.status !== 200) return text(failure(response), true);
  const source = decodeURIComponent(String(response.headers["x-octopus-pc-path"] || args.pc_path));
  const name = source.split(/[\\/]/).pop() || "download";
  const target = path.resolve(typeof args.path === "string" && args.path.trim() ? args.path : name);
  if (!args.overwrite && await exists(target)) return text(target + " already exists here; pass overwrite: true to replace it", true);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = target + ".octopus-" + process.pid;
  await writeFile(temp, response.body);
  await rename(temp, target);
  return text("saved " + source + " from the PC as " + target + " (" + response.body.length + " bytes)");
}

async function sendFile(args) {
  if (typeof args.path !== "string" || !args.path.trim()) return text("path is required", true);
  if (typeof args.pc_path !== "string" || !args.pc_path.trim()) return text("pc_path is required", true);
  const source = path.resolve(args.path);
  const info = await stat(source).catch(() => undefined);
  if (!info || !info.isFile()) return text(source + " is not a file", true);
  if (info.size > MAX_FILE_BYTES) return text(source + " is larger than 64 MiB; split or compress it first", true);
  const body = await readFile(source);
  const response = await request("write_file", {
    body, query: { pc_path: args.pc_path, overwrite: args.overwrite ? "1" : "0" }, timeoutMs: 15 * 60 * 1000,
  });
  if (response.status !== 200) return text(failure(response), true);
  const result = JSON.parse(response.body.toString("utf8"));
  return text("saved " + source + " on the PC as " + result.pc_path + " (" + result.bytes + " bytes)");
}

async function callTool(name, args) {
  try {
    if (name === "run_powershell") return await runPowershell(args);
    if (name === "fetch_file") return await fetchFile(args);
    if (name === "send_file") return await sendFile(args);
    return text("unknown tool " + name, true);
  } catch (error) {
    return text("the PC could not be reached: " + (error && error.message ? error.message : String(error)), true);
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function handle(message) {
  if (message === null || typeof message !== "object" || message.id === undefined || message.id === null) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    const requested = message.params && typeof message.params.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18";
    return reply({ protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: "octopus-pc", version: "1.0.0" }, instructions: INSTRUCTIONS });
  }
  if (message.method === "ping") return reply({});
  if (message.method === "tools/list") return reply({ tools: TOOLS });
  if (message.method === "tools/call") {
    const params = message.params || {};
    return reply(await callTool(params.name, params.arguments || {}));
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found: " + message.method } });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  void handle(message);
});
lines.on("close", () => process.exit(0));
`;
