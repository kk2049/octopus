import type { ReactNode } from "react";
import { AvButton, EmptyState, StatusChip } from "@claude-bot/agent-view-react/ui";

export type DocumentPaneVariant = "viewer" | "editor";
export type DocumentReadStatus = "empty" | "loading" | "ready" | "refused";

/** Display facts only; workspace, CRDT, prompt or log domains can all provide them structurally. */
export interface TextDocumentMetadata {
  readonly label: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly modifiedAt?: string;
}

export interface DocumentPaneProps {
  variant: DocumentPaneVariant;
  document: TextDocumentMetadata | null;
  label: string;
  status: DocumentReadStatus;
  streaming: boolean;
  message: string;
  code: string;
  dirty?: boolean;
  onReload(): void;
  onClose?(): void;
  domIdScope?: string;
  reloadLabel?: string;
  /** A consumer may serialize reload with an in-flight mutation. */
  reloadDisabled?: boolean;
  digest?: string;
  digestTitle?: string;
  /** A refused stream may still have yielded useful, explicitly partial text. */
  hasPartialContent?: boolean;
  empty?: { icon: string; title: string; text: string };
  /** Controls placed after the spacer and before reload. */
  actions?: ReactNode;
  /** Save/refusal details owned by the consumer, placed above the text surface. */
  notices?: ReactNode;
  children: ReactNode;
}

const READ_ACTIONABLE: Readonly<Record<string, string>> = Object.freeze({
  approval_required: "这次读取需要设备主人在可信审批栏确认后重试。",
  no_authority: "当前登录没有读取工作区文件的授权。",
  not_text: "这个文件不是 UTF-8 文本，本视图不打开它。",
  outside_workspace: "这个引用指向了已登记工作区之外。",
  scope_closed: "这个视图的会话已经结束，请重新打开页面。",
  // Ticket #201. Both mean "the header arrived and the body did not", which
  // without a sentence here renders as a blank pane under a real file size.
  stalled: "这个文件的内容读到一半就没有继续了；点「重新读取」再试一次。",
  incomplete: "这次读取结束了，却没有送来任何内容；点「重新读取」再试一次。",
  // Ticket #253. The leg BEFORE those two: the open itself never answered, so
  // there is not even a size to show — without a sentence the pane is a file
  // name over an empty gutter, which reads as "the page will not load".
  unanswered: "这个文件的读取一直没有得到回应；点「重新读取」再试一次。",
});

const VARIANT = Object.freeze({
  viewer: {
    section: "wsviewer",
    bar: "wsviewer-bar",
    spacer: "wsviewer-spacer",
    sectionId: "wsviewer",
    reloadId: "wsReload",
    closeId: "wsClose",
  },
  editor: {
    section: "wsedit",
    bar: "wsedit-bar",
    spacer: "wsedit-spacer",
    sectionId: "wsedit",
    reloadId: "wseditReload",
    closeId: "wseditClose",
  },
} as const);

/** Shared document chrome. It renders facts and callbacks; it owns no resource state. */
export function DocumentPane(props: DocumentPaneProps) {
  if (props.status === "empty" && props.empty) {
    return <EmptyState icon={props.empty.icon} title={props.empty.title} text={props.empty.text} />;
  }

  const names = VARIANT[props.variant];
  const id = (name: string): string => (props.domIdScope ? `${name}-${props.domIdScope}` : name);
  const document = props.document;
  const digest = props.digest || document?.digest || "";
  const reloadLabel = props.reloadLabel ?? "重新读取";

  return (
    <section
      className={`${names.section} av-document-pane`}
      id={id(names.sectionId)}
      data-av-document-pane={props.variant}
      aria-busy={props.streaming || undefined}
    >
      <div className={`${names.bar} av-document-bar`} data-av-document-bar>
        <strong>{document?.label || props.label}</strong>
        {document ? (
          <span className="wsmeta av-document-meta" data-av-document-meta>
            {document.mediaType} · {displayTextSize(document.sizeBytes)}
            {document.modifiedAt ? ` · ${document.modifiedAt}` : ""}
          </span>
        ) : null}
        {props.streaming ? <StatusChip busy word="正在读取最新内容" tone="info" /> : null}
        {props.dirty ? <StatusChip icon="●" word="未保存" tone="warn" /> : null}
        <span className={`${names.spacer} av-document-spacer`} />
        {props.actions}
        <AvButton
          id={id(names.reloadId)}
          aria-label={reloadLabel}
          title={reloadLabel}
          disabled={props.reloadDisabled}
          onClick={props.onReload}
        >
          <span aria-hidden="true">↻</span>
          <span className="av-document-action-word">{reloadLabel}</span>
        </AvButton>
        {props.onClose ? (
          <AvButton id={id(names.closeId)} aria-label="关闭" title="关闭" onClick={props.onClose}>
            <span aria-hidden="true">×</span>
            <span className="av-document-action-word">关闭</span>
          </AvButton>
        ) : null}
      </div>

      {props.status === "refused" ? (
        <p className="wsrefusal" role="note" data-code={props.code}>
          {READ_ACTIONABLE[props.code] ?? props.message ?? "这次读取没有完成。"}
          {props.hasPartialContent ? "（下面是本次已经读到的部分内容。）" : ""}
        </p>
      ) : null}
      {props.notices}
      {props.children}
      {digest ? (
        <p className="wsmeta wsdigest" data-av-document-digest title={props.digestTitle ?? "打开这个文件时整份内容的摘要"}>
          {digest}
        </p>
      ) : null}
    </section>
  );
}

/** Display-only byte formatting shared by viewer and editor chrome. */
export function displayTextSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
