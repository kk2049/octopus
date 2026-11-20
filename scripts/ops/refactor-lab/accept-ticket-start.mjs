import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {labClient} from './lab-client.mjs';
const [root='/lab',caseId]=process.argv.slice(2);assert(/^[a-z0-9-]{1,60}$/.test(caseId||''));const lab=await labClient(root);
const file=path.join(lab.root,'artifacts',caseId+'.json');const record={schema:'octopus-refactor-acceptance/v1',caseId,sha:lab.sha,startedAt:new Date().toISOString(),passed:false,phase:'before-create'};
fs.writeFileSync(file,JSON.stringify(record,null,2),{flag:'wx'});
try{
 const list=await (await lab.request.get('/api/tickets')).json();const choices=list.execution_choices.lab_alice;
 const source=choices.sources.find(s=>s.device==='lab_alice_model'&&s.source==='codex'&&s.available);
 const workspace=choices.workspaces.find(w=>w.device==='lab_alice_execution'&&w.available);assert(source&&workspace);
 const reply=await lab.post('/api/tickets',{kind:'discuss',model:'codex-gpt-5.6-sol',effort:'low',agent_source:source.id,workspace:workspace.id,
 body:`这是完全隔离的合成工单验收 ${caseId}，不是开发交付。请使用真实 shell 在当前分配的工单工作区创建 ${caseId}-started.txt，内容是 started，然后 sleep 90，最后创建 ${caseId}-done.txt 内容为 5（计算 2+3）。已有文件不覆盖、不追加。只操作这两个测试文件；不修改源码，不提交、不合并、不部署，不向他人发送消息。最后读取结果并回复测试完成。`});
 record.ticketId=reply.ticket.id;record.phase='created';fs.writeFileSync(file,JSON.stringify(record,null,2));console.log(JSON.stringify(record));
}finally{await lab.close();}
