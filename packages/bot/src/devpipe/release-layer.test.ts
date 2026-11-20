import { execFileSync } from "node:child_process";
import path from "node:path";
import { it } from "vitest";

it("preserves independent releases while reusing verified dependencies and yielding cleanup", () => {
  execFileSync("python3", [path.join(process.cwd(), "scripts/ops/release-layer.test.py"), "-v"],
    { timeout: 30000, stdio: "pipe" });
}, 35000);
