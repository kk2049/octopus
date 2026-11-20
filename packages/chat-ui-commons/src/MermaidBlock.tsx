import { isValidElement, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import type { MermaidResult } from "./mermaid.js";

export interface MermaidCopy {
  image: string;
  source: string;
  pending: string;
  invalid: string;
  tooLarge: string;
  /** The explicit per-diagram opt-in offered beside `tooLarge`. */
  renderAnyway?: string;
}

const DEFAULT_COPY: MermaidCopy = {
  image: "Mermaid 流程图",
  source: "查看源码",
  pending: "正在绘制流程图…",
  invalid: "流程图暂无法渲染，请检查语法或图表类型。",
  tooLarge: "流程图过大，已保留源码。",
  renderAnyway: "仍然绘制（页面可能短暂卡顿）",
};

export function MermaidBlock({ source, copy = DEFAULT_COPY }: { source: string; copy?: MermaidCopy }) {
  const [rendered, setRendered] = useState<{ source: string; force: boolean; result: MermaidResult }>();
  // The exact source the reader accepted the main-thread cost for. Keyed by the
  // text, so a fence still streaming is not re-laid out on every settle.
  const [forcedSource, setForcedSource] = useState<string>();
  const force = forcedSource === source;
  // A changed source cannot display the previous diagram, even before effects
  // run. Debouncing also avoids laying out every token of an unfinished fence.
  const result = rendered?.source === source && rendered.force === force ? rendered.result : undefined;
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      // Most conversations contain no diagrams. Load the layout engine only
      // after an actual fence settles, without retaining a stale render task.
      void import("./mermaid.js").then(({ renderMermaidImage }) => {
        if (!cancelled) setRendered({ source, force, result: renderMermaidImage(source, { force }) });
      }).catch(() => {
        if (!cancelled) setRendered({ source, force, result: { error: "invalid" } });
      });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [source, force]);

  const image = result && "src" in result ? result.src : undefined;
  const [failedImage, setFailedImage] = useState<string>();
  const error = result && "error" in result ? result.error : image && failedImage === image ? "invalid" : undefined;
  return (
    <div data-mermaid-diagram="" style={{ minWidth: 0, maxWidth: "100%", marginBlock: "1em" }}>
      {image && !error ? (
        <div style={{ overflow: "auto", maxWidth: "100%", borderRadius: 8, background: "#fff" }}>
          <img
            src={image}
            alt={copy.image}
            style={{ display: "block", maxWidth: "none", height: "auto" }}
            onError={() => setFailedImage(image)}
          />
        </div>
      ) : (
        <p role="status">
          {error === "too_large" ? copy.tooLarge : error ? copy.invalid : copy.pending}
          {error === "too_large" ? (
            <>
              {" "}
              <button type="button" onClick={() => setForcedSource(source)}>
                {copy.renderAnyway ?? DEFAULT_COPY.renderAnyway}
              </button>
            </>
          ) : null}
        </p>
      )}
      <details>
        <summary>{copy.source}</summary>
        <pre><code className="language-mermaid">{source}</code></pre>
      </details>
    </div>
  );
}

/** Opt-in adapter for an already parsed fenced block; it never parses Markdown. */
export function MermaidPre({ children, copy, ...props }: ComponentProps<"pre"> & { copy?: MermaidCopy }) {
  if (isValidElement<{ className?: string; children?: ReactNode }>(children)
    && children.type === "code"
    && children.props.className?.split(/\s+/).includes("language-mermaid")
    && typeof children.props.children === "string") {
    return <MermaidBlock source={children.props.children} copy={copy} />;
  }
  return <pre {...props}>{children}</pre>;
}
