import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AgentInteractionCard,
  TranscriptView,
} from "@claude-bot/agent-sessions-view";
import {
  reconcileTranscriptWindows,
  type TranscriptWindow,
} from "@claude-bot/agent-sessions-contract";
import { requestId, type Call } from "../client.js";
import { toBase64 } from "../collaboration.js";
import { readSlice } from "../file-upload.js";
import { ConversationSettings } from "./ConversationSettings.js";

export function NativeConversation({
  node,
  conversation,
  call,
  epoch,
  runnable,
  openFile,
  appendDraft,
  expanded,
  toggle,
  settings,
}: {
  node: string;
  conversation: string;
  call: Call;
  epoch: number;
  runnable: boolean;
  openFile(path: string): void;
  appendDraft(text: string): void;
  expanded: Record<string, boolean>;
  toggle(key: string, value: boolean): void;
  settings?: ReactNode;
}) {
  const [transcript, setTranscript] = useState<TranscriptWindow | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false),
    sequence = useRef(0),
    inFlight = useRef<symbol | null>(null),
    queued = useRef<{ offset?: number; retry: boolean } | null>(null),
    refused = useRef(false);
  const refresh = useCallback(
    async (offset?: number, retry = false): Promise<void> => {
      if (refused.current && !retry) return;
      if (inFlight.current) {
        if (!queued.current || offset !== undefined || retry)
          queued.current = { offset, retry };
        return;
      }
      const request = sequence.current, lease = Symbol();
      inFlight.current = lease;
      setBusy(true);
      try {
        const answer = await call<{ transcript: TranscriptWindow | null }>(
          "session_read",
          { node, conversation, offset },
        );
        if (request !== sequence.current) return;
        setTranscript((current) =>
          reconcileTranscriptWindows(current, answer.transcript),
        );
        setError("");
        refused.current = false;
      } catch (error) {
        if (request === sequence.current) {
          setError(String(error));
          refused.current = true;
        }
      } finally {
        if (inFlight.current === lease) {
          inFlight.current = null;
          if (request === sequence.current) {
            setBusy(false);
            const next = queued.current;
            queued.current = null;
            if (next && (next.retry || !refused.current))
              void refresh(next.offset, next.retry);
          }
        }
      }
    },
    [call, node, conversation],
  );
  useEffect(() => {
    // Only a resource/transport change invalidates a response. Data-only wakes
    // may arrive while that very response is still travelling to the browser.
    refused.current = false;
    setTranscript(null);
    setError("");
    return () => {
      sequence.current++;
      inFlight.current = null;
      queued.current = null;
    };
  }, [refresh]);
  useEffect(() => {
    void refresh();
  }, [refresh, epoch]);
  const upload = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      // Any size: each 32 000-byte window is read from the File just before it is sent.
      const count = Math.max(1, Math.ceil(file.size / 32000));
      let uploadId: string | undefined;
      for (let index = 0; index < count; index++) {
        const bytes = await readSlice(file, index * 32000, 32000);
        const answer = await call<{
          upload_id: string;
          attachment?: { path: string; label: string };
        }>("session_attach", {
          node,
          name: file.name,
          media_type: file.type || "application/octet-stream",
          chunk_index: index,
          chunk_count: count,
          upload_id: uploadId,
          data: toBase64(bytes),
        });
        uploadId = answer.upload_id;
        if (answer.attachment)
          appendDraft(
            `\n[${answer.attachment.label}](${answer.attachment.path})\n`,
          );
      }
    } catch (error) {
      setError(String(error));
    } finally {
      setUploading(false);
    }
  };
  const interaction = transcript?.runtime?.interaction;
  const turnState = transcript?.runtime?.turn_state;
  const stateLabel = turnState === "working" ? "工作中" : turnState === "idle" ? "空闲" : turnState === "needs_input" ? "等待输入" : "状态未知";
  return (
    <>
      {error && (
        <p role="alert">
          {error}{" "}
          <button onClick={() => void refresh(undefined, true)}>
            重新读取
          </button>
        </p>
      )}
      <div className="rv-conversation-toolbar">
        <span className="rv-conversation-status" role="status">
          {transcript?.runtime ? `原会话 · ${stateLabel}` : busy ? "正在读取原会话…" : "原会话"}
        </span>
        <ConversationSettings>
          {settings}
          {runnable && (
            <label className="rv-upload">
              {uploading ? "正在上传附件…" : "附加文件"}
              <input
                aria-label="会话附件"
                type="file"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
            </label>
          )}
        </ConversationSettings>
      </div>
      <TranscriptView
        thinking={turnState === "working"}
        resource={`${node}:${conversation}`}
        data={transcript ?? { messages: [] }}
        status={undefined}
        busy={busy}
        onLoadOlder={() => {
          if (transcript?.offset)
            void refresh(Math.max(0, transcript.offset - 100));
        }}
        onOpenFileLink={openFile}
        expandOverrides={expanded}
        onToggleGroup={toggle}
      />
      {interaction && runnable && (
        <AgentInteractionCard
          key={interaction.id}
          interaction={interaction}
          onRespond={async (response) => {
            await call("session_respond", {
              request: requestId(),
              node,
              conversation,
              interaction: interaction.id,
              response,
            });
            await refresh(undefined, true);
          }}
        />
      )}
    </>
  );
}
