/**
 * The composer half of pasted attachments (any file type): one hook and one strip.
 *
 * Three boxes needed this — filing a ticket, opening a discussion, and
 * answering an agent mid-ticket — and they are three different forms (one
 * `react-hook-form`, two plain `useState`). What they share is not markup but
 * a rule: the file uploads on paste, appears as a removable chip, and is
 * named in the body AT SEND TIME from the chips that are still there. Writing
 * that rule three times is how one of the three quietly stops appending the
 * refs and the agent starts receiving pictures it is never told about.
 *
 * The strip renders nothing when the draft is empty, so a form that has never
 * been pasted into is unchanged — including its height.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../lib/api.js";
import {
  filesFromClipboard,
  releaseAttachment,
  uploadAttachment,
  withAttachments,
  type Attachment,
} from "../lib/attachments.js";
import styles from "./Attachments.module.css";
import { useMessages } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";

export interface AttachmentDraft {
  items: readonly Attachment[];
  /** Wire onto the textarea. A paste with no file stays an ordinary paste. */
  onPaste(event: React.ClipboardEvent): void;
  /** File pickers/capture share the same pending and generation ownership. */
  addFiles(files: readonly File[] | Promise<readonly File[]>): Promise<void>;
  /** A successful send consumes only the chips present at this snapshot. */
  markSubmission(): () => void;
  remove(id: string): void;
  /** Body + refs, in the one order every composer sends them. */
  compose(body: string): string;
  /** Await this draft's uploads; rejects on upload failure or draft replacement. */
  ready(): Promise<void>;
  /** Cleared after a successful send; previews are revoked. */
  clear(): void;
  status: string;
  failure: string;
}

export function useAttachments(scopeKey = "draft"): AttachmentDraft {
  const { t } = useMessages();
  const [items, setItems] = useState<Attachment[]>([]);
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState("");
  const live = useRef<readonly Attachment[]>([]);
  const generation = useRef(0);
  const pending = useRef(new Set<Promise<void>>());
  const uploadFailure = useRef("");

  const invalidate = useCallback(() => {
    generation.current += 1;
    live.current.forEach(releaseAttachment);
    live.current = [];
    pending.current.clear();
    uploadFailure.current = "";
  }, []);
  const clear = useCallback(() => {
    invalidate();
    setItems([]);
    setStatus("");
    setFailure("");
  }, [invalidate]);
  useEffect(() => {
    clear();
    return invalidate;
  }, [scopeKey, clear, invalidate]);

  const addFiles = useCallback((files: readonly File[] | Promise<readonly File[]>): Promise<void> => {
    if (Array.isArray(files) && !files.length) return Promise.resolve();
    const current = generation.current;
    uploadFailure.current = "";
    setFailure("");
    setStatus(t("attachment.uploading", { count: Array.isArray(files) ? files.length : 1 }));
    const job = Promise.resolve().then(async () => {
      try {
        const picked = await files;
        for (const file of picked) {
          if (current !== generation.current) return;
          const attachment = await uploadAttachment(file, {
            current: () => current === generation.current,
            onProgress: (sent, total) => {
              if (current !== generation.current || total <= 0) return;
              setStatus(t("attachment.progress", { name: file.name || t("attachment.label"), percent: Math.floor((sent / total) * 100) }));
            },
          });
          if (current !== generation.current) { releaseAttachment(attachment); return; }
          live.current = [...live.current, attachment];
          setItems([...live.current]);
        }
      } catch (err) {
        if (current !== generation.current) return;
        uploadFailure.current = errorText(err) || t("attachment.uploadFailed");
        setFailure(uploadFailure.current);
      }
    });
    pending.current.add(job);
    void job.then(() => {
      if (current !== generation.current) return;
      pending.current.delete(job);
      if (!pending.current.size) setStatus("");
    });
    return job.then(() => {
      if (current !== generation.current) throw new Error(uiText("附件草稿已变化，请重新发送。"));
      if (uploadFailure.current) throw new Error(uploadFailure.current);
    });
  }, [t]);
  const onPaste = useCallback((event: React.ClipboardEvent): void => {
    const files = filesFromClipboard(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files).catch(() => {}); // The hook exposes the bounded failure.
  }, [addFiles]);

  const ready = useCallback(async () => {
    const current = generation.current;
    while (pending.current.size) {
      await Promise.all([...pending.current]);
      if (current !== generation.current) throw new Error(uiText("附件草稿已变化，请重新发送。"));
    }
    if (uploadFailure.current) throw new Error(uploadFailure.current);
  }, []);
  const remove = useCallback((id: string): void => {
    const gone = live.current.find((item) => item.id === id);
    if (gone) releaseAttachment(gone);
    live.current = live.current.filter((item) => item.id !== id);
    setItems([...live.current]);
  }, []);
  const markSubmission = useCallback(() => {
    const current = generation.current;
    const ids = new Set(live.current.map((item) => item.id));
    return () => {
      if (current !== generation.current) return;
      live.current.filter((item) => ids.has(item.id)).forEach(releaseAttachment);
      live.current = live.current.filter((item) => !ids.has(item.id));
      setItems([...live.current]);
    };
  }, []);
  const compose = useCallback((body: string): string => withAttachments(body, live.current), []);

  return { items, onPaste, addFiles, markSubmission, remove, compose, ready, clear, status, failure };
}

/** KB below one MiB, MB (one decimal) above: a 40 MiB file is not "40960 KB". */
export function attachmentSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentStrip({ draft }: { draft: AttachmentDraft }) {
  const { t } = useMessages();
  if (!draft.items.length && !draft.status && !draft.failure) return null;
  return (
    <div className={styles.strip}>
      <ul className={styles.chips} aria-label={t("attachment.label")}>
        {draft.items.map((item) => (
          <li className={styles.chip} key={item.id}>
            {item.previewUrl
              ? <a href={item.previewUrl} target="_blank" rel="noopener noreferrer">{item.label}</a>
              : <span title={item.mediaType}>{item.label}</span>}
            <span className={styles.size}>{attachmentSize(item.bytes)}</span>
            <button
              type="button"
              className={styles.remove}
              aria-label={t("attachment.remove", { name: item.label })}
              onClick={() => draft.remove(item.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {draft.status ? <span className={styles.note}>{draft.status}</span> : null}
      {draft.failure ? <span className={styles.bad} role="alert">{draft.failure}
        <button type="button" className={styles.remove} aria-label={t("attachment.remove", { name: t("attachment.label") })} onClick={draft.clear}>✕</button>
      </span> : null}
    </div>
  );
}
