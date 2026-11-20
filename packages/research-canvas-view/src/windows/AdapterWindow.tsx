import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import type { NodeWindowProps } from "./NodeWindow.js";
type Scalar = string | number | boolean | null;
type Adapter = { source: string; entry: string; schema: { view: "table" | "metrics" | "text"; columns: { key: string; label: string }[]; primary?: string }; status: "registered" | "live" | "paused" | "removed"; sourceRevision: string; cursor: string | null; rows: { id: string; cells: Record<string, Scalar> }[]; publisher: string; updatedAt: string };
function readAdapter(node: ResearchNode): Adapter {
  const value = node.data.adapter;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("适配器投影数据无效");
  return value as unknown as Adapter;
}
/** Read-only structured projection; lifecycle buttons dispatch declared actions. */
export function AdapterWindow({ node, editable, mutate }: Pick<NodeWindowProps, "node" | "editable" | "mutate">) {
  let adapter: Adapter;
  try { adapter = readAdapter(node); } catch { return <p role="alert">适配器投影数据无效</p>; }
  const rows = adapter.rows ?? [];
  const columns = adapter.schema?.columns ?? [];
  const stateLabel = adapter.status === "live" ? "已发布投影" : adapter.status === "paused" ? "已暂停" : adapter.status === "removed" ? "已移除" : "已登记";
  const control = (state: "paused" | "registered" | "removed") => void mutate("adapter_control", { request: `adapter_${Date.now().toString(36)}`, node: node.id, version: node.resourceVersion ?? node.version, state });
  return <section className="rv-adapter-window">
    <header className="rv-adapter-header"><div><b>{stateLabel}</b><span>{adapter.schema.view} · {rows.length} 行</span></div>{editable && adapter.status !== "removed" && <div className="rv-inline rv-adapter-actions">{adapter.status === "paused" ? <button onClick={() => control("registered")}>恢复监听</button> : <button onClick={() => control("paused")}>暂停监听</button>}<button onClick={() => control("removed")}>移除适配器</button></div>}</header>
    <dl className="rv-adapter-source"><div><dt>来源</dt><dd>{adapter.source}</dd></div><div><dt>版本</dt><dd>{adapter.sourceRevision || "尚未发布"}</dd></div><div><dt>游标</dt><dd>{adapter.cursor ?? "—"}</dd></div><div><dt>入口</dt><dd>{adapter.entry}</dd></div></dl>
    {adapter.schema.view === "metrics" ? <div className="rv-adapter-metrics">{rows.map((row) => <article key={row.id}><small>{String(row.cells[adapter.schema.primary ?? columns[0]?.key] ?? row.id)}</small><strong>{String(row.cells[columns[1]?.key ?? columns[0]?.key] ?? "—")}</strong></article>)}</div> : adapter.schema.view === "text" ? <div className="rv-adapter-text">{rows.map((row) => <p key={row.id}>{columns.map((column) => String(row.cells[column.key] ?? "")).join(" · ")}</p>)}</div> : <div className="rv-adapter-table-wrap"><table><thead><tr><th>id</th>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.id}</td>{columns.map((column) => <td key={column.key}>{String(row.cells[column.key] ?? "")}</td>)}</tr>)}</tbody></table></div>}
    <small className="rv-muted">发布者 {adapter.publisher} · 更新于 {adapter.updatedAt}</small>
  </section>;
}
