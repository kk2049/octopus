/**
 * Which substrings of a transcript are FILES — a display heuristic, and
 * deliberately nothing else.
 *
 * ── Why a heuristic is allowed here at all ──────────────────────────────────
 *
 * Nothing in this file can open anything. It produces STRINGS that a reader may
 * click. Each Host then resolves that claim through its own authorized file
 * provider. The scanner cannot fabricate a ref, choose a repository, skip a
 * Gate or perform an I/O operation.
 *
 * That is what makes a permissive-looking scanner acceptable, and it is also
 * why the scanner is still conservative: a paragraph of prose peppered with
 * blue words nobody meant to click is a worse surface than a plain one.
 *
 * ── The grammar, stated once ────────────────────────────────────────────────
 *
 * A candidate is a maximal run of path characters. `:` is NOT one of them, on
 * purpose: `src/a.ts:120` then scans as `src/a.ts` followed by `120`, so the
 * line-number suffix agents write is dropped from the target instead of
 * breaking it, and `https:` never joins its own authority.
 *
 * A path character is an ASCII path character OR any Unicode letter, number or
 * combining mark (ticket #201). Filenames on this fleet are routinely Chinese —
 * `~/lht/oh-my-pi-技术报告.md` is a real one — and an ASCII-only run stopped at
 * the first CJK byte, so the most common path an agent writes here was the one
 * form that never became a link. Punctuation stays OUT of the class in both
 * scripts, which is what keeps the run from swallowing the sentence around it:
 * `（`, `，`, `。`, `》` are `\p{P}`, exactly like `(`, `,` and `.`-as-a-period
 * would be if they were not needed inside names.
 *
 * A candidate is a file when its last segment ends in a plausible extension —
 * 1–8 alphanumerics, never all digits (that is a version number, `v4.0`). On
 * top of that:
 *
 *  · anchored (`/…`, `~/…`, `./…`, `../…`) — accepted; the anchor is the claim.
 *  · relative WITH a slash — accepted, unless its first segment looks like a
 *    hostname (`example.com/a.ts` is a URL somebody dropped the scheme from).
 *  · a bare name — accepted only for a known extension, and never for the
 *    handful of stems prose writes with a dot (`Node.js`, `Vue.js`).
 *
 * A directory is never a candidate: it has no extension, and `planWalk` would
 * refuse it anyway with a sentence about expanding the index instead.
 */

/** Longer than any path worth offering; also the bound on one scanned token. */
const MAX_PATH_LENGTH = 200;

/** Never scan more than this much of one tool output for mentions. */
const SCAN_LIMIT = 20_000;

/**
 * One maximal run of path characters. Deliberately excludes `:` — see above.
 *
 * A fresh instance per call: a shared `/g` literal carries `lastIndex` between
 * a `matchAll` and a `replace`, which is a scanner that silently skips the
 * first half of the second caller's text.
 */
function pathRun(): RegExp {
  return /[A-Za-z0-9_.\-+@~/\\\p{L}\p{N}\p{M}]+/gu;
}

/** Anything outside the run alphabet. One definition, used by `filePathOf`. */
const NOT_PATH_CHAR = /[^A-Za-z0-9_.\-+@~/\p{L}\p{N}\p{M}]/u;

/** A hostname-shaped first segment, i.e. a URL with the scheme left off. */
const HOSTNAME = /^(?:[\w-]+\.)+[a-z]{2,}$/i;

/** A trailing `:120` / `:120:4` an agent appended to point at a line. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/**
 * Extensions a BARE name (no slash, no anchor) may carry.
 *
 * A bare name has no path context at all, so it is the one case where the
 * extension is the entire evidence. Keeping the list closed is what stops
 * ordinary prose — a version, an abbreviation, a sentence-ending word — from
 * becoming a link.
 */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "lock",
  "md", "mdx", "txt", "csv", "tsv", "log", "sql", "graphql", "proto", "prisma",
  "css", "scss", "less", "html", "htm", "xml", "svg", "vue", "svelte",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp",
  "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "lua", "r", "pl",
  "gradle", "make", "mk", "dockerfile", "tf", "tfvars", "patch", "diff",
]);

/**
 * Stems prose writes with a dot. Only consulted for BARE names, where there is
 * no other evidence; `docs/node.js` still resolves as a path.
 */
const PROSE_STEMS: ReadonlySet<string> = new Set([
  "node", "next", "nuxt", "vue", "react", "three", "d3", "chart", "socket",
  "express", "jquery", "moment", "lodash", "webpack", "vite", "esbuild",
  "rollup", "babel", "deno", "bun", "ember", "backbone", "angular",
]);

/**
 * The path this token claims to be, or `""`.
 *
 * Pure, total, and the single definition both the scanner and the Markdown
 * rewriter consult — two grammars would mean a path that is a link in prose and
 * plain text in a tool card, which reads as a bug in the feature rather than a
 * boundary of it.
 */
