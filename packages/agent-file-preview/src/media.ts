import { useEffect, useRef, useState } from "react";
import {
  WORKSPACE_MEDIA_LIMITS,
  type AnyWorkspaceFilesPort,
  type WorkspaceMediaDocument,
  type WorkspaceMediaPort,
} from "@claude-bot/workspace-files-contract";

const MEDIA_READ_STALL_MS = 20_000;

/**
 * An image or PDF renders from all of its bytes, so a preview holds the whole
 * file in the page. Past this budget the hook asks instead of loading:
 * `too_large` with the header, and the caller offers to preview anyway
 * (`budgetBytes = Infinity`) or to download. The port itself has no size cap.
 */
export const MEDIA_PREVIEW_BUDGET_BYTES = WORKSPACE_MEDIA_LIMITS.previewBytes;

export interface MediaState {
  status: "empty" | "loading" | "ready" | "refused";
  document: WorkspaceMediaDocument | null;
  url: string;
  data: Uint8Array<ArrayBuffer> | null;
  streaming: boolean;
  message: string;
  code: string;
}

const EMPTY: MediaState = Object.freeze({
  status: "empty",
  document: null,
  url: "",
  data: null,
  streaming: false,
  message: "",
  code: "",
});

const LOADING: MediaState = Object.freeze({ ...EMPTY, status: "loading", streaming: true });

interface ScopedMediaState {
  port: AnyWorkspaceFilesPort;
  ref: string;
  reload: number;
  budget: number;
  value: MediaState;
}

