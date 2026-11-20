import type { Language, LanguageSupport } from "@codemirror/language";
import { StreamLanguage } from "@codemirror/language";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { csharp, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";

export type TextLanguage = Language | LanguageSupport;

type LanguageKey =
  | "c"
  | "cpp"
  | "csharp"
  | "css"
  | "dockerfile"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "jsx"
  | "json"
  | "kotlin"
  | "markdown"
  | "nginx"
  | "php"
  | "properties"
  | "python"
  | "rust"
  | "shell"
  | "sql"
  | "swift"
  | "toml"
  | "tsx"
  | "typescript"
  | "xml"
  | "yaml";

/** A stable language key from a display name; no path or authority is inferred. */
export function languageKeyForFileName(fileName: string): LanguageKey | null {
  const base = fileName.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "nginx.conf") return "nginx";
  if (base === ".env" || base.startsWith(".env.")) return "properties";
  const dot = base.lastIndexOf(".");
  const extension = dot >= 0 ? base.slice(dot + 1) : "";
  switch (extension) {
    case "js": case "mjs": case "cjs": return "javascript";
    case "jsx": return "jsx";
    case "ts": case "mts": case "cts": return "typescript";
    case "tsx": return "tsx";
    case "json": case "jsonc": case "jsonl": return "json";
    case "md": case "mdx": case "markdown": return "markdown";
    case "py": case "pyw": return "python";
    case "html": case "htm": return "html";
    case "css": case "scss": case "less": return "css";
    case "xml": case "xsl": case "svg": return "xml";
    case "yaml": case "yml": return "yaml";
    case "sql": return "sql";
    case "java": return "java";
    case "cs": return "csharp";
    case "kt": case "kts": return "kotlin";
    case "swift": return "swift";
    case "c": case "h": return "c";
    case "cc": case "cpp": case "cxx": case "hpp": case "hh": case "hxx": return "cpp";
    case "rs": return "rust";
    case "go": return "go";
    case "php": return "php";
    case "sh": case "bash": case "zsh": case "fish": return "shell";
    case "toml": return "toml";
    case "nginx": case "conf": return "nginx";
    case "docker": return "dockerfile";
    case "properties": case "env": case "ini": return "properties";
    default: return null;
  }
}

const FACTORIES: Readonly<Record<LanguageKey, () => TextLanguage>> = Object.freeze({
  c: () => cpp(),
  cpp: () => cpp(),
  csharp: () => StreamLanguage.define(csharp),
  css: () => css(),
  dockerfile: () => StreamLanguage.define(dockerFile),
  go: () => go(),
  html: () => html(),
  java: () => java(),
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  json: () => json(),
  kotlin: () => StreamLanguage.define(kotlin),
  markdown: () => markdown(),
  nginx: () => StreamLanguage.define(nginx),
  php: () => php(),
  properties: () => StreamLanguage.define(properties),
  python: () => python(),
  rust: () => rust(),
  shell: () => StreamLanguage.define(shell),
  sql: () => sql(),
  swift: () => StreamLanguage.define(swift),
  toml: () => StreamLanguage.define(toml),
  tsx: () => javascript({ typescript: true, jsx: true }),
  typescript: () => javascript({ typescript: true }),
  xml: () => xml(),
  yaml: () => yaml(),
});

/** CodeMirror support for a file name, or null for ordinary plain text. */
export function languageForFileName(fileName: string): TextLanguage | null {
  const key = languageKeyForFileName(fileName);
  return key ? FACTORIES[key]() : null;
}