export function filePathOf(raw: string): string {
  const value = raw.trim().replace(/\\/g, "/").replace(LINE_SUFFIX, "");
  if (!value || value.length > MAX_PATH_LENGTH) return "";
  // `…` is an elision the projection made; `//` is what is left of a URL after
  // its scheme was split off by the `:` this grammar refuses.
  if (value.includes("…") || value.includes("//")) return "";
  if (NOT_PATH_CHAR.test(value)) return "";
  const anchored = value.startsWith("/")
    || value === "~"
    || value.startsWith("~/")
    || value.startsWith("./")
    || value.startsWith("../");
  const segments = value.split("/").filter((part) => part && part !== "." && part !== "..");
  const name = segments[segments.length - 1] ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  const extension = name.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(extension) || /^\d+$/.test(extension)) return "";
  if (anchored) return value;
  if (value.includes("/")) {
    return HOSTNAME.test(value.split("/")[0]!) ? "" : value;
  }
  if (!KNOWN_EXTENSIONS.has(extension)) return "";
  return PROSE_STEMS.has(name.slice(0, dot).toLowerCase()) ? "" : value;
}

/**
 * Every file this text mentions, in order of appearance, deduplicated.
 *
 * Written for a tool call's recorded input and output: those are JSON blobs and
 * command transcripts, where the paths a reader wants are quoted, comma
 * separated or embedded in a diff header — all of which the run scanner already
 * splits correctly, and none of which is Markdown.
 */
export function findFilePaths(text: string | undefined, limit = 12): string[] {
  if (!text) return [];
  const source = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(pathRun())) {
    if (out.length >= limit) break;
    const path = filePathOf(match[0]);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Rewrite the file paths in one Markdown document as Markdown links.
 *
 * This is how a path in ORDINARY PROSE becomes clickable without teaching the
 * Markdown renderer a path grammar: the renderer stays swappable presentation,
 * and the surface that already turns a schemeless link into an open request
 * (`components/Transcript.tsx`) handles the result with no new code path. A
 * link target here is therefore exactly as authoritative as a link an agent
 * typed by hand — which is to say, not at all.
 *
 * What it must never do is corrupt the document:
 *
 *  · fenced code blocks are copied verbatim — a rewritten sample is a wrong
 *    sample, and nobody clicks a path inside a diff they are reading as code;
 *  · an existing link or image is copied verbatim, so a target already chosen
 *    by the author wins;
 *  · an inline code span becomes `[`path`](path)` only when the WHOLE span is
 *    one path, which is how agents actually write file references.
 */
export function linkifyFilePaths(markdown: string, preserveLine = false): string {
  if (!markdown || !/[./~]/.test(markdown)) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence = "";
  for (const line of lines) {
    const fenced = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (fenced && fenced[1]![0] === fence[0] && fenced[1]!.length >= fence.length) fence = "";
      continue;
    }
    if (fenced) {
      fence = fenced[1]!;
      out.push(line);
      continue;
    }
    out.push(linkifyLine(line, preserveLine));
  }
  return out.join("\n");
}

/** Special characters that end a plain run and start a construct. */
const SPECIAL = "`[<!";

function linkifyLine(line: string, preserveLine: boolean): string {
  let out = "";
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === "`") {
      const ticks = /^`+/.exec(line.slice(index))![0];
      const close = line.indexOf(ticks, index + ticks.length);
      if (close === -1) return out + line.slice(index);
      const raw = line.slice(index, close + ticks.length);
      const value = line.slice(index + ticks.length, close).trim();
      const path = filePathOf(value);
      out += path ? `[${raw}](${preserveLine ? value : path})` : raw;
      index = close + ticks.length;
      continue;
    }
    if (char === "[" || (char === "!" && line[index + 1] === "[")) {
      const construct = markdownLinkAt(line, index);
      if (construct) {
        out += construct;
        index += construct.length;
        continue;
      }
    }
    if (char === "<") {
      const close = line.indexOf(">", index);
      if (close !== -1) {
        out += line.slice(index, close + 1);
        index = close + 1;
        continue;
      }
    }
    let end = index;
    while (end < line.length && !SPECIAL.includes(line[end]!)) end += 1;
    if (end === index) {
      out += char;
      index += 1;
      continue;
    }
    out += linkifyPlain(line.slice(index, end), preserveLine);
    index = end;
  }
  return out;
}

/** The whole `[text](url)` / `![alt](url)` construct at `start`, or `""`. */
function markdownLinkAt(line: string, start: number): string {
  const open = line[start] === "!" ? start + 1 : start;
  if (line[open] !== "[") return "";
  let depth = 0;
  let cursor = open;
  for (; cursor < line.length; cursor += 1) {
    if (line[cursor] === "[") depth += 1;
    else if (line[cursor] === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || line[cursor + 1] !== "(") return "";
  const close = line.indexOf(")", cursor + 2);
  return close === -1 ? "" : line.slice(start, close + 1);
}

function linkifyPlain(text: string, preserveLine: boolean): string {
  const run = preserveLine ? new RegExp(pathRun().source + "(?::[0-9]+(?::[0-9]+)?)?", "gu") : pathRun();
  return text.replace(run, (token) => {
    const path = filePathOf(token);
    return path ? `[${token}](${preserveLine ? token : path})` : token;
  });
}
