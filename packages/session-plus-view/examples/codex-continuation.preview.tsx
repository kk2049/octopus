/** Isolated browser fixture; no production accounts, network writes or model execution. */
import "../src/styles/app.css";
import "../../chat-ui-commons/src/transcript-ui.css";
import "../../agent-sessions-view/src/sessions.css";
import "../../agent-sessions-view/src/chat-controls.css";
import { useState } from "react";
import { renderAgentViewThemeCss } from "@claude-bot/agent-view-build/theme-tokens";
import { AgentChat } from "../../agent-sessions-view/src/components/AgentChat.js";
import { DEFAULT_CODEX_CONTINUATION, type CodexContinuationSettings } from "@claude-bot/agent-sessions-contract";

const theme = document.createElement("style");
theme.textContent = `@layer agent-view-base { ${renderAgentViewThemeCss()} }`;
document.head.append(theme);
const key = "ticket-834-continuation-fixture";
function current(): CodexContinuationSettings {
  return JSON.parse(localStorage.getItem(key) ?? "null") ?? {
    protocol: "codex-continuation/v1", prompt: null, effectivePrompt: DEFAULT_CODEX_CONTINUATION, revision: "0",
  };
}
function Preview() {
  const [offline, setOffline] = useState(false);
  return <main className="session-plus-app" style={{ maxWidth: 1000, width: "100%", margin: "auto", boxSizing: "border-box" }}>
    <p>Codex 自动续接消息 · 隔离预览，使用模拟数据，不连接真实会话。</p>
    <button onClick={() => setOffline(value => !value)}>{offline ? "恢复模拟设备连接" : "模拟设备离线"}</button>
    <section className="av-panel" data-av-module="agent.chat/v1" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
    <AgentChat session={{ resourceId: "fixture-codex", deviceId: "fixture-runner", cliKind: "codex",
      cwdDisplay: "~/example", title: "English conversation", status: "idle", resumable: true }}
      transcript={{ messages: [{ role: "user", text: "Please use English throughout this conversation." }], offset: 0, totalMessages: 1 }}
      transcriptStatus={undefined} transcriptBusy={false} onSend={() => {}} onPin={() => {}} onRefresh={() => {}} onLoadOlder={() => {}}
      onReadContinuation={async () => {
        if (offline) throw new Error("fixture offline");
        return { ok: true, message: "", result: current() };
      }}
      onSaveContinuation={async (prompt, revision) => {
        if (offline) throw new Error("fixture offline");
        if (revision !== current().revision) return { ok: false, message: "设置已变化，请重新读取后保存" };
        const settings = { protocol: "codex-continuation/v1", prompt,
          effectivePrompt: prompt ?? DEFAULT_CODEX_CONTINUATION,
          revision: `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0")}` };
        localStorage.setItem(key, JSON.stringify(settings));
        return { ok: true, message: "", result: settings };
      }} />
    </section>
  </main>;
}
export default { kind: "custom", app: "codex-continuation-preview", title: "Codex 续接设置验收", render: () => <Preview /> };
