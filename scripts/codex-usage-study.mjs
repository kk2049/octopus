#!/usr/bin/env node
/** Offline, numeric-only observational study. No network, credentials or model calls. */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

async function* files(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}
function point(event, model) {
  const p = event.payload;
  if (p?.type !== "token_count") return null;
  const usage = p.info?.total_token_usage;
  const limits = p.rate_limits;
  const weekly = [limits?.primary, limits?.secondary].find((w) => w?.window_minutes === 10080);
  if (!usage || !weekly) return null;
  const tokens = usage.input_tokens + usage.output_tokens;
  const time = Date.parse(event.timestamp);
  if (![tokens, weekly.used_percent, time].every(Number.isFinite) || !Number.isSafeInteger(tokens) || tokens < 0) return null;
  return { tokens, percent: weekly.used_percent, reset: weekly.resets_at, model, time };
}
const percentile = (values, p) => values.length ? Math.round(values[Math.floor((values.length - 1) * p)]) : null;

export async function study(root) {
  const byModel = new Map();
  let fileCount = 0, snapshots = 0, boundaries = 0;
  for await (const path of files(root)) {
    fileCount++;
    let anchor = null, previous = null, model = "unknown";
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "turn_context" && typeof event.payload?.model === "string") model = event.payload.model;
      const current = point(event, model);
      if (!current) continue;
      snapshots++;
      if (!previous || current.reset !== previous.reset || current.model !== previous.model || current.tokens < previous.tokens || current.percent < previous.percent || current.time < previous.time) {
        anchor = current; boundaries++;
      }
      previous = current;
      const elapsed = current.time - anchor.time;
      if (elapsed > 3_600_000 || current.percent >= 100) { anchor = current; continue; }
      const delta = current.percent - anchor.percent;
      if (delta < 3 || elapsed < 30_000) continue;
      const ratio = (current.tokens - anchor.tokens) / delta;
      if (ratio > 0) {
        const samples = byModel.get(model) ?? [];
        samples.push(ratio); byModel.set(model, samples);
      }
      anchor = current;
    }
  }
  const distributions = [...byModel].map(([model, values]) => {
    values.sort((a, b) => a - b);
    return { model, samples: values.length, tokensPerPercentagePoint: { min: percentile(values, 0), p25: percentile(values, .25), median: percentile(values, .5), p75: percentile(values, .75), max: percentile(values, 1) } };
  });
  return { files: fileCount, snapshots, resetOrModelOrCounterBoundaries: boundaries, distributions,
    attribution: "unidentifiable: account-wide quota, concurrent and external usage, rounding, unknown model/cache weights",
    billingConversion: null };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  if (!process.argv[2]) { process.stderr.write("Usage: node scripts/codex-usage-study.mjs <Codex sessions directory> [more directories...]\n"); process.exitCode = 1; }
  else {
    const reports = [];
    for (const [index, root] of process.argv.slice(2).entries()) reports.push({ sample: index + 1, ...await study(root) });
    process.stdout.write(JSON.stringify({ version: 1, reports }, null, 2) + "\n");
  }
}
