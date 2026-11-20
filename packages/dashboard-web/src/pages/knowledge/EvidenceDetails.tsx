import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { UiTag } from "../../ui-kit/primitives.js";
import type { WikiStatement } from "./types.js";
import styles from "../KnowledgePage.module.css";

export function StrengthTag({ item }: { item: WikiStatement }) {
  useDashboardLanguage();
  const strength = item.detail.strength ?? "agent_inferred";
  return <UiTag tone={strength === "human_required" ? "warning" : strength === "human_reviewed" ? "info" : "neutral"}>
    {strength === "human_required" ? uiText("用户原始／强制要求") : strength === "human_reviewed" ? uiText("人类明确审阅") : uiText("Agent 判断／人类证据未核实")}
  </UiTag>;
}

export function EvidenceDetails({ item }: { item: WikiStatement }) {
  useDashboardLanguage();
  const p = item.detail.provenance;
  return <div className={styles.evidenceDetails}>
    <StrengthTag item={item} />
    <p><b>{uiText("原始动机")}</b> {item.detail.rationale || uiText("原始动机尚未调查，不能从检测规则推断。")}</p>
    <p><b>{uiText("逐字依据")}</b> {item.detail.quote ? <q>{item.detail.quote}</q> : uiText("暂无逐字依据")}</p>
    <p><b>{uiText("记录作者")}</b> {p ? `${p.author.name} · ${p.author.kind}` : uiText("未知")}</p>
    <p><b>{uiText("决策模型")}</b> {p?.author.model ?? uiText("未知；不从当前工单模型倒推")}</p>
    {p?.critical && <p role="note">{uiText("关键设计待明确审阅")}: {p.critical}</p>}
    {!!p?.basis.length && <details><summary>{uiText("推断所依据的来源")}</summary><ul>{p.basis.map((ref) => <li key={ref}>{ref}</li>)}</ul></details>}
    {!!p?.events.length && <details open><summary>{uiText("历史提问与背书证据")}</summary><ol>{p.events.map((event, index) => <li key={`${event.ref}:${index}`}>
      <b>{event.actor}</b> · <time dateTime={event.at}>{event.at.slice(0, 16).replace("T", " ")}</time> · {event.kind}<p><q>{event.quote}</q></p><small>{event.ref}</small>
    </li>)}</ol></details>}
  </div>;
}