interface MediaRequest {
  port: AnyWorkspaceFilesPort;
  ref: string;
  reload: number;
  budget: number;
  owner: number;
  cancelled: boolean;
  objectUrl: string;
  close(): void;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Pull one v3 media stream to a complete Blob URL. Never retries. */
export function useWorkspaceMedia(
  port: AnyWorkspaceFilesPort,
  ref: string | null,
  reload = 0,
  budgetBytes = MEDIA_PREVIEW_BUDGET_BYTES,
): MediaState {
  const [scoped, setScoped] = useState<ScopedMediaState | null>(null);
  const request = useRef<MediaRequest | null>(null);
  const ownerSequence = useRef(0);

  useEffect(() => {
    if (!ref) {
      request.current = null;
      setScoped(null);
      return;
    }

    const owner = ++ownerSequence.current;
    let active = request.current;
    const reusable = active !== null
      && !active.cancelled
      && active.port === port
      && active.ref === ref
      && active.reload === reload
      && active.budget === budgetBytes;

    if (reusable) {
      active!.owner = owner;
    } else {
      if (active && !active.cancelled) {
        active.cancelled = true;
        active.close();
      }
      let streamClosed = false;
      let closeStream: (() => void) | null = null;
      active = {
        port,
        ref,
        reload,
        budget: budgetBytes,
        owner,
        cancelled: false,
        objectUrl: "",
        close() {
          if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = "";
          }
          if (!closeStream || streamClosed) return;
          streamClosed = true;
          closeStream();
        },
      };
      request.current = active;
      setScoped({ port, ref, reload, budget: budgetBytes, value: LOADING });

      const running = active;
      const live = (): boolean => !running.cancelled && running.owner !== 0 && request.current === running;
      const publish = (next: MediaState): void => {
        if (live()) {
          setScoped({ port: running.port, ref: running.ref, reload: running.reload, budget: running.budget, value: next });
        }
      };
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const disarm = (): void => {
        if (watchdog === null) return;
        clearTimeout(watchdog);
        watchdog = null;
      };
      const armed = active.close.bind(active);
      active.close = () => {
        disarm();
        armed();
      };

      void (async () => {
        const mediaPort = port as Partial<WorkspaceMediaPort>;
        if (typeof mediaPort.openMedia !== "function") {
          publish({ ...EMPTY, status: "refused", message: "当前工作区连接不支持媒体预览。", code: "unsupported_media" });
          return;
        }
        watchdog = setTimeout(() => {
          watchdog = null;
          if (!live()) return;
          publish({ ...EMPTY, status: "refused", message: "这个媒体文件的读取一直没有得到回应。", code: "unanswered" });
          running.cancelled = true;
          running.close();
        }, MEDIA_READ_STALL_MS);
        const opened = await mediaPort.openMedia(ref).catch(() => null);
        disarm();
        if (!opened) {
          publish({ ...EMPTY, status: "refused", message: "这次媒体读取没有返回结果。", code: "unavailable" });
          return;
        }
        if (!opened.ok) {
          publish({ ...EMPTY, status: "refused", message: opened.message, code: opened.code });
          return;
        }
        const { document, stream } = opened.value;
        closeStream = () => void stream.close();
        if (!live()) {
          running.close();
          return;
        }
        if (document.sizeBytes > running.budget) {
          publish({
            status: "refused",
            document,
            url: "",
            data: null,
            streaming: false,
            message: `文件共 ${(document.sizeBytes / (1024 * 1024)).toFixed(1)} MiB，较大，没有自动预览；可继续预览或下载。`,
            code: "too_large",
          });
          running.close();
          return;
        }
        publish({ status: "loading", document, url: "", data: null, streaming: true, message: "", code: "" });

        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let received = 0;
        for (;;) {
          watchdog = setTimeout(() => {
            watchdog = null;
            if (!live()) return;
            publish({
              status: "refused",
              document,
              url: "",
              data: null,
              streaming: false,
              message: "这个媒体文件的内容在读取中途停住了。",
              code: "stalled",
            });
            running.cancelled = true;
            running.close();
          }, MEDIA_READ_STALL_MS);
          const read = await stream.next().catch(() => null);
          disarm();
          if (!live()) {
            running.close();
            return;
          }
          if (!read) {
            publish({ status: "refused", document, url: "", data: null, streaming: false, message: "这条资源流没有继续。", code: "unavailable" });
            running.close();
            return;
          }
          if (read.kind === "chunk") {
            const bytes = decodeBase64(read.value.data);
            if (read.value.offset !== received || bytes.length !== read.value.bytes) {
              publish({ status: "refused", document, url: "", data: null, streaming: false, message: "媒体分块的读取位置不连续。", code: "protocol" });
              running.close();
              return;
            }
            chunks.push(bytes);
            received += bytes.length;
            continue;
          }
          if (read.kind === "end") {
            if (received !== document.sizeBytes) {
              publish({ status: "refused", document, url: "", data: null, streaming: false, message: "媒体读取没有送来完整文件。", code: "incomplete" });
              running.close();
              return;
            }
            const pdf = document.mediaType === "application/pdf";
            const data = pdf ? concatenate(chunks, received) : null;
            const url = pdf ? "" : URL.createObjectURL(new Blob(chunks, { type: document.mediaType }));
            running.objectUrl = url;
            publish({ status: "ready", document, url, data, streaming: false, message: "", code: "" });
            if (closeStream && !streamClosed) {
              streamClosed = true;
              closeStream();
            }
            return;
          }
          publish({ status: "refused", document, url: "", data: null, streaming: false, message: read.message, code: read.code });
          running.close();
          return;
        }
      })();
    }

    return () => {
      if (active!.owner === owner) active!.owner = 0;
      const released = active!;
      queueMicrotask(() => {
        if (released.owner !== 0 || released.cancelled) return;
        released.cancelled = true;
        released.close();
      });
    };
  }, [port, ref, reload, budgetBytes]);

  if (!ref) return EMPTY;
  return scoped?.port === port && scoped.ref === ref && scoped.reload === reload && scoped.budget === budgetBytes
    ? scoped.value
    : LOADING;
}

function concatenate(chunks: readonly Uint8Array<ArrayBuffer>[], size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
