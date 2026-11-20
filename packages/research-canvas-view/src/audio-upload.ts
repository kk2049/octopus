import { nodeMetadata, type ResearchNode } from "@claude-bot/research-canvas-contract";
import { persist, requestId, stored, type Call } from "./client.js";
import { sendChunks, sha256Of, type ByteSource } from "./file-upload.js";

export interface AudioFileInfo { id: string; name: string; mime: string; bytes: number; sha256: string; version: number }
export interface AudioUploadDraft { request: string; data: { name: string; mime: string; bytes: number; sha256: string } }
export interface AudioUploadState {
  phase: "idle" | "hashing" | "uploading" | "committing" | "pausing" | "paused" | "failed" | "completed";
  name: string; total: number; received: number; error: string; file: AudioFileInfo | null;
}
export const uploadPending = (state: AudioUploadState) => ["hashing", "uploading", "committing", "pausing"].includes(state.phase);
export function meetingMetadata(node: ResearchNode) {
  const value = nodeMetadata(node).meeting;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as { fileVersion?: number; fileName?: string; bytes?: number; stage?: string; summaryState?: string }
    : {};
}
export function audioSize(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(bytes >= 1024 * 1024 ? 1 : 2)} MiB`; }
function readDraft(key: string): AudioUploadDraft | null {
  const draft = stored<AudioUploadDraft | null>(key, null);
  return draft && typeof draft.request === "string" && draft.data && typeof draft.data.name === "string"
    && typeof draft.data.mime === "string" && Number.isSafeInteger(draft.data.bytes) && draft.data.bytes > 0
    && /^[0-9a-f]{64}$/.test(draft.data.sha256) ? draft : null;
}

/** One controller per viewer/project/node owns upload work across card/detail mounts.
 * Only metadata is stored locally. Reselecting the same file restores the exact request.
 * Cancellation stops subsequent chunks; a dispatched commit must be reconciled, not undone.
 * A recording of any size is hashed and sent in bounded windows read from the File;
 * the page never holds the whole recording.
 */
export class AudioUploadController {
  private listeners = new Set<() => void>();
  private generation = 0;
  private busy = false;
  private cancelled = false;
  private selected: (ByteSource & Pick<File, "name" | "type">) | null = null;
  private draft: AudioUploadDraft | null;
  private state: AudioUploadState;
  private key: string;
  constructor(private call: Call, storageKey: string, private node: string) {
    this.key = `${storageKey}:audio-upload:${node}`;
    this.draft = readDraft(this.key);
    this.state = { phase: this.draft ? "paused" : "idle", name: this.draft?.data.name ?? "", total: this.draft?.data.bytes ?? 0,
      received: 0, file: null, error: this.draft ? "上次上传尚未确认，请重新选择同一录音继续。" : "" };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<AudioUploadState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  canRetry = () => Boolean(this.selected);
  retry = () => this.selected ? this.upload(this.selected) : Promise.resolve();
  cancel = () => {
    if (!this.busy || this.state.phase === "committing") return;
    this.cancelled = true; this.update({ phase: "pausing" });
  };
  close() { this.generation++; this.listeners.clear(); this.selected = null; }
  async upload(file: ByteSource & Pick<File, "name" | "type">) {
    if (this.busy) return;
    if (!file.type.startsWith("audio/") && !/\.(m4a|mp3|wav|ogg|flac|aac|webm|mp4)$/i.test(file.name)) {
      this.update({ phase: "failed", error: "请选择录音文件（m4a、mp3、wav、flac 等）。" }); return;
    }
    if (!file.size) {
      this.update({ phase: "failed", error: "录音文件为空，请重新选择。" }); return;
    }
    const ticket = ++this.generation;
    const current = () => ticket === this.generation;
    const continueUpload = () => current() && !this.cancelled;
    this.busy = true; this.cancelled = false; this.selected = file;
    this.update({ phase: "hashing", name: file.name, total: file.size, received: 0, error: "" });
    try {
      const sha256 = await sha256Of(file, continueUpload);
      if (sha256 === null || !continueUpload()) return;
      const previous = this.draft;
      if (!previous || previous.data.sha256 !== sha256 || previous.data.name !== file.name || previous.data.bytes !== file.size) {
        this.draft = { request: requestId(), data: { name: file.name, mime: file.type || "application/octet-stream", bytes: file.size, sha256 } };
        persist(this.key, this.draft);
      }
      const draft = this.draft!;
      this.update({ phase: "uploading" });
      const begin = await this.call<{ upload: { id: string; received: number } }>("file_begin", { ...draft, node: this.node });
      if (!continueUpload()) return;
      if (!begin.upload?.id || !Number.isSafeInteger(begin.upload.received) || begin.upload.received < 0 || begin.upload.received > file.size)
        throw new Error("上传进度未确认，请用原录音重试。");
      this.update({ received: begin.upload.received });
      if (!await sendChunks(this.call, begin.upload.id, file, begin.upload.received, continueUpload, received => this.update({ received }))) return;
      this.update({ phase: "committing" });
      const result = await this.call<{ file: AudioFileInfo }>("file_commit", { request: `${draft.request}:commit`, upload: begin.upload.id });
      if (!current()) return;
      if (!result.file?.id || !Number.isSafeInteger(result.file.version)) throw new Error("上传提交结果未确认，请重试确认原请求。");
      this.draft = null; this.selected = null; persist(this.key, null);
      this.update({ phase: "completed", received: file.size, file: result.file, error: "" });
    } catch (reason) {
      if (current()) this.update({ phase: "failed", error: String(reason).slice(0, 1200) });
    } finally {
      this.busy = false;
      if (current() && this.cancelled) this.update({ phase: "paused", error: "上传已暂停，继续时复用已传部分。" });
    }
  }
}
export type AudioUploadFor = (node: string) => AudioUploadController;
