import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateProcessClient } from "./client.js";
import { STATE_READ_PAGE_LIMIT } from "./types.js";

const main = fileURLToPath(new URL("./main.ts", import.meta.url));
const dirs: string[] = [];
const clients: StateProcessClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function make(stateDir: string): StateProcessClient {
  const client = new StateProcessClient({
    modulePath: main,
    stateDir,
    execArgv: ["--import", "tsx"],
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
    readyTimeoutMs: 10_000,
  });
  clients.push(client);
  return client;
}

describe("app-state child service", () => {
  it("serializes two accidentally concurrent service processes through SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-state-process-"));
    dirs.push(dir);
    const one = make(dir);
    const two = make(dir);
    await Promise.all([one.start(), two.start()]);
    const [a, b] = await Promise.all([
      one.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } }),
      two.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } }),
    ]);
    expect(a).toEqual(b);
    const base = {
      streamId: a.streamId,
      expectedRevision: 0,
      actor: "session-plus",
      action: "pin_session",
      paramsHash: "p".repeat(64),
      backendCodeDigest: "b".repeat(64),
      contractDigest: "c".repeat(64),
      events: [{ type: "session_pinned", data: { session: "demo-1" }, at: new Date(0).toISOString(), by: "session-plus" }],
    };
    const [left, right] = await Promise.all([
      one.commit({ ...base, dispatchId: "one" }),
      two.commit({ ...base, dispatchId: "two" }),
    ]);
    expect([left, right].filter((result) => result.ok)).toHaveLength(1);
    expect([left, right].filter((result) => !result.ok)).toEqual([{ ok: false, code: "conflict", head: 1 }]);
    expect((await one.readSince(a.streamId, 0, STATE_READ_PAGE_LIMIT)).events).toHaveLength(1);
  });

  it("reads a stream larger than 2 MiB through bounded pages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-state-process-large-"));
    dirs.push(dir);
    const client = make(dir);
    await client.start();
    const stream = await client.resolveStream({ app: "session-plus", scope: { kind: "account", key: "large" } });
    const body = "x".repeat(63 * 1024);
    for (let index = 0; index < 32; index++) {
      await expect(client.commit({
        streamId: stream.streamId,
        expectedRevision: index,
        dispatchId: `large-${index}`,
        actor: "session-plus",
        action: "bulk",
        paramsHash: "p".repeat(64),
        backendCodeDigest: "b".repeat(64),
        contractDigest: "c".repeat(64),
        events: [{
          type: "chunk",
          data: { index, body },
          at: new Date(0).toISOString(),
          by: "session-plus",
        }],
      })).resolves.toMatchObject({ ok: true, revision: index + 1 });
    }
    const first = await client.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT);
    const second = await client.readSince(stream.streamId, first.cursor, STATE_READ_PAGE_LIMIT);
    expect([first.events.length, second.events.length]).toEqual([16, 16]);
    expect(second).toMatchObject({ head: 32, cursor: 32, hasMore: false });
  });
});
