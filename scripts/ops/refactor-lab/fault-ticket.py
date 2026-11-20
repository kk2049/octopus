#!/usr/bin/env python3
"""A real ticket remains attached through isolated Head/peer restarts."""
import argparse,datetime,hashlib,json,pathlib,re,shlex,subprocess,time
p=argparse.ArgumentParser()
for key in ['head-host','lab','root','sha','case','output']:p.add_argument('--'+key,required=True)
p.add_argument('--peer-lab');a=p.parse_args()
for value in [a.head_host,a.lab,a.case]+([a.peer_lab] if a.peer_lab else []):assert re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}',value)
assert re.fullmatch(r'[a-f0-9]{40}',a.sha) and a.root.startswith('/')
def ssh(args,timeout=90):return subprocess.check_output(['ssh',a.head_host,shlex.join(args)],text=True,timeout=timeout).strip()
builder='octopus-refactor-'+a.lab;head=builder+'-head'
def owned(name,lab):
 d=json.loads(ssh(['sudo','-n','docker','inspect',name]))[0];labels=d['Config']['Labels'];assert labels.get('octopus.role')=='refactor-lab' and labels.get('octopus.lab')==lab;assert labels.get('octopus.candidate')==a.sha;return d
owned(head,a.lab)
record={'schema':'octopus-refactor-acceptance/v1','sha':a.sha,'caseId':a.case,'realAgent':True,'consumerIds':['ticket'],'scenarios':['head-restart']+(['multi-head-isolation'] if a.peer_lab else []),'passed':False,'events':[], 'driverSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
out=pathlib.Path(a.output);out.parent.mkdir(parents=True,exist_ok=True)
with out.open('x') as f:json.dump(record,f)
def event(name,data=None):
 row={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'event':name,'data':data};record['events'].append(row);out.write_text(json.dumps(record,indent=2));print(json.dumps(row),flush=True)
def driver(name,*args):return ssh(['sudo','-n','docker','exec','-w','/lab/releases/'+a.sha,builder,'/usr/local/bin/node','/lab/drivers/'+name,'/lab',a.case,*args])
def observe():return json.loads(driver('observe-ticket.mjs'))
def wait(predicate,seconds=180):
 deadline=time.monotonic()+seconds
 while True:
  value=observe()
  if predicate(value):return value
  if time.monotonic()>deadline:raise RuntimeError('ticket condition timeout: '+json.dumps(value))
  time.sleep(2)
try:
 driver('accept-ticket-start.mjs');first=wait(lambda v:v['started'] and len(v['turns'])==1 and v['sessionId']);assert not first['done'];event('original-active',first)
 if a.peer_lab:
  peer='octopus-refactor-'+a.peer_lab+'-head';owned(peer,a.peer_lab);execution=owned(builder+'-execution',a.lab)
  command=['sudo','-n','docker','exec','-u','1000','-e','RUNNER_SCAN_HOME=/lab/runners/execution',builder+'-execution','/usr/local/bin/node','/lab/releases/'+a.sha+'/packages/runner/dist/standalone.js','sites','list']
  before=json.loads(ssh(command));assert len(before)==2 and all(s['online'] for s in before);assert before[0]['controls_machine'] and not before[1]['controls_machine'];event('two-full-heads',before)
  primary=owned(head,a.lab)['State']['StartedAt'];ssh(['sudo','-n','docker','restart','--timeout','75',peer]);event('peer-restarted')
  deadline=time.monotonic()+45
  while True:
   sites=json.loads(ssh(command))
   assert next(s for s in sites if s['id']=='primary')['online']
   if all(s['online'] for s in sites):break
   if time.monotonic()>deadline:raise RuntimeError('peer did not reconnect')
   time.sleep(2)
  assert owned(head,a.lab)['State']['StartedAt']==primary and owned(builder+'-execution',a.lab)['State']['StartedAt']==execution['State']['StartedAt'];event('primary-uninterrupted',sites)
 ssh(['sudo','-n','docker','restart','--timeout','75',head]);event('primary-head-restarted')
 # Give the bounded bootstrap its normal readiness window before authenticated reads.
 deadline=time.monotonic()+90
 while True:
  try:
   now=observe();break
  except subprocess.CalledProcessError:
   if time.monotonic()>deadline:raise
   time.sleep(2)
 done=wait(lambda v:v['done'] and not v['turnStartedAt'] and any(j['observed']=='completed' for j in v['jobs']),240);assert done['sessionId']==first['sessionId'] and done['turns'][0]['id']==first['turns'][0]['id']
 final=json.loads(driver('observe-ticket.mjs','finish'));event('original-completed',final);record['passed']=True;event('passed')
finally:
 out.write_text(json.dumps(record,indent=2));subprocess.run(['scp',str(out),a.head_host+':/tmp/'+a.case+'-fault.json'],check=True)
 ssh(['sudo','-n','cp','/tmp/'+a.case+'-fault.json',a.root+'/artifacts/'+a.case+'-fault.json'])
