/**
 * What all three modules say when there is no deck to show.
 *
 * One component because all three have to say the same four things — waiting,
 * wrong path, wrong shape, ready — and three copies of that reasoning is three
 * places for the "invalid" case to quietly become "empty".
 *
 * The invalid case prints the reader's own diagnostics. They are bounded and
 * field-named by construction, and they are the only thing that tells an App
 * author which key of which slide their backend got wrong.
 */

import type { ContractIssue } from "@claude-bot/deck-model-contract";
import type { DeckSourceStatus } from "../lib/deck-source.js";

export interface SourceNoticeProps {
  status: DeckSourceStatus;
  /** The configured projection path, quoted back when it does not resolve. */
  source: string;
  issues: readonly ContractIssue[];
  /** No projection has arrived yet — checked before `status`. */
  booting: boolean;
}

/**
 * Whether there is a reason not to render content.
 *
 * A predicate rather than "call the component and check for null": a JSX element
 * is truthy even when the component returns null, so `element ?? content` always
 * picks the element. That mistake renders a header and nothing else, which is
 * exactly the silent-empty failure this component exists to prevent.
 */
export function sourceIsBlocked(status: DeckSourceStatus, booting: boolean): boolean {
  return booting || status !== "ok";
}

/** `null` when there is nothing to say — guard with `sourceIsBlocked` first. */
export function SourceNotice({ status, source, issues, booting }: SourceNoticeProps) {
  if (booting) {
    return <p className="dkv-note" role="note">⏳ 正在等待第一份投影…</p>;
  }
  if (status === "missing") {
    return (
      <p className="dkv-note" role="note">
        这个组合指向的 deck 不存在：<code>{source}</code>
      </p>
    );
  }
  if (status === "invalid") {
    return (
      <div className="dkv-note" role="note">
        <p>
          <code>{source}</code> 上的数据不是一份 <code>deck-model/v1</code> 文档：
        </p>
        <ul className="dkv-issues">
          {issues.slice(0, 6).map((issue, index) => (
            <li key={`${issue.code}-${issue.at ?? index}`}>
              <code>{issue.at ?? "deck"}</code> · {issue.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}
