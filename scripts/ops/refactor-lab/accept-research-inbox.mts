/** Real model + declared Research MCP inbox; distinct from parent-owned Apps MCP calls. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const load=(file:string)=>import(pathToFileURL(path.join(process.cwd(),file)).href);
const {AppRuntimeService,InProcessRuntimeClient,backendRelease}=await load('packages/app-runtime/src/index.ts');
const {AppStateService,InProcessStateClient}=await load('packages/app-state/src/index.ts');
const {Store}=await load('packages/bot/src/store/store.ts');
const {AppInstanceService}=await load('packages/bot/src/app-registry/app-instance.ts');
const {DeclaredAppAgentBackend}=await load('packages/bot/src/app-registry/declared-agent-backend.ts');
const {ManagedExecutionSupervisor}=await load('packages/bot/src/managed-execution/supervisor.ts');
const {ResourceRecoveryService}=await load('packages/bot/src/resources/recovery.ts');
const {AgentLoop}=await load('packages/bot/src/app-agents/loop.ts');const {AppAgentPlane}=await load('packages/bot/src/app-agents/plane.ts');
const root=path.resolve(process.argv[2]??'/lab');assert(fs.existsSync(path.join(root,'.refactor-lab')));
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();assert(!execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim());
const stamp=Date.now();const dir=path.join(root,'harness',`research-mcp-${sha}-${stamp}`);fs.mkdirSync(dir,{recursive:true,mode:0o700});
const config=JSON.parse(fs.readFileSync(path.join(root,'private/config.json'),'utf8'));assert.equal(new URL(config.openai.base_url).hostname,'127.0.0.1');
const packed=JSON.parse(fs.readFileSync(path.join(root,'artifacts',`research-program-${sha}.bundle.json`),'utf8'));
const appDir=path.join(root,'state/app-releases/prepared',packed.descriptor.packageDigest);
const state=new AppStateService(dir);const runtime=new AppRuntimeService(appDir);const store=new Store(path.join(dir,'bot.db'));
const release={stableAppId:'research-program',publisher:packed.descriptor.publisher,packageDigest:packed.descriptor.packageDigest,permissionContractDigest:packed.descriptor.permissionContractDigest,backendCodeDigest:backendRelease(appDir).backendCodeDigest,appDir};
assert(release.packageDigest&&release.backendCodeDigest);
const instanceKey='asi_lab_research_inbox';store.createSharedAppInstance({app_id:'research-program',instance_key:instanceKey,creator:'lab_alice',created_at:new Date().toISOString(),status:'open'},'owner');
const app=new AppInstanceService({state:new InProcessStateClient(state),runtime:new InProcessRuntimeClient(runtime),activeRelease:()=>release,servableRelease:(digest:string)=>digest===release.packageDigest?release:null,servablePackageDigests:()=>new Set([release.packageDigest]),shared:{instance:(appId:string,key:string)=>store.getSharedAppInstance(appId,key),member:(appId:string,key:string,owner:string)=>store.getSharedAppMember(appId,key,owner)}});
const supervisor=new ManagedExecutionSupervisor(store.managedExecutions,new ResourceRecoveryService(store.resourceWaiters));let modelRequests=0;
const plane=new AppAgentPlane({supervisor,store,backends:[new DeclaredAppAgentBackend('research-program',app)],loop:new AgentLoop({baseUrl:config.openai.base_url,apiKey:config.openai.api_key,fetchImpl:async(...args:any[])=>{modelRequests++;return fetch(...args);}}),defaultModel:'gpt-5.6-sol',defaultEffort:'low'});
plane.completeBackendRegistration();const startedAt=new Date().toISOString();const recordId=`lab-inbox-${stamp}`;
const receipt:any={schema:'octopus-refactor-acceptance/v1',scenario:'research-mcp-real-inbox',sha,passed:false,realAgent:true,consumerIds:['app:research-program:mcp'],scenarios:['cross-owner-isolation'],startedAt,driverSha256:createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex')};
try{
 const delivery=await plane.deliver({appId:'research-program',owner:'lab_alice',instanceKey,agent:'mcp',text:`这是隔离测试。请调用 research_record 一次登记记录 record=${recordId}，kind=note，title=合成验收，body=没有实验结果，属于 Agent 推断而非真人批准。origin=imported。可选数组字段省略。不要询问，不运行实验，不请求确认。`});assert(delivery.ok);
 const key={appId:'research-program',scopeKey:`shared:${instanceKey}:lab_alice`,agent:'mcp'};
 const end=Date.now()+120000;while(!store.listAppAgentTurns(key)[0]?.finished_at){assert(Date.now()<end,'real Research inbox timeout');await new Promise(r=>setTimeout(r,250));}
 const turn=store.listAppAgentTurns(key)[0];assert.equal(turn.status,'succeeded',turn.note??'');
 const tab=await app.open({owner:'lab_alice',credential:'ws:lab-research',session:true},{instanceKey});assert(JSON.stringify(tab.projection).includes(recordId),'real persisted research record');
 await assert.rejects(()=>app.open({owner:'lab_bob',credential:'ws:lab-research-bob',session:true},{instanceKey}));
 receipt.modelRequests=modelRequests;receipt.turnId=turn.id;receipt.toolCalls=turn.tool_calls;receipt.passed=true;receipt.finishedAt=new Date().toISOString();
}catch(error){receipt.error=String(error);throw error;}
finally{fs.writeFileSync(path.join(root,'artifacts',`research-inbox-${sha}-${stamp}.json`),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));await plane.stop();await supervisor.close();await app.stop();await runtime.stop();state.close();store.close();}
