import { useState } from "react";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { Dialog } from "./Dialog.js";
import { requestId, type Call } from "./client.js";
export function AgentRequest({ node, agents, call, close }: { node: ResearchNode; agents: ResearchNode[]; call: Call; close(): void }) {
  const [agent, setAgent] = useState(""), [prompt, setPrompt] = useState(`请查看「${node.title}」并回应其中的问题。`), [pending, setPending] = useState(false), [error, setError] = useState("");
  return <Dialog title="请 Agent 回应" close={close}><button aria-label="关闭 Agent 请求" onClick={close}>关闭</button><form onSubmit={async e => { e.preventDefault(); setPending(true); setError(""); try { await call("agent_send", { request: requestId(), node: agent, prompt: `${prompt}\n\n来源节点：${node.id}\n资源引用：${node.ref ?? node.id}\n${node.summary}\n请通过科研平台读取完整内容；将结论作为新节点以回应关系连回来源。` }); close(); } catch (reason) { setError(String(reason)); } finally { setPending(false); } }}>
    <label>Agent<select aria-label="响应卡片的 Agent" value={agent} onChange={e => setAgent(e.target.value)}><option value="">选择项目 Agent</option>{agents.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <label>希望它做什么<textarea aria-label="给 Agent 的要求" value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
    {!agents.length && <p>项目尚未绑定 Agent。</p>}{error && <p role="alert">{error}</p>}<button disabled={pending || !agent || !prompt.trim()}>{pending ? "提交中…" : "发送"}</button>
  </form></Dialog>;
}
