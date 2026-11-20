import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText, localizedLabels } from "../../i18n/ui-text.js";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import type { ArchModuleEcosystem } from "../ArchitecturePage.js";
import { CopyButton, SourceRef } from "./bits.js";
import {
  ecosystemEdgeKey,
  layoutModuleEcosystem,
  type EcosystemBox,
} from "./module-ecosystem.js";
import { FrontendModuleDemo } from "./FrontendModuleDemo.js";
import styles from "../ArchitecturePage.module.css";

function compactPackage(id: string): string {
  return id.replace(/^@claude-bot\//, "");
}

function clipped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function edgePath(from: EcosystemBox, to: EcosystemBox): string {
  const sy = from.y + from.h / 2;
  const ty = to.y + to.h / 2;
  if (to.x > from.x + from.w) {
    const sx = from.x + from.w;
    const tx = to.x;
    const bend = Math.max(28, Math.min(86, (tx - sx) / 2));
    return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
  }
  const sx = from.x + from.w;
  const tx = to.x + to.w;
  const loop = Math.max(sx, tx) + 34;
  return `M ${sx} ${sy} C ${loop} ${sy}, ${loop} ${ty}, ${tx} ${ty}`;
}

/** SVG uses width/height attributes; the layout model deliberately uses w/h. */
function rectProps(box: EcosystemBox): { x: number; y: number; width: number; height: number } {
  return { x: box.x, y: box.y, width: box.w, height: box.h };
}

function onKeyboardActivate(event: KeyboardEvent<SVGGElement>, action: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

const SLOT_LABEL = localizedLabels((): Readonly<Record<string, string>> => ({
  navigation: uiText("导航区"),
  primary: uiText("主工作区"),
  secondary: uiText("辅助工作区"),
  bottom: uiText("底部状态区"),
  overlay: uiText("浮层工作区"),
}));

function slotList(slots: string[]): string {
  return slots.map((slot) => SLOT_LABEL()[slot] ?? slot).join("、") || uiText("未声明");
}

function DetailRows({ title, items }: { title: string; items: ReactNode[] }) {
  useDashboardLanguage();
  if (items.length === 0) return null;
  return (
    <div className={styles.moduleDetailSection}>
      <h5>{title}</h5>
      <ul>{items.map((item, at) => <li key={at}>{item}</li>)}</ul>
    </div>
  );
}

export function ModuleEcosystemView({ ecosystem }: { ecosystem: ArchModuleEcosystem }) {
  useDashboardLanguage();
  const layout = useMemo(() => layoutModuleEcosystem(ecosystem), [ecosystem]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const visibleEdges = useMemo(
    () => ecosystem.dependencies.filter((edge) => layout.boxes.has(edge.from) && layout.boxes.has(edge.to)),
    [ecosystem.dependencies, layout.boxes],
  );
  const picked = selectedEdge ? visibleEdges.find((edge) => ecosystemEdgeKey(edge) === selectedEdge) ?? null : null;
  const selectedFrontend = layout.frontend.flatMap((group) => group.modules).find((entry) => entry.key === selectedNode);
  const selectedContract = layout.contracts.find((entry) => entry.key === selectedNode);
  const selectedBackend = layout.backend.find((entry) => entry.key === selectedNode);
  const connected = useMemo(() => {
    if (!selectedNode) return null;
    return new Set(visibleEdges.flatMap((edge) => edge.from === selectedNode || edge.to === selectedNode ? [edge.from, edge.to] : []));
  }, [selectedNode, visibleEdges]);

  const selectNode = (key: string) => {
    setSelectedNode(selectedNode === key ? null : key);
    setSelectedEdge(null);
  };

  if (ecosystem.frontend.length === 0 && ecosystem.contracts.length === 0 && ecosystem.backend.length === 0) {
    return (
      <section className={styles.card}>
        <h3>{uiText("前端 / 后端模组")}</h3>
        <p className={styles.muted}>{uiText("这份快照还没有模组目录；点页面右上角「重新分析」即可从当前源码自动生成。")}</p>
      </section>
    );
  }

  return (
    <div>
      <section className={styles.card}>
        <div className={styles.moduleEcosystemHead}>
          <div>
            <h3>{uiText("可组合模块生态")}</h3>
            <p className={styles.muted}>
              {ecosystem.frontend.length} {uiText(" 个 View 模组 · ")}{ecosystem.contracts.length} {uiText(" 个 typed contract · ")}{ecosystem.backend.length} {uiText(" 个可信 Provider")}</p>
          </div>
          <div className={styles.moduleLegend} aria-label={uiText("模组拓扑图例")}>
            <span><i className={styles.legendFrontend} />{uiText("View 模组")}</span>
            <span><i className={styles.legendContract} />{uiText("兼容契约")}</span>
            <span><i className={styles.legendBackend} />{uiText("可信 Provider")}</span>
            <span><i className={styles.legendPortEdge} />{uiText("需要 / 实现")}</span>
          </div>
        </div>
        <p className={styles.moduleDirection}>{uiText("箭头表示 View → contract → Provider；平台底座不在图中。")}</p>
        <div className={styles.moduleEcosystemGrid}>
          <div className={styles.moduleSvgWrap}>
            <svg width={layout.width} height={layout.height} role="img" aria-label={uiText("View 模组、类型契约与可信 Provider 的拓扑依赖图")}>
              <defs>
                <marker id="arch-module-arrow" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
                  <path d="M0,0 L9,3.5 L0,7 z" fill="var(--line-strong)" />
                </marker>
                <marker id="arch-module-arrow-port" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
                  <path d="M0,0 L9,3.5 L0,7 z" fill="var(--accent)" />
                </marker>
                <marker id="arch-module-arrow-cycle" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
                  <path d="M0,0 L9,3.5 L0,7 z" fill="var(--err)" />
                </marker>
              </defs>

              <text x={16} y={24} className={styles.moduleColumnTitle}>{uiText("1 · VIEW 模组")}</text>
              <text x={layout.contracts[0]?.box.x ?? 380} y={24} className={styles.moduleColumnTitle}>{uiText("2 · 类型契约")}</text>
              <text x={layout.backend[0]?.box.x ?? 704} y={24} className={styles.moduleColumnTitle}>{uiText("3 · 可信 PROVIDER")}</text>

              {visibleEdges.map((edge) => {
                const from = layout.boxes.get(edge.from)!;
                const to = layout.boxes.get(edge.to)!;
                const key = ecosystemEdgeKey(edge);
                const cycle = layout.cyclicEdges.has(key);
                const selected = selectedEdge === key;
                const dimmed = Boolean((selectedNode && edge.from !== selectedNode && edge.to !== selectedNode) || (selectedEdge && !selected));
                const semantic = edge.kind === "requires" || edge.kind === "provides";
                const className = cycle ? styles.moduleEdgeCycle : semantic ? styles.moduleEdgePort : styles.moduleEdge;
                const marker = cycle ? "url(#arch-module-arrow-cycle)" : semantic ? "url(#arch-module-arrow-port)" : "url(#arch-module-arrow)";
                const d = edgePath(from, to);
                return (
                  <g key={key} className={dimmed ? styles.moduleDim : ""}>
                    <path d={d} className={`${className} ${selected ? styles.moduleEdgeSelected : ""}`} markerEnd={marker} />
                    <path
                      d={d}
                      className={styles.edgeHit}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={12}
                      onClick={() => { setSelectedEdge(selected ? null : key); setSelectedNode(null); }}
                    >
                      <title>{edge.from} → {edge.to} · {edge.label}</title>
                    </path>
                  </g>
                );
              })}

              {layout.frontend.map((group) => (
                <g key={group.packageId} className={connected && !group.modules.some((entry) => connected.has(entry.key)) ? styles.moduleDim : ""}>
                  <rect {...rectProps(group.box)} rx={9} className={styles.frontendGroupBox} />
                  <text x={group.box.x + 10} y={group.box.y + 19} className={styles.frontendGroupTitle}>
                    {clipped(compactPackage(group.packageId), 34)}
                  </text>
                  {group.modules.map(({ module, key, box }) => {
                    const selected = selectedNode === key;
                    return (
                      <g
                        key={key}
                        role="button"
                        tabIndex={0}
                        aria-label={uiText("前端模组 {v0}", { v0: module.title })}
                        className={styles.moduleNode}
                        onClick={() => selectNode(key)}
                        onKeyDown={(event) => onKeyboardActivate(event, () => selectNode(key))}
                      >
                        <rect {...rectProps(box)} rx={6} className={`${styles.frontendModuleBox} ${selected ? styles.moduleNodeSelected : ""}`} />
                        <text x={box.x + 9} y={box.y + 14} className={styles.frontendModuleTitle}>{clipped(module.title, 22)}</text>
                        <text x={box.x + 9} y={box.y + 27} className={styles.frontendModuleId}>{clipped(module.id, 36)}</text>
                        <title>{module.summary}</title>
                      </g>
                    );
                  })}
                </g>
              ))}

              {layout.contracts.map(({ module, key, box }) => {
                const selected = selectedNode === key;
                const dimmed = connected ? !connected.has(key) : false;
                return (
                  <g
                    key={key}
                    role="button"
                    tabIndex={0}
                    aria-label={uiText("类型契约 {v0}", { v0: module.id })}
                    className={`${styles.moduleNode} ${dimmed ? styles.moduleDim : ""}`}
                    onClick={() => selectNode(key)}
                    onKeyDown={(event) => onKeyboardActivate(event, () => selectNode(key))}
                  >
                    <rect {...rectProps(box)} rx={8} className={`${styles.contractModuleBox} ${selected ? styles.moduleNodeSelected : ""}`} />
                    <text x={box.x + 10} y={box.y + 18} className={styles.backendModuleTitle}>{clipped(module.id, 30)}</text>
                    <text x={box.x + 10} y={box.y + 36} className={styles.backendModuleSummary}>{clipped(module.summary, 18)}</text>
                    <text x={box.x + 10} y={box.y + 48} className={styles.backendModuleMeta}>
                      {module.provision === "trusted-provider" ? uiText("由可信 Provider 实现") : uiText("由 App / Host 适配")}
                    </text>
                    <title>{module.summary}</title>
                  </g>
                );
              })}

              {layout.backend.map(({ module, key, box, cyclic }) => {
                const selected = selectedNode === key;
                const dimmed = connected ? !connected.has(key) : false;
                return (
                  <g
                    key={key}
                    role="button"
                    tabIndex={0}
                    aria-label={uiText("可信 Provider {v0}", { v0: module.name })}
                    className={`${styles.moduleNode} ${dimmed ? styles.moduleDim : ""}`}
                    onClick={() => selectNode(key)}
                    onKeyDown={(event) => onKeyboardActivate(event, () => selectNode(key))}
                  >
                    <rect {...rectProps(box)} rx={8} className={`${styles.backendModuleBox} ${cyclic ? styles.moduleNodeCycle : ""} ${selected ? styles.moduleNodeSelected : ""}`} />
                    <text x={box.x + 10} y={box.y + 18} className={styles.backendModuleTitle}>{clipped(module.name, 31)}</text>
                    <text x={box.x + 10} y={box.y + 37} className={styles.backendModuleSummary}>{clipped(module.summary, 19)}</text>
                    <text x={box.x + 10} y={box.y + 56} className={styles.backendModuleMeta}>
                      {module.registered ? uiText("已在生产组合注册") : uiText("已发现 · 未见生产注册")} · {module.contracts.length} {uiText("契约")}</text>
                    <title>{module.summary}</title>
                  </g>
                );
              })}
            </svg>
          </div>

          <aside className={styles.moduleInspector} aria-live="polite">
            {!selectedFrontend && !selectedContract && !selectedBackend && !picked && (
              <>
                <p className={styles.moduleInspectorEyebrow}>{uiText("节点详情")}</p>
                <h4>{uiText("选择一个节点")}</h4>
                <p>{uiText("查看接口、实现和依赖；图中关系不授予权限。")}</p>
              </>
            )}

            {selectedFrontend && (() => {
              const module = selectedFrontend.module;
              const relations = visibleEdges.filter((edge) => edge.from === selectedFrontend.key);
              return (
                <>
                  <p className={styles.moduleInspectorEyebrow}>{uiText("View 模组 · 可复用前端")}</p>
                  <h4>{module.title} <span className={styles.sev}>{module.version}</span></h4>
                  <FrontendModuleDemo key={module.id} module={module} />
                  <p>{module.summary}</p>
                  <dl className={styles.moduleKv}>
                    <dt>{uiText("模组 ID")}</dt><dd className={styles.mono}>{module.id}</dd>
                    <dt>{uiText("可放位置")}</dt><dd>{slotList(module.slots)}</dd>
                    <dt>{uiText("可打开")}</dt><dd>{module.opens.join("、") || uiText("不直接打开资源")}</dd>
                    <dt>{uiText("实现")}</dt><dd className={styles.mono}>{module.implementation}</dd>
                    <dt>{uiText("配置项")}</dt><dd>{module.configKeys.join("、") || uiText("无")}</dd>
                  </dl>
                  <DetailRows title={uiText("适配关系")} items={relations.map((edge) => <><code>{edge.label}</code>{uiText("：仅依赖这个接口。")}</>)} />
                  <SourceRef source={module.source} />
                </>
              );
            })()}

            {selectedContract && (() => {
              const contract = selectedContract.module;
              const consumers = visibleEdges.filter((edge) => edge.kind === "requires" && edge.to === selectedContract.key);
              const providers = visibleEdges.filter((edge) => edge.kind === "provides" && edge.from === selectedContract.key);
              return (
                <>
                  <p className={styles.moduleInspectorEyebrow}>{uiText("Typed contract · 生态兼容接缝")}</p>
                  <h4>{contract.id}</h4>
                  <p>{contract.summary}</p>
                  <p className={styles.compatCallout}>{uiText("双方实现同一 contract 即可适配；关系不代表授权。")}</p>
                  <DetailRows title={uiText("前端消费者")} items={consumers.map((edge) => <code>{edge.from.replace(/^frontend:/, "")}</code>)} />
                  <DetailRows title={uiText("可信实现")} items={providers.map((edge) => <code>{edge.to.replace(/^backend:/, "")}</code>)} />
                  <DetailRows title={uiText("功能动作")} items={contract.actions.map((action) => <><code>{action.id}</code> — {action.summary}{action.operation ? <>{uiText("；权限操作 ")}<code>{action.operation}</code></> : null}</>)} />
                  {contract.source && <SourceRef source={contract.source} />}
                </>
              );
            })()}

            {selectedBackend && (() => {
              const module = selectedBackend.module;
              const consumers = visibleEdges.filter((edge) => edge.kind === "provides" && edge.to === selectedBackend.key);
              return (
                <>
                  <p className={styles.moduleInspectorEyebrow}>{uiText("Trusted Provider · 受信后端")}</p>
                  <h4>{module.name} <span className={module.registered ? styles.providerLive : styles.providerIdle}>{module.registered ? uiText("已注册") : uiText("未注册")}</span></h4>
                  <p>{module.summary}</p>
                  <dl className={styles.moduleKv}>
                    <dt>{uiText("实现契约")}</dt><dd>{module.contracts.map((id) => <code key={id}>{id}</code>)}</dd>
                    <dt>{uiText("Provider 依赖")}</dt><dd>{module.dependencies.join("、") || uiText("当前 catalog 无 Provider→Provider 依赖")}</dd>
                    <dt>{uiText("平台路径")}</dt><dd>{uiText("资源调用仍经过 Capability Gate / Kernel。")}</dd>
                    <dt>{uiText("源码包")}</dt><dd className={styles.mono}>{module.packageId}</dd>
                  </dl>
                  <DetailRows title={uiText("适配关系")} items={consumers.map((edge) => <>{uiText("实现 ")}<code>{edge.from.replace(/^contract:/, "")}</code>{uiText("，可被消费同一 contract 的 View 组合使用。")}</>)} />
                  <DetailRows title={uiText("功能动作")} items={module.actions.map((action) => <><code>{action.id}</code> — {action.summary}{action.operation ? <>{uiText("；经 Gate 使用 ")}<code>{action.operation}</code></> : null}</>)} />
                  <SourceRef source={module.source} /> <CopyButton text={module.path} />
                </>
              );
            })()}

            {picked && (
              <>
                <p className={styles.moduleInspectorEyebrow}>{uiText("关系解释")}</p>
                <h4>{picked.kind === "requires" ? uiText("View 需要 contract") : picked.kind === "provides" ? uiText("Provider 实现 contract") : uiText("Provider 组合依赖")}</h4>
                <p className={styles.mono}>{picked.from} → {picked.to}</p>
                <p>{picked.kind === "requires"
                  ? uiText("View 依赖此 contract，不选择 Provider 或获得权限。")
                  : picked.kind === "provides"
                    ? uiText("Provider 实现此 contract；资源调用仍经过权限检查。")
                    : uiText("受信组合根显式连接两个 Provider。")}</p>
              </>
            )}
          </aside>
        </div>
      </section>

      {ecosystem.issues.length > 0 && (
        <section className={styles.card}>
          <h3>{uiText("自动发现告警")}</h3>
          {ecosystem.issues.map((issue, at) => (
            <div className={styles.findingRow} key={`${issue.message}:${at}`}>
              <span>{issue.message}</span>
              {issue.source && <SourceRef source={issue.source} />}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
