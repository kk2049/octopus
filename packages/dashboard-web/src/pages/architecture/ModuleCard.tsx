import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { UiButton } from "../../ui-kit/primitives.js";
/**
 * The persistent right rail: a module's profile when one is selected, a flow
 * step's declaration when one is picked in 流程, and the snapshot's totals
 * otherwise. Pure presentation of server facts.
 */

import type { ReactNode } from "react";
import type { ArchFlow, ArchFlowStep, ArchModule } from "../ArchitecturePage.js";
import type { SafeView } from "./model.js";
import { TRUST_LABEL, constraintModules } from "./model.js";
import { CopyButton, SeverityBadge, SourceRef, StatusBadge } from "./bits.js";
import styles from "../ArchitecturePage.module.css";

function Row({ name, children }: { name: string; children: ReactNode }) {
  useDashboardLanguage();
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function MetaCard({ snap }: { snap: SafeView }) {
  useDashboardLanguage();
  const meta = snap.meta;
  return (
    <section className={styles.railCard}>
      <h3 className={styles.railTitle}>{uiText("快照总览")}</h3>
      {!meta && <p className={styles.muted}>{uiText("快照缺少 meta。")}</p>}
      {meta && (
        <dl className={styles.kv}>
          <Row name="commit">
            <span className={styles.mono}>{String(meta.commit ?? "").slice(0, 12) || "—"}</span>
            {meta.dirty && <span className={styles.dirty}>{uiText("未提交")}</span>}
          </Row>
          <Row name={uiText("分支")}>{meta.branch || "—"}</Row>
          <Row name={uiText("文件")}>{meta.totals?.files ?? "—"}</Row>
          <Row name={uiText("代码行")}>{meta.totals?.codeLoc ?? "—"}</Row>
          <Row name={uiText("符号")}>{meta.totals?.symbols ?? "—"}</Row>
          <Row name={uiText("调用")}>{meta.totals?.calls ?? "—"}</Row>
          <Row name={uiText("标注")}>{meta.totals?.annotations ?? "—"}</Row>
          <Row name={uiText("zone / 模块")}>
            {snap.zones.length} / {snap.modules.length}
          </Row>
          <Row name={uiText("依赖 / 流程")}>
            {snap.dependencies.length} / {snap.flows.length}
          </Row>
        </dl>
      )}
      <p className={styles.muted}>{uiText("在总览或依赖剖面点一个模块，这里会显示它的档案。")}</p>
    </section>
  );
}

export function ModuleCard({
  snap,
  module: mod,
  onClose,
}: {
  snap: SafeView;
  module: ArchModule;
  onClose: () => void;
}) {
  useDashboardLanguage();
  const zone = snap.zones.find((z) => z.id === mod.zone);
  // "Which flow steps is it in" is unanswerable from the DTO (steps do not name
  // modules), so the related list is the constraints/findings that call it out.
  const namedBy = snap.constraints.filter((c) => constraintModules(c, [mod]).length > 0);
  const findings = snap.findings.filter((f) => f.moduleIds.includes(mod.id));
  return (
    <section className={styles.railCard}>
      <div className={styles.railHead}>
        <h3 className={styles.railTitle}>{mod.label || mod.id}</h3>
        <UiButton className={styles.railClose} onClick={onClose} aria-label={uiText("取消选中")}>
          ✕
        </UiButton>
      </div>
      {mod.description && <p className={styles.muted}>{mod.description}</p>}
      <p className={styles.rowTitle}>
        {zone && (
          <span className={styles.chip} title={TRUST_LABEL()[zone.trust] ?? zone.trust}>
            {zone.label}
          </span>
        )}
        {!zone && mod.zone && <span className={styles.chip}>{mod.zone}</span>}
        {mod.criticality && (
          <span className={mod.criticality === "critical" ? `${styles.sev} ${styles.sevErr}` : `${styles.sev} ${styles.sevMuted}`}>
            {mod.criticality}
          </span>
        )}
        {mod.tags.map((tag) => (
          <span key={tag} className={styles.chip}>
            {tag}
          </span>
        ))}
      </p>
      <dl className={styles.kv}>
        <Row name={uiText("规模")}>
          {mod.codeLoc} LOC · {mod.files} {uiText(" 文件 · ")}{mod.testFiles} {uiText(" 测试文件")}</Row>
        <Row name={uiText("改动")}>{mod.gitTouches} {uiText(" 次")}</Row>
        <Row name="runtime fan-in / out">
          {mod.runtimeFanIn} / {mod.runtimeFanOut}
        </Row>
        <Row name="type-only fan-in / out">
          {mod.typeOnlyFanIn} / {mod.typeOnlyFanOut}
        </Row>
        <Row name={uiText("标注")}>{mod.annotations}</Row>
      </dl>
      {mod.docs.length > 0 && (
        <div>
          <h4 className={styles.subhead}>{uiText("文档")}</h4>
          {mod.docs.map((doc) => (
            <div key={doc} className={styles.docRow}>
              <span className={styles.mono}>{doc}</span>
              <CopyButton text={doc} />
            </div>
          ))}
        </div>
      )}
      {(namedBy.length > 0 || findings.length > 0) && (
        <div>
          <h4 className={styles.subhead}>{uiText("点名它的条目")}</h4>
          {namedBy.map((constraint) => (
            <div key={constraint.id} className={styles.relRow}>
              <StatusBadge status={constraint.status} />
              <span>{constraint.title}</span>
            </div>
          ))}
          {findings.map((finding, at) => (
            <div key={at} className={styles.relRow}>
              <SeverityBadge severity={finding.severity} />
              <span>{finding.message}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function StepCard({
  flow,
  step,
  onClose,
}: {
  flow: ArchFlow;
  step: ArchFlowStep;
  onClose: () => void;
}) {
  useDashboardLanguage();
  return (
    <section className={styles.railCard}>
      <div className={styles.railHead}>
        <h3 className={styles.railTitle}>{step.label}</h3>
        <UiButton className={styles.railClose} onClick={onClose} aria-label={uiText("关闭步骤详情")}>
          ✕
        </UiButton>
      </div>
      <p className={styles.muted}>
        {flow.title}
        {step.terminal && <span className={styles.chip}>{uiText("终态")}</span>}
      </p>
      {step.description && <p>{step.description}</p>}
      <dl className={styles.kv}>
        <Row name="zone">{step.zone || "—"}</Row>
        {step.role && <Row name={uiText("角色")}>{step.role}</Row>}
        {step.condition && <Row name={uiText("条件")}>{step.condition}</Row>}
        {step.outcome && <Row name={uiText("结果")}>{step.outcome}</Row>}
        {step.authority && <Row name={uiText("授权方")}>{step.authority}</Row>}
        {step.after.length > 0 && (
          <Row name={uiText("前置")}>
            <span className={styles.mono}>{step.after.join(", ")}</span>
          </Row>
        )}
      </dl>
      {step.source && (
        <p>
          <SourceRef source={step.source} />
        </p>
      )}
    </section>
  );
}
