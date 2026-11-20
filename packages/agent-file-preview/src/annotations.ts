/**
 * The adapter shape a preview surface receives when the composition wants
 * annotations for a file. It is intentionally narrow: read the list, write
 * the list. The preview owns the interaction (which selection becomes a
 * quote, when to save, when to export); the App owns transport, persistence
 * and permissions.
 *
 * `fileKey` is opaque bounded text the App mints from the listing lineage.
 * The preview never inspects it — it is only used as a stable dictionary key
 * and echoed back on save.
 */

import type { FileAnnotation } from "@claude-bot/agent-sessions-contract";

export type { FileAnnotation };
export type { AnnotationTarget, AnnotationTargetMarkdown, AnnotationTargetPdf } from "@claude-bot/agent-sessions-contract";

export interface FileAnnotationDraftRecord {
  readonly text: string;
  readonly updatedAt: number;
}

/**
 * Optional browser-local display state supplied by the App composition.
 * The preview chooses exact file/target keys; the implementation adds viewer
 * and release scoping outside the opaque View.
 */
export interface FileAnnotationDraftStore {
  get(key: string): FileAnnotationDraftRecord;
  set(key: string, text: string): void;
  subscribe(key: string, listener: (record: FileAnnotationDraftRecord) => void): () => void;
}

export interface FileAnnotationsAdapter {
  /**
   * Persist the full list of annotations for `fileKey`. Empty array clears
   * every annotation for the key. Returns a bounded reason on refusal;
   * a promise is always resolved, never rejected.
   */
  save(fileKey: string, annotations: readonly FileAnnotation[]): Promise<
    { ok: true } | { ok: false; message: string; code?: string }
  >;
  /** Snapshot of the durable annotations for `fileKey`; frames identity-share. */
  read(fileKey: string): readonly FileAnnotation[];
  /** Optional lossy note drafts; never used as annotation authority. */
  drafts?: FileAnnotationDraftStore;
}

/** Bounds shared by every anchor payload so no single note can exceed the wire budget. */
export const ANNOTATION_LIMITS = Object.freeze({
  quoteMax: 512,
  contextMax: 128,
  noteMax: 1000,
  perFileMax: 128,
});

/** Trim + cap the context strings that ride alongside a quote. */
export function clampContext(text: string): string {
  const trimmed = text.replace(/\r/g, "");
  return trimmed.length <= ANNOTATION_LIMITS.contextMax
    ? trimmed
    : trimmed.slice(trimmed.length - ANNOTATION_LIMITS.contextMax);
}

/** Trim + cap the quote itself. */
export function clampQuote(text: string): string {
  const trimmed = text.replace(/\r/g, "");
  return trimmed.length <= ANNOTATION_LIMITS.quoteMax
    ? trimmed
    : trimmed.slice(0, ANNOTATION_LIMITS.quoteMax);
}
