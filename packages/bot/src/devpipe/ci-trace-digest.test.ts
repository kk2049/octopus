import { describe, expect, it } from "vitest";
import { cleanTraceLines, digestCiTrace, parseCiTrace, rosterFromDigestText } from "./ci-trace-digest.js";

/** ESC is spelled out so the fixtures stay readable in review and in diffs. */
const ESC = "\u001B";
const C = (code: string, text: string) => `${ESC}[${code}m${text}${ESC}[0m`;

/**
 * Shaped after the real thing: GitLab stamps every line with
 * `<rfc3339> <n><stream> ` and Vitest colours everything. Together those were
 * 42% of the 5 000-character window repair agents used to receive.
 */
function runnerLine(stream: "O" | "E", text: string, seq = 1): string {
  return `2026-08-10T07:51:40.66538${seq}Z 0${seq}${stream} ${text}`;
}

const RED_TRACE = [
  runnerLine(
    "E",
    `${C("41;1", " FAIL ")} ${C("30;43", " web ")} packages/agent-view-react/src/workspace/WorkspaceShell.test.tsx${C("2", " > ")}WorkspaceShell${C("2", " > ")}ArrowLeft wraps to the last tab`,
  ),
  runnerLine("E", `${C("31;1", "AssertionError")}: expected <span class="av-tab" /> to be <span class="av-tab" />`),
  runnerLine("E", `${C("36", " ❯ ")}src/workspace/WorkspaceShell.test.tsx:${C("2", "483:36")}`),
  runnerLine("E", C("31;2", "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[14/70]⎯")),
  runnerLine(
    "E",
    `${C("41;1", " FAIL ")} ${C("30;43", " node ")} packages/bot/src/session-plus/architecture-budget.test.ts${C("2", " > ")}Session Plus architecture budgets${C("2", " > ")}keeps the runtime under 4000 lines`,
  ),
  runnerLine("E", `${C("31;1", "AssertionError")}: expected 4544 to be less than or equal to 4000`),
  runnerLine("E", `${C("36", " ❯ ")}packages/bot/src/session-plus/architecture-budget.test.ts:${C("2", "149:74")}`),
  runnerLine("O", `${C("2", " Test Files ")} ${C("31;1", "7 failed")}${C("2", " | ")}${C("32;1", "282 passed")}${C("90", " (289)")}`),
  runnerLine(
    "O",
    `${C("2", "      Tests ")} ${C("31;1", "70 failed")}${C("2", " | ")}${C("32;1", "3504 passed")}${C("2", " | ")}${C("33", "2 skipped")}${C("90", " (3576)")}`,
  ),
  runnerLine("E", C("31;1", "ERROR: Job failed: exit code 1")),
].join("\n");

describe("cleanTraceLines", () => {
  it("removes the runner prefix and every ANSI sequence", () => {
    const lines = cleanTraceLines(RED_TRACE);
    expect(lines.some((line) => line.includes(ESC))).toBe(false);
    expect(lines.some((line) => /^\d{4}-\d{2}-\d{2}T/.test(line))).toBe(false);
    expect(lines[lines.length - 1]).toBe("ERROR: Job failed: exit code 1");
  });

  it("is a large net reduction on a realistic trace", () => {
    const cleaned = cleanTraceLines(RED_TRACE).join("\n");
    expect(cleaned.length).toBeLessThan(RED_TRACE.length * 0.6);
  });
});

