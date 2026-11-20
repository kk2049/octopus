/** First-party discussion source projection. Credentials and execution paths never enter it. */
import type { MeetingSummaryExecution } from "./meeting.js";
export const SOURCE_STAGES = ["uploaded", "queued", "transferring", "transcribing", "checking", "transcribed", "summarizing", "candidates", "completed", "needs_review", "failed", "unknown"] as const;
export type DiscussionSourceStage = typeof SOURCE_STAGES[number];
export interface DiscussionSegment {
  id: string;
  text: string;
  speaker?: string;
  start?: number;
  end?: number;
  at?: string;
}
export interface DiscussionIntegrity {
  complete: boolean;
  rawClosed: boolean;
  durationSeconds: number;
  lastEndSeconds: number;
  trailingSeconds: number;
  segments: number;
  tokenLimited: boolean;
  recovered: boolean;
  warnings: string[];
}
export interface DiscussionSourceStatus {
  id: string;
  node: string;
  kind: "audio" | "chat";
  title: string;
  sourceVersion: string;
  stage: DiscussionSourceStage;
  progress: number | null;
  message: string;
  updatedAt: string;
  createdAt: string;
  transcript?: { id: string; ref: string };
  minutes?: { id: string; ref: string };
  evidence?: { id: string; ref: string };
  batch?: string;
  integrity?: DiscussionIntegrity;
  model?: string | null;
  summary?: MeetingSummaryExecution;
  follow?: { enabled: boolean; cursor: string; updatedAt: string; error?: string };
}
export const SOURCE_STAGE_LABELS: Record<DiscussionSourceStage, string> = {
  uploaded: "录音已上传", queued: "等待处理", transferring: "传送至转写设备",
  transcribing: "识别文字与讲话人", checking: "检查完整性", transcribed: "完整转写已就绪", summarizing: "整理纪要",
  candidates: "提取候选事项", completed: "材料已生成", needs_review: "需要复核",
  failed: "处理失败", unknown: "结果待核对",
};
