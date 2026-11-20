import { promises as fs } from "node:fs";

const CHECK_MS = 1_500;
const RESOLVE_MS = 10_000;

export interface TranscriptSourceWatchOptions {
  /** Trusted device-local resolver; no file path is accepted from the wire. */
  resolvePath(): Promise<string>;
  onChanged(): void;
  onChecked?(): void;
  /** Metadata-only seam for deterministic lifecycle tests. */
  fingerprint?(file: string): Promise<string>;
  now?(): number;
}

async function fingerprint(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error("transcript source is not a regular file");
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

/**
 * A bounded observer for one authorized subscription. Native hooks are the
 * fast path; metadata checks recover missed hooks without parsing cold logs.
 * Identity is re-resolved periodically so account copies/path replacement
 * retain the normal scanner selection rules.
 */
export function watchTranscriptSource(options: TranscriptSourceWatchOptions): () => void {
  const now = options.now ?? Date.now;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let file: string | undefined;
  let resolveAt = 0;
  let previous: string | undefined;
  const check = async (): Promise<void> => {
    try {
      if (!file || now() >= resolveAt) {
        file = await options.resolvePath();
        resolveAt = now() + RESOLVE_MS;
      }
      if (closed) return;
      const version = file + ":" + await (options.fingerprint ?? fingerprint)(file);
      if (closed) return;
      if (version !== previous) { previous = version; options.onChanged(); }
      else options.onChecked?.();
    } catch {
      // A disappearing source gets one invalidation and retries resolution.
      // Do not keep following a stale path or repeatedly parse a missing file.
      file = undefined;
      if (!closed && previous !== "missing") {
        previous = "missing";
        options.onChanged();
      }
    } finally {
      if (!closed) {
        timer = setTimeout(() => { void check(); }, CHECK_MS);
        timer.unref?.();
      }
    }
  };
  void check();
  return () => { closed = true; if (timer) clearTimeout(timer); };
}
