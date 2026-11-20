import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';

/** Browser credentials stay in memory; only synthetic named identities may enter. */
export async function labClient(rootInput='/lab', username='lab_alice') {
 const root=path.resolve(rootInput);
 const marker=JSON.parse(fs.readFileSync(path.join(root,'.refactor-lab'),'utf8'));
 const url=new URL(marker.origin);
 assert(url.hostname==='127.0.0.1' && url.protocol==='http:', 'loopback lab origin required');
 assert(username.startsWith('lab_'),'synthetic identity required');
 const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 assert(!execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'candidate tracked source must be clean');
 function assertCandidate() {
  const deployed=JSON.parse(fs.readFileSync(path.join(root,'state/current-deployment.json'),'utf8'));
  assert.equal(deployed.sha,sha,'running Head must match acceptance checkout');
  assert(deployed.startupReady && deployed.containerId,'verified deployment receipt required');
  const heartbeat=Date.parse(fs.readFileSync(path.join(root,'state',`health-${sha}`),'utf8'));
  assert(Number.isFinite(heartbeat) && Date.now()-heartbeat<75000,'running candidate heartbeat required');
  return deployed;
 }
 assertCandidate();
 const playwright=createRequire(path.join(process.cwd(),'package.json'))('playwright');
 const request=await playwright.request.newContext({baseURL:url.origin});
 const credentials=JSON.parse(fs.readFileSync(path.join(root,'private/credentials.json'),'utf8'));
 const login=await request.post('/login',{data:{token:credentials.users[username].dashboard,next:'/'},headers:{origin:url.origin},maxRedirects:0});
 assert.equal(login.status(),303,'fake account login');
 const state=await request.storageState();
 const csrf=state.cookies.find(cookie=>cookie.name.includes('csrf'))?.value;
 assert(csrf,'browser CSRF cookie');
 return {root,sha,assertCandidate,origin:url.origin,request,playwright,state,
  async post(route,data,headers={}){
   const response=await request.post(route,{data,headers:{...headers,origin:url.origin,'x-csrf-token':csrf}});
   const body=await response.json();
   assert(response.ok(),`${route}: ${response.status()} ${JSON.stringify(body).slice(0,1000)}`);
   return body;
  },
  close:()=>request.dispose(),
 };
}
