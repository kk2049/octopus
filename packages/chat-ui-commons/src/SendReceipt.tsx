import { ChatTurn, type ChatTurnClasses } from "./TranscriptGroup.js";
import type { SessionInputReceipt } from "@claude-bot/agent-sessions-contract";

export interface ChatSendReceipt {
  prompt: string;
  author?: string;
  phase: "sending" | "submitted" | "waiting_approval" | "running" | "refused" | "failed" | "uncertain" | "done";
  input?: SessionInputReceipt;
  message?: string;
}

/** Shared by ticket chat and Sessions+; execution activity is a separate fact. */
export function sendPhaseWord(entry: ChatSendReceipt) {
  if (entry.phase === "refused") return "✗ 发送被拒绝";
  if (entry.phase === "failed") return "✗ 发送未完成";
  if (entry.input?.phase === "input_observed") return "✓ Agent 已读取输入";
  if (entry.input?.phase === "provider_accepted") return "✓ Agent 已接收输入";
  // Unknown is a finished outcome, not a wait: nothing further is awaited or
  // replayed, whatever dispatch evidence exists. It must not read as pending.
  if (entry.phase === "uncertain") return "? 结果未知";
  if (entry.input?.phase === "local_queued") return entry.input.transport === "codex-queue"
    ? "已排队，将作为下一轮处理" : "已在本地排队，等待 Agent 接收";
  if (entry.input?.phase === "dispatched") return entry.input.evidence === "terminal_write"
    ? "已写入终端，等待 Agent 确认" : "已分派，等待 Agent 确认";
  if (entry.phase === "sending") return "⏳ 发送中…";
  if (entry.phase === "submitted") return "📨 已提交，等待发送确认";
  if (entry.phase === "waiting_approval") return "等待批准";
  if (entry.phase === "running") return "正在处理发送请求…";
  if (entry.phase === "done") return "✓ 已送达";
  return "✗ 发送未完成";
}

export function SendReceipt({ entry, classes, onRestore, onDismiss, confirmedNote, text = (value) => value }: {
  entry: ChatSendReceipt;
  classes: ChatTurnClasses & { userBody: string };
  onRestore?(): void;
  onDismiss?(): void;
  /** Hosts without transcript correlation should not promise automatic sync. */
  confirmedNote?: string;
  text?(value: string): string;
}) {
  const failed = entry.phase === "refused" || entry.phase === "failed";
  const uncertain = entry.phase === "uncertain";
  const settled = failed || uncertain || entry.phase === "done";
  const awaitingAgent = entry.input?.phase === "local_queued" || entry.input?.phase === "dispatched";
  const tone = failed ? "ev-send-refused" : uncertain ? "ev-send-uncertain"
    : entry.phase === "done" && !awaitingAgent ? "ev-send-confirmed" : "ev-send-pending";
  const terminalWritten = entry.input?.phase === "dispatched" && entry.input.evidence === "terminal_write";
  const actions = <>
    {(uncertain || failed) && onRestore ? <button type="button" className="ev-send-dismiss" onClick={onRestore}>
      {text("放回输入框")}
    </button> : null}
    {onDismiss ? <button type="button" className="ev-send-dismiss" onClick={onDismiss}>
      {text(entry.phase === "done" ? "隐藏本地回显" : "清除")}
    </button> : null}
  </>;
  return <ChatTurn role="user" pending={!settled} classes={classes}
    label={<>🧑 {entry.author ?? text("你")} · <span className={tone} data-av-send-phase={entry.phase}
      aria-busy={!settled} role="status">{text(sendPhaseWord(entry))}</span></>}>
    <div className={classes.userBody}>{entry.prompt}</div>
    {settled ? <div className={`ev-send-note ${tone}`} role={uncertain ? undefined : "status"}>
      {uncertain ? <>
        <div role="status">{text("可能已送达，不会自动重发。请先查看会话记录，确认没收到再重新发送。")}</div>
        <details className="ev-send-details">
          <summary>{text("查看发送详情")}</summary>
          {terminalWritten ? <div>{text("已写入终端，但未收到 Agent 确认。")}</div> : null}
          {entry.message ? <div>{entry.message}</div> : null}
          {actions}
        </details>
      </> : <>
        {entry.phase === "done" ? awaitingAgent
          ? text("尚未收到 Agent 接收确认；请查看原会话是否仍在运行或等待操作，无需重复发送。")
          : confirmedNote ?? text("正在等待会话记录同步") : entry.message || text("未收到更多说明")}
        {actions}
      </>}
    </div> : null}
  </ChatTurn>;
}
