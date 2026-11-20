import { describe, expect, it, vi } from "vitest";
import {
  RESOURCE_STREAM_CONTRACT,
  type ResourceStream,
  type ResourceStreamRead,
} from "@claude-bot/resource-stream-contract";
import {
  WORKSPACE_DOWNLOAD_ACTION,
  WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD,
  WORKSPACE_DOWNLOAD_LIMITS,
  WORKSPACE_DOWNLOAD_MEDIA_TYPE,
  WORKSPACE_DOWNLOAD_OPERATION,
  WORKSPACE_DOWNLOAD_STALL_MS,
  WORKSPACE_DOWNLOAD_OPEN_STALL_MS,
  WORKSPACE_FILES_DECLARATION_V4,
  collectWorkspaceDownload,
  readWorkspaceDownloadChunk,
  readWorkspaceDownloadDocument,
  type WorkspaceDownloadChunk,
  type WorkspaceDownloadDocument,
  type WorkspaceDownloadPort,
} from "./download.js";
import {
  RESOURCE_DOWNLOAD_FILE_ACTION,
  WORKSPACE_FILES_PROPOSAL_ACTIONS_V4,
  createRemoteWorkspaceFilesPortV4,
} from "./remote-v4.js";
import type { ProposalTransport } from "./remote.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const TEST_TIMERS = globalThis as unknown as {
  setTimeout(callback: () => void, delayMs: number): unknown;
};
const DOCUMENT: WorkspaceDownloadDocument = {
  ref: "wf_download_ref",
  label: "archive.bin",
  mediaType: WORKSPACE_DOWNLOAD_MEDIA_TYPE,
  sizeBytes: 4,
  digest: DIGEST,
};

function downloadPort(stream: ResourceStream<WorkspaceDownloadChunk>): WorkspaceDownloadPort {
  return {
    async downloadFile() {
      return { ok: true, value: { document: DOCUMENT, stream } };
    },
  };
}

