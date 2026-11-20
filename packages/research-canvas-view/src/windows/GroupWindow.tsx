import { useEffect, useRef, useState } from "react";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { persist, requestId, stored, type Call } from "../client.js";
import { DiscussionSourceWindow } from "./DiscussionSourceWindow.js";
interface GroupHistory {
  items: {
    message_id: string;
    sender?: string;
    body?: string;
    create_time?: string;
    truncated?: boolean;
  }[];
  has_more: boolean;
  page_token?: string;
}
export function GroupWindow({
  node,
  call,
  runnable,
  storageKey,
  editable,
  open,
}: {
  node: ResearchNode;
  call: Call;
  runnable: boolean;
  storageKey: string;
  editable: boolean;
  open(id: string): void;
}) {
  const [history, setHistory] = useState<GroupHistory | null>(null),
    [text, setText] = useState(() =>
      stored(`${storageKey}:group:${node.id}`, ""),
    ),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [from, setFrom] = useState(""), [to, setTo] = useState(""), [captureTitle, setCaptureTitle] = useState("讨论记录");
  const [capturing, setCapturing] = useState(false), [captured, setCaptured] = useState("");
  const captureKey = `${storageKey}:discussion:${node.id}`;
  const [captureRequest, setCaptureRequest] = useState<Record<string, string> | null>(() => stored(captureKey, null));
  const [sourceEpoch, setSourceEpoch] = useState(0), [follow, setFollow] = useState<{ enabled: boolean; cursor: string; error?: string } | null>(null);
  const [creating, setCreating] = useState(false), [groupTitle, setGroupTitle] = useState(node.title), [agenda, setAgenda] = useState("");
  const createKey = `${storageKey}:create-group:${node.id}`;
  const [createRequest, setCreateRequest] = useState<Record<string, string> | null>(() => stored(createKey, null));
  const generation = useRef(0);
  const loadFollow = async () => {
    const ticket = generation.current;
    try { const result = await call<{ follow: typeof follow }>("source_read", { node: node.id }); if (ticket === generation.current) setFollow(result.follow); }
    catch (reason) { if (ticket === generation.current) setError(String(reason)); }
  };
  const read = async (cursor?: string) => {
    const ticket = generation.current;
    setPending(true);
    try {
      const result = await call<GroupHistory>("resource_read", {
        node: node.id,
        cursor,
      });
      if (ticket === generation.current)
        setHistory((previous) => ({
          ...result,
          items: [...(cursor ? (previous?.items ?? []) : []), ...result.items],
        }));
    } catch (error) {
      if (ticket === generation.current) setError(String(error));
    } finally {
      if (ticket === generation.current) setPending(false);
    }
  };
  useEffect(() => {
    void read(); void loadFollow();
    return () => {
      generation.current++;
    };
  }, [node.id]);
  return (
    <div>
      <div className="rv-inline">
        <span>群历史 · 新消息默认不拉起 Agent</span>
        <button disabled={pending} onClick={() => void read()}>
          刷新
        </button>
      </div>
      <div className="rv-group-history">
        {history?.items.map((message) => (
          <article key={message.message_id}>
            <small>
              {message.sender ?? "未知发言者"} ·{" "}
              {message.create_time
                ? new Date(Number(message.create_time)).toLocaleString()
                : ""}
            </small>
            <p>{messageText(message.body ?? "")}</p>
            {message.truncated && <small>消息较长，当前为摘要</small>}
          </article>
        ))}
      </div>
      {history?.has_more && (
        <button
          disabled={pending}
          onClick={() => void read(history.page_token)}
        >
          更早消息
        </button>
      )}
      <details className="rv-settings rv-discussion-capture">
        <summary>保存讨论区间与纪要</summary>
        <p>选择首末消息，平台读取跨页区间并固定原始记录；纪要保留来源与待确认项。</p>
        <label>讨论标题<input value={captureTitle} onChange={event => setCaptureTitle(event.target.value)} maxLength={160} /></label>
        <label>首条消息<select aria-label="讨论首条消息" value={from} onChange={event => setFrom(event.target.value)}><option value="">选择较早的消息</option>{history?.items.map(message => <option key={message.message_id} value={message.message_id}>{message.sender ?? "发言"} · {messageText(message.body ?? "").slice(0, 48)} · {message.message_id}</option>)}</select></label>
        <label>末条消息<select aria-label="讨论末条消息" value={to} onChange={event => setTo(event.target.value)}><option value="">选择较新的消息</option>{history?.items.map(message => <option key={message.message_id} value={message.message_id}>{message.sender ?? "发言"} · {messageText(message.body ?? "").slice(0, 48)} · {message.message_id}</option>)}</select></label>
        <button disabled={!editable || capturing || (!captureRequest && (!from || !to || !captureTitle.trim()))} onClick={async () => {
          const ticket = generation.current;
          const request = captureRequest ?? { request: requestId(), node: node.id, from, to, title: captureTitle.trim() };
          setCaptureRequest(request); persist(captureKey, request); setCapturing(true); setError("");
          try {
            const result = await call<{ minutes: { id: string } }>("discussion_capture", request);
            if (ticket !== generation.current) return;
            setCaptured(result.minutes.id); setCaptureRequest(null); persist(captureKey, null); setSourceEpoch(value => value + 1);
          } catch (reason) { if (ticket === generation.current) setError(String(reason)); }
          finally { if (ticket === generation.current) setCapturing(false); }
        }}>{capturing ? "正在保存区间…" : captureRequest ? "重试原区间" : "生成原始记录与纪要草稿"}</button>
        {captureRequest && <small>待重试：{captureRequest.title} · {captureRequest.from} → {captureRequest.to}</small>}
        {captured && <button onClick={() => open(captured)}>打开纪要</button>}
        {captureRequest && !capturing && <button onClick={() => { setCaptureRequest(null); persist(captureKey, null); setError(""); }}>放弃重试，使用新选择</button>}
      </details>
      <details className="rv-settings"><summary>新建飞书讨论群</summary>
        <p>创建本人参与的私有讨论群并绑定为来源。这个动作会在飞书创建新群。</p>
        <label>群标题<input value={groupTitle} maxLength={100} disabled={creating || Boolean(createRequest)} onChange={event => setGroupTitle(event.target.value)} /></label>
        <label>群说明<textarea value={agenda} maxLength={1000} disabled={creating || Boolean(createRequest)} onChange={event => setAgenda(event.target.value)} /></label>
        <button disabled={!editable || creating || !groupTitle.trim()} onClick={async () => {
          const ticket = generation.current;
          const request = createRequest ?? { request: requestId(), node: node.id, title: groupTitle.trim(), agenda };
          setCreateRequest(request); persist(createKey, request); setCreating(true); setError("");
          try { const result = await call<{ status: string }>("discussion_create", request); if (ticket !== generation.current) return;
            if (result.status !== "created") throw new Error("建群结果尚未确认，请先在飞书核对");
            setCreateRequest(null); persist(createKey, null); await read();
          } catch (reason) { if (ticket === generation.current) setError(String(reason)); }
          finally { if (ticket === generation.current) setCreating(false); }
        }}>{creating ? "创建中…" : createRequest ? "核对原建群请求" : "在飞书创建并绑定"}</button>
        {createRequest && <p className="rv-muted">不确定的创建结果不会自动重发；也可在来源设置中绑定已存在的群。</p>}
      </details>
      <details className="rv-settings"><summary>持续增量接入</summary>
        <p>启用后从已确认的消息游标继续保存新讨论；重复消息去重，整理失败不会推进游标。来源消息不会进入语音识别。</p>
        <p>{follow?.enabled ? `已启用 · 起点 ${follow.cursor}` : "已暂停"}</p>
        {follow?.error && <p role="alert">{follow.error}</p>}
        <button disabled={!runnable || pending} onClick={async () => {
          const ticket = generation.current; setPending(true); setError("");
          try { const result = await call<{ follow: NonNullable<typeof follow> }>("discussion_follow", { request: requestId(), node: node.id,
            data: { enabled: !follow?.enabled, ...(!follow?.cursor && to ? { cursor: to } : {}) } });
            if (ticket === generation.current) setFollow(result.follow);
          } catch (reason) { if (ticket === generation.current) setError(String(reason)); }
          finally { if (ticket === generation.current) setPending(false); }
        }}>{follow?.enabled ? "暂停增量接入" : "从选定末条／当前最新消息开始接入"}</button>
        {follow?.enabled && <button disabled={!runnable || pending} onClick={async () => {
          const ticket = generation.current; setPending(true); setError("");
          try { await call("discussion_sync", { request: requestId(), node: node.id }); if (ticket === generation.current) { await loadFollow(); setSourceEpoch(value => value + 1); } }
          catch (reason) { if (ticket === generation.current) setError(String(reason)); }
          finally { if (ticket === generation.current) setPending(false); }
        }}>接入新讨论</button>}
      </details>
      <DiscussionSourceWindow storageKey={storageKey} node={node} call={call} editable={editable} runnable={runnable} open={open} epoch={sourceEpoch} />
      <form
        className="rv-composer"
        onSubmit={async (event) => {
          event.preventDefault();
          const submitted = text;
          setPending(true);
          setError("");
          try {
            const receipt = await call<{ status: string; message?: string }>(
              "group_send",
              { request: requestId(), node: node.id, text: submitted },
            );
            if (receipt.status !== "sent")
              setError(receipt.message ?? "发送结果未确认，请先核对群历史");
            else {
              setText((current) => {
                if (current !== submitted) return current;
                persist(`${storageKey}:group:${node.id}`, "");
                return "";
              });
              await read();
            }
          } catch (error) {
            setError(String(error));
          } finally {
            setPending(false);
          }
        }}
      >
        <textarea
          aria-label="群消息"
          value={text}
          placeholder="发送到这个飞书群…"
          onChange={(event) => {
            setText(event.target.value);
            persist(`${storageKey}:group:${node.id}`, event.target.value);
          }}
        />
        <button disabled={!runnable || pending || !text.trim()}>
          发送到群
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function messageText(body: string): string {
  try {
    const value = JSON.parse(body);
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.content))
      return value.content
        .flat()
        .map((item: { text?: string }) => item.text ?? "")
        .join("");
  } catch {}
  return body;
}
