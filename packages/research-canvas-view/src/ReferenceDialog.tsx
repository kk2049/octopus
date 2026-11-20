import { useEffect, useRef, useState } from "react";
import { GRAPH_SCHEMA, referenceResearchNode, type GraphEditResult, type GraphSpec, type ResearchNode } from "@claude-bot/research-canvas-contract";
import { requestId, type Call } from "./client.js";
import { Dialog } from "./Dialog.js";
export function ReferenceDialog({ node, scope, call, close, changed }: { node: ResearchNode; scope: ResearchNode; call: Call; close(): void; changed(): void }) {
  const [ownership, setOwnership] = useState<"common" | "retain">("common"), [pending, setPending] = useState(false), [error, setError] = useState("");
  const outgoing = useRef<{ request: string; yaml: string } | undefined>(undefined), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async () => {
    setPending(true); setError("");
    try {
      if (!outgoing.current) {
        const snapshot = await call<{ snapshot: string; graph: GraphSpec }>("graph_read");
        if (!mounted.current) return;
        const request = requestId();
        const plan = referenceResearchNode(snapshot.graph, node.id, scope.id, ownership, request.replace(/[^A-Za-z0-9_]/g, ""));
        outgoing.current = { request, yaml: JSON.stringify({ schema: GRAPH_SCHEMA, snapshot: snapshot.snapshot, ...plan.graph }) };
      }
      const result = await call<GraphEditResult>("graph_apply", outgoing.current);
      if (!mounted.current) return;
      if (result.conflicts?.length || result.issues?.length) { outgoing.current = undefined; setError("部分关系有并发修改，请检查当前图后重试。"); changed(); return; }
      changed(); close();
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { if (mounted.current) setPending(false); }
  };
  return <Dialog title="引入节点引用" close={close}><section className="rv-dialog small">
    <header><h2>将「{node.title}」引入「{scope.title}」</h2><button onClick={close}>×</button></header>
    <p>引用始终打开同一个节点；在任何位置编辑正文都会更新同一份内容。</p>
    <label><input type="radio" name="ownership" checked={ownership === "common"} disabled={pending || !!outgoing.current} onChange={() => setOwnership("common")} /> 放到共同上层（默认）</label>
    <p>原分支和当前分支都保留引用。没有共同目标时，节点归属项目总览。</p>
    <label><input type="radio" name="ownership" checked={ownership === "retain"} disabled={pending || !!outgoing.current} onChange={() => setOwnership("retain")} /> 保留原归属，只在这里引用</label>
    {error && <p role="alert">{error}</p>}
    <button className="rv-primary" disabled={pending} onClick={() => void submit()}>{pending ? "正在引入…" : outgoing.current ? "重试引入" : "引入引用"}</button>
  </section></Dialog>;
}
