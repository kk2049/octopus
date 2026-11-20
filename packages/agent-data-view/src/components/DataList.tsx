import { AvButton } from "@claude-bot/agent-view-react/ui";
/**
 * A list of rows, and the four states that are not "a list of rows".
 *
 * Purely presentational: it takes rows and gives back a selection. Which
 * projection path they came from, whether selecting one opens a panel, and what
 * a badge means are all decided by the module above — this file exists so that
 * layer has no DOM in it.
 *
 * The status branches are the point. "The composition points at a path this
 * projection does not have" and "the path is there and the collection is empty"
 * look identical if you only render rows, and they are the two mistakes an App
 * author actually makes.
 */

import { Banner, StatusChip } from "@claude-bot/agent-view-react/ui";
import type { CollectionStatus, DataRow, ProjectedNotice } from "../lib/select.js";

export interface DataListProps {
  title: string;
  rows: readonly DataRow[];
  truncated: boolean;
  /** Entries in the whole collection; `rows` is the prefix shown so far. */
  total: number;
  /** Reveal the next page. The collection is never silently cut off. */
  onMore?(): void;
  status: CollectionStatus;
  /** The configured path, quoted back when it does not resolve. */
  source: string;
  emptyText: string;
  selected: string | null;
  /**
   * No projection has arrived yet.
   *
   * Checked BEFORE `status`, because a projection that has not arrived and a
   * path that does not exist read identically to any reader — and telling an App
   * author their composition is wrong while the channel is still opening is the
   * worst possible first paint.
   */
  booting: boolean;
  /** Suffix for DOM ids when a second instance of this module is mounted. */
  domIdScope?: string;
  /** A bounded banner the projection raised for this collection, or null. */
  notice?: ProjectedNotice | null;
  onSelect(row: DataRow): void;
}

export function DataList({
  title,
  rows,
  truncated,
  total,
  onMore,
  status,
  source,
  emptyText,
  selected,
  booting,
  domIdScope,
  notice = null,
  onSelect,
}: DataListProps) {
  const id = (name: string): string => (domIdScope ? `${name}-${domIdScope}` : name);
  return (
    <section className="dv-list" data-dv-source={source}>
      {title ? (
        <header className="dv-head">
          <b>{title}</b>
          {total ? <span className="dv-count">{total}</span> : null}
        </header>
      ) : null}
      {notice && !booting ? (
        <div className="dv-list-notice" data-dv-notice>
          <Banner tone={notice.tone} title={notice.text} />
        </div>
      ) : null}
      {booting ? (
        <p className="dv-note" role="note">⏳ 正在等待第一份投影…</p>
      ) : status === "missing" ? (
        <p className="dv-note" role="note">
          这个组合指向的投影路径不存在：<code>{source}</code>
        </p>
      ) : status === "not_a_collection" ? (
        <p className="dv-note" role="note">
          <code>{source}</code> 上不是一份可以列出的集合。
        </p>
      ) : rows.length === 0 ? (
        <p className="dv-note" role="note">{emptyText || "这里还没有条目。"}</p>
      ) : (
        <ul className="dv-rows" id={id("dv-rows")}>
          {rows.map((row) => (
            <li key={row.id}>
              <AvButton
                className="dv-row"
                data-dv-row={row.id}
                aria-current={selected === row.id ? "true" : undefined}
                onClick={() => onSelect(row)}
              >
                <span className="dv-row-title">{row.title}</span>
                {row.subtitle ? <span className="dv-row-sub">{row.subtitle}</span> : null}
                {row.badge ? <StatusChip word={row.badge} tone={row.tone} /> : null}
              </AvButton>
            </li>
          ))}
        </ul>
      )}
      {truncated ? <MoreRows shown={rows.length} total={total} onMore={onMore} /> : null}
    </section>
  );
}

/** "Shown so far / total", and the button that reveals the next page. */
export function MoreRows({ shown, total, onMore }: { shown: number; total: number; onMore?: () => void }) {
  return (
    <p className="dv-note dv-more" role="note" data-dv-more>
      已显示 {shown} / {total} 条。
      {onMore ? (
        <AvButton className="dv-more-button" onClick={onMore}>显示更多</AvButton>
      ) : null}
    </p>
  );
}
