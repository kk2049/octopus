import { AvButton } from "@claude-bot/agent-view-react/ui";
/**
 * The generated Typst source, shown as text.
 *
 * ── What a frame like this can actually do, measured ───────────────────────
 *
 * This renders in `sandbox="allow-scripts"` with no `allow` attribute: an opaque
 * origin with no delegated Permissions Policy. Chromium 1.62, parent and frame
 * on different origins, one real user gesture (the probe is in the worklog):
 *
 *   navigator.clipboard            present, and `writeText` is a function
 *   navigator.clipboard.writeText  rejects — NotAllowedError, "The Clipboard API
 *                                  has been blocked because of a permissions
 *                                  policy applied"
 *   document.execCommand("copy")   returns true; the selection is copied
 *   Selection / Range              works
 *   <a download> / blob URL        no download starts (no `allow-downloads`)
 *   isSecureContext                true; origin is "null"
 *
 * Three consequences, and each is a line of code below rather than a comment:
 *
 *  1. **A presence check for `navigator.clipboard` proves nothing here** — it is
 *     present and it refuses. So copy is attempted, not predicted.
 *  2. **The legacy synchronous command is the one that works**, so it is tried
 *     FIRST and the async API is the fallback. That is the opposite of the usual
 *     advice, and it is what the boundary measures out to.
 *  3. **There is no download button**, because a download cannot start. A button
 *     that silently does nothing is worse than its absence.
 *
 * What always works is a `<pre>` a person can select, so that is the primary
 * surface: every failure path ends with the source selected and a sentence
 * saying to copy it by hand.
 *
 * ── Why this is a panel and not a modal ─────────────────────────────────────
 *
 * It is opened with `open-resource/v1` like everything else, so closing it is
 * closing a panel. A modal would be a second layout system inside a module.
 */

import { useCallback, useRef, useState } from "react";
import { Banner } from "@claude-bot/agent-view-react/ui";
import type { ContractIssue } from "@claude-bot/deck-model-contract";
import type { DeckSourceStatus } from "../lib/deck-source.js";
import { SourceNotice, sourceIsBlocked } from "./SourceNotice.js";

export interface TypstExportProps {
  title: string;
  status: DeckSourceStatus;
  source: string;
  issues: readonly ContractIssue[];
  booting: boolean;
  /** The generated Typst text. Empty when there is no deck. */
  typst: string;
  slideCount: number;
  onClose?(): void;
}

interface Notice {
  tone: "ok" | "warn";
  text: string;
}

export function TypstExport({ title, status, source, issues, booting, typst, slideCount, onClose }: TypstExportProps) {
  const pre = useRef<HTMLPreElement | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const selectAll = useCallback((): boolean => {
    const node = pre.current;
    if (!node) return false;
    const selection = node.ownerDocument.defaultView?.getSelection();
    if (!selection) return false;
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }, []);

  const onSelect = useCallback(() => {
    setNotice(null);
    selectAll();
  }, [selectAll]);

  const onCopy = useCallback(() => {
    setNotice(null);
    const selected = selectAll();
    // Measured order: the synchronous command is the one that works in this
    // frame; the async API is present and blocked by permissions policy.
    try {
      const document_ = pre.current?.ownerDocument;
      if (selected && typeof document_?.execCommand === "function" && document_.execCommand("copy")) {
        setNotice({ tone: "ok", text: "已复制到剪贴板。" });
        return;
      }
    } catch {
      // Falls through to the asynchronous attempt, which reports for itself.
    }
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      setNotice({ tone: "warn", text: "这个画面不能写剪贴板。源码已经全选，请手动复制。" });
      return;
    }
    void clipboard.writeText(typst).then(
      () => setNotice({ tone: "ok", text: "已复制到剪贴板。" }),
      () => setNotice({ tone: "warn", text: "浏览器拒绝了这个画面的剪贴板写入。源码已经全选，请手动复制。" }),
    );
  }, [selectAll, typst]);

  return (
    <section className="dkv-typst" data-dkv-source={source} data-dkv-status={status}>
      <header className="dkv-head">
        <b>{title || "Typst 源码"}</b>
        <span className="dkv-sub">
          {slideCount} 页 · {typst.length} 字符
        </span>
        {onClose ? (
          <AvButton className="dkv-close" data-dkv-close onClick={onClose}>
            关闭
          </AvButton>
        ) : null}
      </header>
      {sourceIsBlocked(status, booting) ? (
        <SourceNotice status={status} source={source} issues={issues} booting={booting} />
      ) : (
        <>
          <p className="dkv-note">
            这是从 deck 生成的派生文件：deck 才是可编辑的事实源，改这份源码不会回写。编译成 PDF 由部署侧负责。
          </p>
          <div className="dkv-actions">
            <AvButton data-dkv-select onClick={onSelect}>
              全选
            </AvButton>
            <AvButton data-dkv-copy onClick={onCopy}>
              复制
            </AvButton>
          </div>
          {notice ? <Banner tone={notice.tone} title={notice.text} /> : null}
          <pre className="dkv-source" data-dkv-typst ref={pre}>
            {typst}
          </pre>
        </>
      )}
    </section>
  );
}
