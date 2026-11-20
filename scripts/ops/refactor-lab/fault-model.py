#!/usr/bin/env python3
"""Cut only a named lab model tunnel and observe the real App's one-minute wait."""
import argparse,datetime,json,pathlib,re,shlex,subprocess,time
p=argparse.ArgumentParser()
for name in ['head-host','provider-host','provider-unit','lab','root','sha','case','output']:p.add_argument('--'+name,required=True)
p.add_argument('--mode',choices=['resume','stop','brief'],default='resume')
a=p.parse_args()
for value in [a.head_host,a.provider_host,a.provider_unit,a.lab,a.case]:assert re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,70}',value)
assert a.provider_unit.startswith('octopus-refactor-') and a.provider_unit.endswith('.service')
assert re.fullmatch(r'[0-9a-f]{40}',a.sha) and a.root.startswith('/')
def ssh(host,args,timeout=30):return subprocess.check_output(['ssh',host,shlex.join(args)],text=True,timeout=timeout).strip()
name='octopus-refactor-'+a.lab
head=json.loads(ssh(a.head_host,['sudo','-n','docker','inspect',name+'-head']))[0]
assert head['Config']['Labels'].get('octopus.role')=='refactor-lab'
assert head['Config']['Labels'].get('octopus.lab')==a.lab and head['Config']['Labels'].get('octopus.candidate')==a.sha
assert ssh(a.provider_host,['systemctl','is-active',a.provider_unit])=='active'
record={'schema':'octopus-refactor-fault/v1','sha':a.sha,'caseId':a.case,'passed':False,'events':[], 'scenarios':['brief-network-outage'] if a.mode=='brief' else []}
out=pathlib.Path(a.output);out.parent.mkdir(parents=True,exist_ok=True)
with out.open('x') as f:json.dump(record,f)
def event(name):
 row={'event':name,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()};record['events'].append(row);out.write_text(json.dumps(record,indent=2));print(json.dumps(row),flush=True)
driver=None
try:
 if a.mode!='brief':
  ssh(a.head_host,['sudo','-n','docker','exec','-w','/lab/releases/'+a.sha,name,'/usr/local/bin/node','/lab/drivers/accept-app-wait.mjs','/lab',a.case,'preflight'],timeout=210)
 event('provider-stopped');ssh(a.provider_host,['systemctl','stop',a.provider_unit])
 driver=subprocess.Popen(['ssh',a.head_host,shlex.join(['sudo','-n','docker','exec','-w','/lab/releases/'+a.sha,name,'/usr/local/bin/node','/lab/drivers/accept-knowledge.mjs' if a.mode=='brief' else '/lab/drivers/accept-app-wait.mjs','/lab',a.case,'brief-offline' if a.mode=='brief' else a.mode])],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 deadline=time.monotonic()+150
 while True:
  result=subprocess.run(['ssh',a.head_host,shlex.join(['sudo','-n','test','-f',a.root+'/artifacts/'+a.case+'-ready.json'])],capture_output=True,timeout=10)
  if result.returncode==0:break
  if driver.poll() is not None:raise RuntimeError(driver.communicate()[0][-3000:])
  if time.monotonic()>deadline:raise RuntimeError('visible wait did not appear')
  time.sleep(2)
 if a.mode=='brief':
  event('original-request-created');time.sleep(10)
 else:event('visible-wait-observed')
 ssh(a.provider_host,['systemctl','start',a.provider_unit]);event('provider-restored')
 ssh(a.head_host,['sudo','-n','touch',a.root+'/artifacts/'+a.case+'-restored.json'])
 text=driver.communicate(timeout=180)[0];assert driver.returncode==0,text[-3000:]
 result=json.loads(ssh(a.head_host,['sudo','-n','cat',a.root+'/artifacts/'+a.case+'.json']));assert result['passed'] and result['sha']==a.sha
 record['passed']=True;event('passed')
finally:
 ssh(a.provider_host,['systemctl','start',a.provider_unit])
 if driver and driver.poll() is None:driver.terminate()
 out.write_text(json.dumps(record,indent=2))
 subprocess.run(['scp',str(out),a.head_host+':/tmp/'+a.case+'-fault.json'],check=True)
 ssh(a.head_host,['sudo','-n','cp','/tmp/'+a.case+'-fault.json',a.root+'/artifacts/'+a.case+'-fault.json'])
