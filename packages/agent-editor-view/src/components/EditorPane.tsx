/**
 * The editor's chrome: a header, the banners, the surface, the save control.
 *
 * Presentational and props-driven, like every other component in the module
 * packages: it holds no port, no draft and no save. That is what lets a harness
 * render it from a fixture, and what keeps the CodeMirror surface underneath
 * replaceable without touching any of the states below.
 *
 * ── The states it must be able to say ───────────────────────────────────────
 *
 * Five, and each is a different sentence with a different next action:
 *
 *  · **read-only, structurally** — this port does not write, or this scope may
 *    not. There is no save control at all, because there is nothing to submit;
 *  · **submitted** — the normal ending. Somebody has to approve it, the outcome
 *    goes to them, and this panel cannot observe/cancel the pending call;
 *  · **conflict** — the file moved on. Same button, different sentence;
 *  · **saved** — applied, with a receipt;
 *  · **refused** — everything else, in the Host's own words.
 *
 * What it must NOT say is a countdown, a progress bar or an automatic refresh:
 * every one of those is a promise to re-issue a capability call, and a re-issued
 * call is another approval card.
 *
 * The same fields the viewer shows, and the same ones it refuses to: label,
 * media type, size, digest. No path, no device, no workspace id, no owner —
 * `workspace-files/v1` does not carry them.
 *
 * ── Why there is no empty state ─────────────────────────────────────────────
 *
 * An editor holding no file has nothing to say that the tree and the viewer have
 * not already said, and its standing instance may be mounted in a slot that only
 * exists while it is in use. So the module renders NOTHING without a resource,
 * and the App hides the empty slot — the arrangement the submission strip
 * already uses, which keeps "what is worth showing" a module decision and "how
 * the slot looks" an App decision.
 */

import type { ReactNode } from "react";
import {
  AvButton,
  Banner,
  DownloadAction,
  DownloadNotice,
  type BrowserDownloadState,
} from "@claude-bot/agent-view-react/ui";
import { DocumentPane } from "@claude-bot/agent-text-view";
import type { WorkspaceTextDocument } from "@claude-bot/workspace-files-contract";
import type { SaveState } from "../lib/save.js";

export interface EditorPaneProps {
  /** Null when this panel is standing and nothing has been opened into it. */
  document: WorkspaceTextDocument | null;
  /** Display label from the link, for the window before the header arrives. */
  label: string;
  status: "empty" | "loading" | "ready" | "refused";
  streaming: boolean;
  /** A refusal from the READ, which is a different thing from a save's. */
  readMessage: string;
  readCode: string;
  save: SaveState;
  /**
   * The whole-file digest the next edit will be submitted against.
   *
   * Usually the one the read carried; after an applied write it is the
   * receipt's `afterDigest`. Shown rather than the document's, because the
   * number a person can compare against another view is the CURRENT one.
   */
  baseDigest: string;
  dirty: boolean;
  /** False hides the save control entirely rather than disabling it. */
  writable: boolean;
  /** Why it is read-only, when it is: shown once, as a banner. */
  readOnlyReason: string;
  canSave: boolean;
  onSave(): void;
  onReload(): void;
  reloadDisabled?: boolean;
  download: BrowserDownloadState;
  onDownload(): void;
  onBrowse?(): void;
  browseDisabled?: boolean;
  onClose?(): void;
  domIdScope?: string;
  /** The text surface. Injected so this file stays free of CodeMirror. */
  children: ReactNode;
}

const SAVE_TONE: Readonly<Record<string, "info" | "warn" | "error" | "ok">> = Object.freeze({
  saving: "info",
  saved: "ok",
  submitted: "info",
  conflict: "warn",
  refused: "error",
});

export function EditorPane(props: EditorPaneProps) {
  const id = (name: string): string => (props.domIdScope ? `${name}-${props.domIdScope}` : name);
  const fileName = props.document?.label ?? props.label;
  return (
    <DocumentPane
      variant="editor"
      document={props.document}
      label={props.label}
      status={props.status}
      streaming={props.streaming}
      message={props.readMessage}
      code={props.readCode}
      dirty={props.dirty}
      onReload={props.onReload}
      reloadDisabled={props.reloadDisabled}
      reloadLabel={props.dirty ? "重新读取（放弃修改）" : "重新读取"}
      digest={props.baseDigest || props.document?.digest || ""}
      digestTitle="这次编辑所基于的整份文件摘要"
      domIdScope={props.domIdScope}
      {...(props.onClose ? { onClose: props.onClose } : {})}
      actions={
        <>
          {props.onBrowse ? (
            <span className="wsview-switch" role="group" aria-label="浏览或编辑">
              <AvButton
                disabled={props.browseDisabled}
                title={props.browseDisabled ? "请先保存或重新读取以放弃未保存的修改。" : undefined}
                onClick={props.onBrowse}
              >
                浏览
              </AvButton>
              <AvButton disabled aria-current="page">编辑</AvButton>
            </span>
          ) : <AvButton disabled aria-current="page">编辑</AvButton>}
          <DownloadAction label={fileName} state={props.download} onDownload={props.onDownload} />
          {props.writable ? (
            <AvButton
              className="wsedit-save"
              id={id("wseditSave")}
              disabled={!props.canSave}
              title="保存（Ctrl/⌘+S）。每次保存都要设备主人批准。"
              onClick={props.onSave}
            >
              保存
            </AvButton>
          ) : null}
        </>
      }
      notices={
        <>
          <DownloadNotice state={props.download} />
          {props.writable ? null : (
            <Banner icon="🔒" tone="warn" title="只读" text={props.readOnlyReason} />
          )}
          {props.save.status === "idle" ? null : (
            <p
              className="wsedit-save-state"
              role="status"
              data-status={props.save.status}
              data-code={props.save.code || undefined}
              data-tone={SAVE_TONE[props.save.status] ?? "info"}
            >
              {props.save.message}
            </p>
          )}
        </>
      }
    >
      {props.children}
    </DocumentPane>
  );
}
