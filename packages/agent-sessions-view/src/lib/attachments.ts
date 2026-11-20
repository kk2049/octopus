/**
 * Files attached to the next chat prompt — the pure browser half.
 *
 * The ref is part of the PROMPT, composed at send time from the chips still on
 * the draft. It is not a side channel or projection field. Removing a chip
 * therefore removes the reference the agent would receive.
 *
 * This View never builds or reads a path. It knows only the display label and
 * absolute path returned after the trusted provider resolved the session and
 * the physical device created a fresh temporary directory.
 */

/** One accepted upload, as the composer holds it. */
export interface ChatAttachment {
  /** Stable per draft, so a React key and a removal do not depend on the path. */
  id: string;
  label: string;
  /** Absolute path on the session's device, returned by the trusted side. */
  path: string;
  bytes: number;
}

/** Clipboard paste remains image-only; button and drag/drop accept any file. */
const ACCEPTED_PASTE_MEDIA: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Images one clipboard paste may carry. */
const MAX_PER_PASTE = 4;

/** Files one draft may carry, so a composer cannot become an uploader. */
export const MAX_CHAT_ATTACHMENTS = 6;
/** Raw bytes per bounded transport chunk. */
export const CHAT_ATTACHMENT_CHUNK_BYTES = 256 * 1024;

export function isAttachableImage(type: string): boolean {
  return ACCEPTED_PASTE_MEDIA.has(type);
}

// Reserve names synchronously across pastes and chat mounts in this View runtime.
// Removing/sending an attachment or completing uploads out of order must not
// reuse a screenshot number. Reloading the View starts a new sequence.
let pastedImageSequence = 0;

function namePastedImage(file: File): File {
  // Keep meaningful filenames; only replace the browser's generic screenshot name.
  if (file.name && !/^image(?:\.(?:png|jpe?g|webp|gif))?$/i.test(file.name)) return file;
  const extension = file.type === "image/jpeg" ? "jpg" : file.type.slice("image/".length);
  pastedImageSequence += 1;
  return new File([file], `image-${pastedImageSequence}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/**
 * Every image on a clipboard payload, bounded.
 *
 * Takes the item list rather than the event so the caller's framework type
 * never reaches this module and a test can hand it two plain objects.
 */
export function imagesFromItems(
  items: ReadonlyArray<{ kind: string; getAsFile(): File | null }>,
): File[] {
  const out: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && isAttachableImage(file.type)) out.push(namePastedImage(file));
    if (out.length >= MAX_PER_PASTE) break;
  }
  return out;
}

/** base64 without a data-URL prefix, chunked so a megabyte does not blow the stack. */
export function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return btoa(binary);
}

/**
 * The prompt the agent receives: what the person wrote, then the completed
 * device-local references. An attachment with no text is a legitimate message.
 */
export function promptWithAttachments(prompt: string, attachments: readonly ChatAttachment[]): string {
  const body = prompt.trim();
  if (!attachments.length) return body;
  const lines = attachments.map((item) => `- ${item.label} — ${item.path}`);
  return [body, "", `[附件 ${attachments.length} 个文件，请直接读取这些绝对路径]`, ...lines]
    .join("\n")
    .trim();
}

let sequence = 0;

/** A chip id that is unique within this document. */
export function nextAttachmentId(): string {
  sequence += 1;
  return `chat-att-${sequence}`;
}

/** Clipboard files for the launch draft; plain text stays a native paste. */
export function filesFromItems(items: ReadonlyArray<{ kind: string; getAsFile(): File | null }>): File[] {
  return items.filter(item => item.kind === "file").slice(0, MAX_CHAT_ATTACHMENTS)
    .flatMap(item => {
      const file = item.getAsFile();
      return file ? [isAttachableImage(file.type) ? namePastedImage(file) : file] : [];
    });
}
