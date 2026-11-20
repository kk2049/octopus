import { useState } from "react";
import { Dialog } from "./Dialog.js";
import type {
  ResearchNode,
  ResearchSubscription,
} from "@claude-bot/research-canvas-contract";
import { pluginFor } from "./plugins.js";
import { requestId, type Call } from "./client.js";
export function SubscriptionEditor({
  source,
  target,
  previous,
  call,
  close,
}: {
  source: ResearchNode;
  target: ResearchNode;
  previous?: ResearchSubscription;
  call: Call;
  close(): void;
}) {
  const [event, setEvent] = useState(
    previous?.event ??
      pluginFor(source.type).events[0]?.type ??
      "agent.completed",
  );
  const [statuses, setStatuses] = useState(
    previous?.filter.statuses ?? ["completed"],
  );
  const [mode, setMode] = useState(
      previous?.filter.mode ?? (source.type === "group" ? "mention" : "all"),
    ),
    [mention, setMention] = useState(previous?.filter.mentionId ?? ""),
    [instruction, setInstruction] = useState(
      previous?.filter.instruction ?? "",
    ),
    [prompt, setPrompt] = useState(previous?.prompt ?? ""),
    [enabled, setEnabled] = useState(previous?.enabled ?? true),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog title="监听连接" close={close}>
      <form
        className="rv-dialog"
        aria-label="监听连接"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError("");
          try {
            await call("subscription_save", {
              request: requestId(),
              data: {
                id: previous?.id,
                version: previous?.version,
                source: source.id,
                target: target.id,
                event,
                enabled,
                prompt,
                filter: { mode, mentionId: mention, instruction, statuses },
              },
            });
            close();
          } catch (error) {
            setError(String(error));
          } finally {
            setPending(false);
          }
        }}
      >
        <header>
          <h2>连接一个事件</h2>
          <button type="button" aria-label="关闭配置" onClick={close}>
            ×
          </button>
        </header>
        <p>
          {source.title} → {target.title}
        </p>
        <label>
          事件
          <select
            value={event}
            onChange={(e) => setEvent(e.target.value as typeof event)}
          >
            {pluginFor(source.type).events.map((item) => (
              <option value={item.type} key={item.type}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        {event === "agent.completed" && (
          <fieldset>
            <legend>响应哪些结束状态</legend>
            {[
              ["completed", "已完成"],
              ["failed", "失败"],
              ["cancelled", "已停止"],
              ["unknown", "结果未知"],
            ].map(([value, title]) => (
              <label className="rv-check" key={value}>
                <input
                  type="checkbox"
                  checked={statuses.includes(value)}
                  onChange={(event) =>
                    setStatuses((prior) =>
                      event.target.checked
                        ? [...prior, value]
                        : prior.filter((item) => item !== value),
                    )
                  }
                />
                {title}
              </label>
            ))}
          </fieldset>
        )}
        {event === "group.message" && (
          <>
            <label>
              何时响应
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="mention">只回应指定 @</option>
                <option value="model">由小模型判断</option>
              </select>
            </label>
            {mode === "mention" ? (
              <label>
                @ 的稳定身份 ID
                <input
                  required
                  value={mention}
                  onChange={(e) => setMention(e.target.value)}
                  placeholder="ou_…"
                />
              </label>
            ) : (
              <label>
                筛选依据
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="哪些消息值得让研究 Agent 回应？"
                />
              </label>
            )}
          </>
        )}
        <label>
          交给 Agent 的任务
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="收到符合条件的事件后…"
          />
        </label>
        <label className="rv-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用监听
        </label>
        <p className="rv-muted">
          这条连接使用独立持续会话，按顺序处理事件，沿用目标 Agent 绑定资源。
        </p>
        {previous?.error && <p role="alert">{previous.error}</p>}
        {error && <p role="alert">{error}</p>}
        <button className="rv-primary" disabled={pending}>
          {pending ? "保存中…" : "保存连接"}
        </button>
      </form>
    </Dialog>
  );
}
