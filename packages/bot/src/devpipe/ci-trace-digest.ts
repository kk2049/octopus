/**
 * Turn a GitLab job trace into the few hundred characters a repair agent
 * actually needs.
 *
 * The old path handed the repair ticket `trace.slice(-5_000)`. Measured on a
 * real red batch (pipeline #19, ticket #50) that window was 15% ANSI escapes,
 * 27% per-line `2026-08-10T07:51:40.665385Z 01E ` prefixes, and ~4% signal —
 * and because it is a byte tail rather than a structural one it showed 1 of the
 * 70 failing tests. The repair agent then spent its first turns rediscovering a
 * failure list the trace already contained.
 *
 * So parse instead of tail: pull the Vitest failure roster (and tsc
 * diagnostics) out of the WHOLE trace, aggregate by file, and emit a bounded
 * digest that names every failing file. GitLab remains the canonical log store;
 * the ticket always keeps the job URL for anyone who wants the raw bytes.
 */

/** One failing test, as the trace reported it. */
export interface CiFailure {
  /** Repo-relative test file. */
  file: string;
  /** `suite > case` chain, when the FAIL line carried one. */
  test?: string;
  /** First error line attributed to this failure. */
  reason?: string;
  /** `line:col` of the frame Vitest pointed at inside `file`. */
  at?: string;
}

export interface CiTraceDigest {
  /** Agent-facing text. Bounded by `maxChars`. */
  text: string;
  /** Everything the parser recognised, in trace order. */
  failures: CiFailure[];
  /** Vitest's own totals, when the run got far enough to print them. */
  counts?: {
    filesFailed?: number;
    filesPassed?: number;
    testsFailed?: number;
    testsPassed?: number;
  };
  /** True when the roster was cut to fit, or the fallback tail was clipped. */
  truncated: boolean;
  /** False when nothing structural parsed and `text` is a cleaned tail. */
  structured: boolean;
}

// `\u001B` rather than a literal ESC byte: a raw control character in
// source is invisible in review and easy to lose to an editor round-trip.
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;
/** GitLab stamps every trace line with an RFC3339 time and a stream tag. */
const RUNNER_PREFIX = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\s+\d+[A-Z]\s?/;
/**
 * `FAIL  node packages/bot/src/x.test.ts > suite > case`, and the shape a
 * COLLECTION error takes: `FAIL  packages/bot/src/x.test.ts [ …same path… ]`,
 * which has no `>` chain at all. Anchoring the tail would drop that second
 * shape entirely — and a file that would not even load is exactly the failure
 * a repair agent most needs to see named.
 */
