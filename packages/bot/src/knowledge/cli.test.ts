import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

describe("knowledge context CLI", () => {
  it("builds an exact committed-HEAD graph when no graph path is configured", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI, "context", "--root", process.cwd(), "packages/bot/src/knowledge/CLAUDE.md"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          OCTOPUS_KNOWLEDGE_GRAPH: "",
          OCTOPUS_BOT_DB: "",
        },
      },
    );
    const output = String(stdout);

    expect(String(stderr)).toContain("building an exact graph from committed HEAD");
    expect(output).not.toContain("graph_unavailable");
    expect(output).not.toMatch(/, 0 records;/u);
    expect(output).toMatch(/, [1-9]\d* records;/u);
  }, 60_000);
});
