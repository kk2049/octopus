import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

// Invoked only as a durable workspace job. Output is outside the analyzed checkout.
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const sha = args.get("--sha"), out = args.get("--out");
if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !path.isAbsolute(out ?? "")) throw new Error("exact --sha and absolute --out are required");
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const atlasFile = path.join(out, "atlas.json");
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "packages/architecture-observatory/src/analyzer/cli.ts",
    "--root", process.cwd(), "--config", "architecture/atlas.json", "--out", atlasFile, "--reuse"], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`architecture analyzer exited ${code}`)));
});
const stat = await fs.stat(atlasFile);
if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error("architecture atlas exceeds 128 MiB");
const atlas = JSON.parse(await fs.readFile(atlasFile, "utf8"));
if (atlas.schemaVersion !== 1 || atlas.meta?.commit !== sha || atlas.meta?.dirty !== false) throw new Error("architecture atlas is not the clean requested commit");
const hash = createHash("sha256"), compressedHash = createHash("sha256");
let rawBytes = 0, compressedBytes = 0;
const meter = (update) => new Transform({ transform(chunk, _encoding, callback) { try { update(chunk); callback(null, chunk); } catch (error) { callback(error); } } });
const temporary = path.join(out, `atlas.${randomUUID()}.gz`);
await pipeline(createReadStream(atlasFile), meter((chunk) => { hash.update(chunk); rawBytes += chunk.length; }),
  createGzip({ level: 6 }), meter((chunk) => {
    compressedHash.update(chunk); compressedBytes += chunk.length;
    if (compressedBytes > 16 * 1024 * 1024) throw new Error("compressed architecture atlas exceeds 16 MiB");
  }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
await fs.rename(temporary, path.join(out, "atlas.json.gz"));
const manifest = { version: 1, repoSha: sha, bytes: rawBytes, sha256: hash.digest("hex"),
  compressedBytes, compressedSha256: compressedHash.digest("hex"), inputFingerprint: atlas.meta.inputFingerprint };
const manifestTemp = path.join(out, `manifest.${randomUUID()}.json`);
await fs.writeFile(manifestTemp, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
await fs.rename(manifestTemp, path.join(out, "manifest.json"));
console.log(JSON.stringify({ architecture_artifact: manifest }));
