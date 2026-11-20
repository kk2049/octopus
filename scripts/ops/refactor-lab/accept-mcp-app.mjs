/** A real external parent Agent calls the live Head's scoped Apps MCP surface. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {labClient} from './lab-client.mjs';
const [root='/lab',caseId]=process.argv.slice(2);assert(/^[a-z0-9-]{1,60}$/.test(caseId||''));
const lab=await labClient(root);const artifact=path.join(root,'artifacts',`${caseId}.json`);
const record={schema:'octopus-refactor-acceptance/v1',scenario:'research-mcp-parent-real-agent',realAgent:true,consumerIds:['mcp-app-parent'],scenarios:['authorization-revocation','cross-owner-isolation'],sha:lab.sha,caseId,startedAt:new Date().toISOString(),passed:false,modelRequests:0,calls:[]};
fs.writeFileSync(artifact,JSON.stringify(record,null,2),{flag:'wx'});
const config=JSON.parse(fs.readFileSync(path.join(root,'private/config.json'),'utf8'));
assert.equal(new URL(config.openai.base_url).hostname,'127.0.0.1');
const {AgentLoop}=await import(pathToFileURL(path.join(process.cwd(),'packages/bot/src/app-agents/loop.ts')).href);
let token;let rpcId=0;
function decode(result){assert(result?.content);return JSON.parse(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));}
async function rpc(method,params){
 const response=await fetch(lab.origin+'/api/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token.token}`},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})});
 assert.equal(response.status,200);const value=await response.json();assert(!value.error,JSON.stringify(value.error));return value.result;
}
try{
 await lab.post('/api/permissions/grant',{subject_type:'service',subject_id:'mcp',operations:['list_apps','read_app_projection','read_app_log','dispatch_app_action']});
 const created=await lab.post('/api/apps/research-program/shared-instances',{role:'owner'});record.instanceKey=created.instance_key;
 token=await lab.post('/api/mcp/tokens/create',{label:caseId,ttl_days:1,tool_groups:['apps'],app_ids:['research-program'],app_instances:[created.instance_key],app_actions:['research_record']});
 const listing=await rpc('tools/list',{});
 const metadata=decode(await rpc('tools/call',{name:'app_list',arguments:{}}));
 const app=(metadata.apps??metadata.result?.apps)?.find(a=>a.app==='research-program');assert(app,'current declared App action schema');
 const action=app.actions.find(a=>a.name==='research_record');assert(action);
 const loop=new AgentLoop({baseUrl:config.openai.base_url,apiKey:config.openai.api_key,fetchImpl:async(...args)=>{record.modelRequests++;return fetch(...args);}});
 const result=await loop.run({model:'gpt-5.6-sol',effort:'low',maxToolTurns:4,
  systemPrompt:'你是隔离测试中的真实科研 Agent。只使用给出的工具一次保存一条合成科研记录。不得代替真人批准。工具拒绝或结局不明时立即停止，禁止重试写入。',
  messages:[{role:'user',content:`在 App research-program 的实例 ${created.instance_key} 上执行 research_record，record=${caseId}，kind=note，title=${caseId}，body=合成验收：没有实验结果，结论属于推断，未获真人批准。origin=authored，其余可选字段省略。动作参数元数据：${JSON.stringify(action)}。保存后简短报告。`}],
  tools:listing.tools.filter(t=>t.name==='app_dispatch').map(t=>({name:t.name,description:t.description,parameters:t.inputSchema})),
  callTool:async(name,args)=>{const out=await rpc('tools/call',{name,arguments:args});record.calls.push({name,action:args.action,isError:Boolean(out.isError)});return {text:JSON.stringify(out),isError:Boolean(out.isError)};},
 });
 assert.equal(result.kind,'done');assert.equal(record.calls.length,1);assert(!record.calls[0].isError);
 const projection=decode(await rpc('tools/call',{name:'app_read_projection',arguments:{app:'research-program',instance:created.instance_key}}));
 assert(JSON.stringify(projection).includes(caseId),'committed research record');
 const foreign=await rpc('tools/call',{name:'app_read_projection',arguments:{app:'research-program',instance:'asi_00000000000000000000000000000000'}});
 assert(foreign.isError,'token may not escape its bound shared instance');
 await lab.post('/api/mcp/tokens/revoke',{token_hash:token.token_hash});
 const revoked=await fetch(lab.origin+'/api/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token.token}`},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/list',params:{}})});
 assert([401,403].includes(revoked.status),'revoked parent credential refused');
 record.tokenRevocationStatus=revoked.status;lab.assertCandidate();record.passed=true;record.finishedAt=new Date().toISOString();
}catch(error){record.error=String(error);throw error;}
finally{if(token)await lab.post('/api/mcp/tokens/revoke',{token_hash:token.token_hash}).catch(()=>{});fs.writeFileSync(artifact,JSON.stringify(record,null,2));await lab.close();console.log(JSON.stringify(record));}