describe("parseCiTrace", () => {
  it("recovers file, test chain, reason and frame for each failure", () => {
    const { failures } = parseCiTrace(RED_TRACE);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      file: "packages/agent-view-react/src/workspace/WorkspaceShell.test.tsx",
      test: "WorkspaceShell > ArrowLeft wraps to the last tab",
      at: "483:36",
    });
    expect(failures[0].reason).toContain("AssertionError");
    expect(failures[1]).toMatchObject({
      file: "packages/bot/src/session-plus/architecture-budget.test.ts",
      at: "149:74",
      reason: "AssertionError: expected 4544 to be less than or equal to 4000",
    });
  });

  it("reads Vitest's own totals", () => {
    const { counts } = parseCiTrace(RED_TRACE);
    expect(counts).toEqual({ filesFailed: 7, filesPassed: 282, testsFailed: 70, testsPassed: 3504 });
  });

  it("sums the totals across serial batches — the CI job prints one tally per batch", () => {
    // Since 2026-08-17 a red batch no longer aborts the job, so a red trace
    // carries EVERY batch's summary. Taking the first tally would report one
    // batch as the whole run.
    const trace = [
      runnerLine("O", " Test Files  1 failed | 39 passed (40)"),
      runnerLine("O", "      Tests  2 failed | 500 passed (502)"),
      runnerLine("O", " Test Files  40 passed (40)"),
      runnerLine("O", "      Tests  480 passed (480)"),
      runnerLine("O", " Test Files  2 failed | 38 passed (40)"),
      runnerLine("O", "      Tests  5 failed | 470 passed (475)"),
    ].join("\n");
    const { counts } = parseCiTrace(trace);
    expect(counts).toEqual({ filesFailed: 3, filesPassed: 117, testsFailed: 7, testsPassed: 1450 });
  });

  it("does not let one failure inherit the next one's error", () => {
    const trace = [
      runnerLine("E", " FAIL  node packages/bot/src/a.test.ts > alpha"),
      runnerLine("E", " FAIL  node packages/bot/src/b.test.ts > beta"),
      runnerLine("E", "AssertionError: only beta explains this"),
    ].join("\n");
    const { failures } = parseCiTrace(trace);
    expect(failures[0].reason).toBeUndefined();
    expect(failures[1].reason).toContain("only beta");
  });

  it("ignores a stack frame that points at another file", () => {
    const trace = [
      runnerLine("E", " FAIL  node packages/bot/src/a.test.ts > alpha"),
      runnerLine("E", "AssertionError: boom"),
      runnerLine("E", " ❯ node_modules/@vitest/runner/dist/index.js:12:3"),
    ].join("\n");
    const { failures } = parseCiTrace(trace);
    expect(failures[0].at).toBeUndefined();
  });

  it("picks up tsc diagnostics when the suite never started", () => {
    const trace = [
      runnerLine("E", "packages/bot/src/devpipe/pipeline.ts(2412,7): error TS2345: Argument of type 'string' is not assignable."),
      runnerLine("E", "ERROR: Job failed: exit code 2"),
    ].join("\n");
    const { failures } = parseCiTrace(trace);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ file: "packages/bot/src/devpipe/pipeline.ts", at: "2412:7" });
    expect(failures[0].reason).toContain("TS2345");
  });

  it("names a file that failed to collect, which prints no test chain at all", () => {
    const trace = [
      runnerLine("E", " FAIL  packages/bot/src/broken.test.ts [ packages/bot/src/broken.test.ts ]"),
      runnerLine("E", "Error: Cannot find module './missing.js'"),
    ].join("\n");
    const { failures } = parseCiTrace(trace);
    expect(failures).toHaveLength(1);
    expect(failures[0].file).toBe("packages/bot/src/broken.test.ts");
    expect(failures[0].test).toBeUndefined();
    expect(failures[0].reason).toContain("Cannot find module");
  });

  it("deduplicates the same file+test reported twice", () => {
    const one = runnerLine("E", " FAIL  node packages/bot/src/a.test.ts > alpha");
    const { failures } = parseCiTrace([one, one].join("\n"));
    expect(failures).toHaveLength(1);
  });
});

