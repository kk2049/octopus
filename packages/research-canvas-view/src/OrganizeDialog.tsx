import {useState} from 'react';
import type {ResearchNode} from '@claude-bot/research-canvas-contract';
import {Dialog} from './Dialog.js';
import {requestId, type Call} from './client.js';

export function OrganizeDialog({agents, call, close, open}: {agents: ResearchNode[]; call: Call; close(): void; open(node:string):void}) {
  const [agent,setAgent]=useState(''),[pending,setPending]=useState(false),[error,setError]=useState('');
  return <Dialog title="整理项目看板" close={close}><form className="rv-dialog" onSubmit={async event=>{
    event.preventDefault();setPending(true);setError('');
    try {await call('agent_send',{request:requestId(),node:agent,prompt:'请梳理整个项目看板：读取历史、当前和下一步节点，识别支持、反对、佐证与产物关系，补充来源明确的摘要和关系，指出仍未解决的矛盾与缺失证据。保留现有内容原意。通过 graph_read 读取 YAML，编辑后 graph_apply 提交并检查冲突回执。坐标单独使用 layout_auto 或 layout_move；文件正文通过 ref 工具直接保存。记录你本次整理的产物。'});open(agent);close();}
    catch(error){setError(String(error));}finally{setPending(false);}
  }}><header><h2>整理项目看板</h2><button type="button" aria-label="关闭整理" onClick={close}>×</button></header>
    <p>手动启动一个已绑定资源的 Agent；本次整理的过程与产物会留在项目中。</p>
    <label>负责整理的 Agent<select required value={agent} onChange={event=>setAgent(event.target.value)}><option value="">选择项目 Agent</option>{agents.map(node=><option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
    {!agents.length&&<p>先新建一个 Agent 节点并绑定运行资源。</p>}
    {error&&<p role="alert">{error}</p>}<button className="rv-primary" disabled={!agent||pending}>{pending?'提交中…':'开始整理'}</button>
  </form></Dialog>;
}
