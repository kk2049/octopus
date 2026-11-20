/** Detached, bounded Git preparation. Never resets a development tree. */
export const WORKSPACE_DEVELOPMENT_WORKER = String.raw`
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const spec=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const deadline=Date.now()+spec.timeout_ms;
const atomic=async(file,value)=>{
  const temp=file+'.'+randomUUID()+'.tmp',h=await fs.open(temp,'wx',0o600);
  try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}
  await fs.rename(temp,file);const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}
};
const read=async(file)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const ticks=async(pid)=>{const s=await fs.readFile('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[19];};
const fail=(code)=>{throw new Error(code);};
const run=(args,cwd=spec.mirror,code='internal_error')=>new Promise((resolve,reject)=>{
  const left=deadline-Date.now();if(left<=0){reject(new Error('timed_out'));return;}
  const child=spawn('timeout',['--signal=TERM','--kill-after=1s',(left/1000).toFixed(3),'git',
    '-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],
    {cwd,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
  let out='',bytes=0;
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576){child.kill('SIGTERM');return;}out+=chunk.toString('utf8');});
  child.stderr.resume();
  child.once('error',()=>reject(new Error(code)));
  child.once('close',exit=>exit===0&&bytes<=1048576?resolve(out.trim()):reject(new Error(exit===124?'timed_out':code)));
});
const canonical=async(dir)=>{if(await fs.realpath(dir)!==dir)fail('workspace_unavailable');};
const safeParent=async()=>{
  const registry=await read(spec.registry);
  const rows=Array.isArray(registry)?registry:registry?.workspaces;
  const parent=rows?.find(row=>row.id===spec.identity.workspace_id);
  if(!parent||parent.path!==spec.root||parent.managed)fail('workspace_unavailable');
  await canonical(spec.root);await canonical(spec.scope);await canonical(spec.dir);
};
let mirrorHeld=false;
const mirrorLock=path.join(spec.scope,'mirror.lock');
const releaseMirror=async()=>{
  if(!mirrorHeld)return;
  const owner=await read(path.join(mirrorLock,'owner.json'));
  if(owner?.request===spec.lock_token){await fs.rm(mirrorLock,{recursive:true});}
  mirrorHeld=false;
};
const acquireMirror=async()=>{
  while(Date.now()<deadline){
    try{
      await fs.mkdir(mirrorLock,{mode:0o700});
      await atomic(path.join(mirrorLock,'owner.json'),{request:spec.lock_token,pid:process.pid,start_ticks:await ticks(process.pid)});
      mirrorHeld=true;return;
    }catch(e){if(e.code!=='EEXIST')throw e;}
    try{
      const stat=await fs.stat(mirrorLock),owner=await read(path.join(mirrorLock,'owner.json'));
      let alive=true;
      if(owner)try{alive=await ticks(owner.pid)===owner.start_ticks;}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')alive=false;else throw e;}
      else alive=Date.now()-stat.mtimeMs<5000;
      if(!alive&&(await fs.stat(mirrorLock)).ino===stat.ino){await fs.rm(mirrorLock,{recursive:true});continue;}
    }catch(e){if(e.code!=='ENOENT')throw e;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  fail('timed_out');
};
// Shared only by this managed site/repository mirror; never edit a tracked ignore file.
// Six suffix characters match the platform's mkdtemp directories at the child root.
const ensureAttachmentExclude=async()=>{
  const info=path.join(spec.mirror,'info');await fs.mkdir(info,{recursive:true,mode:0o700});await canonical(info);
  const file=await fs.open(path.join(info,'exclude'),constants.O_RDWR|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
  try{
    const stat=await file.stat();if(!stat.isFile()||stat.size>65536)fail('workspace_unavailable');
    const existing=await file.readFile('utf8'),rule='/.octopus-attachment-??????/';
    if(!existing.split(/\r?\n/).includes(rule)){
      await file.write((existing&&!existing.endsWith('\n')?'\n':'')+rule+'\n');await file.sync();
    }
  }finally{await file.close();}
};
const download=async(input)=>{
  const file=path.join(spec.dir,'input.bundle'),h=await fs.open(file,'wx',0o600),hash=createHash('sha256');
  let bytes=0;
  try{
    const response=await fetch(input.url,{redirect:'error',signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))}).catch(()=>fail('input_unavailable'));
    if(!response.ok||!response.body)fail('input_unavailable');
    for await(const chunk of response.body){
      bytes+=chunk.length;if(bytes>input.bytes||bytes>spec.max_bundle_bytes)fail('input_invalid');
      hash.update(chunk);await h.write(chunk);
    }
    if(bytes!==input.bytes||hash.digest('hex')!==input.sha256)fail('input_invalid');await h.sync();
  }finally{await h.close();}
  return file;
};
const ancestor=async(base,head,cwd=spec.mirror)=>{try{await run(['merge-base','--is-ancestor',base,head],cwd,'head_mismatch');return true;}catch(e){if(e.message==='head_mismatch')return false;throw e;}};
let result;
try{
  await atomic(path.join(spec.dir,'pid.json'),{pid:process.pid,start_ticks:await ticks(process.pid)});
  await atomic(path.join(spec.dir,'state.json'),{state:'running'});
  await safeParent();
  if(spec.action==='prepare'||spec.action==='sync'){
    if(spec.action==='sync')await canonical(spec.cwd);
    const target=spec.request.target_sha??spec.request.base_sha;
    const bundle=spec.input?await download(spec.input):null;
    await safeParent();await acquireMirror();
    try{
      try{await fs.stat(spec.mirror);}catch(e){if(e.code!=='ENOENT')throw e;await run(['init','--bare',spec.mirror],spec.scope);}
      await canonical(spec.mirror);
      await ensureAttachmentExclude();
      if(bundle){
        await run(['bundle','verify',bundle],spec.mirror,'input_invalid');
        const heads=await run(['bundle','list-heads',bundle],spec.mirror,'input_invalid');
        if(!heads.split('\n').some(line=>line===target+' HEAD'))fail('input_invalid');
        await run(['fetch','--no-tags',bundle,'HEAD'],spec.mirror,'input_invalid');
        if(await run(['rev-parse','FETCH_HEAD'],spec.mirror)!==target)fail('input_invalid');
      }
      await run(['cat-file','-e',target+'^{commit}'],spec.mirror,'base_missing');
      let old=null;try{old=await run(['rev-parse','refs/remotes/octopus/head']);}catch{}
      if(!old||await ancestor(old,target)){
        await run(['update-ref','refs/remotes/octopus/head',target,...(old?[old]:[])]);
      }else if(!await ancestor(target,old))fail('head_mismatch');
      if(spec.action==='prepare'){
        let exists=false;try{await fs.stat(spec.cwd);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
        if(!exists){
          await run(['worktree','add','-b',spec.branch,spec.cwd,spec.request.base_sha]);
        }else{
          await canonical(spec.cwd);
          const common=await run(['rev-parse','--path-format=absolute','--git-common-dir'],spec.cwd);
          if(common!==spec.mirror)fail('binding_mismatch');
        }
      }
      await atomic(path.join(spec.development_dir,'synced.json'),{sha:await run(['rev-parse','refs/remotes/octopus/head'])});
    }finally{await releaseMirror();}
    if(bundle)await fs.unlink(bundle);
  }else{
    await canonical(spec.cwd);
    const head=await run(['rev-parse','HEAD'],spec.cwd);
    if(head!==spec.request.expected_head_sha)fail('head_mismatch');
    const gitDir=await run(['rev-parse','--absolute-git-dir'],spec.cwd);
    for(const marker of spec.git_operation_markers){
      try{await fs.lstat(path.join(gitDir,marker));fail('conflicted_worktree');}
      catch(e){if(e.code!=='ENOENT')throw e;}
    }
    const conflicts=await run(['ls-files','-u'],spec.cwd);
    if(conflicts)fail('conflicted_worktree');
    if(await run(['status','--porcelain','--untracked-files=normal'],spec.cwd))fail('dirty_worktree');
    const synced=await read(path.join(spec.development_dir,'synced.json'));
    if(!synced||!await ancestor(spec.request.expected_base_sha,synced.sha))fail('base_missing');
    if(!await ancestor(spec.request.expected_base_sha,head,spec.cwd))fail('head_mismatch');
    const file=path.join(spec.dir,'source.bundle');
    await run(['bundle','create',file,'HEAD','^'+spec.request.expected_base_sha],spec.cwd,'candidate_invalid');
    if(await run(['bundle','list-heads',file],spec.cwd)!==head+' HEAD')fail('candidate_invalid');
    const h=await fs.open(file,'r'),hash=createHash('sha256');
    let bytes=0;try{for await(const chunk of h.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>spec.max_bundle_bytes)fail('candidate_invalid');hash.update(chunk);}}finally{await h.close();}
    if(await run(['rev-parse','HEAD'],spec.cwd)!==head||await run(['status','--porcelain','--untracked-files=normal'],spec.cwd))fail('head_mismatch');
    await safeParent();
    const candidate={candidate_id:randomUUID(),development_id:spec.identity.development_id,
      base_sha:spec.request.expected_base_sha,head_sha:head,clean:true,
      bundle:{artifact_id:'source.bundle',sha256:hash.digest('hex'),bytes}};
    await atomic(path.join(spec.development_dir,'candidates',candidate.candidate_id+'.json'),{request_id:spec.request.request_id,candidate});
    result={state:'succeeded',candidate};
  }
  await safeParent();
  result??={state:'succeeded'};
}catch(e){
  const allowed=['binding_mismatch','workspace_unavailable','input_unavailable','input_invalid','base_missing','head_mismatch','dirty_worktree','conflicted_worktree','candidate_invalid','timed_out'];
  result={state:'failed',error:allowed.includes(e.message)?e.message:'internal_error'};
}finally{
  await releaseMirror().catch(()=>{});
}
await atomic(path.join(spec.dir,'result.json'),{...result,finished_at:new Date().toISOString()});
const held=await read(path.join(spec.lock_dir,'owner.json'));
if(held?.request===spec.lock_token)await fs.rm(spec.lock_dir,{recursive:true});
`;
