/** Enable tickets on a private source mirror, with production deployment uncomposed. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]??'/lab');assert(fs.existsSync(path.join(root,'.refactor-lab')));
const configFile=path.join(root,'private/config.json');const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
assert(!config.channels || Object.keys(config.channels).length===0);assert(!config.selfhosting?.run_dir);
const repo=path.join(root,'ticket-repo');
if(!fs.existsSync(repo)){
 execFileSync('git',['clone','--no-hardlinks','--no-checkout',process.cwd(),repo],{stdio:'pipe'});
 execFileSync('git',['-C',repo,'remote','remove','origin']);
 execFileSync('git',['-C',repo,'checkout','-B','v4','HEAD'],{stdio:'pipe'});
 execFileSync('git',['-C',repo,'config','user.name','Lab Agent']);execFileSync('git',['-C',repo,'config','user.email','lab@example.invalid']);
}
assert.equal(execFileSync('git',['-C',repo,'remote'],{encoding:'utf8'}).trim(),'');
const registry=JSON.parse(fs.readFileSync(path.join(root,'runners/execution/.octopus-runner/workspaces.json'),'utf8'));
const parent=registry.workspaces.find((w:any)=>w.path===path.join(root,'workspaces/sessions'));
assert(parent,'known synthetic workspace only');
config.selfhosting={enabled:true,repo_dir:repo,worktrees_dir:path.join(root,'ticket-worktrees'),base_branch:'v4',stable_branch:'v4-stable',build_warm:false,
 knowledge_index:{enabled:false},runner_tickets:{targets:{lab_alice:{device:'lab_alice_model',workspace_id:parent.id,workspaces:[{device:'lab_alice_execution',workspace_id:parent.id,label:'Synthetic ticket workspace'}],permission_profile:'full_access',instructions:'这是隔离灰度实例。没有生产部署能力或生产 Git 远端，只允许操作这个合成工单的开发工作区。'}},initial_grants:{lab_alice:{operations:['start_session','append_session','get_session_operation','read_session','upload_session_file'],auto_allow:['start_session','append_session','get_session_operation','read_session','upload_session_file']}}}};
fs.copyFileSync(configFile,configFile+'.before-tickets');fs.chmodSync(configFile+'.before-tickets',0o600);
fs.writeFileSync(configFile,JSON.stringify(config,null,2),{mode:0o600});
console.log(JSON.stringify({repo,workspace:parent.id,productionDeploymentComposed:false,gitRemotes:[]}));
