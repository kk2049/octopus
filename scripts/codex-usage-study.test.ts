import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("studies the weekly window in either slot, excludes resets, and never returns a billing conversion or content", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-study-"));
  try {
    const snapshot = (seconds: number, tokens: number, percent: number, resets = 100, slot = "primary") => ({ timestamp: new Date(1_800_000_000_000 + seconds * 1000).toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: tokens, cached_input_tokens: tokens / 2, output_tokens: 0 } }, rate_limits: { [slot]: { window_minutes: 10080, used_percent: percent, resets_at: resets } } } });
    writeFileSync(join(dir, "rollout.jsonl"), [
      { type: "turn_context", payload: { model: "model-a", content: "PRIVATE CONTENT" } },
      snapshot(0, 1000, 10), snapshot(60, 4000, 13),
      snapshot(120, 5000, 1, 200), snapshot(180, 11000, 4, 200, "secondary"),
    ].map((v) => JSON.stringify(v)).join("\n"));
    const out = execFileSync(process.execPath, ["scripts/codex-usage-study.mjs", dir], { encoding: "utf8" });
    const report = JSON.parse(out).reports[0];
    expect(report.billingConversion).toBeNull();
    expect(report.distributions).toEqual([{ model: "model-a", samples: 2, tokensPerPercentagePoint: { min: 1000, p25: 1000, median: 1000, p75: 1000, max: 2000 } }]);
    expect(out).not.toContain("PRIVATE CONTENT"); expect(out).not.toContain(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
