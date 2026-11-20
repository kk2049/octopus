/** The installed reporter imports only Node builtins; it never boots the Runner. */
export const HOOK_REPORTER_SOURCE = String.raw`
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
const provider = process.argv[2];
const limit = 256 * 1024;
let payload;
try {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new Error("hook input too large");
    chunks.push(chunk);
  }
  payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const event = payload.hook_event_name ?? payload.event_name ?? payload.event;
  const blocking = provider === "claude" && (event === "PermissionRequest" || (event === "PreToolUse" && payload.tool_name === "AskUserQuestion"));
  const runtime = process.env.XDG_RUNTIME_DIR;
  const root = runtime && path.isAbsolute(runtime) ? path.join(runtime, "octopus-runner")
    : path.join(os.tmpdir(), "octopus-runner-" + (process.getuid?.() ?? "user"));
  const envelope = JSON.stringify({ provider, reporter_pid: process.pid, payload });
  if (Buffer.byteLength(envelope) > limit) throw new Error("hook input too large");
  const reply = await new Promise(resolve => {
    const socket = createConnection(path.join(root, "hooks.sock"));
    let response = "", settled = false;
    const done = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done(null), blocking ? 600000 : 2000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(envelope));
    socket.on("data", chunk => { response += chunk; if (Buffer.byteLength(response) > limit) done(null); });
    socket.on("end", () => { try { done(JSON.parse(response)); } catch { done(null); } });
    socket.on("error", () => done(null));
  });
  if (reply?.hook_output) console.log(JSON.stringify(reply.hook_output));
  if (provider === "codex" && event === "Stop") console.log("{}");
} catch { if (provider === "codex") console.log("{}"); }
`;
