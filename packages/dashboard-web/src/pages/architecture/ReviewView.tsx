import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { UiButton } from "../../ui-kit/primitives.js";
/**
 * 剖面 1 · 审阅 — the entry view. Constraints grouped by verdict with the
 * failures expanded first, then the findings list. The verdicts themselves are
 * the server's; this view only sorts and links them to the other cuts.
 */

import type { ArchConstraint } from "../ArchitecturePage.js";
import type { SafeView } from "./model.js";
import { constraintModules } from "./model.js";
import { SeverityBadge, SourceRef, StatusBadge, VerifyBadge } from "./bits.js";
import styles from "../ArchitecturePage.module.css";

const LINKABLE_KINDS = new Set(["forbid-dependency", "no-cycles"]);

function FailCard({ constraint }: { constraint: ArchConstraint }) {
  useDashboardLanguage();
  return (
    <section className={styles.failCard}>
      <div className={styles.rowTitle}>
        <strong>{constraint.title}</strong>
        <SeverityBadge severity={constraint.severity} />
        <VerifyBadge mechanismKind={constraint.mechanismKind} />
        <StatusBadge status={constraint.status} />
      </div>
      {constraint.description && <p className={styles.muted}>{constraint.description}</p>}
      {constraint.summary && <p className={styles.muted}>{constraint.summary}</p>}
      <ul className={styles.violations}>
        {constraint.violations.map((violation, at) => (
          <li key={at} className={styles.violation}>
            <span>{violation.message}</span>
            <SourceRef source={violation.source} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReviewView({
  snap,
  onShowInDeps,
  onJumpToModule,
}: {
  snap: SafeView;
  onShowInDeps: (ids: string[]) => void;
  onJumpToModule: (id: string) => void;
}) {
  useDashboardLanguage();
  const fails = snap.constraints.filter((c) => c.status === "fail");
  const passes = snap.constraints.filter((c) => c.status === "pass");
  const reviews = snap.constraints.filter((c) => c.status !== "fail" && c.status !== "pass");

  return (
    <div>
      <section className={styles.card}>
        <h3>
          {uiText("约束 ")}<span className={styles.muted}>
            {fails.length} {uiText(" 失败 · ")}{reviews.length} {uiText(" 待审 · ")}{passes.length} {uiText(" 通过")}</span>
        </h3>

        {fails.length === 0 && <p className={styles.muted}>{uiText("没有失败的约束。")}</p>}
        {fails.map((constraint) => (
          <div key={constraint.id}>
            <FailCard constraint={constraint} />
            {LINKABLE_KINDS.has(constraint.mechanismKind ?? "") && (
              <p className={styles.failActions}>
                <UiButton
                  onClick={() => onShowInDeps(constraintModules(constraint, snap.modules))}
                >
                  {uiText("在依赖图中查看")}</UiButton>
              </p>
            )}
          </div>
        ))}

        {reviews.length > 0 && (
          <div className={styles.reviewList}>
            <h4 className={styles.subhead}>{uiText("待人工审阅")}</h4>
            {reviews.map((constraint) => (
              <details key={constraint.id} className={styles.reviewRow}>
                <summary>
                  <span className={styles.rowTitle}>
                    <span>{constraint.title}</span>
                    <SeverityBadge severity={constraint.severity} />
                    <VerifyBadge mechanismKind={constraint.mechanismKind} />
                    {constraint.violations.length > 0 && (
                      <span className={styles.muted}>{constraint.violations.length} {uiText(" 条待核对")}</span>
                    )}
                  </span>
                </summary>
                {constraint.description && <p className={styles.muted}>{constraint.description}</p>}
                {constraint.summary && <p className={styles.muted}>{constraint.summary}</p>}
                {constraint.violations.length > 0 && (
                  <ul className={styles.violations}>
                    {constraint.violations.map((violation, at) => (
                      <li key={at} className={styles.violation}>
                        <span>{violation.message}</span>
                        <SourceRef source={violation.source} />
                      </li>
                    ))}
                  </ul>
                )}
                {constraint.evidence.length > 0 && (
                  <ul className={styles.violations}>
                    {constraint.evidence.map((ev, at) => (
                      <li key={at} className={styles.violation}>
                        <span className={styles.muted}>
                          [{ev.grade}] {ev.label}
                        </span>
                        <SourceRef source={ev.source} />
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            ))}
          </div>
        )}

        {passes.length > 0 && (
          <div className={styles.passStrip}>
            <h4 className={styles.subhead}>{uiText("已通过")}</h4>
            <div className={styles.passBadges}>
              {passes.map((constraint) => (
                <span key={constraint.id} className={styles.passItem} title={constraint.summary || constraint.description}>
                  <VerifyBadge mechanismKind={constraint.mechanismKind} />
                  <span>{constraint.title}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className={styles.card}>
        <h3>{uiText("观察信号")}</h3>
        {snap.findings.length === 0 && <p className={styles.muted}>{uiText("本快照没有观察信号。")}</p>}
        {snap.findings.map((finding, at) => (
          <div key={at} className={styles.findingRow}>
            <SeverityBadge severity={finding.severity} />
            {finding.signal && <span className={styles.mono}>{finding.signal}</span>}
            <span className={styles.findingMsg}>{finding.message}</span>
            {finding.moduleIds.map((id) => (
              <UiButton key={id} className={styles.chipBtn} onClick={() => onJumpToModule(id)}>
                {id}
              </UiButton>
            ))}
            <SourceRef source={finding.source} />
          </div>
        ))}
      </section>
    </div>
  );
}