describe("digestCiTrace", () => {
  it("names every failing file and stays far under the old 5000-byte tail", () => {
    const digest = digestCiTrace(RED_TRACE);
    expect(digest.structured).toBe(true);
    expect(digest.text).toContain("packages/agent-view-react/src/workspace/WorkspaceShell.test.tsx");
    expect(digest.text).toContain("packages/bot/src/session-plus/architecture-budget.test.ts");
    expect(digest.text).toContain("expected 4544 to be less than or equal to 4000");
    expect(digest.text).toContain("用例 70 失败");
    expect(digest.text.length).toBeLessThan(1_200);
    // The point of the change: no runner bookkeeping survives into the ticket.
    expect(digest.text).not.toContain(ESC);
    expect(digest.text).not.toContain("2026-08-10T07:51:40");
  });

  it("aggregates repeated failures in one file instead of listing all of them", () => {
    const trace = Array.from({ length: 12 }, (_, i) =>
      [
        runnerLine("E", ` FAIL  node packages/bot/src/big.test.ts > case ${i}`),
        runnerLine("E", `AssertionError: case ${i} failed`),
      ].join("\n"),
    ).join("\n");
    const digest = digestCiTrace(trace);
    expect(digest.failures).toHaveLength(12);
    expect(digest.text).toContain("packages/bot/src/big.test.ts (12 条)");
    expect(digest.text.length).toBeLessThan(600);
  });

  it("bounds the roster when very many files fail", () => {
    const trace = Array.from({ length: 40 }, (_, i) =>
      runnerLine("E", ` FAIL  node packages/bot/src/f${i}.test.ts > only case`),
    ).join("\n");
    const digest = digestCiTrace(trace, { maxFiles: 5 });
    expect(digest.truncated).toBe(true);
    expect(digest.text).toContain("还有 35 个文件失败");
  });

  it("treats maxChars as a real ceiling, note included", () => {
    const trace = Array.from({ length: 40 }, (_, i) =>
      [
        runnerLine("E", ` FAIL  node packages/bot/src/f${i}.test.ts > a case with a fairly long name ${i}`),
        runnerLine("E", `AssertionError: something went wrong in a long winded way ${i}`),
      ].join("\n"),
    ).join("\n");
    const digest = digestCiTrace(trace, { maxChars: 500, maxFiles: 40 });
    expect(digest.text.length).toBeLessThanOrEqual(500);
    expect(digest.truncated).toBe(true);
  });

  it("falls back to a cleaned tail — never raw bytes — when nothing parses", () => {
    const trace = [
      runnerLine("E", C("31", "Runner failed to pull the image")),
      runnerLine("E", "ERROR: Job failed: prepare environment"),
    ].join("\n");
    const digest = digestCiTrace(trace);
    expect(digest.structured).toBe(false);
    expect(digest.failures).toHaveLength(0);
    expect(digest.text).toContain("Runner failed to pull the image");
    expect(digest.text).not.toContain(ESC);
    expect(digest.text).not.toContain("2026-08-10T");
  });

  it("keeps the tail bounded in the fallback path too", () => {
    const trace = Array.from({ length: 500 }, (_, i) => runnerLine("O", `noise line ${i}`)).join("\n");
    const digest = digestCiTrace(trace, { maxChars: 400 });
    expect(digest.structured).toBe(false);
    expect(digest.truncated).toBe(true);
    expect(digest.text.length).toBeLessThanOrEqual(400);
    // A tail keeps the END of the log, which is where a runner error lands.
    expect(digest.text).toContain("noise line 499");
  });
});

describe("rosterFromDigestText", () => {
  it("reads back exactly the spec files the renderer named", () => {
    const digest = digestCiTrace(RED_TRACE);
    expect(rosterFromDigestText(digest.text)).toEqual([
      "packages/agent-view-react/src/workspace/WorkspaceShell.test.tsx",
      "packages/bot/src/session-plus/architecture-budget.test.ts",
    ]);
  });

  it("survives the surrounding ticket evidence the roster is embedded in", () => {
    const body = [
      "GitLab pipeline #42 failed",
      "https://gitlab.example/pipelines/42",
      "- full_suite: script_failure (https://gitlab.example/jobs/9)",
      "",
      "--- full_suite 失败摘要 ---",
      digestCiTrace(RED_TRACE).text,
    ].join("\n");
    expect(rosterFromDigestText(body)).toContain("packages/bot/src/session-plus/architecture-budget.test.ts");
  });

  it("leaves tsc diagnostics out — the land gate's typecheck already owns them", () => {
    const trace = [
      runnerLine("E", "packages/bot/src/devpipe/pipeline.ts(2412,7): error TS2345: Argument of type 'string' is not assignable."),
      runnerLine("E", "ERROR: Job failed: exit code 2"),
    ].join("\n");
    const digest = digestCiTrace(trace);
    expect(digest.text).toContain("packages/bot/src/devpipe/pipeline.ts");
    expect(rosterFromDigestText(digest.text)).toEqual([]);
  });

  it("returns nothing for an unstructured tail", () => {
    expect(rosterFromDigestText("Runner failed to pull the image\nERROR: Job failed")).toEqual([]);
  });

  it("does not report the same file twice when two jobs failed on it", () => {
    const twice = [digestCiTrace(RED_TRACE).text, digestCiTrace(RED_TRACE).text].join("\n");
    expect(rosterFromDigestText(twice)).toHaveLength(2);
  });
});
