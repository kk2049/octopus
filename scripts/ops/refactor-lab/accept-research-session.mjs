import {createHash} from 'node:crypto';
import {finishNative} from './native-page.mjs';
/** Trusted Research owner binds an existing real session, reads it, then continues it. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {labClient} from './lab-client.mjs';
const [root,caseId,sid]=process.argv.slice(2);assert(/^[a-z0-9-]{1,60}$/.test(caseId||'')&&/^[a-f0-9-]{36}$/.test(sid||''));
const lab=await labClient(root);const record={schema:'octopus-refactor-acceptance/v1',sha:lab.sha,caseId,scenario:'research-native-lead',realAgent:true,consumerIds:['research-native'],scenarios:[],passed:false,sessionId:sid,startedAt:new Date().toISOString()};
const file=path.join(root,'artifacts',caseId+'.json');fs.writeFileSync(file,JSON.stringify(record,null,2),{flag:'wx'});let handle;
try{
 await lab.post('/api/permissions/grant',{subject_type:'app',subject_id:'research-program',operations:['read_session','append_session','upload_session_file']});
 const project=await lab.post('/api/apps/research-program/shared-instances',{role:'owner'});record.instanceKey=project.instance_key;
 const opened=await lab.request.get('/apps/research-program/open?instance='+project.instance_key);
 handle=/id="octopus-app-instance">"([^"]+)"<\/script>/.exec(await opened.text())?.[1];assert(handle,'trusted browser instance');
 async function act(action,params){const out=await lab.post('/api/app-view/act?app=research-program',{action,params},{'x-app-instance':handle});assert(out.ok,JSON.stringify(out));return out;}
 await act('publish_agent_update',{agent_key:'lead-agent',agent_label:caseId,provider:'codex',workspace_key:'lab-workspace',workspace_label:'Synthetic shared workspace',session_key:'lead-session',session_title:caseId,status:'idle'});
 await act('research_bind_source',{source_key:'lead-session',generation:createHash('sha256').update('').digest('hex'),kind:'session',total:'0',provider:'codex',title:caseId,source_ref:'lab:'+sid,reason:'Synthetic live locator; no archived transcript imported'});
 await act('set_lead_agent',{agent_key:'lead-agent',session_key:'lead-session',reason:'Synthetic owner selects existing session'});
 await act('research_set_source_locations',{expected_revision:'0',locations:JSON.stringify({roots:['/lab/workspaces/sessions'],sessions:{'lead-session':{cwd:'/lab/workspaces/sessions',device:'lab_alice_model',provider:'codex',session_id:sid}}}),reason:'Exact synthetic Runner session locator'});
 await act('open_session',{resource:'lead-session',limit:'30'});
 const sent=await act('append_session',{resource:'lead-session',prompt:`合成科研主导 Agent 验收 ${caseId}。请在当前工作目录创建 ${caseId}-research.txt，若不存在则写一行 research-agent-ok，已有文件不改动。读取并确认；不操作其他文件，不部署，不发消息。`});
 record.operationId=sent.result?.opId;assert(record.operationId,'durable original operation');
 await finishNative(lab,sid,caseId+'-research.txt',record);
 assert.equal(record.output,'research-agent-ok');
 const operations=await (await lab.request.get('/api/sessions/operations?session='+sid)).json();
 const op=operations.operations.find(o=>o.id===record.operationId);assert(op);record.operationStatus=op.status;
 lab.assertCandidate();record.passed=true;record.finishedAt=new Date().toISOString();
}catch(error){record.error=String(error);throw error;}
finally{if(handle)await lab.post('/api/app-view/close?app=research-program',{}, {'x-app-instance':handle}).catch(()=>{});fs.writeFileSync(file,JSON.stringify(record,null,2));await lab.close();console.log(JSON.stringify(record));}
