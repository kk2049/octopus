/** The native App's registered inbox, real model, real sandbox and persisted state. */
import fs from "node:fs";import path from "node:path";import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";import {execFileSync} from "node:child_process";import {createHash} from "node:crypto";
const load=(file:string)=>import(pathToFileURL(path.join(process.cwd(),file)).href);
const {AppRuntimeService,InProcessRuntimeClient}=await load('packages/app-runtime/src/index.ts');
const {AppStateService,InProcessStateClient}=await load('packages/app-state/src/index.ts');
const {Store}=await load('packages/bot/src/store/store.ts');
const {SessionPlusAppService}=await load('packages/bot/src/session-plus/app-service.ts');
const {SessionPlusAgentBackend}=await load('packages/bot/src/session-plus/agent-backend.ts');
const {loadSessionPlusManifest}=await load('packages/bot/src/app-core/manifest.ts');
const {sessionPlusIdentity}=await load('packages/bot/src/app-core/identity.ts');
const {bundledAppDir}=await load('packages/bot/src/app-core/app-path.ts');
const {ManagedExecutionSupervisor}=await load('packages/bot/src/managed-execution/supervisor.ts');
const {ResourceRecoveryService}=await load('packages/bot/src/resources/recovery.ts');
const {AgentLoop}=await load('packages/bot/src/app-agents/loop.ts');const {AppAgentPlane}=await load('packages/bot/src/app-agents/plane.ts');
const root=path.resolve(process.argv[2]??'/lab');assert(fs.existsSync(path.join(root,'.refactor-lab')));
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert(!execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim());
const dir=path.join(root,'harness',`keeper-fault-${sha}-${Date.now()}`);fs.mkdirSync(dir,{recursive:true,mode:0o700});
const config=JSON.parse(fs.readFileSync(path.join(root,'private/config.json'),'utf8'));assert.equal(new URL(config.openai.base_url).hostname,'127.0.0.1');

const mode=process.argv[3];assert(['unknown','capacity'].includes(mode));
let actualModelRequests=0, fetchAttempts=0, dispatches=0, faultInjected=false;
const startedAt=new Date().toISOString();const key={appId:'session-plus',scopeKey:'account:lab_alice',agent:'keeper'};
function open(){
 const state=new AppStateService(dir), runtime=new AppRuntimeService(bundledAppDir('session-plus')), store=new Store(path.join(dir,'bot.db'));
 const manifest=loadSessionPlusManifest();const app=new SessionPlusAppService({state:new InProcessStateClient(state),runtime:new InProcessRuntimeClient(runtime),identity:sessionPlusIdentity(),manifest});
 const supervisor=new ManagedExecutionSupervisor(store.managedExecutions,new ResourceRecoveryService(store.resourceWaiters));
 const backend=new SessionPlusAgentBackend({app,manifest:()=>manifest});const original=backend.openTurn.bind(backend);
 backend.openTurn=async(input:any)=>{const handle=await original(input);return {...handle,async dispatch(action:string,params:any){
  const answer=await handle.dispatch(action,params);if(answer.ok){dispatches++;if(mode==='unknown'&&!faultInjected){faultInjected=true;throw new Error('injected lost response after actual App state commit');}}return answer;
 }};};
 const plane=new AppAgentPlane({supervisor,store,backends:[backend],defaultModel:'gpt-5.6-sol',defaultEffort:'low',
  loop:new AgentLoop({baseUrl:config.openai.base_url,apiKey:config.openai.api_key,fetchImpl:async(...args:any[])=>{
   fetchAttempts++;if(mode==='capacity'&&dispatches>0&&!faultInjected){faultInjected=true;return new Response(JSON.stringify({error:{message:'model at cap (synthetic injected capacity fault)',type:'rate_limit_error'}}),{status:429,headers:{'content-type':'application/json'}});}
   actualModelRequests++;return fetch(...args);
  }})});
 plane.completeBackendRegistration();plane.recover();
 return {store,supervisor,plane,app,async close(){await plane.stop();await supervisor.close();await app.stop();await runtime.stop();state.close();store.close();}};
}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function settled(h:any){const until=Date.now()+120000;while(!h.store.listAppAgentTurns(key)[0]?.finished_at){assert(Date.now()<until,'real keeper timed out');await sleep(200);}return h.store.listAppAgentTurns(key)[0];}
async function deliver(h:any,id:string){await h.plane.deliver({appId:'session-plus',owner:'lab_alice',agent:'keeper',text:`合成灰度验收。只调用一次 pin_session 收藏已确认的资源 id ${id}，不要搜索、不要读会话、不要使用其他工具；若工具发生不确定结果必须立即停止。`});await h.plane.pump();}
let h=open();
const receipt:any={schema:'octopus-refactor-acceptance/v1',sha,realAgent:true,consumerIds:['app:session-plus:keeper'],scenarios:[mode==='unknown'?'uncertain-effect-no-replay':'capacity-terminal-continue'],scenario:'keeper-real-'+mode,passed:false,startedAt,driverSha256:createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex')};
const artifact=path.join(root,'artifacts',`keeper-${mode}-${sha}-${Date.now()}.json`);fs.writeFileSync(artifact,JSON.stringify(receipt,null,2),{flag:'wx'});
try{
 await deliver(h,'lab-'+mode+'-first');const first=await settled(h);receipt.firstTurnId=first.id;
 assert(faultInjected);assert.equal(first.status,mode==='unknown'?'unknown':'failed');assert.equal(dispatches,1);assert(actualModelRequests>=1);
 const attempts=fetchAttempts;
 for(let i=0;i<4;i++){h.supervisor.kick();await h.plane.pump();await sleep(100);}
 await h.close();h=open();await h.plane.pump();await sleep(1500);
 assert.equal(fetchAttempts,attempts,'terminal/uncertain work must not replay after reopen');assert.equal(dispatches,1);
 assert.equal(h.store.managedExecutions.listOwned('lab_alice')[0].observed,mode==='unknown'?'unknown':'failed');
 const view=await h.app.open({owner:'lab_alice',credential:'ws:fault-acceptance',session:true});assert.equal(view.projection.pinned.filter((id:string)=>id==='lab-'+mode+'-first').length,1);
 if(mode==='capacity'){
  await deliver(h,'lab-capacity-explicit-continue');const next=await settled(h);assert.equal(next.status,'succeeded');assert.notEqual(next.id,first.id);assert.equal(dispatches,2);
  const view=await h.app.open({owner:'lab_alice',credential:'ws:fault-next',session:true});assert(view.projection.pinned.includes('lab-capacity-explicit-continue'));receipt.nextTurnId=next.id;
 }
 receipt.actualModelRequests=actualModelRequests;receipt.fetchAttempts=fetchAttempts;receipt.committedActions=dispatches;receipt.passed=true;receipt.finishedAt=new Date().toISOString();
}catch(error){receipt.error=String(error);throw error;}
finally{fs.writeFileSync(artifact,JSON.stringify(receipt,null,2));await h.close();console.log(JSON.stringify(receipt));}
