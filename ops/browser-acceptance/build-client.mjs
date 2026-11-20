import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Usage: node build-client.mjs ABSOLUTE_OUTPUT.mjs');
const require = createRequire(path.join(root, 'packages/runner/package.json'));
const { build } = createRequire(require.resolve('tsup'))('esbuild');
await build({ entryPoints: [path.join(root, 'ops/browser-acceptance/client.mjs')], outfile: output, bundle: true,
  platform: 'node', format: 'esm', target: 'node22', nodePaths: [path.join(root, 'packages/runner/node_modules')],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
