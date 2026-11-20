import type { ReactNode } from "react";

/** Closing this native disclosure keeps the conversation and settings mounted. */
export function ConversationSettings({ children }: { children: ReactNode }) {
  return (
    <details
      className="rv-conversation-settings"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
        event.stopPropagation();
      }}
    >
      <summary aria-label="会话与节点设置" title="会话与节点设置">⋯</summary>
      <div className="rv-conversation-settings-body">
        <strong>会话与节点设置</strong>
        {children}
      </div>
    </details>
  );
}
