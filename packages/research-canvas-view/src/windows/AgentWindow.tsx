import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TranscriptView } from "@claude-bot/agent-sessions-view";
import type { TranscriptWindow } from "@claude-bot/agent-sessions-contract";
import type {
  ResearchMessage,
  ResearchNode,
  ResearchRun,
  ResourceBinding,
} from "@claude-bot/research-canvas-contract";
import { persist, requestId, stored, type Call } from "../client.js";
import { NativeConversation } from "./NativeConversation.js";
import { ConversationSettings } from "./ConversationSettings.js";
import "./agent-window.css";

interface History {
  manualConversation?: string;
  runs: ResearchRun[];
  messages: ResearchMessage[];
  older: string | null;
  binding: ResourceBinding | null;
}
export function AgentWindow({
  node,
  call,
  epoch,
  storageKey,
  runnable,
  openFile,
  conversationId,
  send,
  settings,
}: {
  node: ResearchNode;
  call: Call;
  epoch: number;
  storageKey: string;
  runnable: boolean;
  openFile(path: string): void;
  conversationId?: string;
  send?(prompt: string): Promise<void>;
  settings?: ReactNode;
}) {
  const [history, setHistory] = useState<History | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [draft, setDraft] = useState(() =>
      stored(`${storageKey}:draft:${node.id}`, ""),
    ),
    [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    stored(`${storageKey}:folds:${node.id}`, {}),
  );
  const [selectedConversation, setConversation] = useState(() =>
      stored(`${storageKey}:conversation:${node.id}`, `manual:${node.id}`),
    ),
    generation = useRef(0),
    inFlight = useRef<symbol | null>(null),
    refused = useRef(false);
  const manualConversation =
    history?.manualConversation ?? `manual:${history?.binding?.node ?? node.id}`;
  // Manual is one choice. Migrate the old card-based ID without resetting a
  // listener selection or a draft when a new history frame arrives.
  const conversation = conversationId ?? (selectedConversation.startsWith("manual:")
    ? manualConversation
    : selectedConversation);
  const listeners = [
    ...new Set([
      ...(history?.runs.filter((run) => run.conversation !== manualConversation).map((run) => run.conversation) ?? []),
      ...(conversation !== manualConversation ? [conversation] : []),
    ]),
  ];
  useEffect(() => {
    persist(`${storageKey}:conversation:${node.id}`, conversation);
  }, [conversation, storageKey, node.id]);
  const refresh = useCallback(
    async (cursor?: string) => {
      if (inFlight.current || refused.current) return;
      const ticket = generation.current,
        lease = Symbol();
      inFlight.current = lease;
      setBusy(true);
      try {
        const answer = await call<History>("resource_read", {
          node: node.id,
          cursor,
        });
        if (ticket === generation.current)
          setHistory((previous) => ({
            ...answer,
            messages: [
              ...new Map(
                [...(previous?.messages ?? []), ...answer.messages].map(
                  (message) => [message.id, message],
                ),
              ).values(),
            ].sort(
              (a, b) =>
                (a.sequence ?? 0) - (b.sequence ?? 0) ||
                a.at.localeCompare(b.at),
            ),
            older: cursor ? answer.older : (previous?.older ?? answer.older),
          }));
      } catch (error) {
        if (ticket === generation.current) {
          setError(String(error));
          refused.current = true;
        }
      } finally {
        if (inFlight.current === lease) {
          inFlight.current = null;
          if (ticket === generation.current) setBusy(false);
        }
      }
    },
    [call, node.id],
  );
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
      inFlight.current = null;
    };
  }, [refresh]);
  useEffect(() => {
    void refresh();
  }, [epoch, refresh]);
  const transcript = useMemo<TranscriptWindow>(
    () => ({
      rich: true,
      sessionId: conversation,
      hasMore: Boolean(history?.older),
      messages: (history?.messages ?? [])
        .filter((row) => row.conversation === conversation)
        .map((row) => ({
          role: row.role === "tool" ? "assistant" : row.role,
          timestamp: row.at,
          blocks:
            row.role === "tool"
              ? [
                  {
                    type: "tool",
                    tool: row.tool,
                    input: row.arguments,
                    output: row.text,
                  },
                ]
              : [{ type: "text", text: row.text }],
        })),
    }),
    [history, conversation],
  );
  const running =
    history?.runs.filter(
      (run) =>
        run.conversation === conversation &&
        ["running", "queued", "waiting"].includes(run.status),
    ) ?? [];
  const latest = history?.runs
    .filter((run) => run.conversation === conversation)
    .at(-1);
  const controls = (
    <>
      <div className="rv-identity">
        <span>所属用户：<b>{history?.binding?.owner ?? "未绑定"}</b></span>
        <span>{latest?.model ? `本次执行确认的模型：${latest.model}` : latest ? "本次执行尚无模型回执" : "尚无本次执行记录"}</span>
        <span>运行资源：{history?.binding?.resource ?? "尚未绑定"}</span>
      </div>
      <div className="rv-inline">
        <select
          aria-label="Agent 会话"
          disabled={Boolean(conversationId)}
          value={conversation}
          onChange={(event) => setConversation(event.target.value)}
        >
          <option value={manualConversation}>手动会话</option>
          {listeners.map((key) => (
            <option value={key} key={key}>
              {key.startsWith("draft:") ? "Agent 草稿" : key.startsWith("execution:") ? "编排任务" : "独立监听"} · {key.slice(-12)}
            </option>
          ))}
        </select>
        <button
          disabled={busy}
          onClick={() => {
            setError("");
            refused.current = false;
            void refresh();
          }}
        >
          刷新历史
        </button>
      </div>
      {latest && (
        <details className="rv-run-receipt">
          <summary>
            {latest.stopRequested && latest.status === "waiting"
              ? "正在停止"
              : latest.status}{" "}
            · 触发：{latest.trigger} ·{" "}
            {latest.usage
              ? `${latest.usage.input + latest.usage.output} tokens`
              : "用量未知"}
          </summary>
          <p>运行 {latest.id}</p>
          <p>
            资源归属 {latest.binding.owner} · 绑定 v{latest.binding.version}
          </p>
        </details>
      )}
      {(history || error) && settings}
    </>
  );
  return (
    <div className="rv-agent-window">
      {(error || latest?.error) && <p role="alert">{error || latest?.error}</p>}
      <div className="rv-transcript">
        {history?.binding?.kind === "session" ? (
          <NativeConversation
            key={conversation}
            node={node.id}
            conversation={conversation}
            call={call}
            epoch={epoch}
            runnable={runnable}
            openFile={openFile}
            expanded={expanded}
            toggle={(key, value) =>
              setExpanded((previous) => {
                const next = { ...previous, [key]: value };
                persist(`${storageKey}:folds:${node.id}`, next);
                return next;
              })
            }
            settings={controls}
            appendDraft={(text) =>
              setDraft((previous) => {
                const next = previous + text;
                persist(`${storageKey}:draft:${node.id}`, next);
                return next;
              })
            }
          />
        ) : (
          <>
            <div className="rv-conversation-toolbar">
              <span className="rv-conversation-status" role="status">
                {busy && !history ? "正在读取会话…" : running.length ? "工作中" : "会话"}
              </span>
              <ConversationSettings>{controls}</ConversationSettings>
            </div>
            <TranscriptView
              resource={node.id}
              data={transcript}
              status={undefined}
              busy={busy}
              onLoadOlder={() => {
                if (history?.older) void refresh(history.older);
              }}
              onOpenFileLink={openFile}
              thinking={running.some((run) => run.status === "running")}
              expandOverrides={expanded}
              onToggleGroup={(key, value) =>
                setExpanded((previous) => {
                  const next = { ...previous, [key]: value };
                  persist(`${storageKey}:folds:${node.id}`, next);
                  return next;
                })
              }
            />
          </>
        )}
      </div>
      <form
        className="rv-composer"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!draft.trim() || sending) return;
          const submitted = draft;
          setSending(true);
          setError("");
          try {
            if (send) await send(submitted);
            else await call("agent_send", {
              request: requestId(),
              node: node.id,
              prompt: submitted,
            });
            setDraft((current) => {
              if (current !== submitted) return current;
              persist(`${storageKey}:draft:${node.id}`, "");
              return "";
            });
            await refresh();
          } catch (error) {
            setError(String(error));
          } finally {
            setSending(false);
          }
        }}
      >
        <textarea
          aria-label="Agent 任务"
          placeholder="给 Agent 一个任务，或引用项目节点…"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            persist(`${storageKey}:draft:${node.id}`, event.target.value);
          }}
        />
        <div className="rv-inline">
          {!runnable && <span className="rv-muted">{node.archived ? "已归档" : "当前项目角色不能运行 Agent"}</span>}
          {runnable && history && !history.binding && <span className="rv-muted">请在设置中绑定运行资源</span>}
          {running.map((run) => (
            <button
              key={run.id}
              type="button"
              disabled={!runnable || Boolean(run.stopRequested)}
              onClick={async () => {
                try {
                  await call("agent_stop", {
                    request: requestId(),
                    run: run.id,
                  });
                  await refresh();
                } catch (error) {
                  setError(String(error));
                }
              }}
            >
              {run.stopRequested ? "等待停止回执" : "停止"}
            </button>
          ))}
          <button
            className="rv-primary"
            title={!draft.trim() ? "输入消息后发送" : undefined}
            disabled={
              !runnable || sending || !draft.trim() || !history?.binding
            }
          >
            {sending ? "提交中…" : "发送任务 ↗"}
          </button>
        </div>
      </form>
    </div>
  );
}
