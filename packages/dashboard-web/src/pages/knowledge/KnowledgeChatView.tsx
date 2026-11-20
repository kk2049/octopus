import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { ApiError, api, errorText } from "../../lib/api.js";
import { useBrowserDraft, type BrowserDraftSubmission } from "../../lib/browser-drafts-react.js";
import { pollInterval } from "../../lib/query.js";
import { ChatScroller, DASHBOARD_CHAT_CLASSES } from "../../transcript/ChatTranscript.js";
import { ChatTurn, type ChatTurnClasses } from "../../transcript/TranscriptGroup.js";
import { Dialog } from "../../ui/Dialog.js";
import { Markdown } from "../../ui/Markdown.js";
import { ErrorBox, Loading, Spinner, Status } from "../../ui/misc.js";
import { UiButton, UiTextArea } from "../../ui-kit/primitives.js";
import styles from "../KnowledgePage.module.css";
import type {
  WikiKnowledgeChat,
  WikiKnowledgeChatDetail,
  WikiKnowledgeChatList,
  WikiKnowledgeChatMessage,
} from "./types.js";

/**
 * Older history windows the reader explicitly loaded for one chat.
 *
 * Messages are append-only, so these windows never change. They continue the
 * live window that started at `anchor`; once that window has slid past the
 * anchor (hundreds of new messages while the page stayed open) the union
 * could have a gap, so they are dropped and the control is offered again.
 */
interface EarlierHistory {
  chatId: string;
  anchor: number;
  messages: WikiKnowledgeChatMessage[];
  hasEarlier: boolean;
}

/**
 * Older roster windows the reader explicitly loaded.
 *
 * They continue the live (polled) first window after `anchor`, that window's
 * last row when they were first asked for. A conversation that becomes active
 * moves into the live window and is shown there, once. Once new activity has
 * pushed rows out of the live window so that it no longer reaches the anchor,
 * the union could have a gap: the older windows are dropped and the control is
 * offered again.
 */
interface EarlierChats {
  anchor: string;
  chats: WikiKnowledgeChat[];
  next: string | null;
}

/** A roster position as the server's cursor spells it: `<updated_at>|<id>`. */
const chatCursor = (chat: WikiKnowledgeChat): string => `${chat.updated_at}|${chat.id}`;

/** Is `chat` at or past `cursor` in roster order (updated_at DESC, id DESC)? */
function reaches(chat: WikiKnowledgeChat, cursor: string): boolean {
  const bar = cursor.indexOf("|");
  const at = cursor.slice(0, bar), id = cursor.slice(bar + 1);
  return chat.updated_at < at || (chat.updated_at === at && chat.id <= id);
}

const TURN_CLASSES: ChatTurnClasses = {
  turn: DASHBOARD_CHAT_CLASSES.turn,
  userTurn: DASHBOARD_CHAT_CLASSES.userTurn,
  assistantTurn: DASHBOARD_CHAT_CLASSES.assistantTurn,
  metaTurn: DASHBOARD_CHAT_CLASSES.metaTurn,
  pendingTurn: DASHBOARD_CHAT_CLASSES.pendingTurn,
  role: DASHBOARD_CHAT_CLASSES.role,
};

function requestId(): string {
  return `kcr_${crypto.randomUUID().replaceAll("-", "")}`;
}

function relative(at: string): string {
  const delta = Date.now() - Date.parse(at);
  if (!Number.isFinite(delta) || delta < 0) return at.slice(0, 16).replace("T", " ");
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return uiText("刚刚");
  if (minutes < 60) return uiText("{v0} 分钟前", { v0: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return uiText("{v0} 小时前", { v0: hours });
  return at.slice(0, 10);
}

function setParam(params: URLSearchParams, setParams: ReturnType<typeof useSearchParams>[1], key: string, value: string | null) {
  const next = new URLSearchParams(params);
  if (value) next.set(key, value);
  else next.delete(key);
  setParams(next, { replace: true });
}

function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void): void {
  if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey) || event.nativeEvent.isComposing) return;
  event.preventDefault();
  submit();
}

