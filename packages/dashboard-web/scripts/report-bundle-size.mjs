import { readdir, readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
const assets = new URL("../dist/a/", import.meta.url);
const names = await readdir(assets);
const manifest = JSON.parse(await readFile(new URL("../dist/.vite/manifest.json", import.meta.url), "utf8"));
const initial = new Set();
function visit(key) {
  const row = manifest[key]; if (!row || initial.has(row.file)) return;
  initial.add(row.file); for (const dependency of row.imports ?? []) visit(dependency);
}
visit("src/main.tsx");
for (const [kind, extension] of [["JS", ".js"], ["CSS", ".css"]]) {
  const matches = names.filter((name) => name.endsWith(extension));
  if (!matches.length) throw new Error(`missing ${kind} assets`);
  let raw = 0, gzip = 0, initialRaw = 0, initialGzip = 0, initialFiles = 0;
  for (const name of matches) {
    const bytes = await readFile(new URL(name, assets));
    const compressed = gzipSync(bytes).byteLength;
    raw += (await stat(new URL(name, assets))).size; gzip += compressed;
    if (kind === "CSS" || initial.has(`a/${name}`)) { initialRaw += bytes.byteLength; initialGzip += compressed; initialFiles++; }
  }
  console.log(`[bundle-size] ${kind}: ${matches.length} files, ${(raw / 1000).toFixed(2)} kB raw / ${(gzip / 1000).toFixed(2)} kB gzip total; initial ${initialFiles} files, ${(initialRaw / 1000).toFixed(2)} kB raw / ${(initialGzip / 1000).toFixed(2)} kB gzip`);
}