const FAIL_LINE =
  /\bFAIL\b\s+(?:\S+\s+)??((?:[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s*>\s*(.+))?/;
/** `AssertionError: expected 4544 to be less than or equal to 4000` */
const ERROR_LINE = /^\s*((?:[A-Z][\w.]*)?Error|[A-Z][\w.]*Exception)\s*:\s*(.+)$/;
/** Vitest's stack pointer: `❯ packages/bot/src/x.test.ts:149:74` */
const FRAME_LINE = /❯\s+(\S+?):(\d+):(\d+)/;
/** `packages/bot/src/x.ts(12,5): error TS2345: ...` */
const TS_ERROR = /^(\S+?)[(:](\d+)[,:](\d+)\)?\s*:?\s*error\s+(TS\d+)\s*:\s*(.+)$/;

/** Strip the runner's per-line bookkeeping so the payload is what remains. */
export function cleanTraceLines(trace: string): string[] {
  return trace
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.replace(RUNNER_PREFIX, "").replace(/\s+$/, ""));
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Vitest's summary lines carry both numbers; read them positionally-free. */
function tallyLine(lines: string[], label: RegExp): { failed?: number; passed?: number } {
  // Sum across every matching summary line: the CI job runs the suite in
  // serial batches and each batch prints its own `Test Files` / `Tests`
  // tally, so the first match alone would report one batch as the whole run.
  let failed: number | undefined;
  let passed: number | undefined;
  for (const line of lines) {
    if (!label.test(line)) continue;
    const f = /(\d+)\s+failed/.exec(line);
    const p = /(\d+)\s+passed/.exec(line);
    if (f) failed = (failed ?? 0) + Number(f[1]);
    if (p) passed = (passed ?? 0) + Number(p[1]);
  }
  return {
    ...(failed != null ? { failed } : {}),
    ...(passed != null ? { passed } : {}),
  };
}

function pushFailure(into: CiFailure[], seen: Set<string>, failure: CiFailure): void {
  // The separator is an ESCAPE for the same reason ANSI above is one: it used
  // to be a literal NUL byte in the source, which made Git classify this whole
  // file as binary — every diff of it, this ticket's included, printed as
  // "Bin 9703 -> 11094 bytes". Identical bytes at runtime, reviewable at rest.
  const key = `${failure.file}\u0000${failure.test ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  into.push(failure);
}

/**
 * Extract the failure roster. Exported separately from rendering so the counts
 * can be asserted without matching on prose.
 */
export function parseCiTrace(trace: string): {
  failures: CiFailure[];
  counts: NonNullable<CiTraceDigest["counts"]>;
  lines: string[];
} {
  const lines = cleanTraceLines(trace);
  const failures: CiFailure[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const ts = TS_ERROR.exec(line);
    if (ts) {
      pushFailure(failures, seen, {
        file: ts[1],
        test: `${ts[4]} @${ts[2]}:${ts[3]}`,
        reason: `${ts[4]}: ${ts[5]}`.slice(0, 240),
        at: `${ts[2]}:${ts[3]}`,
      });
      continue;
    }

    const fail = FAIL_LINE.exec(line);
    if (!fail) continue;
    const failure: CiFailure = { file: fail[1] };
    const chain = (fail[2] ?? "").trim();
    if (chain) failure.test = chain.slice(0, 160);

    // Vitest prints the error and the frame within a handful of lines of the
    // FAIL header. Stop at the next FAIL so two failures never trade details.
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
      const next = lines[j];
      if (FAIL_LINE.test(next)) break;
      if (!failure.reason) {
        const err = ERROR_LINE.exec(next);
        if (err) failure.reason = `${err[1]}: ${err[2]}`.trim().slice(0, 240);
      }
      if (!failure.at) {
        const frame = FRAME_LINE.exec(next);
        // Vitest prints project-relative frames while the FAIL header is
        // repo-relative, so compare the leaf and ignore foreign frames.
        if (frame && baseName(frame[1]) === baseName(failure.file)) failure.at = `${frame[2]}:${frame[3]}`;
      }
      if (failure.reason && failure.at) break;
    }
    pushFailure(failures, seen, failure);
  }

  const files = tallyLine(lines, /^\s*Test Files\s/);
  const tests = tallyLine(lines, /^\s*Tests\s/);
  const counts = {
    ...(files.failed != null ? { filesFailed: files.failed } : {}),
    ...(files.passed != null ? { filesPassed: files.passed } : {}),
    ...(tests.failed != null ? { testsFailed: tests.failed } : {}),
    ...(tests.passed != null ? { testsPassed: tests.passed } : {}),
  };
  return { failures, counts, lines };
}

export interface DigestOptions {
  /** Hard ceiling on the rendered text. */
  maxChars?: number;
  /** How many distinct files to name before summarising the rest. */
  maxFiles?: number;
}

/** A Vitest spec file. TS diagnostics name source files; those are tsc's job. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** The `● packages/bot/src/x.test.ts (9 条)` header `digestCiTrace` renders. */
const ROSTER_LINE = /^●\s+(\S+?)(?:\s+\(\d+\s*条\))?\s*$/;

/**
 * Read the failing-file roster back out of a rendered digest.
 *
 * The inverse of the `● <file>` header above, and deliberately so: the digest
 * text is already persisted on the test-run row, so the roster survives a bot
 * restart, a red row observed on a later poll, and the repair ticket being
 * opened minutes after the trace was fetched — none of which an in-memory
 * hand-off between `finishFailed` and `openRepairTicket` would survive. The
 * format is ours and this parser is tested against the renderer.
 *
 * Only spec files come back. A tsc diagnostic renders with the same bullet but
 * names a SOURCE file, and handing that to `vitest run` is a refusal that says
 * nothing — the land gate's typecheck step already owns that failure class.
 */
export function rosterFromDigestText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = ROSTER_LINE.exec(raw.trim());
    if (!m || !TEST_FILE.test(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

/**
 * Render the digest. Aggregating by file is deliberate: 70 failures are almost
 * always a handful of causes, and the file roster is what decides whether this
 * is one repair or several.
 */
export function digestCiTrace(trace: string, options: DigestOptions = {}): CiTraceDigest {
  const maxChars = options.maxChars ?? 3_000;
  const maxFiles = options.maxFiles ?? 20;
  const { failures, counts, lines } = parseCiTrace(trace);
  const hasCounts = Object.keys(counts).length > 0;

  if (failures.length === 0) {
    // Nothing structural: still hand back the CLEANED tail rather than raw
    // bytes. On the measured sample that alone is ~2x the information density.
    const cleaned = lines.filter((line) => line.trim() !== "").join("\n");
    const truncated = cleaned.length > maxChars;
    return {
      text: truncated ? cleaned.slice(-maxChars) : cleaned,
      failures: [],
      ...(hasCounts ? { counts } : {}),
      truncated,
      structured: false,
    };
  }

  const byFile = new Map<string, CiFailure[]>();
  for (const failure of failures) {
    const list = byFile.get(failure.file);
    if (list) list.push(failure);
    else byFile.set(failure.file, [failure]);
  }

  const head: string[] = [];
  if (counts.filesFailed != null || counts.testsFailed != null) {
    const parts: string[] = [];
    if (counts.filesFailed != null) {
      parts.push(
        `测试文件 ${counts.filesFailed} 失败${counts.filesPassed != null ? ` / ${counts.filesPassed} 通过` : ""}`,
      );
    }
    if (counts.testsFailed != null) {
      parts.push(
        `用例 ${counts.testsFailed} 失败${counts.testsPassed != null ? ` / ${counts.testsPassed} 通过` : ""}`,
      );
    }
    head.push(parts.join(";"));
  }
  head.push(`解析出 ${failures.length} 条失败,分布在 ${byFile.size} 个文件:`);

  const body: string[] = [];
  const files = [...byFile.entries()];
  let truncated = false;
  for (const [file, list] of files.slice(0, maxFiles)) {
    body.push(`\n● ${file}${list.length > 1 ? ` (${list.length} 条)` : ""}`);
    const first = list[0];
    if (first.test) body.push(`  ↳ ${first.test}${first.at ? ` @${first.at}` : ""}`);
    if (first.reason) body.push(`     ${first.reason}`);
    if (list.length > 1) {
      const rest = list.slice(1, 3).map((f) => f.test).filter(Boolean);
      if (rest.length) body.push(`     同文件还有:${rest.join(" / ")}${list.length > 3 ? " …" : ""}`);
    }
  }
  if (files.length > maxFiles) {
    truncated = true;
    body.push(`\n…还有 ${files.length - maxFiles} 个文件失败,见 GitLab 完整日志。`);
  }

  const CUT_NOTE = "\n…(摘要已截断,完整日志见 GitLab)";
  let text = [...head, ...body].join("\n");
  if (text.length > maxChars) {
    truncated = true;
    // Keep `maxChars` a real ceiling: the note has to fit inside it, not on
    // top of it, or every caller's budget is quietly wrong by a constant.
    text = text.slice(0, Math.max(0, maxChars - CUT_NOTE.length)) + CUT_NOTE;
  }
  return {
    text,
    failures,
    ...(hasCounts ? { counts } : {}),
    truncated,
    structured: true,
  };
}
