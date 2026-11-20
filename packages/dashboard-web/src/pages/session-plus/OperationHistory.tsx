import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText, localizedLabels } from "../../i18n/ui-text.js";
import styles from "../SessionPlusPage.module.css";

const HISTORY_LIMIT = 20;

const STATUS_WORDS = localizedLabels((): Readonly<Record<string, string>> => (Object.freeze({
  submitted: uiText("已提交"),
  waiting_approval: uiText("等待批准"),
  running: uiText("运行中"),
  succeeded: uiText("已完成"),
  failed: uiText("失败"),
  rejected: uiText("已拒绝"),
  unknown: uiText("结果未知"),
  reconnecting: uiText("重新连接中"),
  waiting_resource: uiText("等待运行环境"),
})));

export interface SessionPlusOperationRow {
  id: string;
  operation: string;
  status: string;
  message: string;
  detail: string;
  recovery?: "reconnecting" | "waiting_resource";
}

/** Defensive, bounded copy of the server-authored operation display fields. */
export function sessionPlusOperationRow(value: unknown): SessionPlusOperationRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const recovery = source.recovery && typeof source.recovery === "object"
    ? (source.recovery as Record<string, unknown>).state : undefined;
  const row: SessionPlusOperationRow = {
    id: boundedText(source.id, 128),
    operation: boundedText(source.operation, 128),
    status: boundedText(source.status, 64),
    message: boundedText(source.message, 500),
    detail: boundedText(source.detail, 1_000),
    ...(recovery === "reconnecting" || recovery === "waiting_resource" ? { recovery } : {}),
  };
  return Object.values(row).some(Boolean) ? row : null;
}

/** Newest event first; later status for one operation replaces its old row. */
export function recordSessionPlusOperation(
  current: readonly SessionPlusOperationRow[],
  value: unknown,
): SessionPlusOperationRow[] {
  const next = sessionPlusOperationRow(value);
  if (!next) return [...current];
  const key = operationKey(next);
  return [next, ...current.filter((row) => operationKey(row) !== key)].slice(0, HISTORY_LIMIT);
}

export function OperationHistory({ operations }: { operations: readonly SessionPlusOperationRow[] }) {
  useDashboardLanguage();
  return (
    <details className={styles.operationDetails}>
      <summary>{uiText("历史动作 ")}<span className={styles.operationCount}>{operations.length}</span></summary>
      {operations.length ? (
        <div className={styles.operationList}>
          {operations.map((row, index) => (
            <article className={styles.operationRow} key={`${operationKey(row)}:${index}`}>
              <span className={styles.operationStatus} data-status={row.recovery ?? row.status}>
                {(STATUS_WORDS()[row.recovery ?? row.status] ?? row.status) || uiText("未知")}
              </span>
              <div className={styles.operationBody}>
                <div className={styles.operationMessage}>{row.message || row.operation || uiText("未命名动作")}</div>
                {row.operation ? <code>{row.operation}</code> : null}
                {row.detail ? <div className={styles.operationDetail}>{row.detail}</div> : null}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className={styles.operationEmpty}>{uiText("本页尚无历史动作。")}</p>
      )}
    </details>
  );
}

function operationKey(row: SessionPlusOperationRow): string {
  return row.id || `${row.operation}\u0000${row.message}`;
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, max)
    : "";
}
