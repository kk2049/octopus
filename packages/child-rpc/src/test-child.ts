import { serveChildRpc } from "./server.js";

serveChildRpc({
  handle(method, params) {
    if (method === "echo") return params;
    if (method === "large") return { text: "x".repeat(2048) };
    if (method === "sized") return { text: "é🙂\"\\".repeat(Number(params)) };
    if (method === "length") return JSON.stringify(params).length;
    if (method === "fail") throw Object.assign(new Error("fixture refusal"), { code: "fixture_error" });
    if (method === "pid") return { pid: process.pid };
    if (method === "wait") return new Promise(resolve => setTimeout(() => resolve(params), 100));
    throw Object.assign(new Error(`unknown fixture method: ${method}`), { code: "unknown_method" });
  },
  maxMessageBytes: 1024,
  maxConcurrent: process.env.FIXTURE_SERIAL === "1" ? 1 : undefined,
});
