#!/usr/bin/env node
/**
 * `octo-build` — the build-cache wrapper invoked by every package's `build`
 * script. See `tools/build-cache/README.md`.
 *
 * Usage: node ../../tools/build-cache/bin/octo-build.mjs [--out dir]... [--check-only] -- '<command>'
 */

import { parseArgs, runCachedBuild } from "../src/run.mjs";

try {
  const { outputs, command } = parseArgs(process.argv.slice(2));
  const result = await runCachedBuild({ command, outputs });
  process.exit(result.exitCode);
} catch (err) {
  // Only wrapper-level misuse reaches here (a bad --out, a missing command).
  // Cache problems never throw; they degrade to a normal build inside run.mjs.
  console.error(`[build-cache] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
