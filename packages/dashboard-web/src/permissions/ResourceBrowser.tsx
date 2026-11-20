import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, localizedLabels } from "../i18n/ui-text.js";
import { useMemo, useState } from "react";
import type { PermissionStudioPermit, PermissionStudioProjection } from "../contract.js";
import { UiButton, UiInput, UiTag } from "../ui-kit/primitives.js";
import { buildResourceTree, nodeAncestors, type ResourceTreeNode } from "./resource-tree.js";
import styles from "./ResourceBrowser.module.css";

const MODES = localizedLabels(() => ({ allow: uiText("允许"), ask: uiText("需批准"), deny: uiText("未授予"), block: uiText("阻止") }));
const HOLDERS = localizedLabels(() => ({ user: uiText("用户"), app: uiText("应用"), agent: "Agent", service: uiText("服务"), organization: uiText("组织"), workspace: uiText("工作区"), credential: uiText("凭据") }));
const EXECUTION = localizedLabels(() => ({
  enforced: uiText("执行时校验"), "intent-only": uiText("仅授权意图"), compatibility: uiText("兼容授权"), unenforced: uiText("未接入执行"),
}));

export function ResourceBrowser({ projection, onOpen }: {
  projection: PermissionStudioProjection;
  onOpen: (permit: PermissionStudioPermit) => void;
}) {
  const language = useDashboardLanguage();
  const defaults = new Set(projection.appDefaults.permits.map((permit) => permit.resourceId));
  const resources = projection.resources.filter((resource) => !defaults.has(resource.id));
  const nodes = useMemo(() => buildResourceTree(
    projection.resources.filter((resource) => !projection.appDefaults.permits.some((p) => p.resourceId === resource.id)),
    projection.aliases,
  ), [projection, language]);
  const [parentUri, setParentUri] = useState<string | null>(null);
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const selected = selectedUri ? nodes.get(selectedUri) : undefined;
  const parent = parentUri ? nodes.get(parentUri) : undefined;
  const roots = [...nodes.values()].filter((node) => node.parent === null);
  const needle = search.trim().toLocaleLowerCase();
  const visible = needle
    ? [...nodes.values()].filter((node) => (node.resources.length || node.alias) &&
      `${node.uri} ${node.resources.map((r) => r.title).join(" ")}`.toLocaleLowerCase().includes(needle))
    : parent ? parent.children.map((uri) => nodes.get(uri)!) : parentUri ? [] : roots;
  const path = nodeAncestors(nodes, parentUri);
  const holders = new Map(projection.holders.map((holder) => [holder.id, holder]));
  const domains = new Map(projection.domains.map((domain) => [domain.id, domain]));
  const choose = (node: ResourceTreeNode) => {
    setSelectedUri(node.uri);
    if (needle) { setParentUri(node.parent); setSearch(""); }
  };
  const enter = (node: ResourceTreeNode) => {
    setParentUri(node.uri);
    setSelectedUri(null);
    setSearch("");
  };
  const row = (node: ResourceTreeNode, next = false) => (
    <li key={node.uri}>
      <button type="button" className={styles.node} aria-pressed={selectedUri === node.uri}
        title={node.uri} onClick={() => { if (next) setParentUri(node.parent); choose(node); }}>
        <span aria-hidden="true" className={styles.icon}>{node.alias ? "↗" : node.children.length ? "▸" : "·"}</span>
        <span className={styles.nodeText}><strong>{node.resources[0]?.title ?? node.label}</strong>
          <small>{node.alias ? uiText("软链接") : node.resources.length ? node.label : uiText("{v0} 个子项", { v0: node.children.length })}</small></span>
        {node.children.length ? <span aria-hidden="true">›</span> : null}
      </button>
    </li>
  );
  return (
    <div className={styles.browser} data-testid="permission-resource-browser">
      <div className={styles.toolbar}>
        <div><strong>{uiText("权限树")}</strong><span className={styles.muted}> {resources.length} {uiText(" 个资源 · ")}{projection.aliases.length} {uiText(" 个软链接")}</span></div>
        <UiInput aria-label={uiText("搜索资源或 URL")} placeholder={uiText("搜索资源或 URL")} value={search}
          onChange={(event) => setSearch(event.target.value)} />
      </div>
      <nav className={styles.breadcrumbs} aria-label={uiText("权限树路径")}>
        <UiButton size="small" tone="quiet" onClick={() => { setParentUri(null); setSelectedUri(null); setSearch(""); }}>{uiText("全部资源")}</UiButton>
        {path.map((node) => <UiButton key={node.uri} size="small" tone="quiet" onClick={() => enter(node)}>› {node.label}</UiButton>)}
      </nav>
      <div className={`${styles.columns} ${selected?.children.length ? styles.withPreview : ""}`}>
        <section className={styles.column} aria-label={uiText("当前目录")}>
          <div className={styles.columnHeading}>
            <strong>{needle ? uiText("搜索结果") : parent?.label ?? uiText("一级目录")}</strong>
            {parentUri ? <UiButton size="small" onClick={() => { setParentUri(parent?.parent ?? null); setSelectedUri(parentUri); }}>{uiText("上一级")}</UiButton> : null}
          </div>
          <ul className={styles.nodeList}>{visible.map((node) => row(node))}</ul>
          {!visible.length ? <p className={styles.empty}>{parentUri && !parent ? uiText("此目录暂不在当前投影中，可返回上一级。") : needle ? uiText("没有匹配的资源") : uiText("当前没有可展示的资源")}</p> : null}
        </section>
        <section className={`${styles.column} ${styles.nextColumn}`} aria-label={uiText("下一级目录")}>
          <div className={styles.columnHeading}><strong>{selected?.children.length ? selected.label : uiText("下一级")}</strong></div>
          <ul className={styles.nodeList}>{selected?.children.map((uri) => row(nodes.get(uri)!, true))}</ul>
          {!selected?.children.length ? <p className={styles.empty}>{selected ? uiText("没有下级目录") : uiText("选择左侧目录继续浏览")}</p> : null}
        </section>
        <section className={styles.inspector} aria-label={uiText("资源授权详情")}>
          {!selected ? <p className={styles.empty}>{selectedUri ? uiText("所选资源暂不在当前投影中，选择已保留。") : uiText("选择资源，查看授予了谁、允许哪些操作及原因。")}</p> : <>
            <h3>{selected.resources[0]?.title ?? selected.label}</h3>
            <code className={styles.uri}>{selected.uri}</code>
            {selected.children.length ? <UiButton className={styles.enter} onClick={() => enter(selected)}>{uiText("进入目录")}</UiButton> : null}
            {selected.alias ? <div className={styles.detailCard}>
              <strong>{uiText("软链接目标")}</strong><code className={styles.uri}>{selected.alias.targetUri}</code>
              {nodes.has(selected.alias.targetUri) ? <UiButton onClick={() => {
                const target = nodes.get(selected.alias!.targetUri)!;
                setParentUri(target.parent); setSelectedUri(target.uri);
              }}>{uiText("查看目标")}</UiButton> : <p className={styles.muted}>{uiText("目标未包含在当前可见资源中。")}</p>}
              <p className={styles.muted}>{uiText("软链接不改变已有授权，许可仍绑定目标资源。")}</p>
            </div> : null}
            {!selected.resources.length && !selected.alias ? <p className={styles.muted}>{uiText("此层用于组织资源。选择下级资源查看具体授权。")}</p> : null}
            {selected.resources.map((resource) => {
              const permits = projection.permits.filter((permit) => permit.resourceId === resource.id);
              const holderIds = [...new Set(permits.map((permit) => permit.holderId))];
              const policies = projection.policies.filter((policy) => policy.resourceId === resource.id);
              return <div key={resource.id}>
                <div className={styles.meta}><UiTag>{EXECUTION()[resource.enforcement]}</UiTag><span>{domains.get(resource.domainId)?.title ?? resource.domainId}</span></div>
                <p className={styles.muted}>{uiText("管理方：")}{resource.authorityLabel} {uiText(" · 来源：")}{resource.sourceSystem}</p>
                {resource.description ? <p>{resource.description}</p> : null}
                <h4>{uiText("授权对象 · ")}{holderIds.length}</h4>
                {!holderIds.length ? <p className={styles.muted} title={projection.emptyCell.explanation}>{projection.emptyCell.label}</p> : null}
                {holderIds.map((id) => <article className={styles.detailCard} key={id}>
                  <strong>{holders.get(id)?.title ?? id}</strong>{holders.get(id) ? <UiTag>{HOLDERS()[holders.get(id)!.kind]}</UiTag> : null}
                  {permits.filter((permit) => permit.holderId === id).map((permit) => <button key={permit.id} type="button" className={styles.permit}
                    aria-label={`${resource.title} / ${holders.get(id)?.title ?? id} / ${permit.operationLabel}: ${permit.verdict}`}
                    onClick={() => onOpen(permit)}>
                    <span>{permit.operationLabel} <UiTag>{MODES()[permit.mode as keyof ReturnType<typeof MODES>] ?? permit.mode}</UiTag></span>
                    <small>{permit.verdict}</small><span className={styles.inspectLink}>{uiText("查看原因")}{permit.editable ? uiText("与设置") : ""} ›</span>
                  </button>)}
                </article>)}
                {policies.length ? <details className={styles.rules}><summary>{uiText("条件与规则 · ")}{policies.length}</summary>
                  {policies.map((policy) => <article className={styles.detailCard} key={policy.id}>
                    <strong>{policy.title}</strong><p>{policy.condition ? uiText("待运行时求值") : uiText("已配置规则")} · {policy.effect}</p>
                    <p>{policy.subjectSelector} · {policy.operationSelector}</p>
                    {policy.condition ? <p>{policy.condition}</p> : null}
                    {policy.mandatory ? <UiTag tone="danger">{uiText("强制规则")}</UiTag> : null}
                    <p>{policy.authorityLabel} · {EXECUTION()[policy.enforcement]}</p><p>{policy.verdict}</p>
                    <details><summary>{uiText("查看规则解释")}</summary>{policy.explanation.steps.map((step, index) => <p key={`${step.stage}:${index}`}><b>{step.title}</b>：{step.detail}</p>)}</details>
                  </article>)}
                </details> : null}
              </div>;
            })}
          </>}
        </section>
      </div>
    </div>
  );
}
