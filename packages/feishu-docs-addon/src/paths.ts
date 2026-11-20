/**
 * File mentions in agent text.
 *
 * A mention is a NAME in the owner's device namespace, never authority: the
 * bridge decides, per click, whether the name resolves inside a workspace the
 * reader was granted. Recognition here only decides what looks clickable, so
 * it errs towards the shapes agents actually print — backticked paths,
 * Markdown links to local files, `path/to/file.ext:12` — and away from prose
 * like "Node.js" or "and/or".
 */

/** The link scheme a recognised mention is rewritten to; only the card's own renderer understands it. */
export const FILE_SCHEME = 'octopus-file:';

const EXT = 'md|markdown|mdx|txt|log|out|err|csv|tsv|json|jsonl|ndjson|yaml|yml|toml|ini|cfg|conf|env|xml|html|htm|pdf|png|jpe?g|gif|webp|svg|bmp|ico|mp4|webm|mov|mp3|wav|ogg|m4a|ipynb|py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|c|h|cc|cpp|hpp|cu|java|kt|rb|php|sh|bash|zsh|fish|sql|tex|bib|sty|cls|r|jl|m|scala|swift|lua|css|scss|less|vue|svelte|lock|diff|patch|docx?|xlsx?|pptx?|zip|tar|gz|tgz|bz2|xz|7z|pt|pth|ckpt|npy|npz|parquet|arrow|feather|h5|hdf5|pkl|pickle|onnx|safetensors|bin|dat|proto|graphql|gradle|cmake|mk|gitignore';
/** In prose a BARE word is clickable only with a data/document extension: "Node.js" stays a word. */
const PROSE_EXT = 'md|markdown|txt|log|out|err|csv|tsv|json|jsonl|yaml|yml|toml|pdf|png|jpe?g|gif|webp|svg|mp4|ipynb|py|tex|bib|docx?|xlsx?|pptx?|zip|parquet|npy|npz|pkl|ckpt|pt|pth|safetensors|onnx|h5|sh';
const HAS_EXT = new RegExp(`\\.(?:${EXT})$`, 'i');
const PROSE_BARE = new RegExp(`\\.(?:${PROSE_EXT})$`, 'i');
const SEGMENT = /^[\p{L}\p{N}_.@+=,~%-]+$/u;
const TRAILING = /[，。；：、,;:!?！？)）]+$/u;
const MAX = 1024;

/**
 * The path a raw mention names, or null. Strips quoting, sentence punctuation
 * and a trailing line/column suffix (`a.ts:12:3`, `a.ts#L12`). `strict` is for
 * prose, where only unambiguous shapes count.
 */
export function fileMention(raw: string, strict = false): string | null {
  let value = raw.trim().replace(/^[`'"“‘(（<[]+|[`'"”’>\]]+$/gu, '').replace(TRAILING, '');
  value = value.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/(?<=\S):\d+(?::\d+)?$/, '');
  if (!value || value.length > MAX || /\s/.test(value) || value.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const directory = value.endsWith('/');
  const body = directory ? value.slice(0, -1) : value;
  const segments = body.split('/');
  const rooted = body.startsWith('/') || body.startsWith('~/') || body.startsWith('./') || body.startsWith('../');
  const parts = segments.filter((s, k) => !(k === 0 && (s === '' || s === '~')) && s !== '.' && s !== '..');
  if (!parts.length || !parts.every((s) => SEGMENT.test(s))) return null;
  if (HAS_EXT.test(body)) return strict && segments.length === 1 && !PROSE_BARE.test(body) ? null : value;
  if (rooted) return segments.length > 2 || directory ? value : null;
  return !strict && (directory || segments.length >= 2) ? value : null;
}

/** Prose tokens worth checking: separated by whitespace or CJK punctuation, containing a dot or a slash. */
const TOKEN = /[^\s，。；：、！？（）《》「」【】"'“”‘’<>]*[./][^\s，。；：、！？（）《》「」【】"'“”‘’<>]*/gu;

interface Node { type: string; value?: string; url?: string; children?: Node[] }

const link = (path: string, text: string): Node => ({ type: 'link', url: FILE_SCHEME + encodeURIComponent(path), children: [{ type: 'inlineCode', value: text }] });

/** Splits one prose text node around the mentions it contains. */
function splitText(text: string): Node[] | null {
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const shown = match[0].replace(TRAILING, '');
    const path = fileMention(shown, true);
    if (!path) continue;
    const start = match.index ?? 0;
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push(link(path, shown));
    last = start + shown.length;
  }
  if (!out.length) return null;
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function walk(node: Node): void {
  const children = node.children;
  if (!children) return;
  for (let k = 0; k < children.length; k++) {
    const child = children[k];
    switch (child.type) {
      case 'link':
        // A Markdown link to a local file (Codex prints `[a.ts](/abs/a.ts:12)`) becomes a mention; its text stays.
        if (child.url !== undefined && !/^(https?:|mailto:)/i.test(child.url)) {
          const path = fileMention(decode(child.url));
          child.url = path ? FILE_SCHEME + encodeURIComponent(path) : '';
        }
        break;
      case 'inlineCode': {
        const path = child.value ? fileMention(child.value) : null;
        if (path) children[k] = link(path, child.value!);
        break;
      }
      case 'text': {
        const parts = child.value ? splitText(child.value) : null;
        if (parts) { children.splice(k, 1, ...parts); k += parts.length - 1; }
        break;
      }
      case 'code': case 'html': case 'linkReference': case 'image': break;
      default: walk(child);
    }
  }
}

/** remark plugin: rewrite file mentions into `octopus-file:` links the card renders as buttons. */
export function remarkFileMentions() {
  return (tree: Node) => { walk(tree); };
}

/** The mention an `octopus-file:` href carries. */
export function mentionOf(href: string): string | null {
  return href.startsWith(FILE_SCHEME) ? decode(href.slice(FILE_SCHEME.length)) || null : null;
}
