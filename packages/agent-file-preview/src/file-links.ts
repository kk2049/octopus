import type { ListedFileLocation } from './markdown-images.js';

/** Resolve a mention through the host-bound resource port. This grants no file access. */
export interface PublishedFileLinks {
  resolve(input: { href: string; sessionRef?: string; fileRef?: string; location?: ListedFileLocation | null }): Promise<
    | { ok: true; ref: string; label: string; location: ListedFileLocation }
    | { ok: false; message: string }
  >;
}