describe("workspace-files/v4 download", () => {
  it("accepts only bounded opaque regular-file headers", () => {
    const document = {
      ref: "wf_download_ref",
      label: "archive.bin",
      mediaType: WORKSPACE_DOWNLOAD_MEDIA_TYPE,
      sizeBytes: 4,
      digest: DIGEST,
      modifiedAt: "2026-08-22T10:20:30.123Z",
    };
    expect(readWorkspaceDownloadDocument(document)).toEqual({ ok: true, value: document });
    expect(readWorkspaceDownloadDocument({ ...document, mediaType: "text/html" }).ok).toBe(false);
    expect(readWorkspaceDownloadDocument({ ...document, sizeBytes: 50 * 1024 ** 3 }).ok).toBe(true);
    expect(readWorkspaceDownloadDocument({
      ...document,
      sizeBytes: WORKSPACE_DOWNLOAD_LIMITS.maxBytes + 1,
    }).ok).toBe(false);
    expect(readWorkspaceDownloadDocument({ ...document, path: "/private/archive.bin" }).ok).toBe(false);
  });

  it("rejects malformed, mismatched, and widened byte chunks", () => {
    expect(readWorkspaceDownloadChunk({ offset: 0, bytes: 4, data: "AAEC/w==" })).toEqual({
      ok: true,
      value: { offset: 0, bytes: 4, data: "AAEC/w==" },
    });
    expect(readWorkspaceDownloadChunk({ offset: 0, bytes: 5, data: "AAEC/w==" }).ok).toBe(false);
    expect(readWorkspaceDownloadChunk({ offset: 0, bytes: 4, data: "AAEC/w==", path: "x" }).ok)
      .toBe(false);
  });

  it("declares one distinct download action and operation", () => {
    expect(WORKSPACE_DOWNLOAD_ACTION).toBe("download_file");
    expect(WORKSPACE_DOWNLOAD_OPERATION).toBe("download_workspace_file");
    expect(WORKSPACE_FILES_DECLARATION_V4.byAction.download_file.operation)
      .toBe(WORKSPACE_DOWNLOAD_OPERATION);
    expect(WORKSPACE_FILES_PROPOSAL_ACTIONS_V4.filter(
      (action) => action === RESOURCE_DOWNLOAD_FILE_ACTION,
    )).toHaveLength(1);
  });

  it("sends only the binding and opaque ref over the v4 download proposal", async () => {
    const sent: Array<{ action: string; params?: Record<string, string> }> = [];
    const transport: ProposalTransport = {
      async propose(action, params) {
        sent.push({ action, params });
        return { ok: false, code: "unavailable", result: null, message: "offline" };
      },
    };
    const remote = createRemoteWorkspaceFilesPortV4(transport, "workspace");

    expect((await remote.port.downloadFile("wf_download_ref")).ok).toBe(false);
    expect(sent).toEqual([{
      action: RESOURCE_DOWNLOAD_FILE_ACTION,
      params: { binding: "workspace", ref: "wf_download_ref" },
    }]);
  });

  it("reports acknowledged bytes and ends a stalled pull without producing a partial file", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const close = vi.fn(async () => {});
      const stream: ResourceStream<WorkspaceDownloadChunk> = {
        contract: RESOURCE_STREAM_CONTRACT,
        metadata: {
          payload: WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD,
          mediaType: WORKSPACE_DOWNLOAD_MEDIA_TYPE,
          totalBytes: DOCUMENT.sizeBytes,
          digest: DOCUMENT.digest,
        },
        async next(): Promise<ResourceStreamRead<WorkspaceDownloadChunk>> {
          reads += 1;
          if (reads === 1) {
            return { kind: "chunk", seq: 0, value: { offset: 0, bytes: 2, data: "AAE=" } };
          }
          return await new Promise<ResourceStreamRead<WorkspaceDownloadChunk>>(() => {});
        },
        close,
      };
      const onProgress = vi.fn();
      const pending = collectWorkspaceDownload(downloadPort(stream), DOCUMENT.ref, () => {}, () => true, onProgress);

      await vi.advanceTimersByTimeAsync(0);
      expect(onProgress.mock.calls).toEqual([[0, 4], [2, 4]]);
      await vi.advanceTimersByTimeAsync(WORKSPACE_DOWNLOAD_STALL_MS);

      expect(await pending).toMatchObject({ ok: false, code: "stalled", document: DOCUMENT });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a healthy download to outlive the watchdog while each pull keeps advancing", async () => {
    vi.useFakeTimers();
    try {
      const frames: ResourceStreamRead<WorkspaceDownloadChunk>[] = [
        { kind: "chunk", seq: 0, value: { offset: 0, bytes: 2, data: "AAE=" } },
        { kind: "chunk", seq: 1, value: { offset: 2, bytes: 2, data: "Av8=" } },
        { kind: "end", chunks: 2, bytes: 4 },
      ];
      const close = vi.fn(async () => {});
      const stream: ResourceStream<WorkspaceDownloadChunk> = {
        contract: RESOURCE_STREAM_CONTRACT,
        metadata: {
          payload: WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD,
          mediaType: WORKSPACE_DOWNLOAD_MEDIA_TYPE,
          totalBytes: DOCUMENT.sizeBytes,
          digest: DOCUMENT.digest,
        },
        async next() {
          const frame = frames.shift()!;
          if (frame.kind === "chunk") {
            await new Promise<void>((resolve) => {
              TEST_TIMERS.setTimeout(resolve, WORKSPACE_DOWNLOAD_STALL_MS - 1_000);
            });
          }
          return frame;
        },
        close,
      };
      const delivered: string[] = [];
      const pending = collectWorkspaceDownload(downloadPort(stream), DOCUMENT.ref, (data) => delivered.push(data));

      await vi.advanceTimersByTimeAsync((WORKSPACE_DOWNLOAD_STALL_MS - 1_000) * 2);
      expect(await pending).toMatchObject({ ok: true, document: DOCUMENT });
      // Chunks reach the sink in order and are not retained in the result.
      expect(delivered).toEqual(["AAE=", "Av8="]);
      expect(await pending).not.toHaveProperty("chunks");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out an unanswered open and releases a late successful stream", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(async () => {});
      const stream: ResourceStream<WorkspaceDownloadChunk> = {
        contract: RESOURCE_STREAM_CONTRACT,
        metadata: {
          payload: WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD,
          mediaType: WORKSPACE_DOWNLOAD_MEDIA_TYPE,
          totalBytes: DOCUMENT.sizeBytes,
          digest: DOCUMENT.digest,
        },
        async next() {
          return { kind: "end", chunks: 0, bytes: 0 };
        },
        close,
      };
      let finish!: (reply: Awaited<ReturnType<WorkspaceDownloadPort["downloadFile"]>>) => void;
      const port: WorkspaceDownloadPort = {
        downloadFile: () => new Promise((resolve) => { finish = resolve; }),
      };
      const pending = collectWorkspaceDownload(port, DOCUMENT.ref, () => {});

      // The open is answered after the device's whole-file pass, so it gets
      // the longer open budget, not the per-pull one.
      await vi.advanceTimersByTimeAsync(WORKSPACE_DOWNLOAD_STALL_MS);
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(WORKSPACE_DOWNLOAD_OPEN_STALL_MS - WORKSPACE_DOWNLOAD_STALL_MS);
      expect(await pending).toMatchObject({ ok: false, code: "unanswered", document: null });
      finish({ ok: true, value: { document: DOCUMENT, stream } });
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
