import { AvButton } from "@claude-bot/agent-view-react/ui";
/**
 * The document rail: every document this App's scope was granted, by title.
 *
 * Presentation only. The enumeration itself (one `listDocs` call at mount,
 * refreshed by an explicit button and never by a timer) lives in the module;
 * this component renders whatever state it was given and raises clicks. What
 * a row shows is exactly what the contract's reader let through — an opaque
 * ref it never displays, and a bounded title it does.
 *
 * ── Why an empty rail is one line (ticket #61) ─────────────────────────────
 *
 * The navigation slot is a flow region whose panels share its height, so a
 * standing rail with nothing in it was still claiming a share of the column
 * the directory index needs — an illustrated empty state where a deployment
 * that granted no documents has, by definition, nothing to say. Zero granted
 * documents therefore collapses to the bar alone (which keeps 刷新 reachable,
 * so a grant made after this frame loaded is one click away). A REFUSAL still
 * renders its sentence: "you may not read this" is not the same fact as
 * "there is nothing here", and hiding it would be the panel lying about why
 * it is empty.
 */

import { StatusChip } from "@claude-bot/agent-view-react/ui";
import type { CrdtDocEntry } from "@claude-bot/crdt-doc-contract";

export interface DocListState {
  readonly status: "idle" | "loading" | "ready" | "refused";
  readonly docs: readonly CrdtDocEntry[];
  /** Bounded refusal text the trusted side wrote, when it refused. */
  readonly message: string;
}

export interface DocListProps {
  state: DocListState;
  /** The ref of the document currently on show, for the active marker. */
  activeRef: string | null;
  onOpen(entry: CrdtDocEntry): void;
  onRefresh(): void;
  domIdScope?: string;
}

export function DocList(props: DocListProps) {
  const id = (name: string): string => (props.domIdScope ? `${name}-${props.domIdScope}` : name);
  const { state } = props;

  return (
    <nav className="crdtdocs" id={id("crdtdocs")} aria-label="协作文档">
      <div className="crdtdocs-bar">
        <strong>文档</strong>
        <span className="crdtdocs-tools">
          {state.status === "loading" ? <StatusChip busy word="正在读取最新文档" tone="info" /> : null}
          <AvButton id={id("crdtdocs-refresh")} onClick={props.onRefresh} title="重新读取文档列表">
            刷新
          </AvButton>
        </span>
      </div>

      {state.status === "refused" ? (
        <p className="crdtdocs-note">{state.message || "文档列表现在读不出来。"}</p>
      ) : state.status === "ready" && state.docs.length === 0 ? null : (
        <ul className="crdtdocs-list">
          {state.docs.map((entry) => (
            <li key={entry.doc}>
              <AvButton
                className={entry.doc === props.activeRef ? "crdtdocs-item is-active" : "crdtdocs-item"}
                onClick={() => props.onOpen(entry)}
              >
                <span className="crdtdocs-icon" aria-hidden>
                  📄
                </span>
                <span className="crdtdocs-title">{entry.title || "未命名文档"}</span>
              </AvButton>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
