#!/usr/bin/env node
/**
 * Drive the historical backfill with headless coding agents, one per batch.
 *
 *   tsx packages/bot/src/knowledge/backfill/run-backfill.ts \
 *     --batches <dossier-dir>/batches --worktree <repo worktree> --out <dossier-dir>/runs \
 *     [--only b01,b02] [--concurrency 3] [--model openai-codex/gpt-5.6-sol] [--thinking medium] [--dry-run]
 *     [--repair <judge.json>]   # second pass: feed the independent review back and re-audit each file
 *     [--repair-evidence <judge.json>] [--evidence <dossier-dir>]   # third pass: verbatim quotes, validator-enforced
 *
 * Each agent reads one batch JSON (ticket bodies, messages, commits, existing
 * statements), writes exactly one `architecture/knowledge/curated/<batch>.jsonl`
 * in the worktree under the contract in architecture/knowledge/README.md, and
 * must leave `pnpm knowledge:validate` green. This runner re-validates every
 * file afterwards and records a status line per batch; it never commits.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface Manifest {
  batches: Array<{ batch: string; capability: string; tickets: number[]; chars: number }>;
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

export function buildPrompt(args: { batch: string; capability: string; tickets: number[]; batchFile: string; worktree: string }): string {
  const outFile = `architecture/knowledge/curated/${args.batch}.jsonl`;
  return `你是 Octopus 仓库知识回填 agent。工作目录是 ${args.worktree}（一个 git worktree）。本批次 ${args.batch}，主能力 ${args.capability}，工单 ${args.tickets.map((id) => `#${id}`).join(" ")}。

## 任务
把批次文件 ${args.batchFile} 里每张工单的**用户需求、最终决策、明确非目标、后续风险**抽成原子语句，按 architecture/knowledge/README.md 的合同写入 ${outFile}（JSON Lines，每行一条）。只写这一个文件。

## 必读（先读，再动手）
1. architecture/knowledge/README.md —— 记录字段合同与 R1–R10 去重/冲突规则，逐条遵守。
2. architecture/capabilities.json —— 只能使用其中的 capability id。
3. architecture/atlas.json 的 modules[].id —— modules 字段只能用这些 id；paths 必须是当前工作树里存在的仓库相对路径。

## 批次文件怎么读
JSON，\`tickets[]\` 每项：\`ticket\`（id/title/body/requester/kind/dev_status/created_at/landed_at/commit_sha/messages[]）、\`commits[]\`（sha/subject/files）、\`deliveries[]\`（相关交付文档路径，可用 cat 读）、\`cli_report\`（kind=cli 时的简报路径；其 v2 字段已自动入图，不要重复）、\`landing[]\`（已有的结构化落地知识，不要重复）、\`capabilities[]\`（分类建议，可修正）、\`existing_statements[]\`（图里已有的相关语句：同义的不要再写，需要表达取代关系时引用其 id）。

## 写什么、不写什么
- requirement：用户原话的意图复述（现在时，不写实现）；一张工单通常 1–4 条。
- decision：最终采用的做法与理由；被否决的替代方案单独一条 decision，status=rejected。
- non_goal：明确没做 / 不得出现的事。risk：后续改动必须留意的事。
- principle：只在用户或 agent 明确提出跨工单通用规则时使用。
- 不写过程叙述、测试结果、commit 列表；**一条记录只陈述一件事**（出现"并且/以及/同时/、"串起多个动作或对象时拆成多条），≤ 400 字符，单行；quote ≤ 120 字符。
- **只写证据里有的**：statement 必须能由引用的正文/消息/文档直接支持；证据没有的数字、名称、原因不要补。需要概括或推断时把 certainty 设为 inferred，并在 rationale 说明推断依据。
- kind 判定：用户提出的要求 → requirement（即使后来实现了）；agent 或用户在讨论中选定的做法 → decision；明确"不做/不得" → non_goal；"以后改动要小心" → risk。验收项、工作流程要求、持续性安全要求都是 requirement，不是 decision 或 risk。
- 按三档证据裁决，不因消息较新就推翻原始人类要求（R1）；工单取消或用户说"不做"→ rejected（R3）；与当前包级文档/代码矛盾时记录实现偏差，不能自动降级用户要求（R2）；拿不准 → certainty=ambiguous + conflict_note（R5），不要替用户裁决。
- 每条 source 必须指向具体来源：ticket_body / ticket_message(带 message_id) / delivery(带 path) / commit(带 sha) / cli_report(带 path)。
- 不写 token、密码、私钥、个人信息。
- id 用 cur:${args.batch}:<ticket>:<n>，n 从 1 递增。

## 步骤
1. 读 README、capabilities.json、atlas modules。
2. 读批次文件；对每张工单：先看 existing_statements 和 landing，再从 body 与 messages 抽语句。
3. 写入 ${outFile}。
4. 运行 \`pnpm knowledge:validate -- ${outFile}\`（在工作目录执行），修到 0 error。
5. 最后只输出一段 JSON 总结：{"batch":"${args.batch}","records":<条数>,"tickets":<覆盖的工单数>,"ambiguous":<条数>,"superseded":<条数>,"rejected":<条数>,"notes":"<≤200字的说明，例如哪些工单没有可抽取的知识及原因>"}。

## 禁止
- 不得修改或创建 ${outFile} 之外的任何文件；不得 git add/commit/checkout/stash；不得改动 bot.db 或访问网络。
- 不要把工单正文整段复制进 statement；不要编造模块名或路径。`;
}

export function buildRepairPrompt(args: { batch: string; worktree: string; flagged: Array<{ id: string; note: string }> }): string {
  const file = `architecture/knowledge/curated/${args.batch}.jsonl`;
  const examples = args.flagged.length
    ? args.flagged.map((item) => `- ${item.id}：${item.note}`).join("\n")
    : "- （抽样未发现问题；仍需按下面的规则复核整个文件）";
  return `你是 Octopus 仓库知识回填的修复 agent。工作目录 ${args.worktree}。只允许修改 ${file}，不得改任何其它文件，不得 git 操作。

独立审阅抽样了这个文件，指出了这些问题（这是样本，同类问题在未抽到的记录里也要修）：
${examples}

## 按规则逐条复核整个文件
读 architecture/knowledge/README.md（合同与 R1–R10），然后对文件里每一条记录做四件事：
1. **原子性**：一条记录只陈述一件事。用"并且/以及/同时/、"串起多个动作、对象或要求的，拆成多条（新记录 id 继续沿用 cur:${args.batch}:<ticket>:<n>，n 接着已有最大值递增；被拆的原记录可以改写成其中一条，保持 id）。
2. **证据支持**：statement 必须能由 source 指向的证据直接支持。证据没有的数字、名称、原因、范围词要删掉；如果是合理概括或推断，certainty 改为 inferred 并在 rationale 说明依据；完全无依据的记录删除。
3. **kind**：用户提出的要求 → requirement；讨论中选定的做法 → decision；明确"不做/不得" → non_goal；"以后改动要小心" → risk；principle 只给跨工单的通用规则。验收项、工作流程要求、持续性安全要求属于 requirement。
4. **status**：取消/放弃 → rejected 且 rationale 引用依据；被后续工单推翻 → superseded + superseded_by；与现行文档矛盾 → historical；拿不准 → ambiguous + conflict_note。没有依据不要改 status。

不要改动 source 指向；不要新增 quote 之外的引用；不要删除仍然正确的记录。

## 收尾
运行 \`pnpm knowledge:validate -- ${file}\` 修到 0 error，然后只输出一段 JSON：{"batch":"${args.batch}","before":<修复前条数>,"after":<修复后条数>,"split":<拆分条数>,"downgraded":<改为 inferred 条数>,"deleted":<删除条数>,"kind_changes":<改 kind 条数>,"notes":"<≤120 字>"}。`;
}

export function buildEvidencePrompt(args: { batch: string; worktree: string; evidenceDir: string; flagged: Array<{ id: string; note: string }> }): string {
  const file = `architecture/knowledge/curated/${args.batch}.jsonl`;
  const examples = args.flagged.length ? args.flagged.map((item) => `- ${item.id}：${item.note}`).join("\n") : "- （本批抽样未被标记；规则同样适用于每一条）";
  const command = `pnpm knowledge:validate -- --evidence ${args.evidenceDir} ${file}`;
  return `你是 Octopus 知识回填的证据锚定修复 agent。工作目录 ${args.worktree}。只允许修改 ${file}；不得改其它文件，不得 git 操作。

两轮独立复核发现：约 20% 的记录在陈述里补了引用来源没有的细节。被标记的样本（同类问题在未抽到的记录里也要修）：
${examples}

## 新的机械规则（校验器已强制）
每条 certainty=exact 的记录必须带 quote：≤120 字符、**逐字**出自 source 指向的那段文本（ticket_body → 工单正文；ticket_message → 该 message_id 的消息；delivery/cli_report → 该文件），且 statement 的含义不得超出 quote 能支持的范围。校验命令会逐字核对 quote 是否出现在来源里。

## 对文件里每一条记录
1. 找出来源里能支持 statement 的原话，填进 quote（≤120 字符，不改字、不拼接两处）。
2. 若 statement 比原话多出数字、名称、原因、范围词，删掉多出的部分，让 statement 是原话的忠实复述。
3. 若找不到能支持的原话：要么删除记录，要么把 certainty 改为 inferred，并在 rationale 写清推断依据（来自哪条消息/哪段文档的什么内容）。inferred 不要求 quote，但不得超过 10% 的记录。
4. 不改 id、不改 source 指向、不改 kind/status（除非明显错误）；不新增记录。

## 收尾
运行 ${command} 修到 0 error（错误 "quote not found verbatim" 表示 quote 不是原话；"exact statements need a verbatim quote" 表示缺 quote）。然后只输出一段 JSON：{"batch":"${args.batch}","before":<条数>,"after":<条数>,"quoted":<补/改 quote 条数>,"trimmed":<收窄 statement 条数>,"downgraded":<改 inferred 条数>,"deleted":<删除条数>,"notes":"<≤120 字>"}。`;
}

async function run(cmd: string, args: string[], opts: { cwd: string; log: fs.WriteStream; timeoutMs: number }): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => opts.log.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => opts.log.write(chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      opts.log.write(`spawn error: ${String(error)}\n`);
      resolve(-1);
    });
  });
}

function validate(worktree: string, file: string, evidenceDir?: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const args = ["knowledge:validate", "--", ...(evidenceDir ? ["--evidence", evidenceDir] : []), file];
    execFile("pnpm", args, { cwd: worktree, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}\n${stderr}`.trim() });
    });
  });
}

async function main(): Promise<void> {
  const opts = flags(process.argv.slice(2));
  const batchesDir = opts.get("batches");
  const worktree = opts.get("worktree");
  const out = opts.get("out");
  if (!batchesDir || !worktree || !out) throw new Error("--batches, --worktree and --out are required");
  const manifest = JSON.parse(fs.readFileSync(path.join(batchesDir, "..", "manifest.json"), "utf8")) as Manifest;
  const only = opts.get("only")?.split(",").map((item) => item.trim()).filter(Boolean);
  const batches = manifest.batches.filter((item) => !only || only.includes(item.batch));
  const concurrency = Number(opts.get("concurrency") ?? 3);
  const model = opts.get("model") ?? "openai-codex/gpt-5.6-sol";
  const thinking = opts.get("thinking") ?? "medium";
  const timeoutMs = Number(opts.get("timeout-min") ?? 40) * 60_000;
  const dryRun = opts.get("dry-run") === "true";
  const repairFrom = opts.get("repair") ?? opts.get("repair-evidence");
  const evidenceMode = opts.has("repair-evidence");
  const evidenceDir = opts.get("evidence") ?? path.resolve(batchesDir, "..");
  const judge = repairFrom
    ? (JSON.parse(fs.readFileSync(path.resolve(repairFrom), "utf8")) as Record<string, { flagged?: Array<{ id: string; note: string }> }>)
    : null;
  fs.mkdirSync(path.join(out, "logs"), { recursive: true });
  fs.mkdirSync(path.join(worktree, "architecture/knowledge/curated"), { recursive: true });
  const statusFile = path.join(out, "status.json");
  const status: Record<string, unknown> = fs.existsSync(statusFile) ? (JSON.parse(fs.readFileSync(statusFile, "utf8")) as Record<string, unknown>) : {};
  const save = () => fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));

  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const item = batches[next];
      next += 1;
      const batchFile = path.resolve(batchesDir, `${item.batch}.json`);
      const prompt = judge
        ? evidenceMode
          ? buildEvidencePrompt({ batch: item.batch, worktree, evidenceDir, flagged: judge[item.batch]?.flagged ?? [] })
          : buildRepairPrompt({ batch: item.batch, worktree, flagged: judge[item.batch]?.flagged ?? [] })
        : buildPrompt({ ...item, batchFile, worktree });
      fs.writeFileSync(path.join(out, "logs", `${item.batch}${judge ? ".repair" : ""}.prompt.md`), prompt);
      if (dryRun) {
        status[item.batch] = { state: "dry-run", tickets: item.tickets.length };
        save();
        continue;
      }
      const started = Date.now();
      status[item.batch] = { state: "running", started_at: new Date(started).toISOString(), tickets: item.tickets.length };
      save();
      const log = fs.createWriteStream(path.join(out, "logs", `${item.batch}${judge ? ".repair" : ""}.log`), { flags: "a" });
      log.write(`\n===== ${item.batch} ${new Date().toISOString()} model=${model}\n`);
      const code = await run("omp", ["-p", "--no-session", "--auto-approve", "--model", model, "--thinking", thinking, "--cwd", worktree, prompt], { cwd: worktree, log, timeoutMs });
      const file = `architecture/knowledge/curated/${item.batch}.jsonl`;
      const exists = fs.existsSync(path.join(worktree, file));
      const validation = exists ? await validate(worktree, file, evidenceMode ? evidenceDir : undefined) : { ok: false, output: "file not written" };
      const lines = exists ? fs.readFileSync(path.join(worktree, file), "utf8").split("\n").filter((line) => line.trim()).length : 0;
      log.write(`\n----- validate (${validation.ok ? "ok" : "FAILED"}):\n${validation.output}\n`);
      log.end();
      status[item.batch] = {
        state: validation.ok ? "valid" : exists ? "invalid" : "missing",
        exit_code: code,
        records: lines,
        tickets: item.tickets.length,
        minutes: Math.round((Date.now() - started) / 6_000) / 10,
        validation: validation.output.split("\n").slice(-3).join(" | ").slice(0, 400),
      };
      save();
      console.log(`${item.batch}: ${String((status[item.batch] as { state: string }).state)} records=${lines} (${Math.round((Date.now() - started) / 60_000)} min)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  const summary = Object.entries(status).map(([batch, value]) => `${batch}=${String((value as { state: string }).state)}`).join(" ");
  console.log(`backfill: ${summary}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
