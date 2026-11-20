/**
 * The guest agent's PreToolUse guard hook, run by the system Node for every
 * tool call of a guest's Claude Code (installed through `--settings`) or
 * Codex (`-c hooks.PreToolUse=...`). Both hand it the same event shape:
 * a shell command arrives as `Bash` with `command` either way.
 *
 * The guest's agent runs as the owner's own user with the owner's login, so
 * nothing in the operating system keeps it out of the owner's files. This
 * hook is the guard: it reads the tool's path-bearing fields (a Bash command,
 * a file path, a search root, the files a Codex patch touches, the workspace
 * side of a `pc` transfer), and if one names a protected tree outside the
 * guest's own directory, it blocks the call, records why, and ends the
 * agent's tmux session.
 *
 * It catches the ordinary ways an agent writes such a path (absolute, `..`
 * traversal, `~user`, quote-split words, `$CLAUDE_CONFIG_DIR`). It does not
 * parse shell and is no defense against deliberate obfuscation.
 * File contents and search patterns are not checked, so documents and greps
 * that merely mention such a path are not mistaken for access.
 *
 * Kept free of template literals: it is embedded as a String.raw constant.
 */
export const GUEST_GUARD_MJS = String.raw`// Octopus guest guard (written by the Octopus Runner; do not edit).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.OCTOPUS_GUEST_HOME || "";
const list = (name) => {
  try {
    const value = JSON.parse(process.env[name] || "[]");
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry) : [];
  } catch {
    return [];
  }
};
// Inside a protected tree, still the guest's own: its home, the shared tools,
// and Claude's own files for this workspace (large tool results it reads back).
const ALLOWED = [HOME, ...list("OCTOPUS_GUEST_ALLOWED")].filter(Boolean);
const PROTECTED = list("OCTOPUS_GUEST_PROTECTED");

/** The strings of one tool call that can name a path on this machine. */
export function candidates(tool, input) {
  const value = (key) => (input && typeof input[key] === "string" ? [input[key]] : []);
  if (tool === "Bash") {
    const command = value("command");
    // Quote-split words ("/ho""me", '/home'/x, \/home) read the same to the shell.
    return [...command, ...command.map((text) => text.replace(/["'\\]/g, ""))];
  }
  if (tool === "Glob") return [...value("pattern"), ...value("path")];
  if (tool === "Grep") return [...value("path"), ...value("glob")];
  // Codex's patch tool: the files it adds, updates, deletes or moves to, not their new contents.
  if (tool === "apply_patch") {
    return value("command").flatMap((patch) =>
      [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1].trim()));
  }
  // A PC transfer's workspace side is here; its pc_path is on the guest's own PC.
  if (tool.startsWith("mcp__pc__")) return value("path");
  return [...value("file_path"), ...value("notebook_path"), ...value("path")];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^()|[\]{}\\$]/g, "\\$&");
}

function allowed(target) {
  return ALLOWED.some((root) => target === root || target.startsWith(root + "/"));
}

/** Why one string reaches outside the guest's directory, or "" when it does not. */
export function violation(text, cwd) {
  for (const root of PROTECTED) {
    // A path component boundary on both sides: not /homebrew, not example.com/home.
    const pattern = new RegExp("(^|[^A-Za-z0-9_])(" + escapeRegExp(root) + ")(?=/|$|[^A-Za-z0-9_.-])", "g");
    for (const match of text.matchAll(pattern)) {
      const start = match.index + match[1].length;
      const rest = text.slice(start);
      const token = rest.slice(0, rest.search(/[\s'"\x60;|&<>(){},]|$/));
      // ./home/x and ../../home/x are relative to cwd: the workspace's own
      // "home" folder is fine; walking up out of the guest's directory is not.
      const dots = /(^|[\s'"=:])((?:\.\.?\/)*\.\.?)$/.exec(text.slice(0, start));
      const target = dots ? path.posix.resolve(cwd || "/", dots[2] + token) : path.posix.normalize(token);
      if (!allowed(target)) return "touches " + target;
    }
  }
  const user = /(^|[\s'"=:(;|&])~([a-z_][a-z0-9_-]*)(?=\/|$|[\s'";|&)])/.exec(text);
  if (user) return "touches the home of user " + user[2];
  if (/\$\{?CLAUDE_CONFIG_DIR\b/.test(text)) return "touches the owner's Claude configuration";
  const proc = /\/proc\/[0-9]+\/(environ|cwd|root|fd|mem)\b/.exec(text);
  if (proc) return "reads another process's " + proc[1];
  return "";
}

function end(reason, event) {
  const record = { at: new Date().toISOString(), tool: event.tool_name, reason };
  try {
    const dir = path.join(HOME, ".octopus");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "guard.log"), JSON.stringify({ ...record, input: JSON.stringify(event.tool_input).slice(0, 2000) }) + "\n");
    writeFileSync(path.join(dir, "terminated.json"), JSON.stringify(record) + "\n");
  } catch { /* the block below still holds */ }
  process.stderr.write("Octopus guard: this session may only work inside " + HOME + ". The call " + reason + ", so it was blocked and the session is ending.\n");
  // End this agent's own tmux server (the host names its socket, in the guest's
  // home, so no other server is touched), after this hook has answered so the
  // block is recorded first.
  const socket = process.env.OCTOPUS_GUEST_TMUX || "";
  if (socket && existsSync(socket)) {
    spawn("sh", ["-c", "sleep 0.3; exec tmux -S \"$0\" kill-server", socket], { detached: true, stdio: "ignore" }).unref();
  }
  process.exit(2);
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  for (const text of candidates(String(event.tool_name || ""), event.tool_input || {})) {
    const reason = violation(text, event.cwd || HOME);
    if (reason) end(reason, event);
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // Fail closed: a call the guard cannot check is blocked (the session goes on).
  main().catch((error) => {
    process.stderr.write("Octopus guard could not check this call (" + String(error && error.message || error) + "), so it was blocked.\n");
    process.exit(2);
  });
}
`;
