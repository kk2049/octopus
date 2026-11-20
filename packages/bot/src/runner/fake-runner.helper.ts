/**
 * Test-only laptop Runner over a REAL WebSocket.
 *
 * The point of the acceptance matrix is "did a frame reach the device", not
 * "what did a policy function return", so every test runner records the exact
 * `{method, args}` frames it received. A test that asserts `frames.length === 0`
 * is asserting the laptop was never touched.
 *
 * Not imported by any production module; excluded from the bundle because
 * tsup only follows src/index.ts.
 */

import WebSocket from "ws";
import type { RunnerInventory } from "@claude-bot/runner/inventory";

export interface FakeRunner {
  ws: WebSocket;
  /** Every rpc frame this device received, in order. */
  frames: Array<{ method: string; args: Record<string, unknown> }>;
  close(): void;
}

export async function startFakeRunner(
  port: number,
  token: string,
  device: string,
  handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {},
  inventory?: RunnerInventory,
): Promise<FakeRunner> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: Array<{ method: string; args: Record<string, unknown> }> = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({
      type: "register",
      token,
      device,
      ...(inventory ? { inventory } : {}),
    })));
    ws.on("message", function onMsg(data) {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (msg.type === "registered") {
        ws.off("message", onMsg);
        resolve();
      } else if (msg.type === "error") {
        reject(new Error(String(msg.message)));
      }
    });
    ws.on("error", reject);
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as {
      type: string;
      id?: string;
      method?: string;
      args?: Record<string, unknown>;
    };
    if (msg.type !== "rpc" || !msg.id || !msg.method) return;
    frames.push({ method: msg.method, args: msg.args ?? {} });
    const h = handlers[msg.method];
    if (!h) {
      ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ok: false, error: `no handler: ${msg.method}` }));
      return;
    }
    void Promise.resolve(h(msg.args ?? {})).then(
      (result) => ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ok: true, result })),
      (err) => ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ok: false, error: (err as Error).message })),
    );
  });
  return { ws, frames, close: () => ws.close() };
}
