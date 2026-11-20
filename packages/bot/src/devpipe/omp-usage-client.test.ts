import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOmpCodexUsage } from "./omp-usage-client.js";

describe("OMP Codex usage client", () => {
  it("runs the bounded command and parses its JSON projection", async () => {
    const payload = { reports: [{ provider: "openai-codex", metadata: { email: "a*" } }] };
    const result = await readOmpCodexUsage({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`],
      timeoutMs: 2_000,
    });
    expect(result).toEqual(payload);
  });

  it("rejects invalid JSON and unsuccessful exits without echoing stderr", async () => {
    await expect(readOmpCodexUsage({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("not-json")'],
      timeoutMs: 2_000,
    })).rejects.toThrow("invalid JSON");

    await expect(readOmpCodexUsage({
      command: process.execPath,
      args: ["-e", 'process.stderr.write("secret-token"); process.exit(2)'],
      timeoutMs: 2_000,
    })).rejects.toThrow("exited unsuccessfully");
  });

  it("bounds stalled and noisy subprocesses and sanitizes launch failure", async () => {
    await expect(readOmpCodexUsage({
      command: process.execPath,
      args: ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"],
      timeoutMs: 100,
    })).rejects.toThrow("timed out");

    await expect(readOmpCodexUsage({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("x".repeat(4096))'],
      timeoutMs: 2_000,
      maxOutputBytes: 1024,
    })).rejects.toThrow("output limit");

    await expect(readOmpCodexUsage({
      command: join(tmpdir(), "omp-usage-definitely-missing"),
      timeoutMs: 2_000,
    })).rejects.toThrow("could not start");
  });
});
