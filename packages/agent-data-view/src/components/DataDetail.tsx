import { AvButton } from "@claude-bot/agent-view-react/ui";
/**
 * One record: a facts table, an optional Markdown body — and, when the instance
 * asked for them, titled sections, an activity thread and a record-scoped
 * action menu.
 *
 * The `kv` half of the engine probe's component catalogue, with the same
 * discipline: values are scalars (or lists of scalars) rendered as text, and a
 * nested object is OMITTED rather than stringified. `[object Object]` in a facts
 * table is worse than a missing row, because it looks like data.
 *
 * Sections and the thread exist so a record's long-form parts (evidence, a
 * discussion) are PART of the record's panel instead of a second panel that has
 * to be told which record is selected — the wiring bug this replaces was a
 * "证据快照" pane that always showed the newest record, whatever was open.
 *
 * The body goes through the SDK's one Markdown renderer, which never puts HTML
 * on the path — a projection is untrusted twice over (publisher code chose it,
 * and a person's own content is inside it).
 */

import { Markdown, StatusChip } from "@claude-bot/agent-view-react/ui";
import type { ActionSpec, Fact, RecordStatus, Section, ThreadSet } from "../lib/select.js";
import { MoreRows } from "./DataList.js";

export interface DataDetailProps {
  title: string;
  facts: readonly Fact[];
  body: string;
  status: RecordStatus;
  /** The configured path, quoted back when it does not resolve. */
  source: string;
  emptyText: string;
  /** No projection has arrived yet. Checked before `status` — see `DataList`. */
  booting: boolean;
  domIdScope?: string;
  /** `stats` renders the facts as a grid of figure cards; "" is the plain table. */
  variant?: string;
  /** Titled Markdown sections after the body. Empty means none were configured. */
  sections?: readonly Section[];
  /** The record's activity thread, when the instance configured a thread_key. */
  thread?: { title: string; set: ThreadSet; onMore?: () => void } | null;
  /** Record-scoped actions. Empty when no menu is configured or nothing is shown. */
  menu?: readonly ActionSpec[];
  onAction?(action: ActionSpec): void;
  /** Present only when this panel was opened for a record. */
  onClose?(): void;
}

export function DataDetail({
  title,
  facts,
  body,
  status,
  source,
  emptyText,
  booting,
  domIdScope,
  variant = "",
  sections = [],
  thread = null,
  menu = [],
  onAction,
  onClose,
}: DataDetailProps) {
  const id = (name: string): string => (domIdScope ? `${name}-${domIdScope}` : name);
  const hasBody = Boolean(body) || sections.length > 0 || Boolean(thread && thread.set.entries.length);
  return (
    <section className="dv-detail" data-dv-source={source} data-dv-status={status}>
      <header className="dv-head">
        <b>{title || "详情"}</b>
        {onClose ? (
          <AvButton className="dv-close" data-dv-close onClick={onClose}>
            关闭
          </AvButton>
        ) : null}
      </header>
      {booting ? (
        <p className="dv-note" role="note">⏳ 正在等待第一份投影…</p>
      ) : status === "missing" ? (
        <p className="dv-note" role="note">
          这个组合指向的投影路径不存在：<code>{source}</code>
        </p>
      ) : status === "not_a_record" ? (
        <p className="dv-note" role="note">
          <code>{source}</code> 上不是一条可以展示的记录。
        </p>
      ) : status === "not_found" ? (
        <p className="dv-note" role="note">{emptyText || "选中的条目不在当前投影里。"}</p>
      ) : (
        <>
          {menu.length && onAction ? (
            <div className="dv-record-actions dv-action-buttons" role="toolbar" aria-label="记录动作">
              {menu.map((action, index) => (
                <AvButton
                  key={action.action}
                  className={index === 0 ? "primary" : undefined}
                  aria-haspopup="dialog"
                  data-dv-action={action.action}
                  onClick={() => onAction(action)}
                >
                  {action.label}
                </AvButton>
              ))}
            </div>
          ) : null}
          {facts.length ? (
            <dl
              className={variant === "stats" ? "dv-facts dv-facts--stats" : "dv-facts"}
              id={id("dv-facts")}
            >
              {facts.map((fact) => (
                <div className="dv-fact" key={fact.key} data-dv-fact={fact.key}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {body ? <Markdown className="dv-body">{body}</Markdown> : null}
          {sections.map((section) => (
            <section className="dv-section" key={section.key} data-dv-section={section.key}>
              <h3 className="dv-section-title">{section.title}</h3>
              <Markdown className="dv-body">{section.body}</Markdown>
            </section>
          ))}
          {thread && thread.set.entries.length ? (
            <section className="dv-thread" data-dv-thread>
              <header className="dv-thread-head">
                <b>{thread.title}</b>
                <span className="dv-count">{thread.set.total}</span>
              </header>
              <ol className="dv-thread-entries">
                {thread.set.entries.map((entry) => (
                  <li className="dv-thread-entry" key={entry.id} data-tone={entry.tone}>
                    <div className="dv-thread-meta">
                      {entry.by ? <span className="dv-thread-by">{entry.by}</span> : null}
                      {entry.badge ? <StatusChip word={entry.badge} tone={entry.tone} /> : null}
                      {entry.at ? <span className="dv-thread-at">{entry.at}</span> : null}
                    </div>
                    {entry.text ? <Markdown className="dv-thread-text">{entry.text}</Markdown> : null}
                  </li>
                ))}
              </ol>
              {thread.set.truncated ? (
                <MoreRows shown={thread.set.entries.length} total={thread.set.total} onMore={thread.onMore} />
              ) : null}
            </section>
          ) : null}
          {!facts.length && !hasBody ? (
            <p className="dv-note" role="note">{emptyText || "这条记录没有可显示的字段。"}</p>
          ) : null}
        </>
      )}
    </section>
  );
}
