import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeProcessClient } from "./client.js";
import { backendRelease } from "./release.js";

const main = fileURLToPath(new URL("./main.ts", import.meta.url));
const dirs: string[] = [];
const clients: RuntimeProcessClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "runtime-child-"));
  dirs.push(dir);
  writeFileSync(join(dir, "actions.ts"), `export function pin_session(ctx, params) { return { events: [{ type: "pin", data: params, at: ctx.now, by: "app" }] }; }`);
  writeFileSync(join(dir, "projection.ts"), `export function project(events) { return { count: events.length }; }`);
  return dir;
}

describe("app-runtime child service", () => {
  it("serves invoke/project over inherited IPC with a scrubbed environment", async () => {
    const appDir = fixture();
    const release = backendRelease(appDir);
    const client = new RuntimeProcessClient({
      modulePath: main,
      appDir,
      execArgv: ["--import", "tsx"],
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
      readyTimeoutMs: 15_000,
    });
    clients.push(client);
    await client.start();
    expect(await client.health()).toEqual({ ok: true, backendCodeDigest: release.backendCodeDigest });
    const out = await client.invoke({
      backendCodeDigest: release.backendCodeDigest,
      action: "pin_session",
      context: { now: "2026-08-04T00:00:00.000Z" },
      params: { session: "demo-1" },
    });
    expect(await client.project({ backendCodeDigest: release.backendCodeDigest, events: out.events })).toEqual({ count: 1 });
    const environ = readFileSync(`/proc/${client.rpc.pid}/environ`, "utf8");
    expect(environ).toContain("NODE_ENV=test");
    expect(environ).not.toContain("APP_STATE_DIR");
    expect(environ).not.toContain("ANTHROPIC_API_KEY");
  });
});
