/**
 * `pnpm run app:pack:showcase` — build the declared "模块演示" App's release
 * from this checkout, and optionally hand it to a host.
 *
 * The whole CLI (flag surface, the pack/declare/install/activate separation and
 * the argument for it) is `runAppPackCli` in `app-package.ts`; this file only
 * says WHICH app. Kept as a named script alongside the generic
 * `app-pack-cli.ts` because this config lives in this tree and a one-line entry
 * is cheaper to invoke than a path argument.
 */

import { runAppPackCli } from "./app-package.js";
import { SHOWCASE_PACK } from "./showcase-package.js";

runAppPackCli(SHOWCASE_PACK).catch((error: unknown) => {
  process.stderr.write(`app:pack:showcase 失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
