/** The same strict MOSS export check runs on Runner publication and Head consumption. */
export interface MossSegment { id: string; text: string; speaker?: string; start?: number; end?: number; at?: string }
export interface MossIntegrity { complete: boolean; rawClosed: boolean; durationSeconds: number; lastEndSeconds: number;
  trailingSeconds: number; segments: number; tokenLimited: boolean; recovered: boolean; warnings: string[] }
export interface MossPacket {
  manifest: { settings: { duration_seconds: number; max_new_tokens?: number; audio_sha256?: string; model?: string; model_revision?: string } };
  complete: { status: string } | null;
  quality: Record<string, unknown>;
  inference: { generated_tokens?: number };
  raw: string;
  segments: MossSegment[];
  dialogue: string;
  recovery?: Record<string, unknown>;
}
export interface SourceTranscription {
  text: string;
  model: string | null;
  segments?: MossSegment[];
  integrity?: MossIntegrity;
  evidence?: string;
}
export class SourceIntegrityError extends Error {
  constructor(message: string, readonly integrity: MossIntegrity, readonly evidence: string, readonly partial?: string, readonly segments?: MossSegment[]) { super(message); }
}
/** Re-check the export instead of treating a successful exit or complete.json as sufficient. */
export function validateMossPacket(packet: MossPacket): SourceTranscription {
  const settings = packet.manifest?.settings;
  const duration = settings?.duration_seconds;
  const segments = packet.segments;
  const warnings: string[] = [];
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(segments) || !segments.length)
    throw new Error("MOSS 结果缺少有效时长或带讲话人的片段");
  const ids = new Set<string>();
  let previous = -1;
  for (const segment of segments) {
    if (typeof segment.id !== "string" || ids.has(segment.id) || !segment.speaker || !segment.text?.trim() ||
      !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start! < 0 ||
      segment.end! <= segment.start! || segment.end! > duration + 1 || segment.start! < previous)
      throw new Error("MOSS 片段标签、顺序或时间范围异常；保留原始结果供复核");
    ids.add(segment.id); previous = segment.start!;
  }
  const rawClosed = /\[\d+(?:\.\d+)?\]\s*$/.test(packet.raw);
  const tagCount = [...packet.raw.matchAll(/\[\d+(?:\.\d+)?\]\s*\[S\d+\]/g)].length;
  const last = Math.max(...segments.map(segment => segment.end!));
  const trailing = Math.max(0, duration - last);
  const tokenLimited = typeof settings.max_new_tokens === "number" &&
    typeof packet.inference?.generated_tokens === "number" && packet.inference.generated_tokens >= settings.max_new_tokens;
  const recovered = Boolean(packet.recovery);
  // A recovery packet is accepted only when its trusted exporter includes the
  // merged raw stream and an explicit source map, never a UI checkbox.
  if (recovered && (!Array.isArray(packet.recovery?.sources) || !packet.recovery?.speaker_mapping))
    warnings.push("补段来源或讲话人映射记录不完整");
  if (!rawClosed) warnings.push("原始模型输出末尾未闭合，可能在讲话中截断");
  if (tagCount !== segments.length) warnings.push("原始标签与已解析片段数量不一致");
  if (tokenLimited) warnings.push("生成达到 token 上限");
  if (trailing > 30 || packet.quality?.tail_review_required === true) warnings.push(`末尾 ${trailing.toFixed(1)} 秒需要核对是否仍有讲话`);
  if (!packet.complete || !["machine_transcription_complete", "recovered_machine_transcript_complete"].includes(packet.complete.status))
    warnings.push("未取得完整转写终态证据");
  if (packet.quality?.speaker_count_matches_expectation === false) warnings.push("声音标签数量与预期不一致");
  const complete = rawClosed && tagCount === segments.length && !tokenLimited && trailing <= 30 &&
    packet.quality?.tail_review_required !== true && Boolean(packet.complete) &&
    ["machine_transcription_complete", "recovered_machine_transcript_complete"].includes(packet.complete!.status) &&
    (!recovered || (Array.isArray(packet.recovery?.sources) && packet.recovery.sources.length >= 2 && Array.isArray(packet.recovery?.speaker_mapping) && packet.recovery.speaker_mapping.length >= 1));
  const integrity: MossIntegrity = { complete, rawClosed, durationSeconds: duration, lastEndSeconds: last, trailingSeconds: trailing,
    segments: segments.length, tokenLimited, recovered, warnings };
  const evidence = JSON.stringify({ manifest: packet.manifest, complete: packet.complete, quality: packet.quality,
    inference: packet.inference, integrity, recovery: packet.recovery ?? null }, null, 2);
  if (!complete) throw new SourceIntegrityError(warnings.join("；"), integrity, evidence, packet.dialogue, segments);
  if (!packet.dialogue?.trim()) throw new Error("完整转写正文缺失");
  return { text: packet.dialogue, model: `${settings.model ?? "MOSS-Transcribe-Diarize"}@${settings.model_revision ?? "unknown"}`, segments,
    integrity, evidence };
}
