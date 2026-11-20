/**
 * The small shared pieces every page needs: a spinner, a status line, an inline
 * error, a loading placeholder, a single-flight guard and a labelled field.
 *
 * They live together because each is a handful of lines and because the point
 * of extracting them is that the panel has ONE spinner and ONE way of saying
 * "that failed" — the hand-built pages had four of each and they did not agree
 * on whether a failure was red text, an `alert()` or a silently empty node.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { UiSkeleton } from "../ui-kit/primitives.js";
import { useMessages } from "../i18n/react.js";
import styles from "./misc.module.css";

/** Indeterminate progress. Hidden from assistive tech; the text beside it wins. */
export function Spinner() {
  return <span className={styles.spin} aria-hidden="true" />;
}

/** The animated ellipsis used next to "正在思考". */
export function Dots() {
  return (
    <span className={styles.dots} aria-hidden="true">
      <i>.</i>
      <i>.</i>
      <i>.</i>
    </span>
  );
}

export type StatusKind = "muted" | "ok" | "err";

/**
 * A polite live region. Every transient "已保存 / 提交中… / ✖ 失败" on the panel
 * goes through this, so screen readers are told about outcomes that previously
 * only existed as a colour change.
 */
export function Status({ kind = "muted", children }: { kind?: StatusKind; children?: ReactNode }) {
  return (
    <span className={`${styles.status} ${styles[kind]}`} role="status" aria-live="polite">
      {children}
    </span>
  );
}

/** A failure with its own box, for panes where the whole content is missing. */
export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className={styles.errorBox} role="alert">
      {children}
    </div>
  );
}

/** A refresh failed after data had already rendered; keep that data mounted. */
export function StaleDataBanner({
  message,
  dataUpdatedAt,
}: {
  message: string;
  dataUpdatedAt: number;
}) {
  const { t } = useMessages();
  const at = new Date(dataUpdatedAt);
  const time = Number.isNaN(at.getTime())
    ? t("common.unknownTime")
    : `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return (
    <ErrorBox>
      {t("common.refreshFailed", { time, message })}
    </ErrorBox>
  );
}

/** "读取中…" — a placeholder that says which thing is loading. */
export function Loading({ what }: { what?: string }) {
  const { t } = useMessages();
  return (
    <div className={styles.loading} role="status">
      <span>{what ?? t("common.loading")}</span>
      <UiSkeleton title={false} paragraph={{ rows: 2 }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

/**
 * A counter that ticks once a second while `active`.
 *
 * Returns `Date.now()` so callers can derive elapsed/silence values that are a
 * function of NOW. The transcript activity strip is only honest if it is
 * re-evaluated on every tick — the first version of it derived a state once and
 * counted upward forever, so a finished session kept claiming to be running.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [active, intervalMs]);
  return now;
}

/**
 * Single-flight around an async action.
 *
 * Every mutation on this panel is non-idempotent — append runs a CLI on
 * somebody's laptop, approve executes a frozen call, deploy restarts the bot.
 * A double click must not produce two of them, and the guard belongs next to
 * the action rather than in each button's `disabled` bookkeeping.
 */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  const running = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (...args: A) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await fnRef.current(...args);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return [run, busy] as const;
}

/** A labelled field wrapper so forms stop hand-pairing `for`/`id`. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {children(id, hintId)}
      {error ? (
        <div id={hintId} className={styles.fieldError} role="alert">
          {error}
        </div>
      ) : hint ? (
        <div id={hintId} className={styles.fieldHint}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
