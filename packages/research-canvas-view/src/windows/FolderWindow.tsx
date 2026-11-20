import { useMemo, useState } from "react";
import { pluginFor } from "../plugins.js";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";

export function FolderWindow({
  node, nodes, editable, mutate, open,
}: { node: ResearchNode; nodes: ResearchNode[]; editable: boolean; mutate(action: string, params: Record<string, unknown>): Promise<unknown>; open(node: string): void }) {
  const members = Array.isArray(node.data.members) ? node.data.members.filter((id): id is string => typeof id === "string") : [];
  const memberSet = useMemo(() => new Set(members), [members.join("\u0000")]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const folders = nodes.filter((candidate) => candidate.type === "folder" && candidate.id !== node.id);
  const candidates = nodes.filter((candidate) => !candidate.archived && candidate.id !== node.id && candidate.type !== "folder").sort((a, b) => Number(memberSet.has(b.id)) - Number(memberSet.has(a.id)));
  const update = async (next: string[]) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      // node_update accepts editable fields at the top level; node data itself
      // must remain under the `data` field so metadata/description survive.
      const result = await mutate("node_update", {
        node: node.id,
        version: node.version, snapshot: node.snapshot,
        data: { data: { ...node.data, members: next } },
      });
      if (result === null) setError("保存失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  };
  const toggle = (id: string) => void update(memberSet.has(id) ? members.filter((member) => member !== id) : [...members, id]);
  return <section className="rv-folder-window">
    <p className="rv-folder-lede">用目录组织方向、事项与工作。勾选内容后，它会出现在此目录的层级视图中。</p>
    <div className="rv-folder-toolbar"><b>{members.length} 项已收纳</b><span>版本 v{node.version}</span></div>
    {error && <p className="rv-error" role="alert">{error}</p>}
    <div className="rv-folder-members">
      {candidates.map((candidate) => <label key={candidate.id} className={memberSet.has(candidate.id) ? "included" : ""}>
        <input type="checkbox" checked={memberSet.has(candidate.id)} disabled={!editable || pending} onChange={() => toggle(candidate.id)} />
        <span>{candidate.title}</span><small>{pluginFor(candidate.type).title}</small>
        <button type="button" disabled={pending} onClick={() => open(candidate.id)}>查看</button>
      </label>)}
      {!candidates.length && <p className="rv-muted">暂无可收纳节点。</p>}
    </div>
    {folders.length > 0 && <details className="rv-folder-nested"><summary>子目录</summary>{folders.map((candidate) => <label key={candidate.id}>
      <input type="checkbox" checked={memberSet.has(candidate.id)} disabled={!editable || pending} onChange={() => toggle(candidate.id)} />{candidate.title}
    </label>)}</details>}
    <p className="rv-muted">同一份材料可以出现在多个目录中；收纳不会复制内容。</p>
  </section>;
}
