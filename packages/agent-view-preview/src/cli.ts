/**
 * `pnpm run app:preview -- <plan file>` — a draft composition on screen in
 * seconds.
 *
 * ── What it is for ─────────────────────────────────────────────────────────
 *
 * The loop for changing an App's assembly today is pack → install → activate →
 * re-consent, and it exists for good reasons: a release is an identity and an
 * activation is a decision. None of those reasons apply to "does the rail hold
 * three modules" or "did that config key actually reach the component", which
 * are most of the questions an author has. This answers those against a fixture,
 * on a loopback port, having touched nothing.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 *  · **It never writes.** No generated entry file, no temp directory, no build
 *    output. The plan file is reached through a resolver alias, so a preview
 *    leaves nothing behind that a later build could pick up.
 *  · **It does not talk to a real backend.** Connecting a draft to a development
 *    instance and running the real typed ports is future work, listed as such.
 *    A harness that could do both would be one flag away from previewing against
 *    production data, and the thing it is previewing is untrusted publisher code.
 *  · **It binds to loopback.** A dev server serving fixture data is harmless, but
 *    "harmless by inspection" is not a default worth having; `--host` is the
 *    explicit opt-in, and the 8920-8939 window is where a public demo belongs.
 */

import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer, type InlineConfig } from "vite";

/** The specifier `app/main.tsx` imports; aliased to the caller's plan file. */
const PLAN_SPECIFIER = "app-preview-plan";

const APP_ROOT = fileURLToPath(new URL("./app/", import.meta.url));

interface Options {
  plan: string;
  host: string;
  port: number;
  open: boolean;
}

const USAGE = `用法: pnpm run app:preview -- <plan 文件> [--host <地址>] [--port <端口>] [--open]

  <plan 文件>  default-export 一个 PreviewPlan 的 .ts/.tsx 文件
               （见 packages/agent-view-preview/src/plan.ts）

例:
  pnpm run app:preview -- packages/agent-data-view/examples/inbox.preview.ts
`;

function parse(argv: readonly string[]): Options | null {
  const rest: string[] = [];
  const options: Options = { plan: "", host: "127.0.0.1", port: 5180, open: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--open") {
      options.open = true;
      continue;
    }
    if (arg === "--host" || arg === "--port") {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) {
        console.error(`缺少 ${arg} 的值`);
        return null;
      }
      if (arg === "--host") options.host = value;
      else {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          console.error(`端口不合法: ${value}`);
          return null;
        }
        options.port = port;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`不认识的参数: ${arg}`);
      return null;
    }
    rest.push(arg);
  }
  if (rest.length !== 1) return null;
  options.plan = rest[0]!;
  return options;
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (!options) {
    console.log(USAGE);
    process.exit(1);
  }
  const plan = path.resolve(process.cwd(), options.plan);
  if (!existsSync(plan) || !statSync(plan).isFile()) {
    console.error(`找不到 plan 文件: ${plan}`);
    process.exit(1);
  }

  const config: InlineConfig = {
    root: APP_ROOT,
    configFile: false,
    plugins: [react()],
    resolve: {
      alias: [{ find: new RegExp(`^${PLAN_SPECIFIER}$`), replacement: plan }],
      // The plan file lives in another workspace package, which under pnpm has
      // its own `react` symlink. Both resolve to one physical copy, but saying
      // so removes the whole class of "two Reacts, hooks throw" surprises from
      // a tool whose job is to be boring.
      dedupe: ["react", "react-dom"],
    },
    server: {
      host: options.host,
      port: options.port,
      open: options.open,
      strictPort: false,
      // The plan file and everything it imports live outside `root`, so the
      // allow-list has to widen — to the repository and nothing further. A dev
      // server that served the whole filesystem would be a file-read primitive
      // on a listening port.
      fs: { allow: [repoRoot()] },
    },
  };

  const server = await createServer(config);
  await server.listen();
  const resolved = server.resolvedUrls?.local?.[0] ?? `http://${options.host}:${options.port}/`;
  console.log("");
  console.log(`  Agent View 预览  ${resolved}`);
  console.log(`  plan             ${path.relative(process.cwd(), plan) || plan}`);
  console.log("");
  console.log("  数据来自 fixture：没有 Host、没有授权、不写任何东西。");
  console.log("  Ctrl+C 退出。");
  console.log("");
}

/** Two levels above this package, i.e. the workspace root. */
function repoRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
