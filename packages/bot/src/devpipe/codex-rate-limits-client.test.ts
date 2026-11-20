import { describe, expect, it } from "vitest";
import { readCodexAccountRateLimitsFromAppServer } from "./codex-rate-limits-client.js";

describe("Codex app-server rate-limit client", () => {
  it("uses the requested CODEX_HOME and the official account RPC", async () => {
    const fakeServer = String.raw`
      const readline = require("node:readline");
      const lines = readline.createInterface({ input: process.stdin });
      let initialized = false;
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === 1) {
          process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
        } else if (message.method === "initialized") {
          initialized = true;
        } else if (initialized && message.id === 2 && message.method === "account/rateLimits/read") {
          process.stdout.write(JSON.stringify({ id: 2, result: {
            home: process.env.CODEX_HOME,
            request: message,
          } }) + "\n");
        }
      });
    `;
    await expect(readCodexAccountRateLimitsFromAppServer({
      command: process.execPath,
      args: ["-e", fakeServer],
      codexHome: "/srv/codex/account-a",
      timeoutMs: 2_000,
    })).resolves.toEqual({
      home: "/srv/codex/account-a",
      request: { id: 2, method: "account/rateLimits/read" },
    });
  });

  it("bounds a stalled subprocess without reflecting provider output", async () => {
    await expect(readCodexAccountRateLimitsFromAppServer({
      command: process.execPath,
      args: ["-e", "process.stderr.write('secret-account'); process.stdin.resume()"],
      timeoutMs: 50,
    })).rejects.toThrow("timed out");
  });
});
