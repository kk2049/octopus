import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// This Linux operations tool uses the installed GPG/Python binaries. Other
// test hosts may omit those tools; deployment hosts run this suite explicitly.
const supported = process.platform === "linux"
  && spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0
  && spawnSync("gpg", ["--version"], { stdio: "ignore" }).status === 0;

it.skipIf(!supported)("verifies encrypted SQLite transfers, failed-remote refusal, retained preimages and reverse restore with real GPG", async () => {
  const script = fileURLToPath(new URL("./state-transfer.test.py", import.meta.url));
  const result = await promisify(execFile)("python3", [script], { timeout: 55000 });
  expect(result.stderr).toContain("OK");
}, 60000);
