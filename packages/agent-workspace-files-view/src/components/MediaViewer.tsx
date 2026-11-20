import type { ReactNode } from "react";
import { AnnotationToolbar, MediaPreview, type AnnotationsPanelHandle } from "@claude-bot/agent-file-preview";
import { useRef } from "react";
import { AvButton, DownloadAction, DownloadNotice, type BrowserDownloadState } from "@claude-bot/agent-view-react/ui";
import { DocumentPane } from "@claude-bot/agent-text-view";
import type { FileAnnotationsAdapter, MediaState } from "@claude-bot/agent-file-preview";

export interface MediaViewerProps extends MediaState {
  label: string;
  revealAction?: ReactNode;
  revealNotice?: ReactNode;
  onReload(): void;
  /** Preview past the default budget, after the person asked for it. */
  onLoadAll?(): void;
  download: BrowserDownloadState;
  onDownload(): void;
  onClose?(): void;
  domIdScope?: string;
  annotations?: FileAnnotationsAdapter | null;
  fileKey?: string;
}

export function MediaViewer(props: MediaViewerProps) {
  const ready = props.status === "ready" && props.document
    && (props.document.mediaType === "application/pdf" ? props.data : props.url);
  const unsupported = props.status === "refused" && props.code === "unsupported_media";
  const annotationControlRef = useRef<AnnotationsPanelHandle>(null);
  const annotationAvailable = Boolean(
    props.annotations
    && props.fileKey
    && props.document?.mediaType === "application/pdf",
  );
  const annotationCount = annotationAvailable ? props.annotations!.read(props.fileKey!).length : 0;
  return (
    <DocumentPane
      variant="viewer"
      document={props.document}
      label={props.label}
      status={props.status}
      streaming={props.streaming}
      message={props.message}
      code={props.code}
      onReload={props.onReload}
      actions={
        <>
          {props.revealAction}
          {props.status === "refused" && props.code === "too_large" && props.onLoadAll ? (
            <AvButton data-av-load-all onClick={props.onLoadAll}>继续预览</AvButton>
          ) : null}
          {annotationAvailable ? (
            <AnnotationToolbar controlRef={annotationControlRef} count={annotationCount} />
          ) : null}
          <DownloadAction
            label={props.document?.label ?? props.label}
            state={props.download}
            onDownload={props.onDownload}
          />
        </>
      }
      notices={<>{props.revealNotice}<DownloadNotice state={props.download} /></>}
      domIdScope={props.domIdScope}
      empty={{
        icon: "▧",
        title: "选择图片或 PDF",
        text: "支持 PNG、JPEG、GIF、WebP 和 PDF；较大的文件会先询问再预览，任何大小都可下载。",
      }}
      {...(props.onClose ? { onClose: props.onClose } : {})}
    >
      <MediaPreview
        className="wsfile-placeholder"
        label={props.label}
        text="这个文件不是受支持的图片或 PDF，但仍可下载到本地使用。"
        state={props.download}
        onDownload={props.onDownload}
        document={props.document}
        url={props.url}
        data={props.data}
        ready={Boolean(ready)}
        streaming={props.streaming}
        unsupported={unsupported}
        {...(props.annotations && props.fileKey ? { annotations: props.annotations, fileKey: props.fileKey } : {})}
        {...(annotationAvailable ? { annotationControlRef } : {})}
      />
    </DocumentPane>
  );
}
