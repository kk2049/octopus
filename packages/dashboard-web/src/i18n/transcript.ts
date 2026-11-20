import type { TranscriptCopy } from "@claude-bot/chat-ui-commons/transcript-ui";
import type { DashboardLanguageId } from "./language.js";

const ZH_CN: TranscriptCopy = {
  copyResponse: "复制全文",
  copyingResponse: "复制中…",
  responseCopied: "已复制",
  copyResponseFailed: "复制失败，请重试或选中文字复制。",

  latest: "回到最新",
  window: ({ total, first, last, count }) => `共 ${total} 条 · 当前 ${first}–${last}（尾窗 ${count}）`,
  loadOlder: "加载更早",
  time: "时间（北京时间）",
  files: "文件",
  input: "input",
  output: "output",
  truncated: "截断",
  outputError: "出错",
  running: "⏳ 执行中…",
  noResult: "（未记录结果）",
  todoUpdating: "Todo 更新中",
  todoProgress: "Todo 进度",
  todoProgressAria: "Todo 完成进度",
  completed: (value) => `${value} 已完成`,
  pending: (value) => `${value} 待处理`,
  current: (value) => `当前：${value}`,
  todoEmpty: "这次更新没有返回可识别的 Todo 条目。",
  callDetails: "调用详情",
  todoState: { done: "已完成", in_progress: "进行中", pending: "待处理", blocked: "受阻" },
  workSummary: ({ thinking, tools }) => thinking
    ? `🧭 ${thinking} 次思考 · ${tools} 个工具调用`
    : `⚙ ${tools} 个工具调用`,
  workRunning: "（执行中）",
  clickToExpand: "（点击展开）",
  thinking: "💭 思考",
  you: "🧑 你",
  assistant: "🤖 助手",
};

const ZH_TW: TranscriptCopy = {
  copyResponse: "複製全文",
  copyingResponse: "複製中…",
  responseCopied: "已複製",
  copyResponseFailed: "複製失敗，請重試或選取文字複製。",

  latest: "回到最新",
  window: ({ total, first, last, count }) => `共 ${total} 則 · 目前 ${first}–${last}（尾端 ${count}）`,
  loadOlder: "載入更早內容",
  time: "時間（北京時間）",
  files: "檔案",
  input: "input",
  output: "output",
  truncated: "已截斷",
  outputError: "錯誤",
  running: "⏳ 執行中…",
  noResult: "（未記錄結果）",
  todoUpdating: "Todo 更新中",
  todoProgress: "Todo 進度",
  todoProgressAria: "Todo 完成進度",
  completed: (value) => `${value} 已完成`,
  pending: (value) => `${value} 待處理`,
  current: (value) => `目前：${value}`,
  todoEmpty: "這次更新沒有傳回可辨識的 Todo 項目。",
  callDetails: "呼叫詳情",
  todoState: { done: "已完成", in_progress: "進行中", pending: "待處理", blocked: "受阻" },
  workSummary: ({ thinking, tools }) => thinking
    ? `🧭 ${thinking} 次思考 · ${tools} 個工具呼叫`
    : `⚙ ${tools} 個工具呼叫`,
  workRunning: "（執行中）",
  clickToExpand: "（點擊展開）",
  thinking: "💭 思考",
  you: "🧑 你",
  assistant: "🤖 助手",
};

const NAN_TW: TranscriptCopy = {
  ...ZH_TW,
  window: ({ total, first, last, count }) => `攏總 ${total} 條 · 這馬 ${first}–${last}（上尾 ${count}）`,
  loadOlder: "載入較早的內容",
  time: "時間（北京時間）",
  files: "檔案",
  truncated: "有截短",
  outputError: "出錯",
  running: "⏳ 咧執行…",
  noResult: "（無記錄結果）",
  todoUpdating: "Todo 咧更新",
  todoProgress: "Todo 進度",
  completed: (value) => `${value} 已完成`,
  pending: (value) => `${value} 待處理`,
  current: (value) => `這馬：${value}`,
  todoEmpty: "這擺更新無傳轉來會當辨識的 Todo 項目。",
  callDetails: "呼叫詳細內容",
  todoState: { done: "已完成", in_progress: "進行中", pending: "待處理", blocked: "受阻" },
  workSummary: ({ thinking, tools }) => thinking
    ? `🧭 ${thinking} 擺思考 · ${tools} 个工具呼叫`
    : `⚙ ${tools} 个工具呼叫`,
  workRunning: "（咧執行）",
  clickToExpand: "（點一下展開）",
  thinking: "💭 思考",
  you: "🧑 你",
  assistant: "🤖 助手",
};

