import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it, vi} from 'vitest';
import {SESSION_OPERATION_PROTOCOL} from '@claude-bot/runner/gateway-protocol';
import type {ResearchNode, ResearchRun} from '@claude-bot/research-canvas-contract';
import {composeDashboardServices} from './bootstrap-v3.js';
import {Store} from './store/store.js';
import {RunnerCapabilities} from './runner/capability.js';
import {hashRunnerToken, type RunnerTransport} from './runner/gateway.js';
import {WorkspaceFilesCapabilities} from './workspace-files/capability.js';
import type {ExecutionWorkspaceCapabilities} from './execution-workspace/capability.js';
import {ManagedExecutionSupervisor} from './managed-execution/supervisor.js';
import {ResourceRecoveryService} from './resources/recovery.js';
import {SessionExecutionRegistry} from './mcp/session-execution.js';
import {RESEARCH_CANVAS_CONTRACT, RESEARCH_CANVAS_DIGEST} from './research-canvas/contract.js';
import type {ResearchCanvasPlane} from './research-canvas/plane.js';

it.each(['new', 'ordinary', 'split', 'expired-split', 'moved-split'] as const)('preserves %s placement for a member-triggered research session', async (placement) => {
  const root=mkdtempSync(join(tmpdir(),'research-composition-')), store=new Store(join(root,'state.db'));
  const at=new Date().toISOString(), workspace='ws_123456789012345678901234';
  for (const [index,username] of ['alice','bob'].entries()) store.saveUser({username,uid:1000+index,home_dir:root,created_at:at});
  store.saveRunnerToken(hashRunnerToken('rt_fixture'),'alice','runner',at);
  const frames: {owner:string;operation:string;args:Record<string,unknown>}[]=[];
  const transport: RunnerTransport={dispatch:async(owner,operation,args)=>{
    frames.push({owner,operation,args});
    if(operation==='list_session_workspaces') return {workspaces:[{id:workspace,label:'Research',display:'/work/research'}]};
    if(operation==='read_session'||operation==='session_plus_read_session') return {rich:true,messages:[{role:'assistant',blocks:[{type:'text',text:'Existing history'}]}],offset:0,totalMessages:1,hasMore:false};
    if(operation==='get_session_operation'&&!frames.some(frame=>frame.operation==='start_session'||frame.operation==='append_session')) return {protocol:SESSION_OPERATION_PROTOCOL,operation_id:args.operation_id,state:'missing'};
    if(operation==='start_session'||operation==='append_session'||operation==='get_session_operation') return {protocol:SESSION_OPERATION_PROTOCOL,operation_id:args.operation_id,state:'running',session_id:'native-session',input:{phase:'provider_accepted',evidence:'provider_ack',at,session_id:'native-session',turn_id:'native-turn',transport:'app-server'}};
    throw new Error(`unexpected ${operation}`);
  },listDevices:()=>[{device:'runner',online:true,created_at:at,last_seen_at:at}],isOnline:()=>true,ping:async()=>1,disconnect:()=>false,openDshTunnel:async()=>{throw new Error('unused');}};
  const caps=new RunnerCapabilities(store,transport), files=new WorkspaceFilesCapabilities({service:caps.service,transport,userExists:()=>true,hasDevice:owner=>owner==='alice'});
  const supervisor=new ManagedExecutionSupervisor(store.managedExecutions,new ResourceRecoveryService(store.resourceWaiters));
  let plane:ResearchCanvasPlane|undefined;
  const issue=vi.spyOn(SessionExecutionRegistry.prototype,'issue').mockReturnValue({credential:'fixture',token:'mcp_fixture',endpoint:'http://127.0.0.1:9999/api/mcp',expiresAt:Date.now()+60000,release:()=>{},bindSession:()=>{}});
  const dispatch=vi.spyOn(SessionExecutionRegistry.prototype,'dispatchForSession').mockImplementation(()=>placement==='split'||placement==='expired-split'&&issue.mock.calls.length>0 ? {token:'mcp_existing',endpoint:'http://127.0.0.1:9999/api/mcp',expiresAt:Date.now()+60000,operationId:'original-launch',executionDevice:'runner',workspaceId:workspace,runtimeOwner:'alice',runtimeResourceId:null} : null);
  if(placement==='expired-split'||placement==='moved-split') store.saveSessionPlusSplitSession({owner:'alice',runtime_owner:'alice',runtime_resource_id:null,runtime_device:'runner',source:'codex',session_id:'native-session',catalog_id:'spc_'+'a'.repeat(64),execution_device:placement==='moved-split'?'other-runner':'runner',workspace_id:workspace,workspace_label:'Research',workspace_display:'/work/research',created_at:at,updated_at:at});
  const composition=composeDashboardServices(store,caps,{port:0,workspaceFiles:files,executionWorkspace:{} as ExecutionWorkspaceCapabilities,managedSupervisor:supervisor,
    researchCanvas:{root:join(root,'research'),model:{baseUrl:'',apiKey:'',models:[],defaultModel:'',filterModel:''}},
    attachDeclaredResources:factory=>{plane=factory('research-v2','octopus:first-party') as ResearchCanvasPlane;return()=>{};},
  });
  try {
    for(const owner of ['alice','bob']) composition.services.permissions.grant({subjectType:'app',subjectId:'research-v2',owner,operations:RESEARCH_CANVAS_CONTRACT.operations,autoAllow:RESEARCH_CANVAS_CONTRACT.autoAllow,source:'config',createdBy:'system:test',publisher:'octopus:first-party',contractDigest:RESEARCH_CANVAS_DIGEST});
    store.createSharedAppInstance({app_id:'research-v2',instance_key:'project',creator:'alice',status:'open',created_at:at},'owner');
    store.addSharedAppMember('research-v2','project','bob','researcher',20,at);
    const alice={project:'project',actor:{kind:'human' as const,owner:'alice'}};
    const {node}=await plane!.invokeTool(alice,'node_add',{request:'node',data:{type:'agent',title:'Native researcher'}}) as {node:ResearchNode};
    await plane!.invokeTool(alice,'resource_bind',{request:'bind',node:node.id,data:{kind:'session',resource:`runner:runner:${workspace}`,config:{device:'runner',workspace,provider:'codex',...(placement==='new'?{}:{session:'native-session'})}}});
    const {run}=await plane!.invokeTool({...alice,actor:{kind:'human',owner:'bob'}},'agent_send',{request:'send',node:node.id,prompt:'Inspect the project tools and record findings'}) as {run:ResearchRun};
    if(placement==='moved-split') {
      await vi.waitFor(()=>expect(dispatch).toHaveBeenCalled());
      await vi.waitFor(()=>expect(['failed','unknown','rejected']).toContain(store.listSessionOperations('alice',{surface:'app:research-v2',limit:1})[0]?.status));
      expect(frames.some(frame=>frame.operation==='append_session')).toBe(false);
      expect(issue).not.toHaveBeenCalled();
      return;
    }
    const operation=placement==='new'?'start_session':'append_session';
    await vi.waitFor(()=>expect(frames.some(frame=>frame.operation===operation)).toBe(true));
    const frame=frames.find(frame=>frame.operation===operation)!;
    expect(frame.owner).toBe('alice');
    if(placement==='new') {
      expect(issue).toHaveBeenCalledWith(expect.objectContaining({owner:'alice',runtimeDevice:'runner',executionDevice:'runner',workspaceId:workspace}));
      expect(frame.args).toMatchObject({workspace_id:workspace,_octopus_execution_mcp_token:'mcp_fixture'});
    } else {
      if(placement==='expired-split') expect(issue).toHaveBeenCalledWith(expect.objectContaining({owner:'alice',runtimeDevice:'runner',executionDevice:'runner',workspaceId:workspace}));
      else expect(issue).not.toHaveBeenCalled();
      expect(frame.args).toMatchObject({source:'codex',id:'native-session'});
      if(placement==='split'||placement==='expired-split') expect(frame.args).toMatchObject({workspace_id:workspace,execution_device:'runner',_octopus_execution_mcp_token:'mcp_existing'});
      else {
        for(const key of ['workspace_id','execution_device','_octopus_execution_mcp_token','_octopus_execution_operation_id']) expect(frame.args).not.toHaveProperty(key);
        expect(store.getSessionExecutionBinding('alice','runner','codex','native-session','0000-01-01T00:00:00.000Z')).toBeUndefined();
      }
    }
    await vi.waitFor(()=>expect(store.researchCanvas.get<ResearchRun>('project','runs',run.id)).toMatchObject({trigger:'bob',binding:{owner:'alice'},status:'running'}));
    expect(frames.filter(frame=>frame.operation===operation)).toHaveLength(1);
  } finally {await composition.close();await supervisor.close();issue.mockRestore();dispatch.mockRestore();caps.service.close();store.close();rmSync(root,{recursive:true,force:true});}
});
