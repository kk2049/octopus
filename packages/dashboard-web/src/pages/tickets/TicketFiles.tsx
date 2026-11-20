import { useEffect, useRef, useState } from "react";
import type { TicketFilesResponse } from "../../contract.js";
import type { FileReference } from "../../lib/file-reference.js";
import { api, errorText, query } from "../../lib/api.js";
import { Dialog } from "../../ui/Dialog.js";
import { Markdown } from "../../ui/Markdown.js";
import { UiButton } from "../../ui-kit/primitives.js";
import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import styles from "./TicketFiles.module.css";

export function TicketFiles({ ticketId, target, onClose, onOpen }: {
  ticketId: number;
  target: FileReference;
  onClose(): void;
  onOpen(target: FileReference): void;
}) {
  useDashboardLanguage();
  const [data, setData] = useState<TicketFilesResponse | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState(false);
  const [line, setLine] = useState(target.line ?? 1);
  const [jump, setJump] = useState(String(target.line ?? 1));
  /** Bytes of a large file read so far, while its windows arrive. */
  const [progress, setProgress] = useState<{ read: number; size: number } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageAbort = useRef<AbortController | null>(null);
  const highlight = useRef<HTMLSpanElement>(null);
  const filesUrl = (extra: Record<string, string | number> = {}) => `/api/tickets/${ticketId}/files${query({ path: target.path, ...extra })}`;
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    setPreview(false);
    setProgress(null);
    setLoadingMore(false);
    setLine(target.line ?? 1);
    setJump(String(target.line ?? 1));
    (async () => {
      let page = await api<TicketFilesResponse>(filesUrl(), { signal: controller.signal });
      if (page.kind === "file" && page.next_offset !== undefined) {
        // A file arrives in byte windows of one blob; it is shown once it is whole.
        const object = page.object;
        const parts = [page.text];
        while (page.kind === "file" && page.next_offset !== undefined) {
          if (controller.signal.aborted) return;
          setProgress({ read: page.next_offset, size: page.size });
          page = await api<TicketFilesResponse>(filesUrl({ offset: page.next_offset }), { signal: controller.signal });
          if (page.kind !== "file" || page.object !== object) throw new Error(uiText("文件在读取期间被新的提交改动了，请重新读取"));
          parts.push(page.text);
        }
        page = { ...page, text: parts.join(""), offset: 0 };
      }
      if (!controller.signal.aborted) { setProgress(null); setData(page); }
    })().catch((reason) => { if (!controller.signal.aborted) setError(errorText(reason)); });
    return () => { controller.abort(); pageAbort.current?.abort(); };
  }, [ticketId, target.path, target.line, refresh]);
  /** The next page of a large directory, appended to what is shown. */
  function loadMore() {
    if (data?.kind !== "directory" || !data.next_cursor || loadingMore) return;
    const controller = new AbortController();
    pageAbort.current = controller;
    setLoadingMore(true);
    api<TicketFilesResponse>(filesUrl({ cursor: data.next_cursor }), { signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        // Pages of one listing must come from one tree object; a changed directory restarts it.
        if (next.kind !== "directory" || next.object !== data.object) {
          setError(uiText("目录在翻页期间被新的提交改动了，请重新读取"));
          return;
        }
        setData((current) => current?.kind === "directory" ? { ...next, entries: [...current.entries, ...next.entries] } : current);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorText(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoadingMore(false); });
  }
  useEffect(() => { highlight.current?.scrollIntoView?.({ block: "center" }); }, [data, line, preview]);
  const lines = data?.kind === "file" ? data.text.split("\n") : [];
  const start = Math.max(0, Math.min(Math.max(0, lines.length - 400), line - 40));
  const parent = data?.path.split("/").slice(0, -1).join("/") ?? "";
  function download() {
    if (data?.kind !== "file") return;
    const url = URL.createObjectURL(new Blob([data.text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = data.path.split("/").at(-1) ?? "source.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={uiText("工单源码")} width={1100}>
    <div className={styles.toolbar}>
      <UiButton onClick={() => onOpen({ path: "" })}>{uiText("仓库根目录")}</UiButton>
      <UiButton disabled={!data?.path} onClick={() => onOpen({ path: parent })}>{uiText("上级目录")}</UiButton>
      <UiButton disabled={!data && !error} onClick={() => setRefresh((n) => n + 1)}>{uiText("重新读取")}</UiButton>
      {data?.kind === "file" && <>
        <UiButton onClick={download}>{uiText("下载源码")}</UiButton>
        {/\.md$/i.test(data.path) && data.text.length <= 200_000 && <UiButton onClick={() => setPreview((v) => !v)}>{preview ? uiText("查看源码") : uiText("预览 Markdown")}</UiButton>}
      </>}
    </div>
    <p className={styles.path}>{data?.path || target.path || "/"}</p>
    <p className="muted">{uiText("仅显示已提交源码；未提交文件与主机私有文件不在此范围。")}</p>
    {data && <p className="muted">{data.source === "ticket" ? uiText("工单版本") : uiText("主线版本")} · <code>{data.revision.slice(0, 12)}</code></p>}
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">{progress
      ? uiText("正在读取源码…（{read} / {size} 字节）", { read: progress.read, size: progress.size })
      : uiText("正在读取源码…")}</p> : null}
    <div className={styles.content}>
      {data?.kind === "directory" && <nav aria-label={uiText("源码目录")} className={styles.directory}>
        {data.entries.length === 0 && <p>{uiText("此目录为空")}</p>}
        {data.entries.map((entry) => <button key={entry.path} type="button" onClick={() => onOpen({ path: entry.path })}>
          {entry.kind === "directory" ? "📁" : "📄"} {entry.name}
        </button>)}
        {data.total > data.entries.length && <p className="muted">{uiText("已显示 {shown} / {total} 项", { shown: data.entries.length, total: data.total })}</p>}
        {data.next_cursor && <UiButton disabled={loadingMore} onClick={loadMore}>{loadingMore ? uiText("正在读取…") : uiText("继续加载")}</UiButton>}
        {data.unlisted ? <p className="muted">{uiText("另有 {count} 项名称含控制字符或反斜杠，无法在这里打开", { count: data.unlisted })}</p> : null}
      </nav>}
      {data?.kind === "file" && (preview ? <Markdown disableImages onOpenFile={(file) => {
        if (file.path.startsWith("/")) { onOpen(file); return; }
        const parts = parent ? parent.split("/") : [];
        for (const part of file.path.split("/")) {
          if (part === "..") { if (!parts.length) { setError(uiText("文件路径不能越过仓库边界")); return; } parts.pop(); }
          else if (part && part !== ".") parts.push(part);
        }
        onOpen({ ...file, path: parts.join("/") });
      }}>{data.text}</Markdown> : <>
        <form className={styles.toolbar} onSubmit={(event) => { event.preventDefault(); const n = Number(jump); if (Number.isSafeInteger(n) && n > 0) setLine(Math.min(n, lines.length)); }}>
          <label>{uiText("行号")} <input type="number" min={1} max={lines.length} value={jump} onChange={(event) => setJump(event.target.value)} /></label>
          <UiButton htmlType="submit">{uiText("定位")}</UiButton>
          <span>{start + 1}–{Math.min(start + 400, lines.length)} / {lines.length}</span>
          <UiButton disabled={start === 0} onClick={() => setLine(Math.max(1, start - 359))}>{uiText("上一段")}</UiButton>
          <UiButton disabled={start + 400 >= lines.length} onClick={() => setLine(start + 440)}>{uiText("下一段")}</UiButton>
        </form>
        <pre className={styles.source}><code>{lines.slice(start, start + 400).map((text, index) => {
          const n = start + index + 1;
          return <span key={n} ref={n === line ? highlight : undefined} data-source-line={n} className={n === line ? styles.selected : undefined}><span className={styles.number}>{n}</span>{text}{"\n"}</span>;
        })}</code></pre>
      </>)}
    </div>
  </Dialog>;
}
