import type { ReactNode } from "react";
/** Read-only workspace text, using the same surface and chrome as the editor. */

import { useMemo, useRef, useState } from "react";
import {
  AnnotationToolbar,
  WorkspaceMarkdown,
  type AnnotationsPanelHandle,
  type FileAnnotationsAdapter,
  type ListedFileLocation,
  type PublishedFileLinks,
} from "@claude-bot/agent-file-preview";
import { AvButton, DownloadAction, DownloadEmptyState, DownloadNotice, MARKDOWN_RENDER_BUDGET_CHARS, type BrowserDownloadState } from "@claude-bot/agent-view-react/ui";
import {
  CodeMirrorTextSurface,
  DocumentPane,
  languageForFileName,
  languageKeyForFileName,
} from "@claude-bot/agent-text-view";
import { WORKSPACE_FILES_LIMITS, type WorkspaceTextDocument } from "@claude-bot/workspace-files-contract";
import type { AnyWorkspaceFilesPort } from "@claude-bot/workspace-files-contract";

export interface FileViewerProps {
  links?: PublishedFileLinks;
  document: WorkspaceTextDocument | null;
  label: string;
  text: string;
  status: "empty" | "loading" | "ready" | "refused";
  streaming: boolean;
  message: string;
  code: string;
  download: BrowserDownloadState;
  onDownload(): void;
  revealAction?: ReactNode;
  revealNotice?: ReactNode;
  onReload(): void;
  /** Re-read without the view budget, after the person asked for the rest. */
  onLoadAll?(): void;
  onEdit?(): void;
  onClose?(): void;
  domIdScope?: string;
  port: AnyWorkspaceFilesPort;
  markdownLocation: ListedFileLocation | null;
  annotations?: FileAnnotationsAdapter | null;
  fileKey?: string;
  onOpenFile?(ref: string, label: string, location: ListedFileLocation): boolean;
}

export function FileViewer(props: FileViewerProps) {
  const fileName = props.document?.label ?? props.label;
  const docKey = props.document ? `${props.document.ref}|${props.document.digest}` : "";
  const language = useMemo(() => languageForFileName(fileName), [fileName]);
  const markdown = languageKeyForFileName(fileName) === "markdown";
  // Markdown renders synchronously and super-linearly; past the budget a large
  // file opens in the virtualised text surface and renders only on request.
  const [renderedKey, setRenderedKey] = useState("");
  const markdownTooLarge = markdown && props.text.length > MARKDOWN_RENDER_BUDGET_CHARS;
  const renderMarkdown = markdown && (!markdownTooLarge || renderedKey === docKey);
  // `too_large` with text is the view budget speaking: the leading part is on
  // screen and the rest is one click away. Without text it is a refusal (an
  // older Runner that still caps reads), and only the download remains.
  const partial = props.status === "refused" && props.code === "too_large" && props.text.length > 0;
  const unsupported = props.status === "refused"
    && (props.code === "not_text" || (props.code === "too_large" && !partial));
  const annotationControlRef = useRef<AnnotationsPanelHandle>(null);
  const annotationAvailable = Boolean(renderMarkdown && !unsupported && props.annotations && props.fileKey);
  const annotationCount = annotationAvailable ? props.annotations!.read(props.fileKey!).length : 0;
  const actions = (
    <>
      {props.revealAction}
      {partial && props.onLoadAll && (props.document?.sizeBytes ?? 0) <= WORKSPACE_FILES_LIMITS.wholeTextMaxBytes ? (
        <AvButton data-av-load-all onClick={props.onLoadAll}>载入全部</AvButton>
      ) : null}
      {props.onEdit && !unsupported && !partial ? (
        <span className="wsview-switch" role="group" aria-label="浏览或编辑">
          <AvButton disabled aria-current="page">浏览</AvButton>
          <AvButton onClick={props.onEdit}>编辑</AvButton>
        </span>
      ) : markdown && !unsupported ? <AvButton disabled aria-current="page">浏览</AvButton> : null}
      {annotationAvailable ? (
        <AnnotationToolbar controlRef={annotationControlRef} count={annotationCount} />
      ) : null}
      {!unsupported ? (
        <DownloadAction label={fileName} state={props.download} onDownload={props.onDownload} />
      ) : null}
    </>
  );

  return (
    <DocumentPane
      variant="viewer"
      document={props.document}
      label={props.label}
      status={props.status}
      streaming={props.streaming}
      message={props.message}
      code={props.code}
      hasPartialContent={props.status === "refused" && props.text.length > 0}
      onReload={props.onReload}
      actions={actions}
      notices={<>{props.revealNotice}<DownloadNotice state={props.download} /></>}
      domIdScope={props.domIdScope}
      empty={{
        icon: "📄",
        title: "选择一个文件",
        text: "应用打开一个文件后，会在这里显示预览或下载入口。",
      }}
      {...(props.onClose ? { onClose: props.onClose } : {})}
    >
      {unsupported ? (
        <DownloadEmptyState
          className="wsfile-placeholder"
          label={fileName}
          text="这个文件不能在浏览器内安全显示，但仍可下载到本地使用。"
          state={props.download}
          onDownload={props.onDownload}
        />
      ) : renderMarkdown && props.status === "ready" ? (
        <article className="wsmarkdown" data-av-file-markdown aria-label={`Markdown 预览：${fileName}`}>
          <WorkspaceMarkdown
            {...(props.links ? { links: props.links } : {})}
            {...(props.document ? { sourceRef: props.document.ref } : {})}
            text={props.text}
            port={props.port}
            location={props.markdownLocation}
            label={fileName}
            {...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {})}
            {...(props.annotations && props.fileKey ? { annotations: props.annotations, fileKey: props.fileKey } : {})}
            {...(annotationAvailable ? { annotationControlRef } : {})}
            {...(markdownTooLarge ? { renderBudgetChars: Number.POSITIVE_INFINITY } : {})}
          />
        </article>
      ) : (
        <>
        {markdownTooLarge && props.status === "ready" ? (
          <p className="wsmarkdown-budget" role="note" data-av-markdown-budget>
            这个 Markdown 文件有 {props.text.length.toLocaleString()} 个字符，渲染可能让页面卡住一段时间，先以文本显示。{" "}
            <AvButton onClick={() => setRenderedKey(docKey)}>按 Markdown 渲染</AvButton>
          </p>
        ) : null}
        <CodeMirrorTextSurface
          doc={props.text}
          docKey={docKey}
          readOnly
          line={null}
          lineToken=""
          className="wstext"
          idBase="wstext"
          ariaLabel={props.document ? `只读文件：${props.document.label}` : "只读文件"}
          initialWrap
          language={language}
          domIdScope={props.domIdScope}
        />
        </>
      )}
    </DocumentPane>
  );
}
