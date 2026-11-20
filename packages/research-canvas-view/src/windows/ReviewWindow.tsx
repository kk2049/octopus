import { useMemo, useState } from "react";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";

export function ReviewWindow({
  node,
  nodes,
  editable,
  mutate,
  open,
}: {
  node: ResearchNode;
  nodes: ResearchNode[];
  editable: boolean;
  mutate(action: string, params: Record<string, unknown>): Promise<unknown>;
  open(node: string, version?: string): void;
}) {
  const targets = node.data.targets && typeof node.data.targets === "object" && !Array.isArray(node.data.targets)
    ? node.data.targets as Record<string, number> : {};
  const current = useMemo(() => Object.fromEntries(
    Object.keys(targets).map((id) => {
      const target = nodes.find((item) => item.id === id);
      return [id, target ? { node: target, version: target.resourceVersion ?? target.version } : null];
    }),
  ), [nodes, targets]);
  const changed = Object.entries(targets).some(([id, version]) => {
    const target = current[id];
    return !target || target.node.archived || target.version !== version;
  });
  const missingOrArchived = Object.values(current).some((entry) => !entry || entry.node.archived);
  const status = typeof node.data.reviewStatus === "string" ? node.data.reviewStatus : "pending";
  const decision = node.data.decision && typeof node.data.decision === "object" && !Array.isArray(node.data.decision) ? node.data.decision as Record<string, unknown> : null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (decisionValue: "approved" | "changes_requested" | "pending") => {
    if (pending || missingOrArchived || (decisionValue === "approved" && changed) || (decisionValue === "changes_requested" && changed)) return;
    setPending(true);
    setError("");
    try {
      // Submit the versions currently visible in this projection. The graph
      // rejects a stale snapshot, forcing the reviewer to read again.
      const targetVersions = Object.fromEntries(Object.entries(current).flatMap(([id, entry]) => entry ? [[id, entry.version]] : []));
      const result = await mutate("review_decide", { node: node.id, version: node.resourceVersion ?? node.version, decision: decisionValue, targets: targetVersions });
      if (result === null) setError("审查操作失败，请重新读取目标。");
    } finally {
      setPending(false);
    }
  };
  const reset = async () => {
    if (pending || missingOrArchived) return;
    setPending(true);
    setError("");
    try {
      const targetVersions = Object.fromEntries(Object.entries(current).flatMap(([id, entry]) => entry ? [[id, entry.version]] : []));
      const result = await mutate("node_update", {
        node: node.id,
        version: node.resourceVersion ?? node.version,
        data: {
          data: {
            ...node.data,
            reviewStatus: "pending",
            targets: targetVersions,
            decision: { status: "pending", targets: targetVersions },
          },
        },
      });
      if (result === null) setError("重置失败，请重新读取审查节点。");
    } finally {
      setPending(false);
    }
  };
  const displayStatus = pending ? "pending" : error ? "error" : changed ? "stale" : status;
  return <section className={`rv-review-panel status-${displayStatus}`}>
    <div className="rv-review-status"><b>{displayStatus === "approved" ? "已审查" : displayStatus === "changes_requested" ? "需要修改" : displayStatus === "stale" ? "目标已变化，需重审" : displayStatus === "error" ? "审查失败" : "等待审查"}</b><span>{Object.keys(targets).length} 个目标</span></div>
    <p>{node.summary || "这是一个独立的审查节点。结论只对当前目标版本有效。"}</p>
    <ul>{Object.entries(targets).map(([id, version]) => {
      const target = current[id];
      return <li key={id}>{target ? <button type="button" onClick={() => open(id, String(target.version))}>{target.node.title}</button> : id} · v{target?.version ?? version}{target?.node.archived ? " · 已归档" : target ? (target.version === version ? "" : ` · 原审 v${version}`) : " · 缺失"}</li>;
    })}</ul>
    {decision && <small>最后记录：{String(decision.by ?? "未知")} · {String(decision.at ?? "")}</small>}
    {error && <p className="rv-error" role="alert">{error}</p>}
    {editable && <div className="rv-inline rv-review-actions">
      <button className="rv-primary" disabled={pending || missingOrArchived || changed} onClick={() => void submit("approved")}>通过审查</button>
      <button disabled={pending || changed || missingOrArchived} onClick={() => void submit("changes_requested")}>要求修改</button>
      <button disabled={pending || missingOrArchived} onClick={() => void reset()}>重置待审</button>
    </div>}
  </section>;
}
