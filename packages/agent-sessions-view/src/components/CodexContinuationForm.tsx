import { useEffect, useRef, useState } from "react";
import { AvButton, AvTextArea } from "@claude-bot/agent-view-react/ui";
import { CODEX_CONTINUATION_MAX_LENGTH, readCodexContinuationSettings, type CodexContinuationSettings, type SessionsReply } from "@claude-bot/agent-sessions-contract";

export function CodexContinuationForm({ read, save }: {
  read(): Promise<SessionsReply>;
  save(prompt: string | null, revision: string): Promise<SessionsReply>;
}) {
  const [settings, setSettings] = useState<CodexContinuationSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  async function run(write: boolean, reset = false) {
    if (inFlight.current) return;
    const current = ++generation.current;
    inFlight.current = true;
    setBusy(true); setNotice("");
    try {
      const reply = write && settings ? await save(reset ? null : draft, settings.revision) : await read();
      if (generation.current !== current) return;
      const value = reply.ok ? readCodexContinuationSettings(reply.result) : null;
      if (!value) { setNotice(reply.message || "未确认设置，请重新读取后再保存。"); return; }
      setSettings(value); setDraft(value.effectivePrompt);
      setNotice(write ? "已保存。下一次自动续接将使用此消息；保存没有发送消息。" : value.prompt === null ? "当前使用默认消息。" : "已读取当前自定义消息。");
    } catch {
      if (generation.current === current) setNotice("未确认设置，可能是设备离线。请重新读取；不会自动重发保存请求。");
    } finally {
      if (generation.current === current) { inFlight.current = false; setBusy(false); }
    }
  }
  return <div className="session-title-control" data-codex-continuation>
    <div>自动续接消息</div>
    <p className="small">用于 Codex 托管会话的重启恢复和容量重试。默认：继续执行。</p>
    <AvButton disabled={busy} onClick={() => void run(false)}>{busy ? "处理中…" : settings ? "重新读取设置" : "读取续接设置"}</AvButton>
    {settings ? <>
      <AvTextArea aria-label="Codex 自动续接消息" value={draft} rows={3} maxLength={CODEX_CONTINUATION_MAX_LENGTH}
        disabled={busy} style={{ width: "100%" }} onChange={event => { setDraft(event.target.value); setNotice(""); }} />
      <div className="row">
        <AvButton disabled={busy || !draft.trim() || draft === settings.effectivePrompt} onClick={() => void run(true)}>保存续接消息</AvButton>
        <AvButton disabled={busy || settings.prompt === null} onClick={() => void run(true, true)}>恢复默认续接消息</AvButton>
      </div>
    </> : null}
    {notice ? <div role="status" className="small">{notice}</div> : null}
  </div>;
}
