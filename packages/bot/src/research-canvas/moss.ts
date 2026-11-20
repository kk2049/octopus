import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { DiscussionSourceStage, ResourceBinding } from "@claude-bot/research-canvas-contract";
import { MEETING_TRANSCRIPTION_METHODS, MEETING_TRANSCRIPTION_PROTOCOL, MEETING_TRANSCRIPTION_LIMITS,
  meetingTranscriptionTerminal, type MeetingTranscriptionStatus, type MeetingTranscriptionChunk } from "@claude-bot/runner/meeting-transcription-protocol";
import type { MeetingTranscriptionCapabilities } from "../meeting-transcription/capability.js";

export interface MossRunnerConfig {
  device: string;
  timeoutMs?: number;
}
export { validateMossPacket, SourceIntegrityError, type MossPacket, type SourceTranscription } from "@claude-bot/runner/meeting-transcription-integrity";
import { validateMossPacket, SourceIntegrityError, type MossPacket, type SourceTranscription } from "@claude-bot/runner/meeting-transcription-integrity";
export type SourceProgress = (stage: DiscussionSourceStage, message: string, progress?: number | null) => void;
/** Trusted resource identity selects a dedicated capability; no generic shell fallback exists. */
export class ResearchMossRunner {
  constructor(private readonly runner: Pick<MeetingTranscriptionCapabilities, "open" | "readiness">, private readonly config: MossRunnerConfig) {
    if (!config.device.trim()) throw new Error("MOSS 必须固定 Runner 设备");
  }
  readiness(owner: string): ReturnType<MeetingTranscriptionCapabilities["readiness"]> { return this.runner.readiness(owner, this.config.device); }
  async transcribe(binding: ResourceBinding, file: { path: string; name: string; mime: string }, signal: AbortSignal, progress: SourceProgress = () => {}, current: () => void = () => {}): Promise<SourceTranscription> {
    const check = () => { current(); signal.throwIfAborted(); };
    check();
    const ready = this.readiness(binding.owner);
    if (!ready.available) throw new Error(`录音转写设备未就绪：${ready.status}`);
    const grant = this.runner.open({ username: binding.owner, device: this.config.device, kind: "job",
      purpose: `科研录音 ${binding.node} v${binding.version}`, rights: MEETING_TRANSCRIPTION_METHODS, autoAllow: MEETING_TRANSCRIPTION_METHODS });
    if (!grant) throw new Error("录音归属人未授权该专用转写能力，或设备绑定已失效");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const key = createHash("sha256").update(`${binding.owner}\0${binding.node}\0${binding.version}\0${binding.resource}`).digest("hex");
    let sha256 = "";
    const call = async <T,>(action: string, args: Record<string, unknown>): Promise<T> => {
      check();
      const result = await grant.call(`meeting_transcription_${action}`, { device: this.config.device, job_key: key, input_sha256: sha256, ...args }) as T;
      check();
      const row = result as { protocol?: unknown; job_key?: unknown; input_sha256?: unknown };
      if (!row || row.protocol !== MEETING_TRANSCRIPTION_PROTOCOL || row.job_key !== key || row.input_sha256 !== sha256) throw new Error("MOSS 返回的作业或录音身份不一致");
      return result;
    };
    const state = async (action: string, args: Record<string, unknown> = {}): Promise<MeetingTranscriptionStatus> => {
      const value = await call<MeetingTranscriptionStatus>(action, args);
      if (!Number.isSafeInteger(value.input_bytes) || value.input_bytes < 1 || value.input_bytes > MEETING_TRANSCRIPTION_LIMITS.inputBytes ||
        !Number.isSafeInteger(value.received) || value.received < 0 || value.received > value.input_bytes ||
        !["uploading", "queued", "launching", "running", "succeeded", "needs_review", "failed", "orphaned", "cancelled", "timed_out"].includes(value.state) ||
        !Array.isArray(value.files) || value.files.length > 64) throw new Error("MOSS 作业状态格式异常");
      return value;
    };
    try {
      handle = await open(file.path, "r"); check();
      const info = await handle.stat(); check();
      if (!info.isFile() || info.size < 1) throw new Error("录音文件无效");
      // The device's own ceiling: only a Runner from before 2026-10-20 has one (64 MiB).
      if (ready.maxInputBytes !== undefined && info.size > ready.maxInputBytes)
        throw new Error(`转写设备的 Runner 版本较旧，只接受 ${Math.floor(ready.maxInputBytes / 1024 / 1024)} MiB 以内的录音；升级该设备的 Runner 后不再限制录音大小`);
      const chunk = Buffer.alloc(MEETING_TRANSCRIPTION_LIMITS.chunkBytes), hash = createHash("sha256");
      for (let offset = 0; offset < info.size;) {
        check(); const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - offset), offset); check();
        if (!bytesRead) throw new Error("录音读取不完整"); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
      }
      sha256 = hash.digest("hex");
      progress("transferring", "正在传送已校验的录音", 0);
      let status = await state("begin", { input_bytes: info.size, title: file.name.slice(0, 240) });
      if (status.input_bytes !== info.size) throw new Error("远端录音大小异常");
      if (status.state === "uploading") {
        const sentHash = createHash("sha256");
        for (let offset = 0; offset < info.size;) {
          check(); const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - offset), offset); check();
          if (!bytesRead) throw new Error("录音读取不完整");
          const bytes = chunk.subarray(0, bytesRead); sentHash.update(bytes);
          // Repeated chunks verify the previous immutable bytes. No unverified append or offset skip.
          const uploaded = await state("upload", { offset, data: bytes.toString("base64"), chunk_sha256: createHash("sha256").update(bytes).digest("hex") });
          if (uploaded.received < offset + bytesRead) throw new Error("录音上传回执未覆盖已传送字节");
          offset += bytesRead; progress("transferring", `已传送 ${offset} / ${info.size} 字节`, Math.floor(offset / info.size * 100));
          await delay(50, undefined, { signal }); check();
        }
        if (sentHash.digest("hex") !== sha256) throw new Error("上传过程中原始录音发生变化");
      }
      status = await state("start");
      const configuredDeadline = Date.now() + Math.min(this.config.timeoutMs ?? MEETING_TRANSCRIPTION_LIMITS.deadlineMs, MEETING_TRANSCRIPTION_LIMITS.deadlineMs);
      const deadline = status.deadline_at ? Math.min(configuredDeadline, Date.parse(status.deadline_at)) : configuredDeadline;
      if (!Number.isFinite(deadline)) throw new Error("MOSS 作业期限格式异常");
      while (!meetingTranscriptionTerminal(status.state)) {
        if (Date.now() >= deadline) throw new Error("MOSS 已到本次等待期限；原作业保留，未自动重启");
        progress("transcribing", status.progress?.status === "recovering" ? "按重叠窗口补段并校验讲话人映射" : status.state === "queued" || status.progress?.status === "waiting_for_gpu" ? "等待转写设备上的上一项任务结束" : status.progress?.generated_tokens ? `已生成 ${status.progress.generated_tokens} tokens；完成后检查尾段` : "MOSS 正在识别文字与匿名讲话人", null);
        await delay(15000, undefined, { signal }); check(); status = await state("status");
      }
      if (!status.files.length) throw new Error(`MOSS 作业 ${status.state}：${status.error ?? "没有已确认的终态产物；原作业未重新启动"}`);
      const names = new Set<string>(); let total = 0;
      for (const item of status.files) {
        if (!item || typeof item.file !== "string" || names.has(item.file) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 ||
          item.bytes > MEETING_TRANSCRIPTION_LIMITS.artifactBytes || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error("MOSS 产物清单异常");
        names.add(item.file); total += item.bytes;
      }
      if (total > MEETING_TRANSCRIPTION_LIMITS.artifactTotalBytes) throw new Error("MOSS 产物总量超出上限");
      progress("checking", "校验原始输出、讲话人片段与录音末尾覆盖", null);
      const artifact = async (name: string): Promise<string> => {
        const item = status.files.find(file => file.file === name); if (!item) return "";
        const chunks: Buffer[] = []; const digest = createHash("sha256"); let offset = 0;
        do {
          const part = await call<MeetingTranscriptionChunk>("read", { file: name, offset, length: MEETING_TRANSCRIPTION_LIMITS.chunkBytes });
          if (typeof part.data !== "string") throw new Error("MOSS 产物块格式异常");
          const bytes = Buffer.from(part.data, "base64");
          if (part.file !== name || part.offset !== offset || part.total !== item.bytes || part.sha256 !== item.sha256 || bytes.length !== part.bytes ||
            bytes.toString("base64") !== part.data || bytes.length > MEETING_TRANSCRIPTION_LIMITS.chunkBytes || offset + bytes.length > item.bytes ||
            part.eof !== (offset + bytes.length === item.bytes) || (!bytes.length && offset < item.bytes)) throw new Error("MOSS 产物块回显或完整性异常");
          chunks.push(bytes); digest.update(bytes); offset += bytes.length;
        } while (offset < item.bytes);
        if (digest.digest("hex") !== item.sha256) throw new Error("MOSS 产物 SHA-256 校验失败");
        return Buffer.concat(chunks).toString("utf8");
      };
      const files: Record<string, string> = {};
      for (const name of ["manifest.json", "complete.json", "quality.json", "inference.json", "model-raw.txt", "segments.json", "dialogue.md", "recovery.json"]) files[name] = await artifact(name);
      const parse = (name: string) => files[name] ? JSON.parse(files[name]) : null;
      const packet: MossPacket = { manifest: parse("manifest.json"), complete: parse("complete.json"), quality: parse("quality.json") ?? {},
        inference: parse("inference.json") ?? {}, raw: files["model-raw.txt"], segments: parse("segments.json"), dialogue: files["dialogue.md"],
        ...(files["recovery.json"] ? { recovery: parse("recovery.json") } : {}) };
      if (packet.manifest?.settings?.audio_sha256 !== sha256) throw new Error("转写产物与原始录音校验值不一致");
      const withReceipt = (evidence: string) => JSON.stringify({ ...JSON.parse(evidence), runner: {
        protocol: MEETING_TRANSCRIPTION_PROTOCOL, job_key: key, input_sha256: sha256, state: status.state, files: status.files } }, null, 2);
      try { const value = validateMossPacket(packet); return { ...value, evidence: withReceipt(value.evidence!) }; }
      catch (error) { if (error instanceof SourceIntegrityError) throw new SourceIntegrityError(error.message, error.integrity, withReceipt(error.evidence), error.partial, error.segments); throw error; }
    } finally { try { await handle?.close(); } finally { grant.destroy(); } }
  }
}
