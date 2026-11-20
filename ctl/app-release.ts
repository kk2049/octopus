#!/usr/bin/env tsx
/**
 * `pnpm app:release` — ff an Agentic App's live release from a terminal.
 *
 * The same three steps the ticket agent's `devpipe_app_release` performs, for
 * the other kind of agent: a CLI session on this host. It is a thin wrapper on
 * purpose — packing and publishing stay `app:pack`'s job, so there is one
 * packing path, not two that can drift.
 *
 * ── Which tree, and why the deployed one by default ────────────────────────
 *
 * The run checkout is the only tree that is always installed, always built,
 * and always exactly the code the trusted process is running. A release packed
 * there can never be "a View that needs a framework nobody deployed yet",
 * because the View and the platform come from one commit. Pass `--tree` when
 * you deliberately want a different checkout (one you have just built).
 *
 * ── Auth ───────────────────────────────────────────────────────────────────
 *
 * The admin key the ops scripts already use, read the same way, so a terminal
 * agent needs no new credential and no new file:
 *
 *   OCTOPUS_OPS_URL         bot base url   (default http://127.0.0.1:9820)
 *   OCTOPUS_OPS_TOKEN       admin dt_ key  (overrides the file)
 *   OCTOPUS_OPS_TOKEN_FILE  where to read it
 *   OCTOPUS_RUN_DIR         deployed checkout to pack from
 *
 * Usage:
 *   pnpm app:release                       # session-plus, from the deployed tree
 *   pnpm app:release -- --app showcase
 *   pnpm app:release -- --app ppt-studio
 *   pnpm app:release -- --app chess
 *   pnpm app:release -- --app meeting-room
 *   pnpm app:release -- --app expense-intake
 *   pnpm app:release -- --app daily-brief
 *   pnpm app:release -- --app report-space
 *   pnpm app:release -- --app research-program
 *   pnpm app:release -- --tree /path/to/built/checkout
 *   pnpm app:release -- --no-activate      # install only; decide on /apps
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_RELEASE_PACK_SCRIPTS: Readonly<Record<string, string>> = {
  "session-plus": "app:pack",
  showcase: "app:pack:showcase",
  "ppt-studio": "app:pack:ppt-studio",
  chess: "app:pack:chess",
  "meeting-room": "app:pack:meeting-room",
  "expense-intake": "app:pack:expense-intake",
  "daily-brief": "app:pack:daily-brief",
  "report-space": "app:pack:report-space",
  "research-program": "app:pack:research-program",
  "research-v2": "app:pack:research-v2",
  "research-docs": "app:pack:research-docs",
};

export function packScriptForApp(app: string): string | undefined {
  return APP_RELEASE_PACK_SCRIPTS[app];
}

interface Args {
  app: string;
  tree: string;
  url: string;
  activate: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    app: "session-plus",
    tree: process.env.OCTOPUS_RUN_DIR || "/home/ubuntu/lht/octopus-run",
    url: process.env.OCTOPUS_OPS_URL || "http://127.0.0.1:9820",
    activate: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--app") { args.app = value ?? args.app; i++; }
    else if (flag === "--tree") { args.tree = value ?? args.tree; i++; }
    else if (flag === "--url") { args.url = value ?? args.url; i++; }
    else if (flag === "--no-activate") args.activate = false;
  }
  return args;
}

function adminToken(): string {
  const direct = process.env.OCTOPUS_OPS_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.OCTOPUS_OPS_TOKEN_FILE || "/home/ubuntu/lht/octopus-dev/dashboard-token.txt";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`读不到管理密钥 ${file}(可用 OCTOPUS_OPS_TOKEN 覆盖)`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const script = packScriptForApp(args.app);
  if (!script) {
    throw new Error(
      `不认识的 App \`${args.app}\`;本仓库可打包的是:${Object.keys(APP_RELEASE_PACK_SCRIPTS).join("、")}`,
    );
  }
  if (!existsSync(path.join(args.tree, "node_modules"))) {
    throw new Error(
      `${args.tree} 没有 node_modules,打包脚本跑不起来。`
        + `部署过的 run checkout 一定有;别的 checkout 需要先 pnpm install && pnpm -r build。`,
    );
  }
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: args.tree, encoding: "utf8" }).trim();
  process.stdout.write(`打包 ${args.app} · 从 ${args.tree}(${head})\n`);

  const dir = mkdtempSync(path.join(tmpdir(), "app-release-"));
  const out = path.join(dir, "release.json");
  try {
    // One packing path: the same command a human runs, in the tree we chose.
    // The packer recomputes the View source digest and refuses a stale build,
    // so "is this checkout current" is its answer to give, not ours.
    execFileSync(
      "pnpm",
      [
        "run", script, "--",
        "--out", out,
        "--publish", args.url,
        "--token", adminToken(),
        ...(args.app === "session-plus" ? [] : ["--declare"]),
        ...(args.activate ? ["--activate"] : []),
      ],
      { cwd: args.tree, stdio: "inherit" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(
    args.activate
      ? "\n已安装并激活。验收:/apps 上 checkout digest 应显示「已安装」且是 active;打开 App 时 frame 主机名会是新 digest。\n"
      : "\n已安装但未激活 —— 在 /apps 上决定是否切换。\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`app:release 失败: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
