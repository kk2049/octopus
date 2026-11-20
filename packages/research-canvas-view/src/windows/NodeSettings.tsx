import { useEffect, useRef, useState } from "react";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { requestId, type Call } from "../client.js";
export function NodeSettings({
  node,
  nodes,
  call,
  editable,
  editField,
}: {
  node: ResearchNode;
  nodes: ResearchNode[];
  call: Call;
  editable: boolean;
  editField?: "title" | "summary" | "body";
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (details.current && (editField === "title" || editField === "summary")) details.current.open = true; }, [editField]);
  const [base, setBase] = useState(node);
  const readOnly = node.data.meta && typeof node.data.meta === "object" && !Array.isArray(node.data.meta) && node.data.meta.read_only === true;
  const [title, setTitle] = useState(node.title),
    [summary, setSummary] = useState(node.summary),
    [instructions, setInstructions] = useState(
      String(node.data.instructions ?? ""),
    );
  const [collection, setCollection] = useState(
      String(node.data.collection ?? ""),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <details ref={details} className="rv-settings">
      <summary>标题与节点设置</summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const result = await call<{ node: ResearchNode; edit?: { conflicts?: unknown[] } }>("node_update", {
              request: requestId(),
              node: node.id,
              version: base.version, snapshot: base.snapshot,
              data: {
                ...(title !== base.title ? { title } : {}),
                ...(!readOnly && summary !== base.summary ? { summary } : {}),
                ...(!readOnly && node.type === "agent" && instructions !== String(base.data.instructions ?? "")
                  ? { data: { ...base.data, instructions } }
                  : !readOnly && ["file", "audio"].includes(node.type) && collection !== String(base.data.collection ?? "")
                    ? { data: { ...base.data, collection: collection || undefined } }
                    : {}),
              },
            });
            setBase(result.node); setTitle(result.node.title);
            if (result.edit?.conflicts?.length) setError("并发修改已合并，当前有效标题已显示。");
          } catch (error) {
            setError(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          标题
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            required
          />
        </label>
        <label>
          摘要
          <textarea
            disabled={Boolean(readOnly) || !editable}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            maxLength={2000}
          />
        </label>
        {node.type === "agent" && (
          <label>
            工作说明
            <textarea
              disabled={Boolean(readOnly) || !editable}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={20000}
              placeholder="希望这个 Agent 如何工作和记录成果…"
            />
          </label>
        )}
        {["file", "audio"].includes(node.type) && (
          <label>
            资料集合
            <select
              disabled={Boolean(readOnly) || !editable}
              value={collection}
              onChange={(event) => setCollection(event.target.value)}
            >
              <option value="">未归入集合</option>
              {nodes
                .filter((item) => item.type === "collection" && !item.archived)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        <button disabled={!editable || busy}>保存设置</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}
