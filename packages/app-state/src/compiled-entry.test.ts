import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { StateProcessClient } from "./client.js";

it("starts the production build with plain Node and no TypeScript loader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "compiled-state-"));
  const client = new StateProcessClient({ stateDir: dir, modulePath: resolve(import.meta.dirname, "../dist/main.js"), execArgv: [], env: {} });
  try { await client.start(); expect((await client.health()).ok).toBe(true); }
  finally { await client.stop(); rmSync(dir, { recursive: true, force: true }); }
});
