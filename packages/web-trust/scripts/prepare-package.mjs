import { copyFile, readFile, writeFile } from "node:fs/promises";

const packageRoot = new URL("../", import.meta.url);
const source = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));

const manifest = {
  name: "@octo-kit/web-trust",
  version: source.version,
  description: source.description,
  license: source.license,
  repository: source.repository,
  homepage: source.homepage,
  bugs: source.bugs,
  type: "module",
  main: "./index.js",
  types: "./index.d.ts",
  exports: {
    ".": {
      types: "./index.d.ts",
      import: "./index.js",
      default: "./index.js",
    },
    "./frame-protocol": {
      types: "./frame-protocol.d.ts",
      import: "./frame-protocol.js",
      default: "./frame-protocol.js",
    },
  },
  files: ["*.js", "*.d.ts", "README.md", "CHANGELOG.md", "LICENSE"],
  engines: source.engines,
  publishConfig: { access: "public" },
};

await Promise.all([
  writeFile(new URL("dist/package.json", packageRoot), `${JSON.stringify(manifest, null, 2)}\n`),
  copyFile(new URL("README.md", packageRoot), new URL("dist/README.md", packageRoot)),
  copyFile(new URL("CHANGELOG.md", packageRoot), new URL("dist/CHANGELOG.md", packageRoot)),
  copyFile(new URL("LICENSE", packageRoot), new URL("dist/LICENSE", packageRoot)),
]);
