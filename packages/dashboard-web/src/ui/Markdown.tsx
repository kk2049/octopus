/**
 * The one Markdown renderer the trusted panel ships.
 *
 * ── Why a library instead of the previous 120-line renderer ─────────────────
 *
 * Everything this renders is untrusted: agent prose, tool output, ticket
 * bodies, secretary drafts, session transcripts. The old `mdLite` was written
 * escape-first and was careful, but it was a hand-rolled HTML *string* builder
 * whose safety rested on the ordering of a dozen regular expressions and on
 * every future caller remembering to pass it through `esc()` first. `dangerouslySetInnerHTML`
 * appeared at 30-odd call sites as a consequence.
 *
 * `react-markdown` parses to an AST and React creates elements — there is no
 * HTML string anywhere on the path, so injection is not a mistake that can be
 * made here. Three rules keep it that way:
 *
 *  1. **No `rehype-raw`, ever.** Raw HTML in the source stays text. The moment
 *     that plugin is added, every transcript becomes an injection surface.
 *  2. **URL schemes are allow-listed** (`http`, `https`, `mailto`, and relative
 *     links). `defaultUrlTransform` already drops `javascript:`; this narrows
 *     further and is where a reviewer looks.
 *  3. **External links get `rel="noopener noreferrer"`** and open in a new tab,
 *     so a link in an agent's output cannot navigate the panel away or reach
 *     `window.opener`.
 *
 * GitHub-flavoured tables/strikethrough/task lists come from `remark-gfm`,
 * which the old renderer did not cover at all — agent output uses tables often.
 */

import ReactMarkdown, { type Components } from "react-markdown";
import { createContext, useContext, useMemo, type ComponentProps } from "react";
import { linkifyFilePaths } from "@claude-bot/chat-ui-commons/file-mentions";
import { fileReference, type FileReference } from "../lib/file-reference.js";

import remarkGfm from "remark-gfm";
import { MermaidPre } from "@claude-bot/chat-ui-commons/mermaid";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import styles from "./Markdown.module.css";

export const MarkdownFileLinks = createContext<((file: FileReference) => void) | undefined>(undefined);

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Returns "" for anything not on the allow-list. React renders an anchor with
 * no href, which is inert and still shows the link text.
 */
function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  // Relative and fragment links stay on this origin and are fine.
  if (/^[#/?]/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed, location.href);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? trimmed : "";
  } catch {
    return "";
  }
}

const components: Components = {
  pre: MermaidCodeBlock,
  a({ href, children, ...rest }) {
    if (!href) return <span {...rest}>{children}</span>;
    return (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

function MermaidCodeBlock({ node: _node, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  useDashboardLanguage();
  return <MermaidPre {...props} copy={{
    image: uiText("Mermaid 流程图"),
    source: uiText("查看源码"),
    pending: uiText("正在绘制流程图…"),
    invalid: uiText("流程图暂无法渲染，请检查语法或图表类型。"),
    tooLarge: uiText("流程图过大，已保留源码。"),
    renderAnyway: uiText("仍然绘制（页面可能短暂卡顿）"),
  }} />;
}

export interface MarkdownProps {
  children: string | null | undefined;
  className?: string;
  onOpenFile?: (file: FileReference) => void;
  /** Repository previews must not turn image destinations into ambient reads. */
  disableImages?: boolean;
}

/** Render untrusted Markdown. There is no unsafe variant of this component. */
export function Markdown({ children, className, onOpenFile, disableImages = false }: MarkdownProps) {
  const contextualOpen = useContext(MarkdownFileLinks);
  const open = onOpenFile ?? contextualOpen;
  const renderers = useMemo<Components>(() => open || disableImages ? {
    ...components,
    // Repository Markdown is text: image URLs must not cause ambient GETs to
    // capability endpoints or expose the reader to external tracking.
    ...(disableImages ? { img: ({ alt }: { alt?: string }) => <span>{alt || "[image]"}</span> } : {}),
    a({ href, children, node: _node, ...rest }) {
      const file = href ? fileReference(href) : null;
      if (!file || !open) return href ? <a {...rest} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
      return <button type="button" className={styles.fileLink} onClick={() => open(file)}>{children}</button>;
    },
  } : components, [open, disableImages]);
  const text = useMemo(() => open ? linkifyFilePaths(children ?? "", true) : children ?? "", [children, open]);
  return (
    <div className={className ? `${styles.prose} ${className}` : styles.prose}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => open && fileReference(url) ? url : safeUrl(url)} components={renderers}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
