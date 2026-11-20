import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { UiButton } from "../../ui-kit/primitives.js";
/**
 * Small shared pieces of the architecture page: copy affordance, source
 * references and the badge vocabulary (severity, constraint status, and the
 * three grades of "green" — mechanically verified, consistency-checked,
 * declared-only).
 */

import { useState } from "react";
import type { ArchSource } from "../ArchitecturePage.js";
import styles from "../ArchitecturePage.module.css";

/** mechanismKinds whose PASS the analyzer actually enforced, not just recorded. */
export const MECHANICAL_KINDS = new Set([
  "forbid-dependency",
  "forbid-external",
  "no-cycles",
  "tcb-budget",
]);

export function CopyButton({ text, title = uiText("复制") }: { text: string; title?: string }) {
  useDashboardLanguage();
  const [done, setDone] = useState(false);
  return (
    <UiButton
      className={styles.copy}
      title={title}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => {});
      }}
    >
      {done ? "✓" : uiText("复制")}
    </UiButton>
  );
}

/** `path:line` in mono plus a copy button. Renders nothing without a source. */
export function SourceRef({ source }: { source?: ArchSource | null }) {
  if (!source || !source.path) return null;
  const text = `${source.path}:${source.line}`;
  return (
    <span className={styles.srcRef}>
      <span className={styles.mono}>{text}</span>
      <CopyButton text={text} />
    </span>
  );
}

function severityClass(severity: string): string {
  const s = (severity || "").toLowerCase();
  if (["critical", "error", "high", "fatal", "blocker"].includes(s)) return styles.sevErr;
  if (["warn", "warning", "medium", "moderate"].includes(s)) return styles.sevWarn;
  return styles.sevMuted;
}

export function SeverityBadge({ severity }: { severity: string }) {
  if (!severity) return null;
  return <span className={`${styles.sev} ${severityClass(severity)}`}>{severity}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const s = (status || "").toLowerCase();
  const cls = s === "pass" ? styles.stPass : s === "fail" ? styles.stFail : styles.stReview;
  return <span className={`${styles.sev} ${cls}`}>{status || "?"}</span>;
}

/**
 * The three grades of assurance, visually distinct on purpose:
 *  · 机械验证 — solid badge: the analyzer enforced this class of constraint.
 *  · 一致性检查 — hollow badge: flow-completeness cross-checks, weaker.
 *  · 声明性 — dashed muted badge: a human wrote it down; nothing checked it.
 */
export function VerifyBadge({ mechanismKind }: { mechanismKind: string | null }) {
  useDashboardLanguage();
  if (mechanismKind === null) {
    return <span className={`${styles.verify} ${styles.vDecl}`}>{uiText("声明性")}</span>;
  }
  if (MECHANICAL_KINDS.has(mechanismKind)) {
    return (
      <span className={`${styles.verify} ${styles.vSolid}`} title={mechanismKind}>
        {uiText("机械验证")}</span>
    );
  }
  if (mechanismKind === "flow-complete") {
    return (
      <span className={`${styles.verify} ${styles.vHollow}`} title={mechanismKind}>
        {uiText("一致性检查")}</span>
    );
  }
  return <span className={`${styles.verify} ${styles.vHollow}`}>{mechanismKind}</span>;
}