const EN: TranscriptCopy = {
  copyResponse: "Copy response",
  copyingResponse: "Copying…",
  responseCopied: "Copied",
  copyResponseFailed: "Could not copy. Try again or select the text to copy.",

  latest: "Jump to latest",
  window: ({ total, first, last, count }) => `${total} messages · ${first}–${last} shown (latest ${count})`,
  loadOlder: "Load earlier",
  time: "Time (Beijing)",
  files: "Files",
  input: "input",
  output: "output",
  truncated: "truncated",
  outputError: "error",
  running: "⏳ Running…",
  noResult: "(no result recorded)",
  todoUpdating: "Updating Todo",
  todoProgress: "Todo progress",
  todoProgressAria: "Todo completion progress",
  completed: (value) => `${value} completed`,
  pending: (value) => `${value} pending`,
  current: (value) => `Current: ${value}`,
  todoEmpty: "This update returned no recognizable Todo items.",
  callDetails: "Call details",
  todoState: { done: "Completed", in_progress: "In progress", pending: "Pending", blocked: "Blocked" },
  workSummary: ({ thinking, tools }) => thinking
    ? `🧭 ${thinking} thoughts · ${tools} tool calls`
    : `⚙ ${tools} tool calls`,
  workRunning: " (running)",
  clickToExpand: " (click to expand)",
  thinking: "💭 Thinking",
  you: "🧑 You",
  assistant: "🤖 Assistant",
};

const JA_JP: TranscriptCopy = {
  copyResponse: "全文をコピー",
  copyingResponse: "コピー中…",
  responseCopied: "コピーしました",
  copyResponseFailed: "コピーできませんでした。再試行するか、テキストを選択してコピーしてください。",

  latest: "最新へ移動",
  window: ({ total, first, last, count }) => `全 ${total} 件 · ${first}–${last} を表示（末尾 ${count} 件）`,
  loadOlder: "以前の内容を読み込む",
  time: "時刻（北京時間）",
  files: "ファイル",
  input: "input",
  output: "output",
  truncated: "省略",
  outputError: "エラー",
  running: "⏳ 実行中…",
  noResult: "（結果の記録なし）",
  todoUpdating: "Todo を更新中",
  todoProgress: "Todo の進捗",
  todoProgressAria: "Todo の完了状況",
  completed: (value) => `${value} 件完了`,
  pending: (value) => `${value} 件保留`,
  current: (value) => `現在：${value}`,
  todoEmpty: "この更新には認識できる Todo 項目がありません。",
  callDetails: "呼び出しの詳細",
  todoState: { done: "完了", in_progress: "進行中", pending: "保留", blocked: "ブロック中" },
  workSummary: ({ thinking, tools }) => thinking
    ? `🧭 思考 ${thinking} 回 · ツール呼び出し ${tools} 件`
    : `⚙ ツール呼び出し ${tools} 件`,
  workRunning: "（実行中）",
  clickToExpand: "（クリックして展開）",
  thinking: "💭 思考",
  you: "🧑 あなた",
  assistant: "🤖 アシスタント",
};

const COPY: Record<DashboardLanguageId, TranscriptCopy> = {
  "zh-CN": ZH_CN,
  "zh-TW": ZH_TW,
  "nan-TW": NAN_TW,
  en: EN,
  "ja-JP": JA_JP,
};

export function transcriptCopy(language: DashboardLanguageId): TranscriptCopy {
  return COPY[language];
}
