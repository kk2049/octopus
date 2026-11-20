import { DownloadEmptyState, type BrowserDownloadDocument, type BrowserDownloadState } from "@claude-bot/agent-view-react/ui";
import type { MutableRefObject } from "react";
import type { AnnotationsPanelHandle } from "./AnnotationsPanel.js";
import { PdfPreview } from "./PdfPreview.js";
import type { FileAnnotationsAdapter } from "./annotations.js";

export interface MediaPreviewProps<T extends BrowserDownloadDocument> {
  className?: string;
  label: string;
  text: string;
  state: BrowserDownloadState;
  onDownload(): void;
  document: T | null;
  url: string;
  data: Uint8Array<ArrayBuffer> | null;
  ready: boolean;
  streaming: boolean;
  unsupported: boolean;
  /** Optional App-provided annotations layer for the PDF pathway. */
  annotations?: FileAnnotationsAdapter;
  /** Opaque per-file key the App mints; only PDF uses annotations today. */
  fileKey?: string;
  /** Shared controller used by file chrome and the in-preview annotation UI. */
  annotationControlRef?: MutableRefObject<AnnotationsPanelHandle | null>;
}

export function MediaPreview<T extends BrowserDownloadDocument>(props: MediaPreviewProps<T>) {
  if (props.unsupported) return <DownloadEmptyState {...props} />;
  const document = props.ready ? props.document : null;
  const pdfData = document?.mediaType === "application/pdf" ? props.data : null;
  return (
    <div
      className={`av-media${pdfData ? " av-media-pdf-flow" : ""}`}
      data-av-media
      aria-busy={props.streaming || undefined}
    >
      {pdfData
        ? (
          <PdfPreview
            data={pdfData}
            label={document?.label ?? props.label}
            {...(props.annotations ? { annotations: props.annotations } : {})}
            {...(props.fileKey ? { fileKey: props.fileKey } : {})}
            {...(props.annotationControlRef ? { annotationControlRef: props.annotationControlRef } : {})}
          />
        )
        : null}
      {document && document.mediaType !== "application/pdf"
        ? <img className="av-media-image" data-av-media-image src={props.url} alt={document.label} />
        : null}
    </div>
  );
}
