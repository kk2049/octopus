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
const dir=path.join(root,'harness',`keeper-${sha}-${Date.now()}`);fs.mkdirSync(dir,{recursive:true,mode:0o700});
const config=JSON.parse(fs.readFileSync(path.join(root,'private/config.json'),'utf8'));assert.equal(new URL(config.openai.base_url).hostname,'127.0.0.1');
const state=new AppStateService(dir);const runtime=new AppRuntimeService(bundledAppDir('session-plus'));const store=new Store(path.join(dir,'bot.db'));
const manifest=loadSessionPlusManifest();const app=new SessionPlusAppService({state:new InProcessStateClient(state),runtime:new InProcessRuntimeClient(runtime),identity:sessionPlusIdentity(),manifest});
const supervisor=new ManagedExecutionSupervisor(store.managedExecutions,new ResourceRecoveryService(store.resourceWaiters));let modelRequests=0;
const plane=new AppAgentPlane({supervisor,store,backends:[new SessionPlusAgentBackend({app,manifest:()=>manifest})],
 loop:new AgentLoop({baseUrl:config.openai.base_url,apiKey:config.openai.api_key,fetchImpl:async(...args:any[])=>{modelRequests++;return fetch(...args);}}),defaultModel:'gpt-5.6-sol',defaultEffort:'low'});
plane.completeBackendRegistration();const startedAt=new Date().toISOString();
try{
 await plane.deliver({appId:'session-plus',owner:'lab_alice',agent:'keeper',text:'这是合成灰度验收。我已确认资源 id 为 lab-keeper-session。请仅调用 pin_session 一次收藏这个明确指定的 id，不搜索、不刷新、不打开会话，不改标题，不执行命令。'});
 await plane.pump();const key={appId:'session-plus',scopeKey:'account:lab_alice',agent:'keeper'};
 const end=Date.now()+120000;while(!store.listAppAgentTurns(key)[0]?.finished_at){if(Date.now()>end)throw new Error('keeper timed out');await new Promise(r=>setTimeout(r,250));}
 const turn=store.listAppAgentTurns(key)[0];assert.equal(turn.status,'succeeded',turn.note??'');
 const tab=await app.open({owner:'lab_alice',credential:'ws:lab-keeper',session:true});
 assert(tab.projection.pinned.includes('lab-keeper-session'));
 const other=await app.open({owner:'lab_bob',credential:'ws:lab-keeper-bob',session:true});assert(!other.projection.pinned.includes('lab-keeper-session'));
 assert(store.managedExecutions.listOwned('lab_alice').some((r:any)=>r.observed==='completed'));
 const receipt={schema:'octopus-refactor-acceptance/v1',scenario:'session-plus-keeper-real-inbox',realAgent:true,consumerIds:['app:session-plus:keeper'],scenarios:['cross-owner-isolation'],sha,driverSha256:createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex'),startedAt,finishedAt:new Date().toISOString(),modelRequests,turnId:turn.id,toolCalls:turn.tool_calls,passed:true};
 fs.writeFileSync(path.join(root,'artifacts',`keeper-${sha}.json`),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{await plane.stop();await supervisor.close();await app.stop();await runtime.stop();state.close();store.close();}
