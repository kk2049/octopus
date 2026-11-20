#!/usr/bin/env node
/**
 * Second-opinion review of the backfill: sample records per batch, show each
 * one next to its cited evidence, and ask an independent headless agent to
 * score it. This is the "verify they followed the rules" step, not a re-run.
 *
 *   tsx packages/bot/src/knowledge/backfill/judge-backfill.ts \
 *     --worktree <repo> --dossiers <dossier-dir> --out <dossier-dir>/judge \
 *     [--sample 0.2] [--min 3] [--seed 1] [--model openai-codex/gpt-5.6-sol] [--thinking medium] [--only b01,b02]
 *     [--records <judge.json>]   # adjudicate: re-judge exactly the flagged ids with fuller evidence windows
 *
 * Scores per record (0/1): supported (the cited source says this), atomic
 * (one claim), kind_ok, status_ok (supersession / rejection / historical
 * applied per R1–R3), capability_ok, privacy_ok. A batch with
 * supported < 0.8 is flagged for deletion or rerun.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface Curated {
  id: string;
  kind: string;
  statement: string;
  ticket?: number;
  source: { type: string; ref: string; message_id?: number; path?: string; sha?: string };
  capabilities: string[];
  status: string;
  certainty: string;
  rationale: string;
  quote?: string;
  supersedes?: string[];
  superseded_by?: string;
  conflict_note?: string;
}

interface Dossier {
  ticket: { id: number; title: string; body: string; messages: Array<{ id: number; author: string; via: string; body: string }> };
  deliveries: string[];
}

function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) out.set(key, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      out.set(key, argv[index + 1]);
      index += 1;
    } else out.set(key, "true");
  }
  return out;
}

/** Deterministic sample: every k-th record after sorting by id, at least `min`. */
export function sample<T extends { id: string }>(records: T[], fraction: number, min: number, seed = 0): T[] {
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : 1));
  const want = Math.max(min, Math.ceil(sorted.length * fraction));
  if (want >= sorted.length) return sorted;
  const step = sorted.length / want;
  const offset = (seed % Math.max(1, Math.floor(step))) || 0;
  const out: T[] = [];
  for (let index = 0; index < want; index += 1) out.push(sorted[Math.min(sorted.length - 1, Math.floor(index * step) + offset)]);
  return out;
}

function evidenceFor(record: Curated, dossiers: Map<number, Dossier>, worktree: string, full = true): string {
  const ticket = record.ticket ? dossiers.get(record.ticket) : undefined;
  const source = record.source;
  const bodyChars = full ? 8_000 : 2_500;
  const messageChars = full ? 3_500 : 1_800;
  const fileChars = full ? 12_000 : 3_000;
  const around = full ? 2 : 1;
  if (source.type === "ticket_body" && ticket) return `工单 #${ticket.ticket.id}《${ticket.ticket.title}》正文：\n${ticket.ticket.body.slice(0, bodyChars)}`;
  if (source.type === "ticket_message" && ticket) {
    const index = ticket.ticket.messages.findIndex((message) => message.id === source.message_id);
    const window = index === -1 ? [] : ticket.ticket.messages.slice(Math.max(0, index - around), index + around + 1);
    if (!window.length) return `（消息 ${source.message_id} 不在 dossier 中）工单正文：\n${ticket.ticket.body.slice(0, bodyChars)}`;
    return window.map((message) => `消息 ${message.id}（${message.author}/${message.via}）：\n${message.body.slice(0, messageChars)}`).join("\n---\n");
  }
  if (source.path) {
    try {
      return `${source.path}：\n${fs.readFileSync(path.join(worktree, source.path), "utf8").slice(0, fileChars)}`;
    } catch {
      return `（无法读取 ${source.path}）`;
    }
  }
  if (ticket) return `工单 #${ticket.ticket.id}《${ticket.ticket.title}》正文：\n${ticket.ticket.body.slice(0, bodyChars)}`;
  return "（无可展示的证据）";
}

export function buildJudgePrompt(batch: string, items: Array<{ record: Curated; evidence: string }>): string {
  const body = items
    .map(({ record, evidence }, index) => `### 记录 ${index + 1}: ${record.id}
\`\`\`json
${JSON.stringify({ kind: record.kind, statement: record.statement, status: record.status, certainty: record.certainty, capabilities: record.capabilities, rationale: record.rationale, quote: record.quote ?? null, supersedes: record.supersedes ?? [], superseded_by: record.superseded_by ?? null, conflict_note: record.conflict_note ?? null, source: record.source }, null, 0)}
\`\`\`
引用的证据：
${evidence}
`)
    .join("\n");
  return `你是知识回填的独立审阅者。下面是批次 ${batch} 的抽样记录，每条后面附它引用的原始证据（正文可能较长，引用可能出现在任何位置；quote 字段已由校验器逐字证实出自该证据）。按 architecture/knowledge/README.md 的合同逐条打分（只看证据，不要脑补）：

- supported：statement 没有超出 quote 及其上下文所能支持的范围——证据里找得到这件事，且 statement 没有补证据没有的数字、名称、原因、范围词（1/0）。忠实的复述或同义概括算 1；certainty=inferred 且 rationale 说明了依据的也算 1。
- atomic：只陈述一件事、≤400 字符、不是过程叙述（1/0）
- kind_ok：requirement/decision/non_goal/risk/principle 用对了（1/0）
- status_ok：status 与 supersedes/superseded_by/rejected/historical 的使用符合 R1–R3（没有矛盾迹象也算 1）（1/0）
- capability_ok：capabilities 归类合理（1/0）
- privacy_ok：没有 token/密码/个人信息，quote ≤120 字符（1/0）
- note：≤40 字说明扣分原因（没有扣分留空）

${body}

只输出一个 JSON 数组，每个元素形如 {"id":"cur:…","supported":1,"atomic":1,"kind_ok":1,"status_ok":1,"capability_ok":1,"privacy_ok":1,"note":""}，不要输出其他文字。`;
}

