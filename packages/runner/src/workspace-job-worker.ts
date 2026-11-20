/** Trusted, self-contained device worker. Detached from both the gateway and Runner. */
export const WORKSPACE_JOB_WORKER = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const chunks=[];
for await (const chunk of process.stdin) chunks.push(chunk);
const spec=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const dir=spec.job_dir;
const atomic=async (name,value)=>{const target=path.join(dir,name); const temp=target+'.'+process.pid+'.tmp';
  const h=await fs.open(temp,'w',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}
  await fs.rename(temp,target);const parent=await fs.open(dir,'r');try{await parent.sync();}finally{await parent.close();}};
const exists=async(file)=>{try{await fs.stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const incarnation=async(pid)=>{const s=await fs.readFile('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[19];};
let current=null, reason=null, logBytes=0;
const deadline=Date.now()+spec.timeout_ms;
const log=await fs.open(path.join(dir,'output.log'),'a',0o600);
let writes=Promise.resolve();
const append=(chunk)=>{logBytes+=chunk.length;if(logBytes>16*1024*1024){reason='log_limit';stop();return;}
  writes=writes.then(()=>log.write(chunk)).catch(()=>{reason='log_io';stop();});};
function stop(){if(current){try{process.kill(-current.pid,'SIGTERM');}catch{}}}
function controlFailure(error,phase){
  reason??='control_io';
  const code=/^[A-Z0-9_]{1,40}$/.test(error?.code??'')?error.code:'UNKNOWN';
  append(Buffer.from('control_io '+phase+' '+code+'\n'));stop();
}
function exited(child){
  if(child.exitCode!==null||child.signalCode!==null)return true;
  try{process.kill(child.pid,0);return false;}catch(error){return error.code==='ESRCH';}
}
const poll=setInterval(async()=>{
  try{if(await exists(path.join(dir,'cancel.json')))reason='cancelled';else if(Date.now()>=deadline)reason='timed_out';
    if(reason){stop(); if(current){const child=current;setTimeout(()=>{if(current===child){try{process.kill(-child.pid,'SIGKILL');}catch{}}},1000).unref();}}}
  catch(error){controlFailure(error,'control_poll');}
},200);
const run=(bin,args,cwd)=>new Promise((resolve,reject)=>{
  if(reason){reject(new Error(reason));return;}
  // coreutils timeout survives a killed worker and bounds the command independently.
  const seconds=Math.max(0.001,(deadline-Date.now())/1000).toFixed(3);
  const child=spawn('timeout',['--signal=TERM','--kill-after=1s',seconds,bin,...args],{cwd,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,OCTOPUS_JOB_ARTIFACT_DIR:path.join(dir,'artifacts'),OCTOPUS_JOB_INPUT_DIR:path.join(dir,'inputs'),OCTOPUS_COMPUTE_ROLE:'worker'}});current=child;
  let identity=Promise.resolve(),spawnError=null;
  child.once('spawn',()=>{
    identity=(async()=>{
      let start_ticks;
      try{start_ticks=await incarnation(child.pid);}
      catch(error){
        // A fast command can be reaped before /proc answers. Only absence of
        // this exited process is benign; unreadable identity for a live child fails.
        // An already-open proc stat descriptor reports ESRCH after its task exits.
        if((error.code==='ENOENT'||error.code==='ESRCH')&&exited(child))return;
        controlFailure(error,'child_identity_read');return;
      }
      try{await atomic('child.json',{pid:child.pid,start_ticks});}
      catch(error){controlFailure(error,'child_identity_write');}
    })();
  });
  child.stdout.on('data',append);child.stderr.on('data',append);
  child.once('error',error=>{spawnError=error;});
  child.once('close',(code,signal)=>{
    if(current===child)current=null;
    // Do not reuse child.json's temporary file or start another command while
    // this command's identity callback can still write or report a failure.
    void identity.then(()=>{if(spawnError)reject(spawnError);else resolve({code,signal});},reject);
  });
});
const checked=async(bin,args,cwd)=>{const r=await run(bin,args,cwd);if(r.code!==0)throw new Error('preparation_failed');return r;};
let result;
try{
  await atomic('pid.json',{pid:process.pid,start_ticks:await incarnation(process.pid)});
  await atomic('state.json',{state:'running',started_at:new Date().toISOString()});
  if(!spec.input&&!(await exists(spec.cwd))&&spec.source_root&&await exists(path.join(spec.source_root,'.git'))){
    await fs.mkdir(path.dirname(spec.cwd),{recursive:true});
    await checked('git',['clone','--quiet','--shared','--no-checkout',spec.source_root,spec.cwd],path.dirname(spec.cwd));
    await checked('git',['checkout','--quiet','--detach',spec.repo_sha],spec.cwd);
  }
  for(const file of spec.files??[]){
    const inputDir=path.join(dir,'inputs');await fs.mkdir(inputDir,{recursive:true,mode:0o700});
    const h=await fs.open(path.join(inputDir,file.name),'wx',0o600),hash=createHash('sha256');let bytes=0;
    try{const response=await fetch(file.url,{redirect:'error',signal:AbortSignal.timeout(Math.min(spec.timeout_ms,120000))});
      if(!response.ok||!response.body)throw new Error('input_download_failed');
      for await(const chunk of response.body){if(reason)throw new Error(reason);bytes+=chunk.length;
        if(bytes>file.bytes)throw new Error('input_size_mismatch');hash.update(chunk);await h.write(chunk);}
      if(bytes!==file.bytes||hash.digest('hex')!==file.sha256)throw new Error('input_digest_mismatch');await h.sync();
    }finally{await h.close();}
  }
  if(spec.input){
    const bundle=path.join(dir,'input.bundle');const h=await fs.open(bundle,'wx',0o600);const hash=createHash('sha256');let bytes=0;
    try{const response=await fetch(spec.input.url,{redirect:'error',signal:AbortSignal.timeout(Math.min(spec.timeout_ms,120000))});
      if(!response.ok||!response.body)throw new Error('input_download_failed');
      for await(const chunk of response.body){if(reason)throw new Error(reason);bytes+=chunk.length;
        if(bytes>spec.input.bytes)throw new Error('input_size_mismatch');hash.update(chunk);await h.write(chunk);}
      if(bytes!==spec.input.bytes||hash.digest('hex')!==spec.input.sha256)throw new Error('input_digest_mismatch');await h.sync();
    }finally{await h.close();}
    const target=spec.cwd;
    if(!(await exists(target))){await fs.mkdir(path.dirname(target),{recursive:true});
      if(spec.source_root&&await exists(path.join(spec.source_root,'.git'))){
        await checked('git',['clone','--quiet','--shared','--no-checkout',spec.source_root,target],path.dirname(target));
        await checked('git',['fetch','--quiet',bundle,'HEAD'],target);
      }else await checked('git',['clone','--quiet','--no-checkout',bundle,target],path.dirname(target));
    }else{await checked('git',['fetch','--quiet',bundle,'HEAD'],target);}
    await checked('git',['checkout','--quiet','--detach',spec.repo_sha],target);
    await checked('git',['reset','--hard','--quiet',spec.repo_sha],target);
    await checked('git',['clean','-fdq','-e','node_modules','-e','dist'],target);
    await fs.unlink(bundle);
  }
  // The task's commands see exactly its committed input, not merely a matching directory label.
  await checked('git',['diff','--quiet','HEAD','--'],spec.cwd);
  const actual=await fs.readFile(path.join(spec.cwd,'.git','HEAD'),'utf8').catch(()=>null);
  if(actual!==null&&actual.trim()!==spec.repo_sha)throw new Error('source_sha_mismatch');
  // git rev-parse also supports a managed worktree .git file.
  await checked('bash',['-c','test "$(git rev-parse HEAD)" = "$1"','verify-sha',spec.repo_sha],spec.cwd);
  const r=await run('bash',['-c',spec.command],spec.cwd);
  if(r.code===124&&Date.now()>=deadline&&!reason)reason='timed_out';
  result={state:reason==='cancelled'?'cancelled':reason==='timed_out'?'timed_out':r.code===0&&!reason?'succeeded':'failed',
    exit_code:r.code,signal:r.signal,error:reason,finished_at:new Date().toISOString()};
}catch(e){result={state:reason==='cancelled'?'cancelled':reason==='timed_out'?'timed_out':'failed',
  exit_code:null,error:reason||(['input_download_failed','input_size_mismatch','input_digest_mismatch','source_sha_mismatch','preparation_failed'].includes(e.message)?e.message:'execution_failed'),finished_at:new Date().toISOString()};}
finally{clearInterval(poll);await writes;await log.sync();await log.close();}
await atomic('result.json',result);
// A terminal receipt is durable before the next task can acquire this execution slot.
try{if((await fs.readFile(path.join(spec.lock_dir,'job-id'),'utf8'))===spec.lock_token){await fs.unlink(path.join(spec.lock_dir,'job-id'));await fs.rmdir(spec.lock_dir);const parent=await fs.open(path.dirname(spec.lock_dir),'r');try{await parent.sync();}finally{await parent.close();}}}catch{}
`;
