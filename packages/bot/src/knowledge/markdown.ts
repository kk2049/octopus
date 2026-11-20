/**
 * Small, dependency-free Markdown helpers for the repository's documentation
 * shape: optional YAML-ish frontmatter, ATX headings, bullet lists, fenced
 * code. This is not a Markdown parser; it extracts the pieces the knowledge
 * graph needs (sections, bullets, paragraphs, paths, ticket refs).
 */

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  /** Line offset of the body inside the original text. */
  bodyLine: number;
}

/**
 * Parses the subset of YAML used by `.claude/rules` and ADR frontmatter:
 * scalars, inline arrays `[a, b]`, and block lists (`- item`). Anything else
 * is kept as its raw string.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text, bodyLine: 0 };
  const data: Record<string, unknown> = {};
  const lines = match[1].split(/\r?\n/);
  let currentKey: string | null = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const listItem = /^\s+-\s+(.*)$/.exec(raw);
    if (listItem && currentKey) {
      const existing = data[currentKey];
      const value = unquote(listItem[1]);
      if (Array.isArray(existing)) existing.push(value);
      else data[currentKey] = [value];
      continue;
    }
    const keyValue = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(raw);
    if (!keyValue) continue;
    currentKey = keyValue[1];
    const rawValue = keyValue[2].trim();
    if (!rawValue) {
      data[currentKey] = [];
    } else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      data[currentKey] = rawValue
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter(Boolean);
    } else {
      data[currentKey] = unquote(rawValue);
    }
  }
  const bodyLine = match[0].split(/\r?\n/).length - 1;
  return { data, body: text.slice(match[0].length), bodyLine };
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

export interface Section {
  level: number;
  title: string;
  /** Titles from the root heading to this one. */
  headingPath: string[];
  /** Body lines excluding the heading line and fenced code. */
  lines: string[];
  startLine: number;
}

/** Splits Markdown into heading-delimited sections; fenced code is dropped. */
export function sections(markdown: string, lineOffset = 0): Section[] {
  const out: Section[] = [];
  const stack: Section[] = [];
  let current: Section = { level: 0, title: "", headingPath: [], lines: [], startLine: lineOffset };
  out.push(current);
  let inFence = false;
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const parentPath = stack.length ? stack[stack.length - 1].headingPath : [];
      current = {
        level,
        title: cleanInline(heading[2]),
        headingPath: [...parentPath, cleanInline(heading[2])],
        lines: [],
        startLine: lineOffset + index,
      };
      stack.push(current);
      out.push(current);
      return;
    }
    current.lines.push(line);
  });
  return out;
}

export function headingSlug(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Strips emphasis, links and inline code markers while keeping the text. */
export function cleanInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Bullet {
  text: string;
  /** Zero-based line index relative to the section body. */
  line: number;
  depth: number;
}

/**
 * Top-level bullets with their continuation lines joined. Nested bullets are
 * folded into their parent when `foldNested` is true (a rule bullet and its
 * sub-clauses are one statement), otherwise returned at their own depth.
 */
export function bullets(lines: readonly string[], foldNested = true): Bullet[] {
  const out: Bullet[] = [];
  let current: Bullet | null = null;
  lines.forEach((line, index) => {
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const depth = Math.floor(item[1].replace(/\t/g, "  ").length / 2);
      if (depth > 0 && current && foldNested) {
        current.text += ` ${item[2].trim()}`;
        return;
      }
      current = { text: item[2].trim(), line: index, depth };
      out.push(current);
      return;
    }
    if (current && line.trim() && /^\s+/.test(line)) {
      current.text += ` ${line.trim()}`;
      return;
    }
    if (!line.trim()) current = null;
  });
  return out.map((bullet) => ({ ...bullet, text: cleanInline(bullet.text) })).filter((bullet) => bullet.text);
}

/** Non-bullet, non-table paragraphs of a section. */
export function paragraphs(lines: readonly string[]): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let buffer: string[] = [];
  let start = 0;
  const flush = () => {
    if (buffer.length) out.push({ text: cleanInline(buffer.join(" ")), line: start });
    buffer = [];
  };
  let inBullet = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      inBullet = false;
      flush();
      return;
    }
    if (/^(?:[-*+]|\d+[.)])\s+/.test(trimmed) || trimmed.startsWith("|") || trimmed.startsWith(">")) {
      inBullet = /^(?:[-*+]|\d+[.)])\s+/.test(trimmed);
      flush();
      return;
    }
    if (inBullet && /^\s+/.test(line)) return; // continuation of the bullet above
    inBullet = false;
    if (!buffer.length) start = index;
    buffer.push(trimmed);
  });
  flush();
  return out.filter((paragraph) => paragraph.text);
}

const REPO_PATH = /(?:^|[\s`(（"'，,：:])((?:packages|plugins|doc|scripts|architecture|ctl|tools|\.claude|\.agents)\/[A-Za-z0-9_./\-]+)/g;

/** Repository-relative paths mentioned in prose (backticks optional). */
export function repoPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(REPO_PATH)) {
    const value = match[1].replace(/[.,;:)）`'"]+$/, "");
    if (value.length > 3) found.add(value);
  }
  return [...found];
}

/** Ticket numbers written as `#123`, `工单 #123`, `工单123`, `ticket 123`. */
export function ticketRefs(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/(?:#|工单\s?#?|ticket\s?#?)(\d{1,5})(?!\d)/gi)) {
    const value = Number(match[1]);
    if (value > 0 && value < 100_000) found.add(value);
  }
  return [...found];
}

/** ADR numbers written as `ADR 0009` / `ADR0009` / `adr/0009`. */
export function adrRefs(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/ADR[\s/-]?(\d{4})/gi)) found.add(match[1]);
  return [...found];
}