function runOmp(prompt: string, cwd: string, model: string, thinking: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("omp", ["-p", "--no-session", "--no-tools", "--model", model, "--thinking", thinking, prompt], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export function parseScores(output: string): Array<Record<string, unknown>> {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const opts = flags(process.argv.slice(2));
  const worktree = opts.get("worktree");
  const dossierDir = opts.get("dossiers");
  const out = opts.get("out");
  if (!worktree || !dossierDir || !out) throw new Error("--worktree, --dossiers and --out are required");
  const fraction = Number(opts.get("sample") ?? 0.2);
  const min = Number(opts.get("min") ?? 3);
  const seed = Number(opts.get("seed") ?? 0);
  const model = opts.get("model") ?? "openai-codex/gpt-5.6-sol";
  const thinking = opts.get("thinking") ?? "medium";
  const only = opts.get("only")?.split(",").map((item) => item.trim()).filter(Boolean);
  const recordsFrom = opts.get("records");
  const flaggedByBatch: Map<string, Set<string>> | null = recordsFrom
    ? new Map(Object.entries(JSON.parse(fs.readFileSync(path.resolve(recordsFrom), "utf8")) as Record<string, { flagged?: Array<{ id: string }> }>)
        .map(([batch, value]) => [batch, new Set((value.flagged ?? []).map((item) => item.id))]))
    : null;
  fs.mkdirSync(out, { recursive: true });
  const dossiers = new Map<number, Dossier>();
  for (const file of fs.readdirSync(path.join(dossierDir, "dossiers"))) {
    const dossier = JSON.parse(fs.readFileSync(path.join(dossierDir, "dossiers", file), "utf8")) as Dossier;
    dossiers.set(dossier.ticket.id, dossier);
  }
  const curatedDir = path.join(worktree, "architecture/knowledge/curated");
  const files = fs.readdirSync(curatedDir).filter((name) => name.endsWith(".jsonl")).filter((name) => !only || only.includes(name.replace(/\.jsonl$/, ""))).sort();
  const judgeFile = path.join(out, "judge.json");
  const results: Record<string, unknown> = fs.existsSync(judgeFile) ? (JSON.parse(fs.readFileSync(judgeFile, "utf8")) as Record<string, unknown>) : {};
  const concurrency = Number(opts.get("concurrency") ?? 3);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      const batch = file.replace(/\.jsonl$/, "");
      const records = fs.readFileSync(path.join(curatedDir, file), "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Curated);
      const picked = flaggedByBatch
        ? records.filter((record) => flaggedByBatch.get(batch)?.has(record.id))
        : sample(records, fraction, min, seed);
      if (!picked.length) {
        results[batch] = { records: records.length, sampled: 0, scored: 0, rates: {}, flagged: [], minutes: 0 };
        continue;
      }
      const items = picked.map((record) => ({ record, evidence: evidenceFor(record, dossiers, worktree) }));
      const prompt = buildJudgePrompt(batch, items);
      fs.writeFileSync(path.join(out, `${batch}.prompt.md`), prompt);
      const started = Date.now();
      const output = await runOmp(prompt, worktree, model, thinking, 15 * 60_000);
      fs.writeFileSync(path.join(out, `${batch}.raw.txt`), output);
      const scores = parseScores(output);
      const keys = ["supported", "atomic", "kind_ok", "status_ok", "capability_ok", "privacy_ok"] as const;
      const totals: Record<string, number> = {};
      for (const key of keys) totals[key] = scores.reduce((sum, score) => sum + (Number(score[key]) === 1 ? 1 : 0), 0);
      results[batch] = {
        records: records.length,
        sampled: picked.length,
        scored: scores.length,
        rates: Object.fromEntries(keys.map((key) => [key, scores.length ? Math.round((totals[key] / scores.length) * 100) / 100 : null])),
        flagged: scores.filter((score) => keys.some((key) => Number(score[key]) !== 1)).map((score) => ({ id: score.id, note: score.note })),
        minutes: Math.round((Date.now() - started) / 6_000) / 10,
      };
      fs.writeFileSync(path.join(out, "judge.json"), JSON.stringify(results, null, 2));
      const rates = (results[batch] as { rates: Record<string, number | null> }).rates;
      console.log(`${batch}: sampled ${picked.length}/${records.length} scored ${scores.length} supported=${rates.supported} status_ok=${rates.status_ok} capability_ok=${rates.capability_ok}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
