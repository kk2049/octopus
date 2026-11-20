import { useRef, useState, useSyncExternalStore } from "react";
import { SOURCE_STAGE_LABELS, type ResearchNode } from "@claude-bot/research-canvas-contract";
import { AudioUploadController, audioSize, meetingMetadata, uploadPending } from "./audio-upload.js";

export function AudioUploadControl({ controller, editable, hasFile, compact = false }: {
  controller: AudioUploadController; editable: boolean; hasFile: boolean; compact?: boolean;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot), input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false), pending = uploadPending(state);
  const status = state.error ? <UploadStatus phase={state.phase} error={state.error} /> : null;
  return <div className={`rv-audio-upload${compact ? " rv-audio-upload-compact" : ""}${dragging ? " rv-audio-drop-active" : ""}`}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.stopPropagation(); if (editable && !pending) setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => {
      if (!Array.from(event.dataTransfer.types).includes("Files") && !event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation(); setDragging(false);
      const file = event.dataTransfer.files[0]; if (file && editable && !pending) void controller.upload(file);
    }}>
    <input ref={input} type="file" hidden accept="audio/*,.m4a,.mp3,.wav,.ogg,.flac,.aac,.webm,.mp4" aria-label="选择会议录音"
      disabled={!editable || pending} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void controller.upload(file); }} />
    {!pending && <button className={!hasFile ? "rv-audio-primary" : undefined} disabled={!editable} onClick={() => {
      if (["failed", "paused"].includes(state.phase) && controller.canRetry()) void controller.retry(); else input.current?.click();
    }}>
      {["failed", "paused"].includes(state.phase) && controller.canRetry() ? "继续上传并确认" : state.phase === "paused" ? "选择原录音继续上传" : hasFile ? "更换录音" : "上传录音"}
    </button>}
    {!hasFile && !pending && <small>或拖入录音 · 大小不限，可续传</small>}
    {pending && <div role="status" className="rv-audio-progress">
      <span>{state.phase === "hashing" ? "正在准备录音…" : state.phase === "committing" ? "正在确认上传…" : state.phase === "pausing" ? "正在暂停上传…" : `上传中 ${Math.round(state.received / Math.max(1, state.total) * 100)}%`}</span>
      <button disabled={state.phase === "committing" || state.phase === "pausing"} onClick={controller.cancel}>暂停上传</button>
      <progress value={state.received} max={state.total || 1} aria-label="录音上传进度" />
      <small>{state.name}</small>
    </div>}
    {/* A card states it once, at its top (AudioCardPreview). */}
    {!compact && status}
    {!pending && ["failed", "paused"].includes(state.phase) && controller.canRetry() &&
      <button disabled={!editable} onClick={() => input.current?.click()}>选择其他录音</button>}
    {!editable && !hasFile && <small>需要编辑权限才能上传录音。</small>}
  </div>;
}

function UploadStatus({ phase, error }: { phase: string; error: string }) {
  return <p role={phase === "failed" ? "alert" : "status"} className="rv-audio-status" title={error}>{error}</p>;
}

export function AudioCardPreview({ node, controller, editable, open }: {
  node: ResearchNode; controller: AudioUploadController; editable: boolean; open(id: string): void;
}) {
  const upload = useSyncExternalStore(controller.subscribe, controller.snapshot), meta = meetingMetadata(node);
  const newerUpload = upload.file && upload.file.version >= (meta.fileVersion ?? 0) ? upload.file : null;
  const name = newerUpload?.name ?? meta.fileName, bytes = newerUpload?.bytes ?? meta.bytes;
  const stage = newerUpload && newerUpload.version > (meta.fileVersion ?? 0) ? "uploaded" : meta.stage;
  const label = stage && stage in SOURCE_STAGE_LABELS ? SOURCE_STAGE_LABELS[stage as keyof typeof SOURCE_STAGE_LABELS] : name ? "录音已上传" : "先添加会议录音";
  return <div className="rv-audio-card" onClick={event => event.stopPropagation()}>
    {/* A small card clips from the bottom, so what the upload says ("上传已暂停…")
        leads the card, across its width and unclamped, instead of being
        squeezed between buttons. */}
    {upload.error && <UploadStatus phase={upload.phase} error={upload.error} />}
    <div className="rv-audio-card-actions">
      {name && !uploadPending(upload) && <button className="rv-audio-primary" onClick={() => open(node.id)}>
        {!stage || stage === "uploaded" ? "语音转文字" : ["completed", "candidates"].includes(stage) ? "查看纪要与任务建议" : stage === "transcribed" ? "选择 Agent 整理纪要" : "查看处理进度"}
      </button>}
      <AudioUploadControl controller={controller} editable={editable} hasFile={Boolean(name)} compact />
    </div>
    {name && <p className="rv-audio-file" title={`${name}${bytes !== undefined ? ` · ${audioSize(bytes)}` : ""}`}>{name}</p>}
    {/* While the upload reports a status, that line is the card's message. */}
    {!uploadPending(upload) && !upload.error && <small className="rv-audio-stage">{label}</small>}
    {!name && !upload.error && <small className="rv-audio-steps">上传 → 转写 → 纪要 → 确认下发</small>}
  </div>;
}
