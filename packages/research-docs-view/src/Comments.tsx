import { useEffect, useRef, useState } from "react";
import type { Call, DocComment } from "@claude-bot/research-docs-contract";
import { readAll } from "./list.js";
type Outgoing = { request: string; text: string; block: string };
export function Comments({
  call,
  page,
  editable,
  epoch,
  block,
  onClose,
  onLocate,
  storageKey,
}: {
  call: Call;
  page: string;
  editable: boolean;
  epoch: number;
  block: () => string;
  onClose: () => void;
  onLocate: (id: string) => void;
  storageKey: string;
}) {
  const saved = () => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
        draft: string;
        outgoing: Outgoing | null;
      } | null;
    } catch {
      return null;
    }
  };
  const [comments, setComments] = useState<DocComment[]>([]),
    [draft, setDraft] = useState(() => saved()?.draft ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [resolved, setResolved] = useState(false);
  const outgoing = useRef<Outgoing | null>(saved()?.outgoing ?? null),
    generation = useRef(0),
    live = useRef(true);
  const persist = (text: string, request: Outgoing | null) => {
    try {
      if (text || request)
        localStorage.setItem(
          storageKey,
          JSON.stringify({ draft: text, outgoing: request }),
        );
      else localStorage.removeItem(storageKey);
    } catch {
      setError("本地草稿未能保存，请保持窗口打开。");
    }
  };
  const refresh = async () => {
    const g = ++generation.current;
    try {
      const all = await readAll<DocComment>(
        call,
        "comments",
        "comments",
        { doc: page },
        () => live.current && g === generation.current,
      );
      if (all) setComments(all);
    } catch (e) {
      if (live.current && g === generation.current) setError(String(e));
    }
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    void refresh();
  }, [epoch]);
  const submit = async () => {
    if (!draft.trim() || busy) return;
    const request = outgoing.current ?? {
      request: crypto.randomUUID(),
      text: draft,
      block: block(),
    };
    outgoing.current = request;
    persist(draft, request);
    setBusy(true);
    setError("");
    try {
      await call("comment", { doc: page, ...request });
      if (!live.current) return;
      outgoing.current = null;
      setDraft((current) => {
        const next = current === request.text ? "" : current;
        persist(next, null);
        return next;
      });
      await refresh();
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <aside className="rd-comments" aria-label="文档讨论">
      <header>
        <h2>
          讨论 <span>{comments.filter((c) => !c.resolved).length}</span>
        </h2>
        <button onClick={onClose} aria-label="关闭讨论">
          ×
        </button>
      </header>
      <div className="rd-comments-list">
        <label className="rd-check">
          <input
            type="checkbox"
            checked={resolved}
            onChange={(e) => setResolved(e.target.checked)}
          />
          显示已解决
        </label>
        {comments
          .filter((c) => resolved || !c.resolved)
          .map((c) => (
            <section
              key={c.id}
              className={"rd-comment " + (c.resolved ? "is-resolved" : "")}
            >
              <div>
                <strong>{c.author}</strong>
                <time>
                  {new Date(c.createdAt).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              {c.block && (
                <button
                  className="rd-comment-anchor"
                  onClick={() => onLocate(c.block)}
                >
                  定位相关段落 ↗
                </button>
              )}
              <p>{c.text}</p>
              {editable && (
                <button
                  onClick={async () => {
                    try {
                      await call("resolve", {
                        doc: page,
                        comment: c.id,
                        resolved: !c.resolved,
                      });
                      await refresh();
                    } catch (e) {
                      if (live.current) setError(String(e));
                    }
                  }}
                >
                  {c.resolved ? "重新打开" : "✓ 解决"}
                </button>
              )}
            </section>
          ))}
        {!comments.length && (
          <div className="rd-empty-hint">
            <span>☷</span>
            <h3>让讨论留在文档旁</h3>
            <p>把问题、建议和审阅结论放在这里，团队成员可以一起跟进。</p>
          </div>
        )}
      </div>
      {error && (
        <p className="rd-error" role="alert">
          {error}
        </p>
      )}
      {editable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <textarea
            aria-label="添加讨论"
            placeholder="添加讨论，关联当前段落…"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              persist(e.target.value, outgoing.current);
            }}
            maxLength={8000}
          />
          <button className="rd-primary" disabled={busy || !draft.trim()}>
            {busy ? "发布中…" : outgoing.current ? "重试原讨论" : "发布讨论"}
          </button>
        </form>
      )}
    </aside>
  );
}
