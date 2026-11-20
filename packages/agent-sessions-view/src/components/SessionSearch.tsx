import { useEffect, useRef, useState } from "react";
import { AvButton, AvInput } from "@claude-bot/agent-view-react/ui";
/**
 * Cross-session search: a box, and the hits the provider answered with.
 *
 * It is its own component — and, in the Session Plus composition, its own module
 * instance — because search and the roster tree are two different questions
 * about the same provider. A read-only viewer might want the tree and not the
 * search; a future workspace might want the search over a different rail. They
 * share `agent-sessions/v1`, not a component.
 *
 * The query lives in the module instance, not in the controller: it is display
 * state, it is per-surface, and two search boxes on one workspace should not
 * share a text field. What comes BACK is instance-level ephemeral source state
 * the provider owns, which is why the result arrives through the projection
 * rather than as the promise's value.
 *
 * A hit's snippet is provider-supplied content, so it is text. The `<b>` around
 * the title is this component's own element.
 */

import type { SearchResult, SessionSummary } from "@claude-bot/agent-sessions-contract";
import { titleOf } from "../lib/projection.js";
import { sessionCliKindLabel } from "../lib/cli.js";
import { formatTime } from "../lib/transcript.js";
import { scopedDomId } from "../lib/dom.js";

export interface SessionSearchProps {
  domIdScope?: string;
  query: string;
  result: SearchResult | undefined;
  customTitles?: Readonly<Record<string, string>>;
  onQuery(value: string): void;
  /** First page without a cursor; later pages with the previous page's `nextCursor`. */
  onSubmit(cursor?: string): void;
  onSelect(resourceId: string): void;
  /** Bumped by another surface (the navigator filter) to search the current query now. */
  submitToken?: number;
}

/**
 * The search is complete but paged: each page searches a bounded slice of the
 * history, newest first. The page shown is the one this box asked for (query
 * and cursor), so a late answer for another page never replaces it.
 */
export function SessionSearch(props: SessionSearchProps) {
  const [submitted, setSubmitted] = useState<{ query: string; cursor: string } | null>(null);
  const [previousCursors, setPreviousCursors] = useState<string[]>([]);
  const query = props.query.trim();
  const result = query && submitted?.query === query && props.result?.query?.trim() === query
    && (props.result.cursor ?? "") === submitted.cursor ? props.result : undefined;
  const ask = (cursor: string, previous: string[]): void => {
    if (!query) return;
    setSubmitted({ query, cursor });
    setPreviousCursors(previous);
    props.onSubmit(cursor || undefined);
  };
  const submit = (): void => ask("", []);
  // A query handed over from the navigator filter is an explicit search request.
  const handled = useRef(props.submitToken ?? 0);
  useEffect(() => {
    if (!props.submitToken || props.submitToken === handled.current) return;
    handled.current = props.submitToken;
    submit();
  });
  const hits = result?.results ?? [];
  const more = result?.nextCursor;
  return (
    <div className="searchpane">
      <div className="tools">
        <AvInput
          id={scopedDomId("search", props.domIdScope)}
          type="search"
          value={props.query}
          placeholder="搜索会话正文…"
          aria-label="搜索会话正文"
          onChange={(event) => {
            setSubmitted(null);
            props.onQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <AvButton id={scopedDomId("doSearch", props.domIdScope)} tone="primary" className="primary" disabled={!query} onClick={submit}>搜索</AvButton>
      </div>
      {result?.query ? (
        <div className="results">
          <h2>搜索 “{result.query}” · {previousCursors.length ? `第 ${previousCursors.length + 1} 页 · ` : ""}{hits.length} 条</h2>
          {hits.length ? (
            hits.map((hit) => {
              const session: Partial<SessionSummary> = hit.session ?? {};
              const id = session.resourceId ?? "";
              const customTitle = props.customTitles?.[id];
              return (
                <div
                  className="hit"
                  data-hit={id}
                  key={id}
                  role="button"
                  tabIndex={0}
                  onClick={() => id && props.onSelect(id)}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && id) {
                      event.preventDefault();
                      props.onSelect(id);
                    }
                  }}
                >
                  <b>{titleOf(customTitle ? { ...session, title: customTitle } : session)}</b>
                  <div className="hit-meta">
                    {[session.deviceLabel || session.deviceId, sessionCliKindLabel(session.cliKind, session.accountLabel),
                      formatTime(session.sortActivity || session.lastActivity)].filter(Boolean).join(" · ")}
                  </div>
                  <div className="small">{hit.snippet || hit.preview || hit.text || ""}</div>
                </div>
              );
            })
          ) : (
            <div className="small">{more ? "这一段会话里没有命中。" : previousCursors.length ? "更早的会话里没有命中。" : "没有命中。"}</div>
          )}
          {result.incompleteSources?.length ? (
            <div className="small" role="note">未能完整搜索：{result.incompleteSources.join("、")}</div>
          ) : null}
          {more || previousCursors.length ? (
            <div className="search-pager">
              <AvButton disabled={!previousCursors.length} onClick={() => ask(previousCursors.at(-1) ?? "", previousCursors.slice(0, -1))}>上一页</AvButton>
              <AvButton disabled={!more} onClick={() => more && ask(more, [...previousCursors, submitted?.cursor ?? ""])}>继续搜索更早的会话</AvButton>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
