/**
 * The generic declared-App pack entry — `tsx app-pack-cli.ts <config> [flags]`.
 *
 * The first positional argument names a PACK-CONFIG MODULE (a TypeScript file
 * whose default export is an `AppPackConfig`), and everything after it is the
 * ordinary flag surface of `runAppPackCli` (`--out` / `--publish` / `--token` /
 * `--declare` / `--activate`).
 *
 * ── Why the config arrives by path and not by import ────────────────────────
 *
 * The config belongs to the app's own package — that is what makes "a new
 * declared App changes nothing under `packages/bot`" a checkable sentence
 * rather than a slogan. A static import here would put the app's name into
 * this tree and a workspace dependency into `packages/bot/package.json`, one
 * per app, forever. Loading by path keeps the arrow pointing the right way:
 * the platform knows how to pack A config; only the root `package.json`
 * script line knows which one. Nothing about trust changes — the module runs
 * with the same authority as the person invoking the build, exactly as every
 * other file `tsx` executes.
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readAppPackConfig, runAppPackCli } from "./app-package.js";

async function main(): Promise<void> {
  const [spec, ...rest] = process.argv.slice(2);
  if (!spec || spec.startsWith("--")) {
    throw new Error(
      "第一个参数必须是打包配置模块的路径，例如 packages/<app>-view/src/pack.ts；"
        + "其后接 --out/--publish/--token/--declare/--activate",
    );
  }
  const loaded: unknown = await import(pathToFileURL(path.resolve(spec)).href);
  const config = readAppPackConfig((loaded as { default?: unknown }).default);
  await runAppPackCli(config, rest);
}

main().catch((error: unknown) => {
  process.stderr.write(`app:pack 失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
