/**
 * The lifecycle of a submission.
 *
 * The WORDING comes from the server (`operation.message`): what "unknown"
 * means is a statement about what the system can and cannot prove, and a View
 * that composed that sentence from a status string would eventually make a
 * claim nobody checked. This component chooses an icon and a tone, and nothing
 * else.
 *
 * `waiting_approval` gets one extra line, and it points OUT of the frame:
 * approval happens in trusted chrome above this iframe, and there is no button
 * here that could stand in for it.
 */

import { StatusChip, type Tone } from "@claude-bot/agent-view-react/ui";
import type { SessionOperation } from "@claude-bot/agent-sessions-contract";

const WORDS: Record<string, { icon: string; word: string; tone: Tone }> = {
  submitted: { icon: "…", word: "已提交", tone: "info" },
  waiting_approval: { icon: "🔐", word: "等待批准", tone: "warn" },
  running: { icon: "▶", word: "运行中", tone: "info" },
  succeeded: { icon: "✓", word: "已完成", tone: "ok" },
  failed: { icon: "×", word: "失败", tone: "error" },
  rejected: { icon: "⊘", word: "已拒绝", tone: "error" },
  unknown: { icon: "?", word: "结果未知", tone: "warn" },
  reconnecting: { icon: "…", word: "重新连接中", tone: "info" },
  waiting_resource: { icon: "…", word: "等待运行环境", tone: "warn" },
};

export interface SessionOperationsProps {
  operations: readonly SessionOperation[];
  limit: number;
}

export function SessionOperations({ operations, limit }: SessionOperationsProps) {
  const shown = operations.slice(0, limit);
  if (!shown.length) return null;
  return (
    <div className="ops">
      {shown.map((operation, index) => {
        const chip = WORDS[String(operation.recovery?.state ?? operation.status ?? "")]
          ?? { icon: "•", word: String(operation.status ?? "未知"), tone: "neutral" as Tone };
        return (
          <div className="op" data-op={String(operation.id ?? "")} key={String(operation.id ?? index)}>
            <StatusChip icon={chip.icon} word={chip.word} tone={chip.tone} />
            <div className="opbody">
              <div className="opmsg">{String(operation.message ?? "")}</div>
              {operation.detail ? <div className="opdetail">{String(operation.detail)}</div> : null}
              {operation.status === "waiting_approval" ? (
                <div className="permission-note">请在 iframe 上方的可信批准栏确认。</div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