function ChatListItem({ chat, selected, onSelect }: {
  chat: WikiKnowledgeChat;
  selected: boolean;
  onSelect: () => void;
}) {
  useDashboardLanguage();
  return (
    <li>
      <button type="button" aria-current={selected ? "true" : undefined} onClick={onSelect}>
        <b>{chat.title}</b>
        <span>{chat.preview}</span>
        <time dateTime={chat.updated_at}>{relative(chat.updated_at)}</time>
      </button>
    </li>
  );
}

export function KnowledgeChatView() {
  useDashboardLanguage();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const subject = params.get("subject")?.trim() || null;
  const requestedChat = params.get("chat");
  const creating = requestedChat === "new";
  const newDraft = useBrowserDraft(`knowledge:chat:new:${subject ?? "general"}`);
  const [newRequestId, setNewRequestId] = useState(requestId);
  const [sendIds, setSendIds] = useState<Record<string, string>>({});
  const [mobilePane, setMobilePane] = useState<"list" | "conversation">("list");

  const roster = useQuery<WikiKnowledgeChatList>({
    queryKey: ["knowledge", "chats"],
    queryFn: () => api("/api/knowledge/chats"),
    refetchInterval: (query) => {
      const running = query.state.data?.chats.some((chat) => Boolean(chat.running_since));
      return running ? pollInterval("/api/knowledge/chats", 2500) : false;
    },
    refetchIntervalInBackground: false,
  });
  const liveChats = roster.data?.chats ?? [];
  const liveLast = liveChats.at(-1);
  const [earlierChats, setEarlierChats] = useState<EarlierChats | null>(null);
  const loadedChats = earlierChats && liveLast && roster.data?.next_before && reaches(liveLast, earlierChats.anchor)
    ? earlierChats
    : null;
  const liveIds = new Set(liveChats.map((chat) => chat.id));
  const shownChats = loadedChats
    ? [...liveChats, ...loadedChats.chats.filter((chat) => !liveIds.has(chat.id))]
    : liveChats;
  const moreChats = loadedChats ? loadedChats.next : roster.data?.next_before ?? null;
  const olderChats = useMutation({
    mutationFn: (input: { before: string; base: EarlierChats | null; anchor: string }) =>
      api<WikiKnowledgeChatList>(`/api/knowledge/chats?before=${encodeURIComponent(input.before)}`),
    onSuccess: (page, input) => setEarlierChats({
      anchor: input.anchor,
      chats: [...(input.base?.chats ?? []), ...page.chats],
      next: page.next_before ?? null,
    }),
  });
  const loadOlderChats = () => {
    if (!moreChats || !liveLast || olderChats.isPending) return;
    olderChats.mutate({ before: moreChats, base: loadedChats, anchor: loadedChats?.anchor ?? chatCursor(liveLast) });
  };
  const selectedId = requestedChat && requestedChat !== "new"
    ? requestedChat
    : roster.data?.chats[0]?.id ?? null;
  const chatDraft = useBrowserDraft(selectedId ? `knowledge:chat:message:${selectedId}` : null);
  const detail = useQuery<WikiKnowledgeChatDetail>({
    queryKey: ["knowledge", "chat", selectedId],
    enabled: Boolean(selectedId),
    queryFn: () => api(`/api/knowledge/chat?id=${encodeURIComponent(selectedId!)}`),
    refetchInterval: (query) => query.state.data?.chat.running_since
      ? pollInterval("/api/knowledge/chat", 2500)
      : false,
    refetchIntervalInBackground: false,
  });

  const [earlier, setEarlier] = useState<EarlierHistory | null>(null);
  const windowMessages = detail.data?.messages ?? [];
  const windowFirst = windowMessages[0]?.id;
  const loadedEarlier = earlier && earlier.chatId === selectedId && windowFirst !== undefined && windowFirst <= earlier.anchor
    ? earlier
    : null;
  const shownMessages = loadedEarlier ? [...loadedEarlier.messages, ...windowMessages] : windowMessages;
  const hasEarlier = loadedEarlier ? loadedEarlier.hasEarlier : Boolean(detail.data?.has_earlier);
  const older = useMutation({
    mutationFn: (input: { chatId: string; before: number; base: EarlierHistory | null; anchor: number }) =>
      api<WikiKnowledgeChatDetail>(`/api/knowledge/chat?id=${encodeURIComponent(input.chatId)}&before=${input.before}`),
    onSuccess: (page, input) => setEarlier({
      chatId: input.chatId,
      anchor: input.anchor,
      messages: [...page.messages, ...(input.base?.messages ?? [])],
      hasEarlier: Boolean(page.has_earlier),
    }),
  });
  const olderForSelected = older.variables?.chatId === selectedId;
  const loadOlder = () => {
    const before = shownMessages[0]?.id;
    if (!selectedId || before === undefined || windowFirst === undefined || older.isPending) return;
    older.mutate({ chatId: selectedId, before, base: loadedEarlier, anchor: loadedEarlier?.anchor ?? windowFirst });
  };

  const create = useMutation({
    mutationFn: (input: {
      message: string;
      requestId: string;
      subject: string | null;
      submission: BrowserDraftSubmission | null;
    }) => api<{ chat: WikiKnowledgeChat }>("/api/knowledge/chats", {
      method: "POST",
      json: {
        message: input.message,
        request_id: input.requestId,
        ...(input.subject ? { subject_id: input.subject } : {}),
      },
    }),
    onSuccess: async (response, input) => {
      newDraft.completeSubmission(input.submission);
      setNewRequestId(requestId());
      const next = new URLSearchParams(params);
      next.set("v", "chat");
      next.set("chat", response.chat.id);
      next.delete("subject");
      setParams(next, { replace: true });
      setMobilePane("conversation");
      await client.invalidateQueries({ queryKey: ["knowledge", "chats"] });
      await client.invalidateQueries({ queryKey: ["knowledge", "chat", response.chat.id] });
    },
    onError: (error, input) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        newDraft.restoreSubmission(input.submission);
      }
    },
  });

  const draft = chatDraft.text;
  const send = useMutation({
    mutationFn: (input: {
      chatId: string;
      message: string;
      requestId: string;
      submission: BrowserDraftSubmission | null;
    }) => api("/api/knowledge/chat/send", {
      method: "POST",
      json: {
        chat_id: input.chatId,
        message: input.message,
        request_id: input.requestId,
      },
    }),
    onSuccess: async (_response, input) => {
      chatDraft.completeSubmission(input.submission);
      setSendIds((current) => ({ ...current, [input.chatId]: requestId() }));
      await client.invalidateQueries({ queryKey: ["knowledge", "chat", input.chatId] });
      await client.invalidateQueries({ queryKey: ["knowledge", "chats"] });
    },
    onError: (error, input) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        chatDraft.restoreSubmission(input.submission);
      }
    },
  });

  const closeCreate = () => {
    if (create.isPending) return;
    newDraft.clear();
    setNewRequestId(requestId());
    setParam(params, setParams, "chat", selectedId);
  };
  const submitCreate = () => {
    const message = newDraft.text.trim();
    if (!message || create.isPending) return;
    create.mutate({
      message,
      requestId: newRequestId,
      subject,
      submission: newDraft.beginSubmission(),
    });
  };
  const submitMessage = () => {
    if (!selectedId || !draft.trim() || send.isPending || detail.data?.chat.running_since || detail.data?.read_only) return;
    send.mutate({
      chatId: selectedId,
      message: draft.trim(),
      requestId: sendIds[selectedId] ?? requestId(),
      submission: chatDraft.beginSubmission(),
    });
  };

  if (roster.isLoading) return <Loading what={uiText("读取知识 Chat…")} />;
  if (roster.error) return <ErrorBox>{errorText(roster.error)}</ErrorBox>;

  return (
    <section className={styles.knowledgeChats} data-mobile-pane={mobilePane} aria-labelledby="knowledge-chat-heading">
      <div className={styles.mobileKnowledgeChatTabs} role="group" aria-label={uiText("知识 Chat 面板")}>
        <button type="button" aria-pressed={mobilePane === "list"} onClick={() => setMobilePane("list")}>{uiText("会话列表")}</button>
        <button type="button" aria-pressed={mobilePane === "conversation"} disabled={!selectedId} onClick={() => setMobilePane("conversation")}>{uiText("当前对话")}</button>
      </div>
      <aside className={styles.knowledgeChatSidebar}>
        <div className={styles.knowledgeChatSidebarHead}>
          <div>
            <h2 id="knowledge-chat-heading">{uiText("知识 Chat")}</h2>
            <p>{uiText("普通知识问答，不是工单")}</p>
          </div>
          <UiButton
            className="primary"
            disabled={!roster.data?.enabled}
            onClick={() => setParam(params, setParams, "chat", "new")}
          >
            {uiText("新建")}</UiButton>
        </div>
        {!roster.data?.enabled ? <Status kind="muted">{uiText("知识 Chat Agent 尚未配置；已有记录仍可查看。")}</Status> : null}
        {shownChats.length ? (
          <ol className={styles.knowledgeChatList} aria-label={uiText("知识 Chat 列表")}>
            {shownChats.map((chat) => (
              <ChatListItem
                key={chat.id}
                chat={chat}
                selected={chat.id === selectedId}
                onSelect={() => {
                  setParam(params, setParams, "chat", chat.id);
                  setMobilePane("conversation");
                }}
              />
            ))}
          </ol>
        ) : null}
        {shownChats.length && moreChats ? (
          <div className={styles.knowledgeChatMore}>
            <UiButton disabled={olderChats.isPending} onClick={loadOlderChats}>
              {olderChats.isPending ? uiText("读取更早的对话…") : uiText("显示更早的对话")}
            </UiButton>
            {olderChats.error ? <Status kind="err">{errorText(olderChats.error)}</Status> : null}
          </div>
        ) : null}
        {shownChats.length ? null : (
          <div className={styles.knowledgeChatEmpty}>
            <b>{uiText("还没有知识 Chat")}</b>
            <p>{uiText("从一个具体问题开始；首条消息会成为对话起点。")}</p>
            <UiButton className="primary" disabled={!roster.data?.enabled} onClick={() => setParam(params, setParams, "chat", "new")}>
              {uiText("新建知识 Chat")}</UiButton>
          </div>
        )}
      </aside>

      <div className={styles.knowledgeChatConversation}>
        {selectedId && detail.isLoading ? <Loading what={uiText("读取对话…")} /> : null}
        {selectedId && detail.error ? (
          <ErrorBox>{errorText(detail.error)}{uiText("；选择仍保留，请刷新后重试。")}</ErrorBox>
        ) : null}
        {detail.data ? (
          <>
            <header className={styles.knowledgeChatConversationHead}>
              <div>
                <h2>{detail.data.chat.title}</h2>
                <p>
                  {detail.data.chat.subject_id ? uiText("关联冲突 {v0}", { v0: detail.data.chat.subject_id }) : uiText("知识库问答")}
                  {detail.data.model ? ` · ${detail.data.model}` : ""}
                </p>
              </div>
              {detail.data.chat.running_since ? <span><Spinner /> {uiText(" Agent 回答中")}</span> : null}
            </header>
            {detail.data.read_only ? <Status kind="muted">{detail.data.read_only_reason ?? uiText("这个对话当前只读")}</Status> : null}
            <ChatScroller
              anchor={detail.data.chat.id}
              followKey={windowMessages.at(-1)?.id}
              prependKey={shownMessages[0]?.id}
              className={`${DASHBOARD_CHAT_CLASSES.transcript} ${styles.knowledgeChatTranscript}`}
              id="knowledge-chat-transcript"
            >
              {hasEarlier ? (
                <div className={DASHBOARD_CHAT_CLASSES.operationMeta}>
                  <UiButton disabled={older.isPending && olderForSelected} onClick={loadOlder}>
                    {older.isPending && olderForSelected ? uiText("读取更早的消息…") : uiText("显示更早的消息")}
                  </UiButton>
                  {older.error && olderForSelected ? <Status kind="err">{errorText(older.error)}</Status> : null}
                </div>
              ) : null}
              {shownMessages.map((message) => (
                <ChatTurn
                  key={message.id}
                  classes={TURN_CLASSES}
                  role={message.role === "assistant" ? "assistant" : message.role === "error" ? "meta" : "user"}
                  label={message.role === "assistant" ? uiText("知识助手") : message.role === "error" ? uiText("运行状态") : uiText("你")}
                >
                  {message.role === "assistant" ? (
                    <div className={DASHBOARD_CHAT_CLASSES.assistantBody}><Markdown>{message.content}</Markdown></div>
                  ) : message.role === "error" ? (
                    <div className={DASHBOARD_CHAT_CLASSES.operationMeta}>{message.content}</div>
                  ) : <div className={DASHBOARD_CHAT_CLASSES.userBody}>{message.content}</div>}
                </ChatTurn>
              ))}
              {detail.data.chat.running_since ? (
                <ChatTurn classes={TURN_CLASSES} pending role="assistant" label={uiText("知识助手")}>
                  <div className={DASHBOARD_CHAT_CLASSES.assistantBody}><Spinner /> {uiText(" 正在整理知识上下文…")}</div>
                </ChatTurn>
              ) : null}
            </ChatScroller>
            <div className={styles.knowledgeChatComposer}>
              <label className="srOnly" htmlFor="knowledge-chat-message">{uiText("继续提问")}</label>
              <UiTextArea
                id="knowledge-chat-message"
                value={draft}
                maxLength={4000}
                disabled={detail.data.read_only || Boolean(detail.data.chat.running_since)}
                autoSize={{ minRows: 2, maxRows: 6 }}
                placeholder={detail.data.read_only ? uiText("关联对象已关闭；历史对话保持只读") : uiText("继续提问（Ctrl/⌘+Enter 发送）")}
                onChange={(event) => {
                  const value = event.target.value;
                  chatDraft.set(value);
                  setSendIds((current) => ({ ...current, [detail.data!.chat.id]: requestId() }));
                }}
                onKeyDown={(event) => submitOnModEnter(event, submitMessage)}
              />
              <UiButton className="primary" disabled={!draft.trim() || send.isPending || detail.data.read_only || Boolean(detail.data.chat.running_since)} onClick={submitMessage}>
                {send.isPending ? uiText("发送中…") : uiText("发送")}
              </UiButton>
            </div>
            {send.error ? <Status kind="err">{errorText(send.error)}{uiText("；消息草稿仍保留，可重试。")}</Status> : null}
          </>
        ) : !selectedId ? (
          <div className={styles.knowledgeChatEmpty}>
            <b>{uiText("选择一个知识 Chat")}</b>
            <p>{uiText("或新建一个带首条消息的对话。")}</p>
          </div>
        ) : null}
      </div>

      <Dialog
        open={creating}
        onOpenChange={(open) => { if (!open) closeCreate(); }}
        title={uiText("新建知识 Chat")}
        description={subject ? uiText("这次对话会带上冲突 {v0} 的只读上下文。", { v0: subject }) : uiText("先写下你想问的第一条消息。")}
        width={560}
        footer={
          <>
            <UiButton disabled={create.isPending} onClick={closeCreate}>{uiText("取消")}</UiButton>
            <UiButton className="primary" disabled={!newDraft.text.trim() || create.isPending} onClick={submitCreate}>
              {create.isPending ? uiText("创建中…") : uiText("创建并提问")}
            </UiButton>
          </>
        }
      >
        <label htmlFor="knowledge-chat-first-message">{uiText("首条消息（必填）")}</label>
        <UiTextArea
          id="knowledge-chat-first-message"
          autoFocus
          value={newDraft.text}
          maxLength={4000}
          autoSize={{ minRows: 5, maxRows: 10 }}
          placeholder={uiText("例如：这两条知识为什么互相冲突？")}
          onChange={(event) => {
            newDraft.set(event.target.value);
            setNewRequestId(requestId());
          }}
          onKeyDown={(event) => submitOnModEnter(event, submitCreate)}
        />
        <div className={styles.knowledgeChatFormMeta}><span>{uiText("必填，最多 4000 字")}</span><span>{newDraft.text.length} / 4000</span></div>
        {create.error ? <Status kind="err">{errorText(create.error)}{uiText("；首条消息仍保留，可重试。")}</Status> : null}
      </Dialog>
    </section>
  );
}
