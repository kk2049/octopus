import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(root, "package.json"));
const esbuild = createRequire(require.resolve("tsx"))("esbuild");
if (!process.argv[2]) throw new Error("Specify output bundle path");
await esbuild.build({ entryPoints: [path.join(root, "scripts/ops/refactor-lab/seed-runner.ts")],
  bundle: true, platform: "node", format: "esm", outfile: path.resolve(process.argv[2]),
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);' } });
