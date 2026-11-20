#!/usr/bin/env python3
"""Orchestrate a real split-agent outage using explicitly named isolated services.
Run on the operator host. Never selects a production Runner or guesses ownership.
"""
import argparse, datetime, hashlib, json, pathlib, re, shlex, subprocess, time
p=argparse.ArgumentParser()
for arg in ['head-host','runner-host','root','model-root','model-container','model-unit','lab','sha','case','output']:
    p.add_argument('--'+arg,required=True)
p.add_argument('--stop-while-waiting',action='store_true')
p.add_argument('--revoke-while-waiting',action='store_true')
p.add_argument('--wait-seconds',type=int,default=70)
a=p.parse_args()
assert 70 <= a.wait_seconds <= 2400
assert not (a.stop_while_waiting and a.revoke_while_waiting)
for value in [a.head_host,a.runner_host,a.model_container,a.model_unit,a.lab,a.case]:
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}',value):p.error('bounded explicit host/container/lab/case names required')
if not re.fullmatch(r'[0-9a-f]{40}',a.sha):p.error('exact candidate SHA required')
if not a.root.startswith('/') or not a.model_root.startswith('/') or '/.octopus-labs/' not in a.model_root:p.error('explicit isolated roots required')
output=pathlib.Path(a.output);output.parent.mkdir(parents=True,exist_ok=True)
record={'schema':'octopus-refactor-acceptance/v1','scenario':'native-stop-while-waiting' if a.stop_while_waiting else 'native-split-recovery',
        'realAgent':True,'consumerIds':['sessions-native','mcp-execution-scope'],'scenarios':['minute-visible-wait']+(['stop-while-waiting'] if a.stop_while_waiting else ['runtime-presence-wake','original-session-resume']),
        'caseId':a.case,'sha':a.sha,'passed':False,'events':[], 'driverSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
with output.open('x') as file:json.dump(record,file)
def ssh(host,args,timeout=60,check=True):
    result=subprocess.run(['ssh',host,shlex.join(args)],text=True,capture_output=True,timeout=timeout)
    if check:result.check_returncode()
    return result.stdout.strip() if check else result
def event(name,data=None):
    row={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'event':name,'data':data}
    record['events'].append(row);output.write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(row),flush=True)
def owned(name):
    value=json.loads(ssh(a.head_host,['sudo','-n','docker','inspect',name]))[0]
    labels=value['Config'].get('Labels',{})
    assert labels.get('octopus.role')=='refactor-lab' and labels.get('octopus.lab')==a.lab
    return value
builder=f'octopus-refactor-{a.lab}';execution=builder+'-execution';head=builder+'-head'
unit=a.model_unit
assert unit.startswith('octopus-refactor-') and unit.endswith('.service')
assert ssh(a.runner_host,['systemctl','is-active',unit])=='active'
# A specific unit is required; prove that it starts this isolated root first.
assert a.model_root in ssh(a.runner_host,['systemctl','cat',unit])
assert owned(head)['Config']['Labels']['octopus.candidate']==a.sha
owned(builder);owned(execution)
assert ssh(a.head_host,['sudo','-n','test','-f',a.root+'/.refactor-lab'])==''
expected=ssh(a.head_host,['sudo','-n','sha256sum',a.root+'/releases/'+a.sha+'/packages/runner/dist/standalone.js']).split()[0]
actual=ssh(a.runner_host,['docker','exec',a.model_container,'sha256sum',a.model_root+'/runners/model/.octopus/runner/standalone.js']).split()[0]
assert actual==expected
record['runnerSha256']=expected
if a.wait_seconds>1800:record['scenarios'].append('over-30-minute-wait')
if a.revoke_while_waiting:record['scenarios']=['minute-visible-wait','authorization-revocation']
fields=['session','status','turnId','recoveryCount','recoveryPhase','unavailableSince','nextRetryAt','updatedAt']
def journal():
    code='import json;d=json.load(open('+repr(a.model_root+'/runners/model/.octopus/managed-recovery.json')+'));print(json.dumps([{k:r.get(k) for k in '+repr(fields)+'} for r in d["records"]]))'
    return json.loads(ssh(a.runner_host,['docker','exec','-u','ubuntu',a.model_container,'python3','-c',code]))
def marker(suffix):return ssh(a.head_host,['sudo','-n','test','-f',a.root+'/workspaces/sessions/'+a.case+'-'+suffix+'.txt'],check=False).returncode==0
def wait_for(predicate,seconds):
    end=time.monotonic()+seconds
    while not predicate():
        if time.monotonic()>end:raise RuntimeError('acceptance condition timed out')
        time.sleep(2)
