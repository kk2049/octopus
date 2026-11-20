import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ChildRpcClient, ChildRpcError } from "./client.js";

const fixture = fileURLToPath(new URL("./test-child.ts", import.meta.url));
const clients: ChildRpcClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

function make(overrides: Partial<ConstructorParameters<typeof ChildRpcClient>[0]> = {}): ChildRpcClient {
  const client = new ChildRpcClient({
    modulePath: fixture,
    execArgv: ["--import", "tsx"],
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
    readyTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
    ...overrides,
  });
  clients.push(client);
  return client;
}

describe("ChildRpcClient", () => {
  it("accepts a burst of synchronous requests at a serial process edge", async () => {
    const client = make({ env: { PATH: process.env.PATH, NODE_ENV: "test", FIXTURE_SERIAL: "1" } });
    await client.start();
    const results = await Promise.allSettled(Array.from({ length: 64 }, (_, index) => client.request("echo", index)));
    expect(results).toEqual(Array.from({ length: 64 }, (_, index) => ({ status: "fulfilled", value: index })));
    await expect(client.request("fail", null)).rejects.toMatchObject({ code: "fixture_error" });
    expect(await client.request("echo", "after-error")).toBe("after-error");
  });

  it("still bounds asynchronous handlers and releases their slot", async () => {
    const client = make({ env: { PATH: process.env.PATH, NODE_ENV: "test", FIXTURE_SERIAL: "1" } });
    await client.start();
    const pending = client.request("wait", "done");
    await expect(client.request("echo", "busy")).rejects.toMatchObject({ code: "child_saturated" });
    expect(await pending).toBe("done");
    expect(await client.request("echo", "after-wait")).toBe("after-wait");
  });

  it("waits for readiness, correlates replies and preserves structured values", async () => {
    const client = make();
    await client.start();
    expect(client.isReady).toBe(true);
    expect(await client.request("echo", { nested: [1, "two"] })).toEqual({ nested: [1, "two"] });
    expect(await client.request("pid", null)).toMatchObject({ pid: expect.any(Number) });
  });

  it("returns the child error code without crashing the parent", async () => {
    const client = make();
    await client.start();
    await expect(client.request("fail", null)).rejects.toMatchObject({
      name: "ChildRpcError",
      code: "fixture_error",
      message: "fixture refusal",
    });
  });

  it("carries a request larger than one frame as bounded parts", async () => {
    // The fixture frames its replies at 1024 bytes; both directions fragment.
    const client = make({ maxMessageBytes: 1024 });
    await client.start();
    const sent: unknown[] = [];
    const child = (client as unknown as { child: { send: (frame: unknown, cb?: unknown) => boolean } }).child;
    const send = child.send.bind(child);
    child.send = (frame, cb) => { sent.push(frame); return send(frame, cb as never); };
    const params = { text: "é🙂\"\\x".repeat(400) };
    expect(await client.request("echo", params)).toEqual(params);
    expect(sent.length).toBeGreaterThan(4);
    for (const frame of sent) expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThanOrEqual(1024);
    expect(await client.request("length", params)).toBe(JSON.stringify(params).length);
  });

  it("reassembles a child response larger than the child's frame bound", async () => {
    const client = make({ maxMessageBytes: 1024 });
    await client.start();
    await expect(client.request("large", null)).resolves.toEqual({ text: "x".repeat(2048) });
    await expect(client.request("sized", 3_000)).resolves.toEqual({ text: "é🙂\"\\".repeat(3_000) });
    const [a, b, c] = await Promise.all([
      client.request("sized", 500),
      client.request("echo", "small"),
      client.request("sized", 700),
    ]);
    expect(a).toEqual({ text: "é🙂\"\\".repeat(500) });
    expect(b).toBe("small");
    expect(c).toEqual({ text: "é🙂\"\\".repeat(700) });
    expect(client.isReady).toBe(true);
  });

  it("still stops a child that writes one frame over the bound", async () => {
    const client = make({ maxMessageBytes: 512 });
    await client.start();
    // The fixture frames at 1024 bytes, so every part is over this parent's window.
    await expect(client.request("large", null)).rejects.toMatchObject({ code: "child_exited" });
    expect(client.isReady).toBe(false);
  });

  it("fails closed when the entry cannot start", async () => {
    const client = make({ modulePath: `${fixture}.missing`, readyTimeoutMs: 500 });
    await expect(client.start()).rejects.toBeInstanceOf(ChildRpcError);
    expect(client.isReady).toBe(false);
  });

  it("stops idempotently and refuses later calls", async () => {
    const client = make();
    await client.start();
    await client.stop();
    await client.stop();
    expect(client.isReady).toBe(false);
    await expect(client.request("echo", null)).rejects.toMatchObject({ code: "child_unavailable" });
  });
});
