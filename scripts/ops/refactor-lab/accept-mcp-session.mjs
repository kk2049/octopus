import {finishNative} from './native-page.mjs';
/** Real parent-model tool call -> browser approval -> original native session. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {labClient} from './lab-client.mjs';
const [root,caseId,sid]=process.argv.slice(2);assert(/^[a-z0-9-]{1,60}$/.test(caseId||'')&&/^[a-f0-9-]{36}$/.test(sid||''));
const lab=await labClient(root);const config=JSON.parse(fs.readFileSync(path.join(root,'private/config.json'),'utf8'));
const {AgentLoop}=await import(pathToFileURL(path.join(process.cwd(),'packages/bot/src/app-agents/loop.ts')).href);
const record={schema:'octopus-refactor-acceptance/v1',sha:lab.sha,caseId,scenario:'mcp-parent-session-approval',realAgent:true,consumerIds:['mcp-session'],scenarios:[],passed:false,modelRequests:0,toolCalls:0,sessionId:sid,startedAt:new Date().toISOString()};
const artifact=path.join(root,'artifacts',`${caseId}.json`);fs.writeFileSync(artifact,JSON.stringify(record,null,2),{flag:'wx'});
const resource=Buffer.from(JSON.stringify(['lab_alice','lab_alice_model','codex',sid])).toString('base64url');
let token;let rpcId=0;
async function rpc(method,params){const response=await fetch(lab.origin+'/api/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token.token}`},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})});assert.equal(response.status,200);const body=await response.json();assert(!body.error,JSON.stringify(body.error));return body.result;}
async function operations(){return (await (await lab.request.get('/api/sessions/operations?session='+sid)).json()).operations;}
try{
 token=await lab.post('/api/mcp/tokens/create',{label:caseId,ttl_days:1,tool_groups:['sessions']});
 const tools=await rpc('tools/list',{});const before=new Set((await operations()).map(o=>o.id));
 const pendingBefore=new Set((await (await lab.request.get('/api/capabilities/pending')).json()).pending.map(p=>p.id));
 const loop=new AgentLoop({baseUrl:config.openai.base_url,apiKey:config.openai.api_key,fetchImpl:async(...args)=>{record.modelRequests++;return fetch(...args);}});
 const outcome=await loop.run({model:'gpt-5.6-sol',effort:'low',maxToolTurns:2,systemPrompt:'你是灰度验收父 Agent。调用一次 send_session_message。批准请求属于正常交接，遇到 approval_required 后立刻停止，绝不重复发送。',
 messages:[{role:'user',content:`请向已确认属于当前账户的资源 ${resource} 发送以下原文一次：这是合成 MCP 验收 ${caseId}，请只在当前工作目录创建 ${caseId}-mcp.txt，若不存在则写一行 mcp-agent-ok，已有文件不改动。然后读取该文件并回复完成；不修改其他文件，不部署，不发消息。`}],
 tools:tools.tools.filter(t=>t.name==='send_session_message').map(t=>({name:t.name,description:t.description,parameters:t.inputSchema})),
 callTool:async(name,args)=>{record.toolCalls++;assert.equal(args.resource_id,resource);const out=await rpc('tools/call',{name,arguments:args});const text=out.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');record.approvalRequested=out.isError===true&&text.startsWith('approval_required:');return {text,isError:out.isError,closesTurn:record.approvalRequested};},
 });
 assert.equal(outcome.kind,'suspended');assert(record.approvalRequested);assert.equal(record.toolCalls,1);
 const submitted=(await operations()).filter(o=>!before.has(o.id));assert.equal(submitted.length,1);const operation=submitted[0];record.operationId=operation.id;assert.equal(operation.status,'waiting_approval');
 const pending=(await (await lab.request.get('/api/capabilities/pending')).json()).pending.filter(p=>!pendingBefore.has(p.id));assert.equal(pending.length,1);
 const approved=await lab.post('/api/capabilities/pending/'+pending[0].id+'/approve',{});assert.equal(approved.operation_id,operation.id);
 await finishNative(lab,sid,caseId+'-mcp.txt',record);
 assert.equal(record.output,'mcp-agent-ok');
 assert.equal((await operations()).filter(o=>!before.has(o.id)).length,1,'approval must execute original operation');
 record.result='mcp-agent-ok';lab.assertCandidate();record.passed=true;record.finishedAt=new Date().toISOString();
}catch(error){record.error=String(error);throw error;}
finally{if(token)await lab.post('/api/mcp/tokens/revoke',{token_hash:token.token_hash}).catch(()=>{});fs.writeFileSync(artifact,JSON.stringify(record,null,2));await lab.close();console.log(JSON.stringify(record));}