before={r['session']['logicalId'] for r in journal()}
driver=subprocess.Popen(['ssh',a.head_host,shlex.join(['sudo','-n','docker','exec','-w','/lab/releases/'+a.sha,builder,'/usr/local/bin/node','/lab/drivers/accept-native-start.mjs','/lab',a.case])],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
model_stopped=False;execution_stopped=False
try:
    wait_for(lambda:marker('started'),150);assert not marker('done')
    fresh=[r for r in journal() if r['session']['logicalId'] not in before];assert len(fresh)==1
    sid=fresh[0]['session']['logicalId'];record['sessionId']=sid;assert fresh[0]['status']=='active'
    def current():return next(r for r in journal() if r['session']['logicalId']==sid)
    event('original-active',fresh[0]);event('stop-model')
    model_stopped=True;ssh(a.runner_host,['systemctl','stop',unit],90)
    event('stop-execution');execution_stopped=True;ssh(a.head_host,['sudo','-n','docker','stop','--timeout','40',execution])
    event('restart-model-only');ssh(a.runner_host,['systemctl','start',unit]);model_stopped=False
    wait_for(lambda:current().get('recoveryPhase')=='waiting_resource',45)
    event('offline-journal',current())
    # The product grace is one minute; retain outage for 70s before observing UI.
    time.sleep(a.wait_seconds)
    row=current();assert row['recoveryPhase']=='waiting_resource';assert not marker('done')
    event('minute-wait',row)
    mode='stop' if a.stop_while_waiting else 'waiting'
    ui=ssh(a.head_host,['sudo','-n','docker','exec','-w','/lab/releases/'+a.sha,builder,'/usr/local/bin/node','/lab/drivers/observe-native.mjs','/lab',a.case,sid,mode],70)
    event('public-ui',json.loads(ui.splitlines()[-1]));assert json.loads(ui.splitlines()[-1])['passed']
    if a.revoke_while_waiting:
        # Freeze scope rotation while the synthetic owner revokes the exact binding.
        model_stopped=True;ssh(a.runner_host,['systemctl','stop',unit],90)
        revoked=ssh(a.head_host,['sudo','-n','docker','exec','-w','/lab/releases/'+a.sha,builder,'/usr/local/bin/node','/lab/drivers/revoke-native.mjs','/lab',sid])
        event('scope-revoked',json.loads(revoked));ssh(a.runner_host,['systemctl','start',unit]);model_stopped=False
        wait_for(lambda:current()['status']=='unknown',45)
        ui=ssh(a.head_host,['sudo','-n','docker','exec','-w','/lab/releases/'+a.sha,builder,'/usr/local/bin/node','/lab/drivers/observe-native.mjs','/lab',a.case,sid,'unknown'],70)
        event('revocation-visible',json.loads(ui.splitlines()[-1]));assert json.loads(ui.splitlines()[-1])['passed']
    event('restore-execution');restored=time.monotonic();ssh(a.head_host,['sudo','-n','docker','start',execution]);execution_stopped=False
    if a.stop_while_waiting or a.revoke_while_waiting:
        time.sleep(35);assert not marker('done');assert current()['status'] not in ['active','recovering'];event('remained-stopped',current())
    else:
        wait_for(lambda:current().get('recoveryPhase')=='dispatching' or current()['status'] in ['active','idle'],90)
        event('original-resume-started',current());record['presenceToResumeSeconds']=round(time.monotonic()-restored,3)
        wait_for(lambda:marker('done') and current()['status']=='idle',180)
        row=current();assert row['session']['lineage']==[sid] and row['recoveryCount']==1
        record['resumeToCompletionSeconds']=round(time.monotonic()-restored,3)
        for suffix,wanted in [('started','started'),('done','done')]:
            assert ssh(a.head_host,['sudo','-n','cat',a.root+'/workspaces/sessions/'+a.case+'-'+suffix+'.txt'])==wanted
        event('original-session-completed',row)
    # Inspect only this synthetic rollout; publish counts, never prompt contents.
    code="""import json,pathlib
files=list(pathlib.Path(ROOT+'/runners/model/.octopus/codex-split-home/sessions').rglob('*'+SID+'*.jsonl'))
assert len(files)==1
messages=[]
for line in files[0].read_text().splitlines():
 try:r=json.loads(line)
 except ValueError:continue
 if r.get('type')=='response_item' and r.get('payload',{}).get('type')=='message' and r['payload'].get('role')=='user':messages.append(''.join(x.get('text','') for x in r['payload'].get('content',[]) if x.get('type')=='input_text'))
print(json.dumps({'originalInputCount':sum(CASE in x for x in messages),'continuationInputCount':sum(x.strip()=='继续执行' for x in messages)}))
""".replace('ROOT',repr(a.model_root)).replace('SID',repr(sid)).replace('CASE',repr(a.case))
    counts=json.loads(ssh(a.runner_host,['docker','exec','-u','ubuntu',a.model_container,'python3','-c',code]))
    assert counts['originalInputCount']==1;assert counts['continuationInputCount']==(0 if a.stop_while_waiting or a.revoke_while_waiting else 1)
    event('input-counts',counts)
    record['passed']=True;event('passed')
except Exception as error:event('failed',str(error));raise
finally:
    # Restore only resources this scenario successfully stopped.
    if model_stopped:ssh(a.runner_host,['systemctl','start',unit])
    if execution_stopped:ssh(a.head_host,['sudo','-n','docker','start',execution])
    try:driver.communicate(timeout=10)
    except subprocess.TimeoutExpired:driver.terminate()
    subprocess.run(['scp',str(output),a.head_host+':/tmp/'+a.case+'-fault.json'],check=True)
    ssh(a.head_host,['sudo','-n','cp','/tmp/'+a.case+'-fault.json',a.root+'/artifacts/'+a.case+'-fault.json'])
